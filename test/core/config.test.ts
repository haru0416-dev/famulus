import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { test } from "vitest"
import { ConfigError, PROJECT_ROOT, parseConfig } from "../../src/core/config.ts"

test("相対パスは設定rootを基準に絶対化し、既定の置き場は家(~/.famulus/data)を指す", () => {
  const root = "/tmp/famulus-config-root"
  const config = parseConfig({ FAMULUS_DB: "state/famulus.db", FAMULUS_RUNS: "runs" }, root)
  assert.equal(config.paths.db, join(root, "state/famulus.db"))
  assert.equal(config.paths.runs, join(root, "runs"))
  assert.ok(isAbsolute(config.paths.backups))
  const home = join(homedir(), ".famulus/data")
  assert.equal(config.paths.runCache, join(home, "run-cache"))
  assert.equal(config.paths.exportRoot, join(home, "claude-export"))
  assert.ok(isAbsolute(config.paths.transcriptRoot))
  assert.equal(config.paths.xaiAuth, join(home, "xai-auth.json"))
})

test("SQLiteのmemory pathと空のcycle unitを保持する", () => {
  const config = parseConfig(
    {
      FAMULUS_DB: ":memory:",
      FAMULUS_RUNS: ":memory:",
      FAMULUS_XAI_AUTH: ":memory:",
      FAMULUS_CYCLE_UNIT: "",
    },
    "/tmp/famulus",
  )
  assert.equal(config.paths.db, ":memory:")
  assert.equal(config.paths.runs, "/tmp/famulus/:memory:")
  assert.equal(config.paths.xaiAuth, "/tmp/famulus/:memory:")
  assert.equal(config.cycle.unit, "")
})

test("model既定値はGrokだけで構成する(埋め込みはローカル ONNX で LLM ではない)", () => {
  assert.deepEqual(parseConfig({}, "/tmp/famulus").models, {
    default: "grok-4.6",
    cycle: "grok-4.6",
    work: "grok-4.3",
    research: "grok-4.3",
    embedding: "ruri-v3-30m",
  })
})

test("FAMULUS_EMBEDDING は3値だけを受ける", () => {
  assert.equal(parseConfig({ FAMULUS_EMBEDDING: "off" }, "/tmp/famulus").models.embedding, "off")
  assert.equal(parseConfig({ FAMULUS_EMBEDDING: "stub" }, "/tmp/famulus").models.embedding, "stub")
  assert.throws(() => parseConfig({ FAMULUS_EMBEDDING: "gpt-embedding" }, "/tmp/famulus"), ConfigError)
})

test.each(["FAMULUS_MODEL", "FAMULUS_CYCLE_MODEL", "FAMULUS_WORK_MODEL", "FAMULUS_RESEARCH_MODEL"] as const)(
  "%sのClaude modelを起動前に拒否する",
  (key) => {
    assert.throws(() => parseConfig({ [key]: "claude-opus-5" }, "/tmp/famulus"), ConfigError)
  },
)

test("解約済みのGPT modelを起動前に拒否する", () => {
  assert.throws(() => parseConfig({ FAMULUS_MODEL: "gpt-5.6-sol" }, "/tmp/famulus"), ConfigError)
})

test.each(["NaN", "Infinity", "1e3", "-1", "1.5"])("不正な数値 %s を拒否する", (value) => {
  assert.throws(() => parseConfig({ FAMULUS_CYCLE_TIMEOUT_MS: value }, "/tmp/famulus"), ConfigError)
})

test("時刻と相互制約を検証する", () => {
  assert.throws(() => parseConfig({ FAMULUS_DREAM_HOUR: "24" }, "/tmp/famulus"), ConfigError)
  assert.throws(
    () =>
      parseConfig(
        { FAMULUS_CYCLE_HEARTBEAT_MS: "30000", FAMULUS_CYCLE_LEASE_TTL_MS: "60000" },
        "/tmp/famulus",
      ),
    ConfigError,
  )
  assert.throws(
    () => parseConfig({ FAMULUS_DAILY_RUNS: "10", FAMULUS_AUTONOMOUS_RUNS: "11" }, "/tmp/famulus"),
    ConfigError,
  )
  assert.throws(() => parseConfig({ FAMULUS_BACKUP_KEEP: "0" }, "/tmp/famulus"), ConfigError)
})

test("TZとURLを境界で検証する", () => {
  assert.throws(() => parseConfig({ FAMULUS_TZ: "Mars/Olympus" }, "/tmp/famulus"), ConfigError)
  assert.throws(() => parseConfig({ FAMULUS_DISCORD_API: "not a url" }, "/tmp/famulus"), ConfigError)
  assert.throws(
    () => parseConfig({ FAMULUS_DISCORD_API: "http://discord.test/api" }, "/tmp/famulus"),
    ConfigError,
  )
  assert.throws(
    () => parseConfig({ FAMULUS_DISCORD_API: "https://discord.test/api?token=x" }, "/tmp/famulus"),
    ConfigError,
  )
  assert.equal(
    parseConfig({ FAMULUS_SEARXNG: "http://127.0.0.1:8888/" }, "/tmp/famulus").web.searxngBase,
    "http://127.0.0.1:8888",
  )
  assert.equal(
    parseConfig({ FAMULUS_DISCORD_API: "http://[::1]:8080/" }, "/tmp/famulus").discord.api,
    "http://[::1]:8080",
  )
  assert.equal(parseConfig({ FAMULUS_SEARXNG: "" }, "/tmp/famulus").web.searxngBase, undefined)
})

test("Discordの秘密値とchannelは空白を除き、空値は未設定にする", () => {
  const config = parseConfig(
    {
      FAMULUS_DISCORD_TOKEN: " token ",
      FAMULUS_DISCORD_OWNER_ID: " owner ",
      FAMULUS_DISCORD_CH_TALK: " talk ",
      FAMULUS_DISCORD_CH_DRAFT: " ",
    },
    "/tmp/famulus",
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
