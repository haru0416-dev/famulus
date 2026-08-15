import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import { afterAll, beforeAll, test } from "vitest"
import { checkDatabase, createBackup, listBackups, verifyRestore } from "../src/db/maintenance.ts"
import { openDb } from "../src/db/sqlite.ts"
import { RunnerStub } from "../src/model/Runner.ts"
import { makeRuntime } from "../src/runtime.ts"
import { Db, DbLive } from "../src/services/Db.ts"

let root = ""
let source = ""
const projectRoot = fileURLToPath(new URL("..", import.meta.url))

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "oz-maintenance-"))
  source = join(root, "open-zero.db")
  const rt = makeRuntime(DbLive(source), RunnerStub([{ text: "ok" }]).layer)
  await rt.runPromise(Effect.flatMap(Db, (db) => db.setMeta("backup-sentinel", "kept")))
  await rt.dispose()
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test("WAL-safe backupを復元した一時DBで検証し成功を記録する", () => {
  const backups = join(root, "backups")
  const writer = openDb(source)
  writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('wal-sentinel','uncheckpointed')`)
  const result = createBackup(source, backups, { keep: 2, now: new Date("2026-08-15T10:20:30.123Z") })
  writer.close()

  assert.ok(result.bytes > 0)
  assert.deepEqual(result.removed, [])
  assert.ok(verifyRestore(result.path).bytes > 0)

  const copy = openDb(result.path)
  assert.equal(
    (copy.prepare("SELECT value FROM schema_meta WHERE key='backup-sentinel'").get() as { value: string })
      .value,
    "kept",
  )
  assert.equal(
    (copy.prepare("SELECT value FROM schema_meta WHERE key='wal-sentinel'").get() as { value: string }).value,
    "uncheckpointed",
  )
  copy.close()

  const live = openDb(source)
  assert.deepEqual(
    live
      .prepare(
        "SELECT key,value FROM schema_meta WHERE key IN ('backup:last_at','restore:last_verified_at') ORDER BY key",
      )
      .all(),
    [
      { key: "backup:last_at", value: "2026-08-15T10:20:30.123Z" },
      { key: "restore:last_verified_at", value: "2026-08-15T10:20:30.123Z" },
    ],
  )
  live.close()
})

test("保持世代を超えた古いbackupだけを削除する", () => {
  const backups = join(root, "retention")
  createBackup(source, backups, { keep: 2, now: new Date("2026-08-15T10:20:30.123Z") })
  createBackup(source, backups, { keep: 2, now: new Date("2026-08-15T10:20:31.123Z") })
  const result = createBackup(source, backups, { keep: 2, now: new Date("2026-08-15T10:20:32.123Z") })
  assert.equal(result.removed.length, 1)
  assert.equal(listBackups(backups).length, 2)
})

test("時計が戻っても作成したbackupとmetadataを残す", () => {
  const backups = join(root, "clock-rollback")
  createBackup(source, backups, { keep: 1, now: new Date("2026-08-15T10:20:32.123Z") })
  const result = createBackup(source, backups, { keep: 1, now: new Date("2026-08-15T10:20:30.123Z") })
  assert.equal(existsSync(result.path), true)
  assert.deepEqual(listBackups(backups), [result.path])
  const live = openDb(source)
  assert.equal(
    (live.prepare("SELECT value FROM schema_meta WHERE key='backup:last_path'").get() as { value: string })
      .value,
    result.path,
  )
  live.close()
})

test("既存のsymlink lockを追跡しない", () => {
  const backups = join(root, "symlink-lock")
  const victim = join(root, "lock-victim.db")
  const victimDb = openDb(victim)
  victimDb.exec("CREATE TABLE sentinel(value TEXT)")
  victimDb.close()
  mkdirSync(backups)
  symlinkSync(victim, join(backups, ".backup-lock.db"))

  assert.throws(() => createBackup(source, backups, { keep: 1 }), /backup lock is not a regular file/)
  const reopened = openDb(victim)
  assert.deepEqual(reopened.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [
    { name: "sentinel" },
  ])
  reopened.close()
})

test("既存のdangling symlink lockも追跡しない", () => {
  const backups = join(root, "dangling-lock")
  const victim = join(root, "missing-lock-victim.db")
  mkdirSync(backups)
  symlinkSync(victim, join(backups, ".backup-lock.db"))

  assert.throws(() => createBackup(source, backups, { keep: 1 }), /backup lock is not a regular file/)
  assert.equal(existsSync(victim), false)
})

test("同時backupは作成途中のfileを保持整理の対象にしない", async () => {
  const backups = join(root, "concurrent")
  const children = Array.from({ length: 6 }, () =>
    Bun.spawn([process.execPath, "test/fixtures/backup-probe.ts", source, backups], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  const results = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  )
  assert.deepEqual(
    results.map((result) => result.code),
    [0, 0, 0, 0, 0, 0],
    results.map((result) => result.stderr).join("\n"),
  )
  assert.equal(listBackups(backups).length, 1)
})

test("壊れたbackupの復元検証を拒否する", () => {
  const corrupt = join(root, "corrupt.db")
  writeFileSync(corrupt, "not sqlite")
  chmodSync(corrupt, 0o600)
  assert.throws(() => verifyRestore(corrupt))
  assert.throws(() => checkDatabase(":memory:"), /memory database/)
})
