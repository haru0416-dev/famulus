/**
 * モデル呼び出しに利用制限と会計を適用する層。モデルの実体とは別に置く。
 *
 * 掛けるのは3つ:
 *   1. 呼ぶ前の検査(halt / クォータ抑止 / 日次 run 数)
 *   2. クォータ状態の更新(リセット前に再試行しないため)
 *   3. 会計(ledger。日次 run 数の上限がこれを数える)
 *
 * フックではなく middleware に置く。道具ループは1回の submission で何度も
 * モデルを呼ぶので、「開始時に1回」の位置に置くと検査は最初の1回きりになる。
 * クォータを実際に消費するのは1回1回の呼び出しなので、事前検査を通さずにモデルへ届く経路を作らないには
 * `wrapGenerate` の位置しかない。
 *
 * src/model/Runner.ts が同じ順序(precheck → 実行 → クォータ状態更新 → 会計)を Effect で持っている。
 * こちらは AI SDK の道具ループから呼ばれる側で、同じ DB の同じ表に載る。
 */

import type { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider"
import { wrapLanguageModel } from "ai"
import * as Effect from "effect/Effect"
import { describeRefusal } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { isRefusal, run } from "../runtime.ts"
import { accountingRole, currentLane, Governance } from "../services/Governance.ts"
import { Ledger } from "../services/Ledger.ts"
import { assertKnownModel, ModelCallError, poolForModel, type QuotaSignal } from "./models.ts"
import { traceOf } from "./trace.ts"
import { XAI_PROVIDER_META, xaiResponsesModel } from "./xai-responses.ts"

/** 呼ぶ前の検査。拒否は Error にして投げる — 道具ループの外まで理由付きで出る。 */
async function gate(model: string): Promise<void> {
  const refusal = await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      yield* gov.precheck({
        // production modelは全て同じ永続クォータ集計単位に載る。
        pool: poolForModel(model),
        at: nowIso(),
        nowMs: Date.now(),
        lane: currentLane(),
      })
      return undefined
    }).pipe(Effect.catch((e) => Effect.succeed(e))),
  )
  if (refusal === undefined) return
  throw new Error(isRefusal(refusal) ? describeRefusal(refusal) : `${refusal._tag}: ${refusal.message}`)
}

/**
 * 会計とクォータ状態の更新。この経路と Runner 経路が同じ DB に載るようにしてある。
 * ここを飛ばすと ledger が空のままになり、日次 run 数の上限(ledger を数える)を適用できない。
 * 記録できない応答を成功扱いにすると上限と監査が欠けるため、記録失敗は呼び出し失敗にする。
 */
async function account(
  model: string,
  usage: { inTok: number; outTok: number; cacheRead: number; cacheWrite: number },
  text: string,
  notionalUsd: number,
): Promise<void> {
  const at = nowIso()
  await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      const ledger = yield* Ledger
      yield* ledger.record({
        kind: "turn",
        role: accountingRole("dialogue"),
        model,
        usage,
        summary: traceOf(text),
        provenance: { pool: poolForModel(model), notionalUsd, via: "agent" },
        at,
      })
    }),
  )
}

/** 失敗してもクォータシグナルが取れていれば、リセット時刻まで再実行を抑止する。 */
async function noteFailure(model: string, e: unknown): Promise<void> {
  const at = nowIso()
  await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      const ledger = yield* Ledger
      if (e instanceof ModelCallError && e.quota) yield* gov.noteQuota(e.quota, at, Date.now())
      yield* ledger.record({
        kind: "model-failed",
        role: accountingRole("dialogue"),
        model,
        usage: { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 },
        summary: traceOf(e instanceof Error ? e.message : String(e)),
        provenance: { pool: poolForModel(model), outcome: "failed", via: "agent" },
        at,
      })
    }),
  )
}

/** AI SDK Agent 経路で、モデル呼び出しごとに事前検査 → 実行 → クォータ状態更新 → 会計を行う。 */
export function governance(): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    /**
     * 流し込み経路は塞ぐ。統治を掛けてあるのは `wrapGenerate` だけなので、ここを素通しにすると
     * 事前検査も会計も通らないままモデルへ届く(xai の `doStream` は実 HTTP でクォータが減る)。
     * エージェント経路は generate しか使わない(実走で確認済み)。使う側が要るようになったら、
     * ここに gate → 実行 → account を書いてから開ける。
     */
    async wrapStream() {
      throw new Error("stream 経路は統治(事前検査・会計)を通らない。generate を使う")
    },
    async wrapGenerate({ doGenerate, model }) {
      await gate(model.modelId)
      let result: Awaited<ReturnType<typeof doGenerate>>
      try {
        result = await doGenerate()
      } catch (e) {
        await noteFailure(model.modelId, e)
        throw e
      }
      const meta = result.providerMetadata?.[XAI_PROVIDER_META]
      const u = result.usage
      await account(
        model.modelId,
        {
          inTok: u.inputTokens.noCache ?? 0,
          outTok: u.outputTokens.total ?? 0,
          cacheRead: u.inputTokens.cacheRead ?? 0,
          cacheWrite: u.inputTokens.cacheWrite ?? 0,
        },
        result.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
        typeof meta?.notionalUsd === "number" ? meta.notionalUsd : 0,
      )
      return result
    },
  }
}

/**
 * 統治つきのモデル。エージェントに差すのはこれだけ。
 * 素の `xaiResponsesModel` を直接使う経路を作らない —
 * 事前検査を通らずにクォータが減る。
 *
 * 知らない id はここで失敗させる。呼ばれるのはエージェントを生成するときなので、env の打ち間違いは
 * 起動時に読める理由で止まる(実行を開始してから上流の 4xx で失敗しない)。
 */
export function governedModel(modelId: string): LanguageModelV4 {
  assertKnownModel(modelId)
  return wrapLanguageModel({ model: xaiResponsesModel(modelId), middleware: governance() })
}
