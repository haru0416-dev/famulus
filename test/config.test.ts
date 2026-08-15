import assert from "node:assert/strict"
import { isAbsolute, join } from "node:path"
import { test } from "vitest"
import { ConfigError, parseConfig } from "../src/core/config.ts"

test("相対パスはcwdではなく設定rootを基準に絶対化する", () => {
  const root = "/tmp/open-zero-config-root"
  const config = parseConfig({ OPEN_ZERO_DB: "state/open-zero.db", OPEN_ZERO_RUNS: "runs" }, root)
  assert.equal(config.paths.db, join(root, "state/open-zero.db"))
  assert.equal(config.paths.runs, join(root, "runs"))
  assert.ok(isAbsolute(config.paths.backups))
})

test("SQLiteのmemory pathと空のcycle unitを保持する", () => {
  const config = parseConfig({ OPEN_ZERO_DB: ":memory:", OPEN_ZERO_CYCLE_UNIT: "" }, "/tmp/open-zero")
  assert.equal(config.paths.db, ":memory:")
  assert.equal(config.cycle.unit, "")
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
})
