/**
 * xAI(Grok)経路の実装。SuperGrok OAuth のトークン(src/model/xai-auth.ts)で
 * `api.x.ai/v1` の Responses API を直接呼ぶ。`store` は false(契約枠の必須指定)。
 *
 * 残量の扱い(実測 2026-08-17):
 *  - 応答ヘッダに使用率が入らない。billing API も残量を返さない
 *    (読めるのは追加クレジットの台帳だけ)。残量は unknown が既定で、
 *    クォータシグナルは**失敗の分類からだけ**作る(classifyXaiFailure)。
 *  - entitlement の誤ブロック(数時間で復旧する 403)がある。枯渇と同じ長さで避けると
 *    必要以上に止まるので、短いクールダウンに分類する。
 */

import { createOpenAI } from "@ai-sdk/openai"
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider"
import { ModelCallError, type ModelCallOptions, poolForModel, type QuotaSignal, XAI_POOL } from "./models.ts"
import { callResponses, collectResponses } from "./responses-call.ts"
import { loadXaiAccess } from "./xai-auth.ts"

export const XAI_BASE_URL = "https://api.x.ai/v1"

/** `providerMetadata` の鍵。統治の middleware がここからクォータシグナルを読む。 */
export const XAI_PROVIDER_META = "supergrok-oauth"

/**
 * 契約枠の枯渇を示すエラー文。OpenClaw の xai extension が同じ分類に使っている表現の一覧
 * (上流はヘッダでなくエラー文でしか枯渇を伝えない)。
 */
const CREDIT_EXHAUSTED =
  /\b(?:used all available credits|run out of credits|monthly spending limit|purchase more credits|raise your spending limit|need a Grok subscription)\b/i

/** entitlement backend の誤ブロック。実測では数時間で復旧するので、枯渇より短く避ける。 */
const ENTITLEMENT_BLOCKED = /\b(?:team.?blocked|entitlement|spending.?limit)\b/i
const ENTITLEMENT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * 失敗をクォータシグナルへ分類する。分類できない失敗は undefined(クールダウンを掛けない)。
 * 枯渇は resetsAtMs を持たない — 週次リセットの時刻は API から読めないので、
 * Governance の既定(1時間)で避けて様子を見る。
 */
export function classifyXaiFailure(
  status: number | undefined,
  message: string,
  nowMs: number,
  pool: string = XAI_POOL,
): QuotaSignal | undefined {
  if (status === 429 || CREDIT_EXHAUSTED.test(message)) {
    return { pool, window: "week", exhausted: true }
  }
  if (status === 403 && ENTITLEMENT_BLOCKED.test(message)) {
    return {
      pool,
      window: "entitlement",
      exhausted: true,
      resetsAtMs: nowMs + ENTITLEMENT_COOLDOWN_MS,
    }
  }
  return undefined
}

/**
 * doStream の出力を1回ぶんの応答にまとめる。doGenerate と構造化呼び出しはこれで作る。
 * ストリーム中の失敗は素のまま投げ、呼び出し側の catch が toXaiError で変換する。
 */
export { collectResponses as collect }

/** 上流の失敗を、統治が読める型に変換する。枯渇・誤ブロックだけクォータシグナルを付ける。 */
function toXaiError(e: unknown, pool: string): ModelCallError {
  if (e instanceof ModelCallError) return e
  const status = (e as { statusCode?: number })?.statusCode
  const message = e instanceof Error ? e.message : String(e)
  const quota = classifyXaiFailure(status, message, Date.now(), pool)
  return new ModelCallError(`xai: ${message}`, quota)
}

