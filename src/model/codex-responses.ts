/**
 * GPT 経路の実装。`~/.codex/auth.json` の OAuth トークンで Codex の Responses API を直接呼ぶ。
 *
 * 前の実装は rmod(`claude` の CLI インターフェースのまま中身を差し替えるローカルプロキシ)を
 * 子プロセスとして起動していた。認証はそのときから同じ Codex の OAuth で、変わったのは経路だけ —
 * bash → bun → ローカルプロキシ → `claude` の4段が無くなり、HTTP リクエスト1回になる。
 *
 * 経路を変えて解消するもの:
 *  - 入力トークン。`claude` のシステムプロンプトが付かない(最小の1問で実測 186 → 27 tok)。
 *  - 道具呼び出し。Responses はツール呼び出しをそのまま返すので、language-model.ts の
 *    「構造化出力として提出させて変換し、拒否されたら取り直す」処理は GPT 側では不要。
 *  - クォータ。応答ヘッダに使用率とリセット時刻が入る(下の `quotaFromHeaders`)。
 *    rmod 経由では `{status:"allowed"}` しか来ず、Governance の使用率によるクールダウンは
 *    GPT 側で一度も適用されなかった。動いていたのは 429 を受けた後の抑止だけ。
 *
 * 上流の制約。どちらも外すと 400 で拒否される:
 *  - `store` は false。
 *  - `stream` は true。**非ストリームの `doGenerate` は使えない**ので、
 *    ここでは doStream の出力をまとめて doGenerate を作る(`collect`)。
 */

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createOpenAI } from "@ai-sdk/openai"
import type {
  JSONObject,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4ProviderTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider"
import {
  baseModel,
  CODEX_POOL,
  isWebModel,
  ModelCallError,
  type ModelCallOptions,
  type ModelCallResult,
  type QuotaSignal,
  RUNTIME_PROMPT,
  stripCitationMarkers,
} from "./models.ts"

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"

/** `providerMetadata` の鍵。統治の middleware がここからクォータシグナルを読む。 */
export const CODEX_PROVIDER_META = "codex-oauth"

/**
 * Codex CLI が送る originator。これを外すとバックエンドが受け付けない。
 * 版番号は資格情報の生成元(`codex login` を実行した CLI)に合わせてある。
 */
const CODEX_USER_AGENT = `codex_cli_rs/0.144.6 (${process.platform}; ${process.arch}) open-zero`

/** 資格情報のファイルパス。`CODEX_HOME` は Codex CLI 自身が読む変数なので、同じものを読む。 */
const authPath = (): string =>
  process.env.OPEN_ZERO_CODEX_AUTH ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")

interface CodexAuth {
  readonly accessToken: string
  readonly accountId?: string
  readonly refreshToken?: string
  /** OAuth の client id。欄としては保存されておらず、id_token の `aud` にだけ入っている。 */
  readonly clientId?: string
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined)

/** JWT の payload を検証せずに読む。公開クレーム(`aud`)を1つ取るだけ。 */
function jwtAud(token: string | undefined): string | undefined {
  const part = token?.split(".")[1]
  if (!part) return undefined
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { aud?: unknown }
    return Array.isArray(payload.aud) ? str(payload.aud[0]) : str(payload.aud)
  } catch {
    return undefined
  }
}

