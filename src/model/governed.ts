/**
 * モデル呼び出しに利用制限と会計を適用する middleware。道具ループは1回の submission で何度もモデルを呼ぶので、
 * 全呼び出しが事前検査を通る位置は `wrapGenerate` しかない。src/model/Runner.ts と同じ順序で、同じ DB の表に載る。
 */

import type { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider"
import { wrapLanguageModel } from "ai"
import * as Effect from "effect/Effect"
import { describeRefusal } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { isRefusal, run } from "../runtime.ts"
import { accountingRole, currentLane, Governance, type Lane } from "../services/Governance.ts"
import { Ledger } from "../services/Ledger.ts"
import { assertKnownModel, ModelCallError, poolForModel, providerForModel } from "./models.ts"
import { traceOf } from "./trace.ts"
import { XAI_PROVIDER_META, type XaiModelOptions, xaiResponsesModel } from "./xai-responses.ts"

/** 拒否は理由付きの Error にして、道具ループの外まで出す。 */
async function gate(model: string): Promise<{ readonly at: string; readonly lane: Lane }> {
  try {
    return await run(
      Effect.gen(function* () {
        const gov = yield* Governance
        const lane = currentLane()
        yield* gov.precheck({
          // production model は全て同じ永続クォータ集計単位に載る。
          pool: poolForModel(model),
          at: nowIso(),
          nowMs: Date.now(),
          lane,
        })
        return { at: yield* gov.claimRun({ lane }), lane }
      }),
    )
  } catch (refusal) {
    if (isRefusal(refusal)) throw new Error(describeRefusal(refusal))
    const tag = typeof refusal === "object" && refusal !== null && "_tag" in refusal ? refusal._tag : "Error"
    const message = refusal instanceof Error ? refusal.message : String(refusal)
    throw new Error(`${String(tag)}: ${message}`)
  }
}

/**
 * 飛ばすと ledger が空になり、日次 run 数の上限を適用できない。記録できない応答を成功扱いにすると
 * 上限と監査が欠けるので、記録失敗は呼び出し失敗にする。
 */
async function account(
  model: string,
  usage: { inTok: number; outTok: number; cacheRead: number; cacheWrite: number },
  text: string,
  notionalUsd: number,
  at: string,
  lane: Lane,
): Promise<void> {
  await run(
    Effect.gen(function* () {
      const ledger = yield* Ledger
      yield* ledger.record({
        kind: "turn",
        role: accountingRole("dialogue", lane),
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
async function noteFailure(model: string, e: unknown, at: string, lane: Lane): Promise<void> {
  await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      const ledger = yield* Ledger
      if (e instanceof ModelCallError && e.quota) yield* gov.noteQuota(e.quota, at, Date.now())
      yield* ledger.record({
        kind: "model-failed",
        role: accountingRole("dialogue", lane),
        model,
        usage: { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 },
        summary: traceOf(e instanceof Error ? e.message : String(e)),
        provenance: { pool: poolForModel(model), outcome: "failed", via: "agent" },
        at,
      })
    }),
  )
}

export function governance(): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    /**
     * 検査と会計は `wrapGenerate` にしか無いので、ストリーム経路は拒否する(通すと検査も会計も無しにクォータが減る)。
     * 開けるときは先に gate → 実行 → account を書く。
     */
    async wrapStream() {
      throw new Error("stream 経路は統治(事前検査・会計)を通らない。generate を使う")
    },
    async wrapGenerate({ doGenerate, model }) {
      const claim = await gate(model.modelId)
      let result: Awaited<ReturnType<typeof doGenerate>>
      try {
        result = await doGenerate()
      } catch (e) {
        await noteFailure(model.modelId, e, claim.at, claim.lane)
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
        claim.at,
        claim.lane,
      )
      return result
    },
  }
}

/** 素の `xaiResponsesModel` を直接使う経路を作らない。知らない id はエージェント生成時にここで失敗させる。 */
export function governedModel(modelId: string, xaiOpts?: XaiModelOptions): LanguageModelV4 {
  assertKnownModel(modelId)
  // 道具ループは xai 経路のみ。GPT を通すと xai の実装で GPT を呼ぶ誤配線になる。
  if (providerForModel(modelId) !== "xai") {
    throw new ModelCallError(`対話経路で使えるのは xai 系のみ: ${modelId}`)
  }
  return wrapLanguageModel({ model: xaiResponsesModel(modelId, xaiOpts), middleware: governance() })
}