export interface XaiModelOptions {
  /**
   * Responses の reasoning.effort。未指定は API 既定(モデル任せ)。
   * AI SDK は grok の model 名では `providerOptions.openai.reasoningEffort` を黙って落とす
   * (o系/gpt-5系の名前でしか効かせない)ため、送信本文へ直接入れる。
   * 実測(2026-08-18、grok-4.6・同一入力): 既定 164〜223秒(推論 10.4k〜12.8k tok)、
   * low 12〜20秒(同 0.6k〜0.9k)、medium 107秒(同 6.0k)。いずれも HTTP 200 で受理。
   */
  readonly reasoningEffort?: "low" | "medium" | "high"
}

/**
 * xAI の Responses を1つの V4 モデルとして返す。統治は適用されていない —
 * ゲートと会計は src/model/governed.ts の middleware が外側で適用する。これを直接使わない。
 */
export function xaiResponsesModel(modelId: string, xaiOpts: XaiModelOptions = {}): LanguageModelV4 {
  const pool = poolForModel(modelId)
  const provider = createOpenAI({
    baseURL: XAI_BASE_URL,
    // 認証は fetch 側で付ける。静的な文字列では refresh 後のトークンを反映できない。
    apiKey: "unused",
    fetch: (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
      const h = new Headers(init?.headers)
      h.set("authorization", `Bearer ${await loadXaiAccess()}`)
      let body = init?.body
      if (xaiOpts.reasoningEffort !== undefined && typeof body === "string" && body.startsWith("{")) {
        body = JSON.stringify({
          ...(JSON.parse(body) as Record<string, unknown>),
          reasoning: { effort: xaiOpts.reasoningEffort },
        })
      }
      return fetch(input, { ...init, ...(body !== init?.body ? { body } : {}), headers: h })
    }) as unknown as typeof fetch,
  })

  /**
   * `store: false` は契約枠の必須指定。`strictJsonSchema` を false にするのは、strict が
   * 全ての object に `additionalProperties: false` と全欄 `required` を要求するため —
   * famulus のスキーマは valibot 生成で任意欄を持つので、そのままでは 400 で拒否される。
   * 構造の保証は上流ではなく読み出し側(schema.validate)にある。
   */
  const prepare = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => ({
    ...options,
    providerOptions: {
      ...options.providerOptions,
      openai: { ...options.providerOptions?.openai, store: false, strictJsonSchema: false },
    },
  })

  /** 従量課金換算額はこの経路では扱わない(定額の週次プール)。 */
  const withMeta = (
    meta: LanguageModelV4GenerateResult["providerMetadata"],
  ): NonNullable<LanguageModelV4GenerateResult["providerMetadata"]> => ({
    ...meta,
    [XAI_PROVIDER_META]: { notionalUsd: 0 },
  })

  const inner = provider.responses(modelId)

  return {
    specificationVersion: "v4",
    provider: XAI_PROVIDER_META,
    modelId,
    supportedUrls: {},

    async doGenerate(options) {
      try {
        const { stream } = await inner.doStream(prepare(options))
        const gen = await collectResponses(stream)
        return { ...gen, warnings: [], providerMetadata: withMeta(gen.providerMetadata) }
      } catch (e) {
        throw toXaiError(e, pool)
      }
    },

    async doStream(options) {
      let result: Awaited<ReturnType<LanguageModelV4["doStream"]>>
      try {
        result = await inner.doStream(prepare(options))
      } catch (e) {
        throw toXaiError(e, pool)
      }
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, ctrl) {
              ctrl.enqueue(
                part.type === "finish"
                  ? { ...part, providerMetadata: withMeta(part.providerMetadata) }
                  : part,
              )
            },
          }),
        ),
      }
    },
  }
}

/**
 * xAIを1回呼ぶ構造化処理の入口。src/model/Runner.tsが使う。
 * そちらは道具ループを持たないので、prompt 1つと任意の JSON Schema だけを渡す。
 */
export async function callXai(opts: ModelCallOptions) {
  const pool = poolForModel(opts.model)
  try {
    return await callResponses(xaiResponsesModel(opts.model), opts, { images: true })
  } catch (e) {
    throw toXaiError(e, pool)
  }
}