export function parseCodexAuth(contents: string): CodexAuth {
  let root: Record<string, unknown>
  try {
    root = JSON.parse(contents) as Record<string, unknown>
  } catch {
    throw new ModelCallError("~/.codex/auth.json を JSON として読めない")
  }
  const tokens = (root.tokens ?? {}) as Record<string, unknown>
  const accessToken = str(tokens.access_token) ?? str(tokens.id_token)
  if (!accessToken) {
    // API キーは受け付けない。定額クォータで実行するのが目的で、API キーを使うと従量課金になる。
    throw new ModelCallError("~/.codex/auth.json に ChatGPT のトークンが無い(`codex login` を通す)")
  }
  const accountId = str(tokens.account_id)
  const refreshToken = str(tokens.refresh_token)
  const clientId = jwtAud(str(tokens.id_token))
  return {
    accessToken,
    ...(accountId ? { accountId } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(clientId ? { clientId } : {}),
  }
}

function readAuth(): CodexAuth {
  const p = authPath()
  if (!existsSync(p)) {
    throw new ModelCallError(`${p} が無い(\`codex login\` を通す)`)
  }
  return parseCodexAuth(readFileSync(p, "utf8"))
}

/**
 * 更新したトークンを `~/.codex/auth.json` へ書き戻す。
 * 書かないと、次に起動したプロセスが古いトークンで 401 を受け直す。tick は15分ごとに
 * 別プロセスとして起動するので、書かない場合は毎回1往復ぶん余分に掛かる。
 * 他の欄(`OPENAI_API_KEY` など)は読み込んだまま残す — この経路が管理する値ではない。
 */
function persistTokens(next: { accessToken: string; idToken?: string; refreshToken?: string }): void {
  const p = authPath()
  try {
    const root = JSON.parse(existsSync(p) ? readFileSync(p, "utf8") : "{}") as Record<string, unknown>
    const tokens = ((root.tokens as Record<string, unknown>) ?? {}) as Record<string, unknown>
    tokens.access_token = next.accessToken
    if (next.idToken) tokens.id_token = next.idToken
    if (next.refreshToken) tokens.refresh_token = next.refreshToken
    root.tokens = tokens
    root.last_refresh = new Date().toISOString()
    writeFileSync(p, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  } catch {
    // 書けなくても今回の呼び出しは成立する。次のプロセスが 401 を1回受けるだけ。
  }
}

/** 同じプロセスで 401 が同時に起きたときに、更新要求を1回にまとめる。 */
let refreshInFlight: Promise<string> | undefined

async function refreshAccessToken(auth: CodexAuth): Promise<string> {
  if (!auth.refreshToken || !auth.clientId) {
    throw new ModelCallError(
      "Codex のトークンが期限切れで、更新に要る refresh_token が無い(`codex login` を通す)",
    )
  }
  refreshInFlight ??= (async () => {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        client_id: auth.clientId,
      }),
    })
    const body = await res.text()
    if (!res.ok) {
      throw new ModelCallError(`Codex のトークン更新が ${res.status} で失敗: ${body.slice(0, 200)}`)
    }
    const parsed = JSON.parse(body) as Record<string, unknown>
    const accessToken = str(parsed.access_token) ?? str(parsed.id_token)
    if (!accessToken) {
      throw new ModelCallError("Codex のトークン更新の応答に access_token が無い")
    }
    const idToken = str(parsed.id_token)
    const nextRefresh = str(parsed.refresh_token)
    persistTokens({
      accessToken,
      ...(idToken ? { idToken } : {}),
      ...(nextRefresh ? { refreshToken: nextRefresh } : {}),
    })
    return accessToken
  })().finally(() => {
    refreshInFlight = undefined
  })
  return refreshInFlight
}

/**
 * 応答ヘッダ → クォータシグナル。
 *
 * `x-codex-primary-*` が主クォータ(実測で7日窓 = 1万分)、`x-codex-secondary-*` が短い窓。
 * Governance は pool ごとに1つしか持たないので、使用率の高いほうを渡す —
 * 先に上限へ達するのはそちらで、使用率の低いほうを渡すと上限に達していても呼び出しに行く。
 */
export function quotaFromHeaders(
  headers: Record<string, string | undefined>,
  nowMs: number,
): QuotaSignal | undefined {
  const num = (k: string): number | undefined => {
    const v = headers[k]
    if (v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const windows = (["primary", "secondary"] as const)
    .map((w) => ({
      window: headers[`x-codex-${w}-window-minutes`] ? `${headers[`x-codex-${w}-window-minutes`]}m` : w,
      usedPercent: num(`x-codex-${w}-used-percent`),
      resetsAfterSec: num(`x-codex-${w}-reset-after-seconds`),
    }))
    // 窓の長さが 0 のものはその契約で使われていない。読むと使用率 0% として選ばれてしまう。
    .filter((w) => w.usedPercent !== undefined && w.window !== "0m")
  if (windows.length === 0) return undefined
  const worst = windows.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a))
  return {
    pool: CODEX_POOL,
    window: worst.window,
    ...(worst.usedPercent !== undefined ? { usedPercent: worst.usedPercent } : {}),
    ...(worst.resetsAfterSec !== undefined ? { resetsAtMs: nowMs + worst.resetsAfterSec * 1000 } : {}),
    exhausted: false,
  }
}

