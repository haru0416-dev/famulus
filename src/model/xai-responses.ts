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
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider"
import {
  ModelCallError,
  type ModelCallOptions,
  type ModelCallResult,
  type QuotaSignal,
  RUNTIME_PROMPT,
  XAI_POOL,
} from "./models.ts"
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
): QuotaSignal | undefined {
  if (status === 429 || CREDIT_EXHAUSTED.test(message)) {
    return { pool: XAI_POOL, window: "week", exhausted: true }
  }
  if (status === 403 && ENTITLEMENT_BLOCKED.test(message)) {
    return {
      pool: XAI_POOL,
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
async function collect(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<Omit<LanguageModelV4GenerateResult, "warnings">> {
  const content: LanguageModelV4Content[] = []
  const open = new Map<string, string>()
  let finishReason: LanguageModelV4GenerateResult["finishReason"] = { unified: "stop", raw: undefined }
  let usage: LanguageModelV4GenerateResult["usage"] | undefined
  let providerMetadata: LanguageModelV4GenerateResult["providerMetadata"]
  let failure: unknown

  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    switch (value.type) {
      case "text-start":
      case "reasoning-start":
        open.set(value.id, "")
        break
      case "text-delta":
      case "reasoning-delta":
        open.set(value.id, (open.get(value.id) ?? "") + value.delta)
        break
      case "text-end":
        content.push({ type: "text", text: open.get(value.id) ?? "" })
        open.delete(value.id)
        break
      case "reasoning-end":
        content.push({ type: "reasoning", text: open.get(value.id) ?? "" })
        open.delete(value.id)
        break
      case "tool-call":
      case "tool-result":
      case "source":
      case "file":
        content.push(value)
        break
      case "finish":
        finishReason = value.finishReason
        usage = value.usage
        providerMetadata = value.providerMetadata
        break
      case "error":
        failure = value.error
        break
      default:
        break
    }
  }
  if (failure !== undefined) throw failure

  return {
    content,
    finishReason,
    usage: usage ?? {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: undefined },
    },
    ...(providerMetadata ? { providerMetadata } : {}),
  }
}

/** 上流の失敗を、統治が読める型に変換する。枯渇・誤ブロックだけクォータシグナルを付ける。 */
function toXaiError(e: unknown): ModelCallError {
  if (e instanceof ModelCallError) return e
  const status = (e as { statusCode?: number })?.statusCode
  const message = e instanceof Error ? e.message : String(e)
  const quota = classifyXaiFailure(status, message, Date.now())
  return new ModelCallError(`xai: ${message}`, quota)
}

/**
 * xAI の Responses を1つの V4 モデルとして返す。統治は適用されていない —
 * ゲートと会計は src/model/governed.ts の middleware が外側で適用する。これを直接使わない。
 */
export function xaiResponsesModel(modelId: string): LanguageModelV4 {
  const provider = createOpenAI({
    baseURL: XAI_BASE_URL,
    // 認証は fetch 側で付ける。静的な文字列では refresh 後のトークンを反映できない。
    apiKey: "unused",
    fetch: (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
      const h = new Headers(init?.headers)
      h.set("authorization", `Bearer ${await loadXaiAccess()}`)
      return fetch(input, { ...init, headers: h })
    }) as unknown as typeof fetch,
  })

  /**
   * `store: false` は契約枠の必須指定。`strictJsonSchema` を false にするのは、strict が
   * 全ての object に `additionalProperties: false` と全欄 `required` を要求するため —
   * open-zero のスキーマは valibot 生成で任意欄を持つので、そのままでは 400 で拒否される。
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
        const gen = await collect(stream)
        return { ...gen, warnings: [], providerMetadata: withMeta(gen.providerMetadata) }
      } catch (e) {
        throw toXaiError(e)
      }
    },

    async doStream(options) {
      let result: Awaited<ReturnType<LanguageModelV4["doStream"]>>
      try {
        result = await inner.doStream(prepare(options))
      } catch (e) {
        throw toXaiError(e)
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
export async function callXai(opts: ModelCallOptions): Promise<ModelCallResult> {
  const model = xaiResponsesModel(opts.model)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000)
  opts.signal?.addEventListener("abort", () => controller.abort(), { once: true })

  try {
    const { stream } = await model.doStream({
      prompt: [
        { role: "system", content: opts.systemPrompt ?? RUNTIME_PROMPT },
        { role: "user", content: [{ type: "text", text: opts.prompt }] },
      ],
      abortSignal: controller.signal,
      ...(opts.jsonSchema !== undefined
        ? {
            responseFormat: {
              type: "json" as const,
              name: "reply",
              schema: opts.jsonSchema as Record<string, unknown>,
            },
          }
        : {}),
    })

    const [a, b] = stream.tee()
    const relay = (async () => {
      if (!opts.onText) return
      const reader = a.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.type === "text-delta") opts.onText(value.delta)
      }
    })()
    if (!opts.onText) void a.cancel()
    const gen = await collect(b)
    await relay

    const text = gen.content.map((c) => (c.type === "text" ? c.text : "")).join("")
    const u = gen.usage

    return {
      text,
      ...(opts.jsonSchema !== undefined ? { structured: parseStructured(text) } : {}),
      usage: {
        inTok: u.inputTokens.noCache ?? 0,
        outTok: u.outputTokens.total ?? 0,
        cacheRead: u.inputTokens.cacheRead ?? 0,
        cacheWrite: u.inputTokens.cacheWrite ?? 0,
        notionalUsd: 0,
      },
      model: opts.model,
    }
  } catch (e) {
    throw toXaiError(e)
  } finally {
    clearTimeout(timer)
  }
}

const parseStructured = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
