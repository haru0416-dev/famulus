import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { afterAll, beforeAll, test } from "vitest"
import { PROJECT_ROOT } from "../../src/core/config.ts"
import { NotFound } from "../../src/core/errors.ts"
import { assertCurrentSchema, enableWalJournalMode, openDb, SCHEMA_SQL } from "../../src/db/sqlite.ts"
import { RunnerStub } from "../../src/model/Runner.ts"
import { makeRuntime } from "../../src/runtime.ts"
import { Db, DbLive, type DbTxAbort } from "../../src/services/Db.ts"
import { legacyV4Sql } from "../helpers.ts"

let root = ""
/**
 * migration 台帳より前の DB を作る。現行 schema から作り、以後の migration が加えた差を
 * 文字列の段階で戻す — v4 の指紋(LEGACY_V4_SCHEMA_FINGERPRINT)と一致させるため。
 * migration を足したら、その差をここでも戻すこと。
 */
const makeLegacyV4 = (db: ReturnType<typeof openDb>): void => {
  db.exec(legacyV4Sql(SCHEMA_SQL))
  db.exec("DROP TABLE schema_migrations")
}

const readLine = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
  return text.trim()
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fam-db-"))
})
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test("現行shapeと違う既存DBは変更せず拒否する", async () => {
  const path = join(root, "wrong-shape.db")
  const db = openDb(path)
  makeLegacyV4(db)
  db.exec("DROP INDEX idx_events_origin")
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(
    () => rt.runPromise(Effect.flatMap(Db, () => Effect.void)),
    /Invalid database baseline/,
  )
  await rt.dispose()

  const reopened = openDb(path)
  assert.equal(
    (
      reopened.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='idx_events_origin'").get() as {
        n: number
      }
    ).n,
    0,
  )
  reopened.close()
})

test("所有メタデータだけを持つ既存DBは初期化しない", async () => {
  const path = join(root, "foreign-metadata.db")
  const db = openDb(path)
  db.exec("PRAGMA user_version=123; PRAGMA application_id=456")
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(() => rt.runPromise(Effect.flatMap(Db, () => Effect.void)), /foreign metadata/)
  await rt.dispose()

  const reopened = openDb(path)
  assert.deepEqual(reopened.prepare("PRAGMA user_version").get(), { user_version: 123 })
  assert.deepEqual(reopened.prepare("PRAGMA application_id").get(), { application_id: 456 })
  reopened.close()
})

test("SQLite内部テーブルが残る既存DBは初期化しない", async () => {
  const path = join(root, "sqlite-sequence.db")
  const db = openDb(path)
  db.exec("CREATE TABLE temporary(id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE temporary")
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(
    () => rt.runPromise(Effect.flatMap(Db, () => Effect.void)),
    /Invalid database baseline/,
  )
  await rt.dispose()
})

test("lease singletonはREPLACEでも差し替えられない", () => {
  const db = openDb(":memory:")
  db.exec(SCHEMA_SQL)
  assert.throws(
    () => db.exec("INSERT OR REPLACE INTO cycle_lease(lease_name,state,fence)VALUES('cycle','free',0)"),
    /cannot be replaced/,
  )
  db.close()
})

test("空DBは現行schemaで一度だけ作られ再オープンできる", async () => {
  const path = join(root, "fresh.db")
  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await rt.runPromise(Effect.flatMap(Db, () => Effect.void))
  await rt.dispose()

  const reopened = openDb(path)
  assertCurrentSchema(reopened, path)
  assert.deepEqual(reopened.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all(), [
    { version: 1, name: "migration-ledger" },
    { version: 2, name: "discord-ack" },
    { version: 3, name: "recall-vec" },
  ])
  assert.throws(() => reopened.exec("DELETE FROM schema_migrations"), /immutable/)
  reopened.close()
})

