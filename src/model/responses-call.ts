import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider"
import type { ModelCallOptions, ModelCallResult, QuotaSignal } from "./models.ts"
import { RUNTIME_PROMPT } from "./models.ts"

/** Responses のストリームを1回ぶんの応答にまとめる。 */
export async function collectResponses(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  onText?: (delta: string) => void,
): Promise<Omit<LanguageModelV4GenerateResult, "warnings">> {
  const content: LanguageModelV4Content[] = []
  const open = new Map<string, string[]>()
  let finishReason: LanguageModelV4GenerateResult["finishReason"] = { unified: "stop", raw: undefined }
  let usage: LanguageModelV4GenerateResult["usage"] | undefined
  let providerMetadata: LanguageModelV4GenerateResult["providerMetadata"]
  let failure: unknown
  let callbackFailed = false
  let callbackFailure: unknown
  const append = (id: string, delta: string): void => {
    const chunks = open.get(id)
    if (chunks) chunks.push(delta)
    else open.set(id, [delta])
  }

  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    switch (value.type) {
      case "text-start":
      case "reasoning-start":
        open.set(value.id, [])
        break
      case "text-delta":
        append(value.id, value.delta)
        if (onText && !callbackFailed) {
          try {
            onText(value.delta)
          } catch (error) {
            callbackFailed = true
            callbackFailure = error
          }
        }
        break
      case "reasoning-delta":
        append(value.id, value.delta)
        break
      case "text-end":
        content.push({ type: "text", text: open.get(value.id)?.join("") ?? "" })
        open.delete(value.id)
        break
      case "reasoning-end":
        content.push({ type: "reasoning", text: open.get(value.id)?.join("") ?? "" })
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
  if (callbackFailed) throw callbackFailure

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

interface ResponsesCallConfig {
  readonly images: boolean
  readonly quota?: (metadata: LanguageModelV4GenerateResult["providerMetadata"]) => QuotaSignal | undefined
}

export async function callResponses(
  model: LanguageModelV4,
  opts: ModelCallOptions,
  config: ResponsesCallConfig,
): Promise<ModelCallResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000)
  const abort = () => controller.abort(opts.signal?.reason)
  if (opts.signal?.aborted) abort()
  else opts.signal?.addEventListener("abort", abort, { once: true })

  try {
    const { stream } = await model.doStream({
      prompt: [
        { role: "system", content: opts.systemPrompt ?? RUNTIME_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: opts.prompt },
            ...(config.images
              ? (opts.images ?? []).map((image) => ({
                  type: "file" as const,
                  data: { type: "data" as const, data: image.data },
                  mediaType: image.mediaType,
                }))
              : []),
          ],
        },
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
    const gen = await collectResponses(stream, opts.onText)
    const text = gen.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    const usage = gen.usage
    const quota = config.quota?.(gen.providerMetadata)

    return {
      text,
      ...(opts.jsonSchema !== undefined ? { structured: parseStructured(text) } : {}),
      usage: {
        inTok: usage.inputTokens.noCache ?? 0,
        outTok: usage.outputTokens.total ?? 0,
        cacheRead: usage.inputTokens.cacheRead ?? 0,
        cacheWrite: usage.inputTokens.cacheWrite ?? 0,
        notionalUsd: 0,
      },
      ...(quota ? { quota } : {}),
      model: opts.model,
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", abort)
  }
}

const parseStructured = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
