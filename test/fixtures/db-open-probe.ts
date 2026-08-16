import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { openDb } from "../../src/db/sqlite.ts"
import { Db, DbLive } from "../../src/services/Db.ts"

const path = process.argv[2]
if (!path) throw new Error("database path is required")

if (process.argv[3] === "hold") {
  const db = openDb(path)
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE")
    console.log("locked")
    await Bun.sleep(250)
    db.exec("ROLLBACK")
  } finally {
    db.close()
  }
  process.exit(0)
}

const runtime = ManagedRuntime.make(DbLive(path))
try {
  const row = await runtime.runPromise(
    Effect.flatMap(Db, (db) =>
      db.get("SELECT version,name FROM schema_migrations ORDER BY version DESC LIMIT 1"),
    ),
  )
  console.log(JSON.stringify(row))
} finally {
  await runtime.dispose()
}