test("既知のbaseline DBはデータを保ったままcurrent schemaへ移行する", async () => {
  const path = join(root, "baseline.db")
  const db = openDb(path)
  makeLegacyV4(db)
  db.prepare("INSERT INTO schema_meta(key,value)VALUES('preserved','yes')").run()
  db.close()

  const fixture = join(PROJECT_ROOT, "test/fixtures", "db-open-probe.ts")
  const holder = Bun.spawn([process.execPath, fixture, path, "hold"], { stdout: "pipe", stderr: "pipe" })
  assert.equal(await readLine(holder.stdout), "locked")
  const processes = [1, 2].map(() =>
    Bun.spawn([process.execPath, fixture, path], { stdout: "pipe", stderr: "pipe" }),
  )
  const exits = await Promise.all(processes.map((process) => process.exited))
  const errors = await Promise.all(processes.map((process) => new Response(process.stderr).text()))
  assert.deepEqual(exits, [0, 0], errors.join("\n"))
  assert.equal(await holder.exited, 0, await new Response(holder.stderr).text())

  const reopened = openDb(path)
  assertCurrentSchema(reopened, path)
  assert.deepEqual(reopened.prepare("SELECT value FROM schema_meta WHERE key='preserved'").get(), {
    value: "yes",
  })
  assert.deepEqual(reopened.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all(), [
    { version: 1, name: "migration-ledger" },
    { version: 2, name: "discord-ack" },
    { version: 3, name: "recall-vec" },
  ])
  reopened.close()
})

test("write lock中のWAL切替はlock解放まで待つ", async () => {
  const path = join(root, "wal-lock.db")
  const db = openDb(path)
  db.exec(SCHEMA_SQL)

  const fixture = join(PROJECT_ROOT, "test/fixtures", "db-open-probe.ts")
  const holder = Bun.spawn([process.execPath, fixture, path, "hold"], { stdout: "pipe", stderr: "pipe" })
  assert.equal(await readLine(holder.stdout), "locked")
  const started = Date.now()
  enableWalJournalMode(db, 2_000)
  assert.ok(Date.now() - started >= 200)
  assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal")
  assert.equal(await holder.exited, 0, await new Response(holder.stderr).text())
  db.close()
})

test("foreign metadataを持つbaseline DBは変更せず拒否する", async () => {
  const path = join(root, "foreign-baseline.db")
  const db = openDb(path)
  makeLegacyV4(db)
  db.exec("PRAGMA user_version=123; PRAGMA application_id=456")
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(() => rt.runPromise(Effect.flatMap(Db, () => Effect.void)), /foreign metadata/)
  await rt.dispose()

  const reopened = openDb(path)
  assert.deepEqual(reopened.prepare("PRAGMA user_version").get(), { user_version: 123 })
  assert.deepEqual(reopened.prepare("PRAGMA application_id").get(), { application_id: 456 })
  assert.equal(
    (
      reopened.prepare("SELECT count(*) n FROM sqlite_master WHERE name='schema_migrations'").get() as {
        n: number
      }
    ).n,
    0,
  )
  reopened.close()
})

