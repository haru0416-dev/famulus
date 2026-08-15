import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { afterAll, beforeAll, test } from "vitest"
import { assertCurrentSchema, openDb, SCHEMA_SQL } from "../src/db/sqlite.ts"
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

test("現行shapeと違う既存DBは変更せず拒否する", async () => {
  const path = join(root, "wrong-shape.db")
  const db = openDb(path)
  db.exec(SCHEMA_SQL)
  db.exec("DROP INDEX idx_events_origin")
  db.close()

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  await assert.rejects(() => rt.runPromise(Effect.flatMap(Db, () => Effect.void)), /idx_events_origin/)
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
  await assert.rejects(() => rt.runPromise(Effect.flatMap(Db, () => Effect.void)), /sqlite_sequence/)
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
