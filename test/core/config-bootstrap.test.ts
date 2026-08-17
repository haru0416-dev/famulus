import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterAll, beforeAll, test } from "vitest"
import { PROJECT_ROOT } from "../../src/core/config.ts"

let callerCwd = ""
let configRoot = ""

beforeAll(() => {
  callerCwd = mkdtempSync(join(tmpdir(), "fam-caller-cwd-"))
  // 相対 FAMULUS_DB が「設定 root 基準」で絶対化されることを見る検査なので、repo 内に要る。
  const scratchParent = join(PROJECT_ROOT, "node_modules/.cache")
  mkdirSync(scratchParent, { recursive: true })
  configRoot = mkdtempSync(join(scratchParent, "fam-config-bootstrap-"))
})

afterAll(() => {
  if (callerCwd) rmSync(callerCwd, { recursive: true, force: true })
  if (configRoot) rmSync(configRoot, { recursive: true, force: true })
})

const fam = async (dbPath: string, extraEnv: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, join(PROJECT_ROOT, "src/cli.ts"), "status"], {
    cwd: callerCwd,
    env: {
      ...Bun.env,
      FAMULUS_DB: relative(PROJECT_ROOT, dbPath),
      FAMULUS_DISCORD_TOKEN: "",
      FAMULUS_TZ: "UTC",
      ...extraEnv,
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

test("別cwdから起動しても相対DBは設定rootに作る", async () => {
  const dbPath = join(configRoot, "famulus.db")
  const result = await fam(dbPath)
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(existsSync(dbPath), true)
  assert.equal(existsSync(join(callerCwd, relative(PROJECT_ROOT, dbPath))), false)
})

test("不正ConfigはDBを開く前に入口を停止する", async () => {
  const dbPath = join(configRoot, "invalid.db")
  const result = await fam(dbPath, { FAMULUS_TZ: "Mars/Olympus" })
  assert.notEqual(result.exitCode, 0)
  assert.match(result.stderr, /FAMULUS_TZ/)
  assert.equal(existsSync(dbPath), false)
})
