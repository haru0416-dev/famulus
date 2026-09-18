/** cache 込み input の二重計上と、不明を0円に数えることを防ぐ。 */

import assert from "node:assert/strict"
import { test } from "vitest"
import { CURSOR_PRICING, estimateRunCostUSD, hasPricing, parseUsage } from "../../src/model/cursor-pricing.ts"

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const close = (a: number | undefined, b: number) => {
  assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≒ ${b}`)
}

test("SDK の TokenUsage 形を受理し、異形は undefined", () => {
  assert.equal(parseUsage(usage(100, 50))?.inputTokens, 100)
  assert.equal(parseUsage(undefined), undefined)
  assert.equal(parseUsage({ tokens: 5 }), undefined)
  assert.equal(parseUsage("100"), undefined)
})

test("composer-2.5 標準単価と fast=:fast キーの別課金", () => {
  close(estimateRunCostUSD({ model: "composer-2.5", usage: usage(1_000_000, 1_000_000) }), 0.5 + 2.5)
  close(estimateRunCostUSD({ model: "composer-2.5", fast: true, usage: usage(1_000_000, 0) }), 3)
})

test("単価未登録モデル・usage 欠落は undefined(0ではない)", () => {
  assert.equal(estimateRunCostUSD({ model: "unknown-model", usage: usage(1, 1) }), undefined)
  assert.equal(estimateRunCostUSD({ model: "composer-2.5", usage: undefined }), undefined)
})

test("inputTokens は cache 込み総入力: cache 分を差し引き、単価があるときだけ加算する", () => {
  const table = {
    asOf: "2026-07-08",
    models: { m: { inputPerM: 1, outputPerM: 1, cacheReadPerM: 0.1, cacheWritePerM: 1.25 } },
  }
  const u = { inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 500_000 }
  close(estimateRunCostUSD({ model: "m", usage: u }, table), 0.5 + 0.1 + 0.625)
})

test("cache 単価未定義のモデルは cache 分を含まない下限見積もり", () => {
  const table = { asOf: "2026-07-08", models: { m: { inputPerM: 1, outputPerM: 1 } } }
  const u = { inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 500_000 }
  close(estimateRunCostUSD({ model: "m", usage: u }, table), 0.5)
})

test("cache 超過(排他的 input を返す SDK)でも負にならない", () => {
  const u = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 5_000_000, cacheWriteTokens: 0 }
  const cost = estimateRunCostUSD({ model: "composer-2.5", usage: u })
  assert.ok(cost !== undefined && cost >= 0)
})

test("hasPricing は estimateRunCostUSD と同じフォールバックを見る", () => {
  assert.equal(hasPricing("composer-2.5", false, CURSOR_PRICING), true)
  assert.equal(hasPricing("composer-2.5", true, CURSOR_PRICING), true)
  assert.equal(hasPricing("claude-opus-4-8", true, CURSOR_PRICING), true)
  assert.equal(hasPricing("unknown-model", false, CURSOR_PRICING), false)
})