/** `providerMetadata` は JSON 値しか受け付けないので、欄を1つずつ書き出す。 */
const quotaJson = (q: QuotaSignal): JSONObject => ({
  pool: q.pool,
  window: q.window,
  ...(q.usedPercent !== undefined ? { usedPercent: q.usedPercent } : {}),
  ...(q.resetsAtMs !== undefined ? { resetsAtMs: q.resetsAtMs } : {}),
  ...(q.exhausted !== undefined ? { exhausted: q.exhausted } : {}),
})

/** 上流側で実行される web 検索。`-web` が付いたモデル id にだけ追加する(models.ts の isWebModel)。 */
const WEB_SEARCH_TOOL: LanguageModelV4ProviderTool = {
  type: "provider",
  id: "openai.web_search",
  name: "web_search",
  args: {},
}

/** 上流の失敗を、統治が読める型に変換する。429 だけはクォータシグナルを付けて返す。 */
function toCliError(e: unknown): ModelCallError {
  if (e instanceof ModelCallError) return e
  const status = (e as { statusCode?: number })?.statusCode
  const message = e instanceof Error ? e.message : String(e)
  if (status === 429) {
    return new ModelCallError(`codex: 429(クォータ枯渇) ${message}`, {
      pool: CODEX_POOL,
      window: "unknown",
      exhausted: true,
    })
  }
  return new ModelCallError(`codex: ${message}`)
}

/** doStream の出力を1回ぶんの応答にまとめる。上流が stream しか受けないので doGenerate はこれで作る。 */
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
        // 引用マーカーはここで除去する。残すと DB の全文検索の索引に表示されない文字が入る。
        content.push({ type: "text", text: stripCitationMarkers(open.get(value.id) ?? "") })
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
  if (failure !== undefined) throw toCliError(failure)

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

/**
 * Codex の Responses を1つの V4 モデルとして返す。統治は適用されていない —
 * ゲートと会計は src/model/governed.ts の middleware が外側で適用する。これを直接使わない。
 */
