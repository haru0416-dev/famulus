/**
 * governance middleware の成功経路の検査。モデルは呼ばない。
 * 固定するのは会計: 成功応答が ledger に kind='turn'・role 付きで記帳され、
 * in_tok が noCache(cache 除外)で入ること。ここが切れると日次 run 数の上限
 * (ledger の role 行を数える)が適用されないまま走り続ける。
 * 失敗→cooldown の連鎖は governed.test.ts(別プロセス。cooldown が残るので同居させない)。
 */

import assert from "node:assert/strict"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import { wrapLanguageModel } from "ai"
import * as Effect from "effect/Effect"
import { beforeAll, test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { governance, governedModel } from "../../src/model/governed.ts"
import { XAI_PROVIDER_META } from "../../src/model/xai-responses.ts"
import { run } from "../../src/runtime.ts"
import { Db } from "../../src/services/Db.ts"

beforeAll(() => {
  process.env.FAMULUS_DB = ":memory:"
  configureApp()
})

/** doGenerate が成功する応答。providerMetadata の有無で notionalUsd の読み分けを見る。 */
const okModel = (meta: boolean): LanguageModelV4 => ({
  specificationVersion: "v4",
  provider: "test",
  modelId: "grok-4.3",
  supportedUrls: {},
  async doGenerate() {
    return {
      content: [{ type: "text", text: "了解" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 100, noCache: 70, cacheRead: 30, cacheWrite: 5 },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
      ...(meta ? { providerMetadata: { [XAI_PROVIDER_META]: { notionalUsd: 1.25 } } } : {}),
    }
  },
  async doStream() {
    throw new Error("この検査では使わない")
  },
})

const OPTS = {
  prompt: [{ role: "user", content: [{ type: "text", text: "検査" }] }],
} as unknown as Parameters<LanguageModelV4["doGenerate"]>[0]

test("成功応答は ledger に turn として記帳される(in_tok は noCache)", async () => {
  const result = await wrapLanguageModel({ model: okModel(true), middleware: governance() }).doGenerate(OPTS)
  assert.deepEqual(result.content, [{ type: "text", text: "了解" }])

  const rows = await run(
    Effect.flatMap(Db, (db) =>
      db.all("SELECT kind, role, model, in_tok, out_tok, cache_read, cache_write, provenance FROM ledger"),
    ),
  )
  assert.equal(rows.length, 1)
  const row = rows[0] as Record<string, unknown>
  assert.equal(row.kind, "turn")
  assert.equal(row.role, "dialogue")
  assert.equal(row.model, "grok-4.3")
  assert.equal(row.in_tok, 70)
  assert.equal(row.out_tok, 10)
  assert.equal(row.cache_read, 30)
  assert.equal(row.cache_write, 5)
  const prov = JSON.parse(String(row.provenance)) as Record<string, unknown>
  assert.equal(prov.pool, "supergrok-oauth")
  assert.equal(prov.via, "agent")
  assert.equal(prov.notionalUsd, 1.25)
})

test("providerMetadata の無い応答は notionalUsd 0 で記帳される", async () => {
  await wrapLanguageModel({ model: okModel(false), middleware: governance() }).doGenerate(OPTS)
  const rows = await run(Effect.flatMap(Db, (db) => db.all("SELECT provenance FROM ledger ORDER BY seq")))
  assert.equal(rows.length, 2)
  const prov = JSON.parse(String((rows[1] as Record<string, unknown>).provenance)) as Record<string, unknown>
  assert.equal(prov.notionalUsd, 0)
})

test("governedModel は知らない id と、xai 以外の pool を組み立ての時点で拒否する", () => {
  assert.throws(() => governedModel("gpt-5.9"), /知らないモデル id/)
  // GPT は既知だが chatgpt-oauth 枠(精査役専用)。対話経路へ流すと xai 実装で呼ぶ誤配線になる。
  assert.throws(() => governedModel("gpt-5.6-sol"), /xai 系のみ/)
  assert.equal(governedModel("grok-4.3").modelId, "grok-4.3")
})

test("日次上限1で並行したprovider呼び出しは1件だけ実行する", async () => {
  await run(
    Effect.flatMap(Db, (db) =>
      Effect.all([
        db.run("DELETE FROM ledger"),
        db.run("DELETE FROM schema_meta WHERE key='governance:run-claims'"),
      ]),
    ),
  )
  process.env.FAMULUS_DAILY_RUNS = "1"
  process.env.FAMULUS_AUTONOMOUS_RUNS = "1"
  configureApp()
  let entered = 0
  const model: LanguageModelV4 = {
    ...okModel(false),
    async doGenerate() {
      entered++
      return okModel(false).doGenerate(OPTS)
    },
  }
  try {
    const wrapped = wrapLanguageModel({ model, middleware: governance() })
    const results = await Promise.allSettled([wrapped.doGenerate(OPTS), wrapped.doGenerate(OPTS)])
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
    assert.equal(entered, 1)
  } finally {
    delete process.env.FAMULUS_DAILY_RUNS
    delete process.env.FAMULUS_AUTONOMOUS_RUNS
    configureApp()
  }
})
