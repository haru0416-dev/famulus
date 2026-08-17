/**
 * governance middleware(src/model/governed.ts)の検査。モデルは呼ばない。
 * 固定するのは失敗→cooldown の連鎖: quota 付きの失敗が noteFailure で記録され、
 * **次の**呼び出しが gate の precheck で拒否されること。ここが切れると枯渇後も
 * 429 を叩き続けて週次プールを浪費する(クォータ検出は失敗分類だけが頼り)。
 *
 * governed の run() はプロセス共通の runtime を遅延生成し、生成時に設定を読む。
 * vitest はファイルごとに別プロセスなので、最初の呼び出しの前に DB を :memory: へ向ける。
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

/** doGenerate が枯渇シグナル付きで落ちる素体。 */
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

  // 1回目: gate は通り、失敗がそのまま外へ出る(握り潰さない)。
  await assert.rejects(async () => void (await wrapped.doGenerate(OPTS)), /credits exhausted/)

  // 2回目: noteFailure が置いた cooldown を gate が読み、モデルに触れる前に拒否する。
  await assert.rejects(async () => void (await wrapped.doGenerate(OPTS)), /クールダウン中/)

  // 失敗は ledger に1行だけ(2回目は gate 止まりで記録されない)。
  const rows = await run(Effect.flatMap(Db, (db) => db.all("SELECT kind, provenance FROM ledger")))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.kind, "model-failed")
  assert.equal(JSON.parse(String(rows[0]?.provenance)).outcome, "failed")
})

test("stream 経路は統治を通らないので塞がっている", async () => {
  const wrapped = wrapLanguageModel({ model: exhaustedModel, middleware: governance() })
  await assert.rejects(async () => void (await wrapped.doStream(OPTS)), /stream 経路は統治/)
})
