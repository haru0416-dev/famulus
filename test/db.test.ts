import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { afterAll, beforeAll, test } from "vitest"
import { assertSchemaV4, openDb, SCHEMA_SQL, schemaVersion } from "../src/db/sqlite.ts"
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

test("旧versionのDBは変更せず拒否する", async () => {
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
  db.exec(`INSERT INTO schema_meta VALUES ('version','4');
    DROP INDEX idx_events_origin;
    CREATE INDEX idx_events_origin ON events(origin_id);
    CREATE INDEX idx_extra ON proposals(summary) WHERE summary='O''Reilly'`)
  assert.throws(() => assertSchemaV4(db, ":memory:"), /idx_events_origin/)
  db.close()
})

test("schema tableが無いDBはversion不明として扱う", () => {
  const db = openDb(":memory:")
  assert.equal(schemaVersion(db), undefined)
  assert.throws(() => assertSchemaV4(db, ":memory:"), /found=missing/)
  db.close()
})

test("空DBはv4で作られ再オープンできる", async () => {
  const path = join(root, "fresh.db")
  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  assert.equal(
    await rt.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Db).meta("version")
      }),
    ),
    "4",
  )
  await rt.dispose()
  const db = openDb(path)
  assertSchemaV4(db, path)
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
    assert.deepEqual(versions, ["4", "4"])
  } finally {
    await Promise.all(runtimes.map((rt) => rt.dispose()))
  }
})
