/** @cursor/sdk は vi.mock で置き換える。message/result の形はここで合成しているので、SDK 側の形の変化には気づけない。 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test, vi } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { listCursorModels, requireCursorKey, runCursorTask } from "../../src/model/cursor.ts"

/** vi.mock の factory は import より先に評価されるので、共有状態は vi.hoisted で作る。 */
const state = vi.hoisted(() => ({
  createCalls: [] as unknown[],
  cancels: 0,
  messages: [] as Record<string, unknown>[],
  result: {} as Record<string, unknown>,
  models: [] as Record<string, unknown>[],
  /** true なら message を流し終えた後、cancel まで stream を止める(時間ガード用)。 */
  block: false,
  release: undefined as (() => void) | undefined,
}))

vi.mock("@cursor/sdk", () => {
  class JsonlLocalAgentStore {
    readonly dir: string
    constructor(dir: string) {
      this.dir = dir
    }
  }
  const makeRun = () => {
    let cancelled = false
    return {
      async *stream() {
        for (const m of state.messages) {
          if (cancelled) return
          yield m
        }
        if (state.block) {
          await new Promise<void>((resolve) => {
            state.release = resolve
          })
        }
      },
      cancel: async () => {
        state.cancels += 1
        cancelled = true
        state.release?.()
      },
      wait: async () => state.result,
    }
  }
  return {
    JsonlLocalAgentStore,
    Cursor: { models: { list: async () => state.models } },
    Agent: {
      create: async (opts: unknown) => {
        state.createCalls.push(opts)
        return { send: async () => makeRun(), close: () => {} }
      },
    },
  }
})

const ENV_KEYS = [
  "FAMULUS_CURSOR_API_KEY",
  "FAMULUS_CURSOR_MODEL",
  "FAMULUS_CURSOR_MAX_TOOL_CALLS",
  "FAMULUS_CURSOR_MAX_DURATION_MS",
  "FAMULUS_CURSOR_RUN_TOKENS",
] as const
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]))
const roots: string[] = []

/** .env 由来の値に依存しないよう、cursor 系の env を検査ごとに決め直す。 */
const configure = (env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.FAMULUS_CURSOR_API_KEY = "test-key"
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  configureApp()
}

beforeEach(() => {
  state.createCalls.splice(0)
  state.cancels = 0
  state.messages = []
  state.result = { status: "completed" }
  state.models = []
  state.block = false
  state.release = undefined
})

afterEach(() => {
  vi.useRealTimers()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  configureApp()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-test-"))
  roots.push(dir)
  return dir
}

const gitRepo = (): string => {
  const dir = tempDir()
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(dir, "a.txt"), "1\n")
  git("add", "a.txt")
  git("commit", "-q", "-m", "c0")
  return dir
}

test("composer には fast=false を明示し、他のモデルには params を付けない", async () => {
  configure({ FAMULUS_CURSOR_MODEL: "composer-2.5" })
  const cwd = tempDir()
  await runCursorTask({ cwd, task: "t" })
  const opts = state.createCalls[0] as {
    apiKey: string
    model: unknown
    mode: string
    local: {
      cwd: string
      settingSources: readonly string[]
      sandboxOptions: { enabled: boolean }
      store: { dir: string }
    }
  }
  assert.deepEqual(opts.model, { id: "composer-2.5", params: [{ id: "fast", value: "false" }] })
  assert.equal(opts.mode, "agent")
  assert.equal(opts.apiKey, "test-key")
  assert.equal(opts.local.cwd, cwd)
  assert.deepEqual(opts.local.settingSources, ["project"])
  assert.deepEqual(opts.local.sandboxOptions, { enabled: false })
  assert.equal(opts.local.store.dir, join(cwd, ".agent", "store"))
  assert.equal(existsSync(join(cwd, ".agent", "store")), true)

  await runCursorTask({ cwd, task: "t", model: "claude-opus-4-8", mode: "plan" })
  const second = state.createCalls[1] as { model: unknown; mode: string }
  assert.deepEqual(second.model, { id: "claude-opus-4-8" })
  assert.equal(second.mode, "plan")
})

