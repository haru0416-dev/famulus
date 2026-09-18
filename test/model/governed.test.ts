/**
 * 失敗→cooldown の連鎖が切れると、枯渇後も 429 を受け続けて週次プールを使い切る。
 * run() は初回呼び出しで設定を読むので、その前に DB を :memory: へ向ける。
 */

import assert from "node:assert/strict"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import { wrapLanguageModel } from "ai"
import * as Effect from "effect/Effect"
import { beforeAll, test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { governance } from "../../src/model/governed.ts"
import { ModelCallError, XAI_POOL } from "../../src/model/models.ts"
import { run } from "../../src/runtime.ts"
import { Db } from "../../src/services/Db.ts"

beforeAll(() => {
  process.env.FAMULUS_DB = ":memory:"
  configureApp()
})

const exhaustedModel: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "grok-4.3",
  supportedUrls: {},
  async doGenerate() {
    throw new ModelCallError("HTTP 429 credits exhausted(検査)", {
      pool: XAI_POOL,
      window: "week",
      exhausted: true,
    })
  },
  async doStream() {
    throw new Error("この検査では使わない")
  },
}

const OPTS = {
  prompt: [{ role: "user", content: [{ type: "text", text: "検査" }] }],
} as unknown as Parameters<LanguageModelV4["doGenerate"]>[0]

test("quota 付きの失敗は記録され、次の呼び出しは cooldown で拒否される", async () => {
  const wrapped = wrapLanguageModel({ model: exhaustedModel, middleware: governance() })

  await assert.rejects(async () => void (await wrapped.doGenerate(OPTS)), /credits exhausted/)

  await assert.rejects(async () => void (await wrapped.doGenerate(OPTS)), /クールダウン中/)

  // 2回目は gate で止まるので ledger に残らない。
  const rows = await run(Effect.flatMap(Db, (db) => db.all("SELECT kind, provenance FROM ledger")))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.kind, "model-failed")
  assert.equal(JSON.parse(String(rows[0]?.provenance)).outcome, "failed")
})

test("stream 経路は統治を通らないので塞がっている", async () => {
  const wrapped = wrapLanguageModel({ model: exhaustedModel, middleware: governance() })
  await assert.rejects(async () => void (await wrapped.doStream(OPTS)), /stream 経路は統治/)
})
