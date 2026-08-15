import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { afterAll, beforeAll, test } from "vitest"
import { assertCurrentSchema, openDb, SCHEMA_SQL, schemaVersion } from "../src/db/sqlite.ts"
import { RunnerStub } from "../src/model/Runner.ts"
import { makeRuntime } from "../src/runtime.ts"
import { Db, DbLive } from "../src/services/Db.ts"

let root = ""
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "oz-db-"))
})
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test("移行経路のない旧versionのDBは変更せず拒否する", async () => {
  const path = join(root, "old.db")
  const db = openDb(path)
  db.exec(
    "CREATE TABLE schema_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version','3')",
  )
  db.close()
  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(
    () =>
      rt.runPromise(
        Effect.gen(function* () {
          yield* Db
        }),
      ),
    /Unsupported database schema/,
  )
  await rt.dispose()
  const reopened = openDb(path)
  assert.equal(
    (reopened.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value,
    "3",
  )
  reopened.close()
})

test("同じversionでも定義の違うDBは拒否する", () => {
  const db = openDb(":memory:")
  db.exec(SCHEMA_SQL)
  db.exec(`INSERT INTO schema_meta VALUES ('version','5');
    INSERT INTO schema_migrations VALUES (5,'baseline','2026-08-15T00:00:00.000Z');
    DROP INDEX idx_events_origin;
    CREATE INDEX idx_events_origin ON events(origin_id);
    CREATE INDEX idx_extra ON proposals(summary) WHERE summary='O''Reilly'`)
  assert.throws(() => assertCurrentSchema(db, ":memory:"), /idx_events_origin/)
  db.close()
})

test("schema tableが無いDBはversion不明として扱う", () => {
  const db = openDb(":memory:")
  assert.equal(schemaVersion(db), undefined)
  assert.throws(() => assertCurrentSchema(db, ":memory:"), /found=missing/)
  db.close()
})

test("所有メタデータだけを持つ既存DBは初期化しない", async () => {
  const path = join(root, "foreign-metadata.db")
  const db = openDb(path)
  db.exec("PRAGMA user_version=123; PRAGMA application_id=456")
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(
    () =>
      rt.runPromise(
        Effect.gen(function* () {
          yield* Db
        }),
      ),
    /foreign metadata/,
  )
  await rt.dispose()

  const reopened = openDb(path)
  assert.deepEqual(reopened.prepare("PRAGMA user_version").get(), { user_version: 123 })
  assert.deepEqual(reopened.prepare("PRAGMA application_id").get(), { application_id: 456 })
  assert.equal((reopened.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n, 0)
  reopened.close()
})

test("SQLite内部テーブルが残る既存DBは初期化しない", async () => {
  const path = join(root, "sqlite-sequence.db")
  const db = openDb(path)
  db.exec("CREATE TABLE temporary(id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE temporary")
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(
    () =>
      rt.runPromise(
        Effect.gen(function* () {
          yield* Db
        }),
      ),
    /found=missing/,
  )
  await rt.dispose()

  const reopened = openDb(path)
  assert.deepEqual(
    reopened.prepare("SELECT name FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all(),
    [{ name: "sqlite_sequence" }],
  )
  reopened.close()
})

test("現行DBに余分なSQLite内部テーブルがあれば拒否する", () => {
  const db = openDb(":memory:")
  db.exec(SCHEMA_SQL)
  db.exec(`INSERT INTO schema_meta VALUES ('version','5');
    CREATE TABLE temporary(id INTEGER PRIMARY KEY AUTOINCREMENT);
    DROP TABLE temporary`)
  assert.throws(() => assertCurrentSchema(db, ":memory:"), /sqlite_sequence/)
  db.close()
})

test("空DBは現行版で作られ再オープンできる", async () => {
  const path = join(root, "fresh.db")
  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  assert.equal(
    await rt.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Db).meta("version")
      }),
    ),
    "5",
  )
  await rt.dispose()
  const db = openDb(path)
  assertCurrentSchema(db, path)
  db.close()
})

test("空DBを2接続が同時に開いても同じschemaを受理する", async () => {
  const path = join(root, "concurrent.db")
  const runtimes = [1, 2].map(() => makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer))
  try {
    const versions = await Promise.all(
      runtimes.map((rt) =>
        rt.runPromise(
          Effect.gen(function* () {
            return yield* (yield* Db).meta("version")
          }),
        ),
      ),
    )
    assert.deepEqual(versions, ["5", "5"])
  } finally {
    await Promise.all(runtimes.map((rt) => rt.dispose()))
  }
})

test("v4をv5へ一度だけ移行し既存データを保持する", async () => {
  const path = join(root, "migrate-v4.db")
  const db = openDb(path)
  db.exec(SCHEMA_SQL)
  db.exec(`DROP TABLE schema_migrations;
    INSERT INTO schema_meta VALUES ('version','4'), ('sentinel','keep');
    ANALYZE`)
  db.close()

  for (let attempt = 0; attempt < 2; attempt++) {
    const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
    const state = await rt.runPromise(
      Effect.gen(function* () {
        const live = yield* Db
        return {
          version: yield* live.meta("version"),
          sentinel: yield* live.meta("sentinel"),
          migrations: yield* live.all("SELECT version,name FROM schema_migrations ORDER BY version"),
        }
      }),
    )
    await rt.dispose()
    assert.deepEqual(state, {
      version: "5",
      sentinel: "keep",
      migrations: [{ version: 5, name: "schema-migrations" }],
    })
  }
})

test("形状が壊れたv4はmigrationをrollbackして元の版を保つ", async () => {
  const path = join(root, "broken-v4.db")
  const db = openDb(path)
  db.exec(SCHEMA_SQL)
  db.exec(
    "DROP TABLE schema_migrations; DROP INDEX idx_events_origin; INSERT INTO schema_meta VALUES ('version','4')",
  )
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(
    () =>
      rt.runPromise(
        Effect.gen(function* () {
          yield* Db
        }),
      ),
    /idx_events_origin/,
  )
  await rt.dispose()

  const reopened = openDb(path)
  assert.equal(schemaVersion(reopened), "4")
  assert.equal(
    (
      reopened.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='schema_migrations'").get() as {
        n: number
      }
    ).n,
    0,
  )
  reopened.close()
})

test("現行schema受理後に旧tick状態をcycleへ一度だけ移す", async () => {
  const path = join(root, "tick-meta.db")
  const db = openDb(path)
  db.exec(SCHEMA_SQL)
  db.exec(`INSERT INTO schema_meta VALUES
    ('version','5'),
    ('migration-test','keep'),
    ('tick:cursor','12'),
    ('tick:last','old'),
    ('cycle:last','current')`)
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  const state = await rt.runPromise(
    Effect.gen(function* () {
      const live = yield* Db
      return {
        cursor: yield* live.meta("cycle:cursor"),
        last: yield* live.meta("cycle:last"),
        old: yield* live.all("SELECT key FROM schema_meta WHERE key LIKE 'tick:%'"),
      }
    }),
  )
  await rt.dispose()

  assert.deepEqual(state, { cursor: "12", last: "current", old: [] })
})
