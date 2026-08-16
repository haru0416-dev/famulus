import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { test } from "vitest"
import { ConfigError, PROJECT_ROOT, parseConfig } from "../src/core/config.ts"

test("相対パスはcwdではなく設定rootを基準に絶対化する", () => {
  const root = "/tmp/open-zero-config-root"
  const config = parseConfig({ OPEN_ZERO_DB: "state/open-zero.db", OPEN_ZERO_RUNS: "runs" }, root)
  assert.equal(config.paths.db, join(root, "state/open-zero.db"))
  assert.equal(config.paths.runs, join(root, "runs"))
  assert.ok(isAbsolute(config.paths.backups))
  assert.equal(config.paths.runCache, join(root, ".data/run-cache"))
  assert.equal(config.paths.exportRoot, join(root, ".data/claude-export"))
  assert.ok(isAbsolute(config.paths.transcriptRoot))
  assert.equal(config.paths.xaiAuth, join(root, ".data/xai-auth.json"))
})

test("SQLiteのmemory pathと空のcycle unitを保持する", () => {
  const config = parseConfig(
    {
      OPEN_ZERO_DB: ":memory:",
      OPEN_ZERO_RUNS: ":memory:",
      OPEN_ZERO_XAI_AUTH: ":memory:",
      OPEN_ZERO_CYCLE_UNIT: "",
    },
    "/tmp/open-zero",
  )
  assert.equal(config.paths.db, ":memory:")
  assert.equal(config.paths.runs, "/tmp/open-zero/:memory:")
  assert.equal(config.paths.xaiAuth, "/tmp/open-zero/:memory:")
  assert.equal(config.cycle.unit, "")
})

test("model既定値はGrokだけで構成する", () => {
  assert.deepEqual(parseConfig({}, "/tmp/open-zero").models, {
    default: "grok-4.6",
    cycle: "grok-4.6",
    work: "grok-4.3",
    research: "grok-4.3",
  })
})

test.each([
  "OPEN_ZERO_MODEL",
  "OPEN_ZERO_CYCLE_MODEL",
  "OPEN_ZERO_WORK_MODEL",
  "OPEN_ZERO_RESEARCH_MODEL",
] as const)("%sのClaude modelを起動前に拒否する", (key) => {
  assert.throws(() => parseConfig({ [key]: "claude-opus-5" }, "/tmp/open-zero"), ConfigError)
})

test("解約済みのGPT modelを起動前に拒否する", () => {
  assert.throws(() => parseConfig({ OPEN_ZERO_MODEL: "gpt-5.6-sol" }, "/tmp/open-zero"), ConfigError)
})

test.each(["NaN", "Infinity", "1e3", "-1", "1.5"])("不正な数値 %s を拒否する", (value) => {
  assert.throws(() => parseConfig({ OPEN_ZERO_CYCLE_TIMEOUT_MS: value }, "/tmp/open-zero"), ConfigError)
})

test("時刻と相互制約を検証する", () => {
  assert.throws(() => parseConfig({ OPEN_ZERO_DREAM_HOUR: "24" }, "/tmp/open-zero"), ConfigError)
  assert.throws(
    () =>
      parseConfig(
        { OPEN_ZERO_CYCLE_HEARTBEAT_MS: "30000", OPEN_ZERO_CYCLE_LEASE_TTL_MS: "60000" },
        "/tmp/open-zero",
      ),
    ConfigError,
  )
  assert.throws(
    () => parseConfig({ OPEN_ZERO_DAILY_RUNS: "10", OPEN_ZERO_AUTONOMOUS_RUNS: "11" }, "/tmp/open-zero"),
    ConfigError,
  )
  assert.throws(() => parseConfig({ OPEN_ZERO_BACKUP_KEEP: "0" }, "/tmp/open-zero"), ConfigError)
})

test("TZとURLを境界で検証する", () => {
  assert.throws(() => parseConfig({ OPEN_ZERO_TZ: "Mars/Olympus" }, "/tmp/open-zero"), ConfigError)
  assert.throws(() => parseConfig({ OPEN_ZERO_DISCORD_API: "not a url" }, "/tmp/open-zero"), ConfigError)
  assert.throws(
    () => parseConfig({ OPEN_ZERO_DISCORD_API: "http://discord.test/api" }, "/tmp/open-zero"),
    ConfigError,
  )
  assert.throws(
    () => parseConfig({ OPEN_ZERO_DISCORD_API: "https://discord.test/api?token=x" }, "/tmp/open-zero"),
    ConfigError,
  )
  assert.equal(
    parseConfig({ OPEN_ZERO_SEARXNG: "http://127.0.0.1:8888/" }, "/tmp/open-zero").web.searxngBase,
    "http://127.0.0.1:8888",
  )
  assert.equal(
    parseConfig({ OPEN_ZERO_DISCORD_API: "http://[::1]:8080/" }, "/tmp/open-zero").discord.api,
    "http://[::1]:8080",
  )
  assert.equal(parseConfig({ OPEN_ZERO_SEARXNG: "" }, "/tmp/open-zero").web.searxngBase, undefined)
})

test("Discordの秘密値とchannelは空白を除き、空値は未設定にする", () => {
  const config = parseConfig(
    {
      OPEN_ZERO_DISCORD_TOKEN: " token ",
      OPEN_ZERO_DISCORD_OWNER_ID: " owner ",
      OPEN_ZERO_DISCORD_CH_TALK: " talk ",
      OPEN_ZERO_DISCORD_CH_DRAFT: " ",
    },
    "/tmp/open-zero",
  )
  assert.equal(config.discord.token, "token")
  assert.equal(config.discord.ownerId, "owner")
  assert.deepEqual(config.discord.channels, { talk: "talk" })
})

test("deployment configはConfig境界以外からprocess environmentを読まない", () => {
  const src = join(PROJECT_ROOT, "src")
  const violations = readdirSync(src, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
    .filter((entry) => entry !== "core/config.ts" && entry !== "core/env.ts")
    .filter((entry) => /(?:process|Bun)\.env/.test(readFileSync(join(src, entry), "utf8")))
  assert.deepEqual(violations, [])
})