test("道具回数が上限を超えたら doomloop-toolcalls で中断する(error は別に数える)", async () => {
  configure({ FAMULUS_CURSOR_MAX_TOOL_CALLS: "2" })
  state.messages = [
    { type: "tool_call", status: "running" },
    { type: "tool_call", status: "error" },
    { type: "tool_call", status: "running" },
    { type: "tool_call", status: "running" },
    { type: "tool_call", status: "running" },
  ]
  state.result = { status: "cancelled" }
  const summary = await runCursorTask({ cwd: tempDir(), task: "t" })
  assert.equal(summary.aborted, "doomloop-toolcalls")
  // 3回目の running で 2 を超えて中断し、cancel 後の message は数えない。
  assert.equal(summary.toolCalls, 3)
  assert.equal(summary.toolErrors, 1)
  assert.equal(state.cancels, 1)
  assert.equal(summary.status, "cancelled")
})

test("token 予算は cacheRead を除いて数え、超過で budget-tokens 中断する", async () => {
  configure({ FAMULUS_CURSOR_RUN_TOKENS: "10000" })
  state.messages = [
    // 生の total の和は 18000 で上限超だが、cacheRead を除けば 9000 に収まる。
    { type: "usage", usage: { totalTokens: 9_000, cacheReadTokens: 5_000 } },
    { type: "usage", usage: { totalTokens: 7_000, cacheReadTokens: 2_000 } },
    // cacheReadTokens 無し。累計 11000 でここが超過になる。
    { type: "usage", usage: { totalTokens: 2_000 } },
  ]
  state.result = { status: "cancelled" }
  const seen: unknown[] = []
  const summary = await runCursorTask({ cwd: tempDir(), task: "t", onMessage: (m) => seen.push(m) })
  assert.equal(summary.aborted, "budget-tokens")
  assert.equal(state.cancels, 1)
  assert.equal(seen.length, 3)
})

test("git repo では before/after と diffStat(untracked 併記)を要約に写す", async () => {
  configure()
  const cwd = gitRepo()
  writeFileSync(join(cwd, "a.txt"), "2\n")
  writeFileSync(join(cwd, "b.txt"), "new\n")
  state.messages = [{ type: "assistant", text: "x" }]
  state.result = { status: "completed", durationMs: 777, usage: { totalTokens: 5 } }
  const summary = await runCursorTask({ cwd, task: "t" })
  assert.equal(summary.status, "completed")
  assert.equal(summary.durationMs, 777)
  assert.match(String(summary.gitBefore), /^[0-9a-f]{40}$/)
  assert.equal(summary.gitAfter, summary.gitBefore)
  assert.match(String(summary.diffStat), /a\.txt/)
  assert.match(String(summary.diffStat), / b\.txt \| \(untracked\)/)
  assert.equal(typeof summary.firstEventMs, "number")
  assert.deepEqual(summary.usage, { totalTokens: 5 })
  assert.equal(summary.aborted, undefined)
})

test("git の無い cwd では git 欄を省き、result.error は message だけ写す", async () => {
  configure()
  state.messages = []
  state.result = { status: "failed", error: { message: "boom" } }
  const summary = await runCursorTask({ cwd: tempDir(), task: "t" })
  assert.equal(summary.status, "failed")
  assert.equal(summary.error, "boom")
  assert.equal("gitBefore" in summary, false)
  assert.equal("gitAfter" in summary, false)
  assert.equal("diffStat" in summary, false)
  // message が来ていないので firstEventMs は無く、durationMs は経過時間になる。
  assert.equal("firstEventMs" in summary, false)
  assert.equal(typeof summary.durationMs, "number")
})

test("stream が止まっていても時間上限で doomloop-duration 中断する", async () => {
  configure({ FAMULUS_CURSOR_MAX_DURATION_MS: "60000" })
  state.block = true
  state.result = { status: "cancelled" }
  vi.useFakeTimers()
  const pending = runCursorTask({ cwd: tempDir(), task: "t" })
  await vi.advanceTimersByTimeAsync(60_001)
  const summary = await pending
  assert.equal(summary.aborted, "doomloop-duration")
  assert.equal(state.cancels, 1)
})

test("requireCursorKey は未設定なら .env への導線付きで落とす", () => {
  configure()
  assert.equal(requireCursorKey(), "test-key")
  delete process.env.FAMULUS_CURSOR_API_KEY
  configureApp()
  assert.throws(() => requireCursorKey(), /FAMULUS_CURSOR_API_KEY/)
})

test("listCursorModels は id と displayName だけに写す(displayName 無しは欄ごと省く)", async () => {
  configure()
  state.models = [{ id: "composer-2.5", displayName: "Composer", extra: "捨てる" }, { id: "claude-opus-4-8" }]
  assert.deepEqual(await listCursorModels(), [
    { id: "composer-2.5", displayName: "Composer" },
    { id: "claude-opus-4-8" },
  ])
})