export function codexResponsesModel(modelId: string): LanguageModelV4 {
  const upstream = baseModel(modelId)

  /** 呼び出しごとに生成する。トークンを毎回読み直し、応答ヘッダをこの呼び出し専用の変数へ記録するため。 */
  const build = (): { model: LanguageModelV4; quota: () => QuotaSignal | undefined } => {
    const headers: Record<string, string | undefined> = {}
    let auth = readAuth()
    const sessionId = randomUUID()

    const provider = createOpenAI({
      baseURL: CODEX_BASE_URL,
      // 認証は fetch 側で付ける。ここは静的な文字列しか受けないので、更新したトークンを反映できない。
      apiKey: "unused",
      headers: {
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
        originator: "codex_cli_rs",
        "session-id": sessionId,
        "thread-id": sessionId,
        "user-agent": CODEX_USER_AGENT,
      },
      // 型は `typeof fetch` で、関数の実装だけでは一致しない(Bun の fetch は `preconnect` を持つ)。
      // 使われるのは呼び出しの部分だけなので、そこだけ一致させて渡す。
      fetch: (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
        const send = async (token: string): Promise<Response> => {
          const h = new Headers(init?.headers)
          h.set("authorization", `Bearer ${token}`)
          return fetch(input, { ...init, headers: h })
        }
        let res = await send(auth.accessToken)
        if (res.status === 401 && auth.refreshToken) {
          const token = await refreshAccessToken(auth)
          auth = { ...auth, accessToken: token }
          res = await send(token)
        }
        res.headers.forEach((v, k) => {
          if (k.startsWith("x-codex-")) headers[k] = v
        })
        return res
      }) as unknown as typeof fetch,
    })

    return { model: provider.responses(upstream), quota: () => quotaFromHeaders(headers, Date.now()) }
  }

  /**
   * 上流が拒否する既定値を上書きし、`-web` のときだけ上流側の web 検索を追加する。
   *
   * `strictJsonSchema` を false にするのは、strict が JSON Schema 側に
   * 「全ての object に `additionalProperties: false`、全ての欄を `required`」を要求するため。
   * open-zero のスキーマは valibot から生成していて任意欄を持つので、そのままでは 400 で拒否される
   * (実測: `Invalid schema for response_format 'reply'`)。読み出し側は欄ごとに既定値を当てているので、
   * 構造の保証は上流ではなく読み出し側にある。
   */
  const prepare = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => ({
    ...options,
    providerOptions: {
      ...options.providerOptions,
      openai: { ...options.providerOptions?.openai, store: false, strictJsonSchema: false },
    },
    ...(isWebModel(modelId) ? { tools: [...(options.tools ?? []), WEB_SEARCH_TOOL] } : {}),
  })

  /** クォータシグナルを統治が読む欄へ書き出す。従量課金換算額はこの経路では取得できないので 0。 */
  const withQuota = (
    meta: LanguageModelV4GenerateResult["providerMetadata"],
    quota: QuotaSignal | undefined,
  ): NonNullable<LanguageModelV4GenerateResult["providerMetadata"]> => ({
    ...meta,
    [CODEX_PROVIDER_META]: { notionalUsd: 0, ...(quota ? { quota: quotaJson(quota) } : {}) },
  })

  return {
    specificationVersion: "v4",
    provider: CODEX_PROVIDER_META,
    modelId,
    supportedUrls: {},

    async doGenerate(options) {
      const { model, quota } = build()
      try {
        const { stream } = await model.doStream(prepare(options))
        const gen = await collect(stream)
        return { ...gen, warnings: [], providerMetadata: withQuota(gen.providerMetadata, quota()) }
      } catch (e) {
        throw toCliError(e)
      }
    },

    async doStream(options) {
      const { model, quota } = build()
      let result: Awaited<ReturnType<LanguageModelV4["doStream"]>>
      try {
        result = await model.doStream(prepare(options))
      } catch (e) {
        throw toCliError(e)
      }
      // finish にだけクォータを付ける。ヘッダは応答の先頭で届くので、この時点で取得済み。
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, ctrl) {
              ctrl.enqueue(
                part.type === "finish"
                  ? { ...part, providerMetadata: withQuota(part.providerMetadata, quota()) }
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
 * `callClaude` と同じ入出力で Codex を1回呼ぶ。構造化処理の入口(src/model/Runner.ts)が使う。
 * そちらは道具ループを持たないので、prompt 1つと任意の JSON Schema だけを渡す。
 */
export async function callCodex(opts: ModelCallOptions): Promise<ModelCallResult> {
  const model = codexResponsesModel(opts.model)
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

    // onText のために一度流してからまとめる。まとめる側は同じ `collect` を通す。
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

    // 引用マーカーは collect が既に除去している。
    const text = gen.content.map((c) => (c.type === "text" ? c.text : "")).join("")
    const meta = gen.providerMetadata?.[CODEX_PROVIDER_META] as { quota?: QuotaSignal } | undefined
    const u = gen.usage

    return {
      text,
      ...(opts.jsonSchema !== undefined ? { structured: parseStructured(text) } : {}),
      usage: {
        inTok: u.inputTokens.noCache ?? 0,
        outTok: u.outputTokens.total ?? 0,
        cacheRead: u.inputTokens.cacheRead ?? 0,
        cacheWrite: u.inputTokens.cacheWrite ?? 0,
        // 定額クォータで、上流は金額を返さない。CLI が返していた数字は Anthropic の単価による換算で、
        // GPT の呼び出しには対応しない値だった。0 のほうが正しい。
        notionalUsd: 0,
      },
      ...(meta?.quota ? { quota: meta.quota } : {}),
      model: opts.model,
    }
  } catch (e) {
    throw toCliError(e)
  } finally {
    clearTimeout(timer)
  }
}

/** 構造化応答の本文。スキーマを渡した回は JSON が本文として返る。解析できなければ undefined を返す。 */
function parseStructured(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