test("改ざんされたmigration ledgerは変更せず拒否する", async () => {
  const path = join(root, "bad-migration-ledger.db")
  const db = openDb(path)
  makeLegacyV4(db)
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TEXT NOT NULL
  ) STRICT`)
  db.prepare(
    "INSERT INTO schema_migrations(version,name,checksum,applied_at)VALUES(1,'migration-ledger',?,?)",
  ).run("0".repeat(64), new Date().toISOString())
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(
    () => rt.runPromise(Effect.flatMap(Db, () => Effect.void)),
    /Invalid schema migration ledger/,
  )
  await rt.dispose()

  const reopened = openDb(path)
  assert.deepEqual(reopened.prepare("SELECT checksum FROM schema_migrations").get(), {
    checksum: "0".repeat(64),
  })
  reopened.close()
})

test("未知のmigration historyは変更せず拒否する", async () => {
  const path = join(root, "unknown-migration.db")
  const db = openDb(path)
  db.exec(SCHEMA_SQL)
  db.exec("DROP TRIGGER schema_migrations_immutable; DROP TRIGGER schema_migrations_no_delete")
  db.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at)VALUES(9,'unknown',?,?)").run(
    "f".repeat(64),
    new Date().toISOString(),
  )
  db.exec(`CREATE TRIGGER schema_migrations_immutable
    BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
    CREATE TRIGGER schema_migrations_no_delete
    BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;`)
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(() => rt.runPromise(Effect.flatMap(Db, () => Effect.void)), /Unknown schema migration/)
  await rt.dispose()

  const reopened = openDb(path)
  assert.equal(
    (reopened.prepare("SELECT count(*) n FROM schema_migrations WHERE version=9").get() as { n: number }).n,
    1,
  )
  reopened.close()
})

test("空DBを2接続が同時に開いても同じschemaを受理する", async () => {
  const path = join(root, "concurrent.db")
  const runtimes = [1, 2].map(() => makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer))
  try {
    await Promise.all(runtimes.map((rt) => rt.runPromise(Effect.flatMap(Db, () => Effect.void))))
  } finally {
    await Promise.all(runtimes.map((rt) => rt.dispose()))
  }

  const db = openDb(path)
  assertCurrentSchema(db, path)
  db.close()
})

test("transaction abortは書き込みを戻し指定されたdomain errorを保持する", async () => {
  const rt = makeRuntime(DbLive(":memory:"), RunnerStub([{ text: "ok" }]).layer)
  const expected = new NotFound({ what: "test row", id: "missing" })
  let leakedAbort: DbTxAbort<NotFound> | undefined
  try {
    await assert.rejects(
      () =>
        rt.runPromise(
          Effect.flatMap(Db, (db) =>
            db.withImmediateTransaction<never, NotFound>("abort test", (tx, abort) => {
              tx.run("INSERT INTO schema_meta(key,value)VALUES('aborted-write','yes')")
              return abort(expected)
            }),
          ),
        ),
      (error) => error === expected,
    )

    await rt.runPromise(
      Effect.flatMap(Db, (db) =>
        db.withImmediateTransaction<void, NotFound>("leak abort handle", (_tx, abort) => {
          leakedAbort = abort
        }),
      ),
    )
    assert.throws(() => leakedAbort?.(expected), /transaction abort handle is no longer active/)
    await assert.rejects(
      () =>
        rt.runPromise(
          Effect.flatMap(Db, (db) =>
            db.withImmediateTransaction("reject stale abort handle", (tx) => {
              tx.run("INSERT INTO schema_meta(key,value)VALUES('stale-abort-write','yes')")
              return leakedAbort?.(expected)
            }),
          ),
        ),
      (error) => error !== expected && /transaction abort handle is no longer active/.test(String(error)),
    )

    const result = await rt.runPromise(
      Effect.flatMap(Db, (db) =>
        Effect.all({
          rolledBack: db.meta("aborted-write"),
          staleAbortRolledBack: db.meta("stale-abort-write"),
          missing: db.withImmediateTransaction("missing row", (tx) =>
            tx.get("SELECT value FROM schema_meta WHERE key='missing'"),
          ),
        }),
      ),
    )
    assert.deepEqual(result, { rolledBack: undefined, staleAbortRolledBack: undefined, missing: undefined })
  } finally {
    await rt.dispose()
  }
})

test("公開DB APIは手動transaction制御SQLを拒否する", async () => {
  const rt = makeRuntime(DbLive(":memory:"), RunnerStub([{ text: "ok" }]).layer)
  try {
    for (const control of ["BEGIN IMMEDIATE", ";; /* hidden */ COMMIT", "-- hidden\nROLLBACK"]) {
      await assert.rejects(
        () => rt.runPromise(Effect.flatMap(Db, (db) => db.run(control))),
        /transaction control SQL is not allowed/,
      )
    }
    await rt.runPromise(Effect.flatMap(Db, (db) => db.setMeta("still-writable", "yes")))
    assert.equal(await rt.runPromise(Effect.flatMap(Db, (db) => db.meta("still-writable"))), "yes")
  } finally {
    await rt.dispose()
  }
})
