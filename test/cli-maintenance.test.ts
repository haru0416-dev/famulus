import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import { afterAll, beforeAll, test } from "vitest"
import { RunnerStub } from "../src/model/Runner.ts"
import { makeRuntime } from "../src/runtime.ts"
import { Db, DbLive } from "../src/services/Db.ts"

let root = ""
let dbPath = ""
let backupDir = ""
const projectRoot = fileURLToPath(new URL("..", import.meta.url))

const oz = async (...args: string[]) => {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: projectRoot,
    env: {
      ...Bun.env,
      FAMULUS_DB: dbPath,
      FAMULUS_BACKUPS: backupDir,
      FAMULUS_TZ: "UTC",
      FAMULUS_DISCORD_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "oz-cli-maintenance-"))
  dbPath = join(root, "famulus.db")
  backupDir = join(root, "backups")
  const rt = makeRuntime(DbLive(dbPath), RunnerStub([{ text: "ok" }]).layer)
  await rt.runPromise(Effect.flatMap(Db, (db) => db.setMeta("cli-sentinel", "kept")))
  await rt.dispose()
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test("CLIでbackup・doctor・restore検証を端から端まで実行する", async () => {
  const backup = await oz("backup")
  assert.equal(backup.exitCode, 0, backup.stderr)
  assert.match(backup.stdout, /バックアップ完了/)
  assert.match(backup.stdout, /復元検証: ok/)

  const doctor = await oz("doctor")
  assert.equal(doctor.exitCode, 0, doctor.stderr)
  assert.match(doctor.stdout, /live DB: ok/)
  assert.match(doctor.stdout, /最新backup復元: ok/)

  const restore = await oz("restore", "--verify")
  assert.equal(restore.exitCode, 0, restore.stderr)
  assert.match(restore.stdout, /復元検証完了/)

  const status = await oz("status")
  assert.equal(status.exitCode, 0, status.stderr)
  assert.match(status.stdout, /バックアップ: 最終/)
  assert.match(status.stdout, /復元検証: 最終/)
  assert.match(status.stdout, /cycle lease:/)
})
