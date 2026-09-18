/**
 * SuperGrok OAuth のトークン(src/model/xai-auth.ts)で `api.x.ai/v1` の Responses API を直接呼ぶ。
 * `store` は false(契約枠の必須指定)。応答ヘッダも billing API も残量を返さないので、
 * クォータシグナルは失敗の分類からだけ作る(classifyXaiFailure)。
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

/** 統治の middleware がここからクォータシグナルを読む。 */
export const XAI_PROVIDER_META = "supergrok-oauth"

/** 契約枠の枯渇を示すエラー文。上流はヘッダでなくエラー文でしか枯渇を伝えない。 */
const CREDIT_EXHAUSTED =
  /\b(?:used all available credits|run out of credits|monthly spending limit|purchase more credits|raise your spending limit|need a Grok subscription)\b/i

/** entitlement backend の誤ブロック(403)。数時間で復旧するので、枯渇より短く避ける。 */
const ENTITLEMENT_BLOCKED = /\b(?:team.?blocked|entitlement|spending.?limit)\b/i
const ENTITLEMENT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * 分類できない失敗は undefined(クールダウンを掛けない)。週次リセットの時刻は API から読めないので、
 * 枯渇は resetsAtMs を持たず Governance の既定で避ける。
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

/** ストリーム中の失敗はそのまま外へ出し、呼び出し側の catch が toXaiError で変換する。 */
export { collectResponses as collect }

/** 枯渇・誤ブロックだけクォータシグナルを付ける。 */
function toXaiError(e: unknown, pool: string): ModelCallError {
  if (e instanceof ModelCallError) return e
  const status = (e as { statusCode?: number })?.statusCode
  const message = e instanceof Error ? e.message : String(e)
  const quota = classifyXaiFailure(status, message, Date.now(), pool)
  return new ModelCallError(`xai: ${message}`, quota)
}

export interface XaiModelOptions {
  /**
   * 未指定は API 既定。AI SDK は grok の model 名では `providerOptions.openai.reasoningEffort` を
   * 黙って落とすので、送信本文へ直接入れる。
   */
  readonly reasoningEffort?: "low" | "medium" | "high"
}

/** 統治は適用されていない(ゲートと会計は src/model/governed.ts の middleware が外側で適用する)。直接使わない。 */
export function xaiResponsesModel(modelId: string, xaiOpts: XaiModelOptions = {}): LanguageModelV4 {
  const pool = poolForModel(modelId)
  const provider = createOpenAI({
    baseURL: XAI_BASE_URL,
    // 認証は fetch で付ける。静的な文字列では refresh 後のトークンを反映できない。
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
   * strict は全 object に `additionalProperties: false` と全欄 `required` を要求し、任意欄を持つ
   * valibot 生成のスキーマが 400 になるので `strictJsonSchema` は false。構造は schema.validate で保証する。
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

/** Runner 用。道具ループを持たないので、prompt 1つと任意の JSON Schema だけを渡す。 */
export async function callXai(opts: ModelCallOptions) {
  const pool = poolForModel(opts.model)
  try {
    return await callResponses(xaiResponsesModel(opts.model), opts, { images: true })
  } catch (e) {
    throw toXaiError(e, pool)
  }
}
