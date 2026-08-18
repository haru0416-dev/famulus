/**
 * GPT 経路の実装。`~/.codex/auth.json` の OAuth トークンで Codex の Responses API を直接呼ぶ。
 * ログインは持たない — 資格情報は Codex CLI(`codex login`)が作り、ここは読むだけ。
 *
 * 使うのは精査役(reviewer)だけ。ChatGPT Pro x5 は SuperGrok より小さい枠なので、
 * 高頻度の役をここへ載せない(役の割当は src/model/Runner.ts の ROLE_MODEL)。
 *
 * 上流の制約。どちらも外すと 400 で拒否される:
 *  - `store` は false。
 *  - `stream` は true。**非ストリームの `doGenerate` は使えない**ので、
 *    doStream の出力をまとめて doGenerate を作る(xai 経路と同じ `collect`)。
 */

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createOpenAI } from "@ai-sdk/openai"
import type {
  JSONObject,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider"
import { appConfig } from "../core/config.ts"
import {
  CODEX_POOL,
  ModelCallError,
  type ModelCallOptions,
  poolForModel,
  type QuotaSignal,
} from "./models.ts"
import { callResponses, collectResponses } from "./responses-call.ts"

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

/** `providerMetadata` の鍵。統治の middleware がここからクォータシグナルを読む。 */
export const CODEX_PROVIDER_META = "codex-oauth"

/**
 * Codex CLI が送る originator。これを外すとバックエンドが受け付けない。
 * 版番号は資格情報の生成元(`codex login` を実行した CLI)に合わせてある。
 */
const CODEX_USER_AGENT = `codex_cli_rs/0.144.6 (${process.platform}; ${process.arch}) famulus`

const authPath = (): string => appConfig().paths.codexAuth

interface CodexAuth {
  readonly accessToken: string
  readonly accountId?: string
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined)

export function parseCodexAuth(contents: string): CodexAuth {
  let root: Record<string, unknown>
  try {
    root = JSON.parse(contents) as Record<string, unknown>
  } catch {
    throw new ModelCallError("codex の auth.json を JSON として読めない")
  }
  const tokens = (root.tokens ?? {}) as Record<string, unknown>
  const accessToken = str(tokens.access_token) ?? str(tokens.id_token)
  if (!accessToken) {
    // API キーは受け付けない。定額クォータで実行するのが目的で、API キーを使うと従量課金になる。
    throw new ModelCallError("codex の auth.json に ChatGPT のトークンが無い(`codex login` を通す)")
  }
  const accountId = str(tokens.account_id)
  return { accessToken, ...(accountId ? { accountId } : {}) }
}

function readAuth(): CodexAuth {
  const p = authPath()
  if (!existsSync(p)) {
    throw new ModelCallError(`${p} が無い(\`codex login\` を通す)`)
  }
  return parseCodexAuth(readFileSync(p, "utf8"))
}

/**
 * 応答ヘッダ → クォータシグナル。
 *
 * `x-codex-primary-*` が主クォータ、`x-codex-secondary-*` が短い窓。
 * Governance は pool ごとに1つしか持たないので、使用率の高いほうを渡す —
 * 先に上限へ達するのはそちらで、使用率の低いほうを渡すと上限に達していても呼び出しに行く。
 */
export function quotaFromHeaders(
  headers: Record<string, string | undefined>,
  nowMs: number,
  pool: string = CODEX_POOL,
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
    pool,
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

/** 上流の失敗を、統治が読める型に変換する。429 だけはクォータシグナルを付けて返す。 */
function toCodexError(e: unknown, pool: string): ModelCallError {
  if (e instanceof ModelCallError) return e
  const status = (e as { statusCode?: number })?.statusCode
  const message = e instanceof Error ? e.message : String(e)
  if (status === 429) {
    return new ModelCallError(`codex: 429(クォータ枯渇) ${message}`, {
      pool,
      window: "unknown",
      exhausted: true,
    })
  }
  return new ModelCallError(`codex: ${message}`)
}

/**
 * Codex の Responses を1つの V4 モデルとして返す。統治は適用されていない —
 * ゲートと会計は呼ぶ側(Runner の makeRunner)が持つ。これを直接使わない。
 */
export function codexResponsesModel(modelId: string): LanguageModelV4 {
  const pool = poolForModel(modelId)
  /** 呼び出しごとに生成する。トークンを毎回読み直し、応答ヘッダをこの呼び出し専用の変数へ記録するため。 */
  const build = (): { model: LanguageModelV4; quota: () => QuotaSignal | undefined } => {
    const headers: Record<string, string | undefined> = {}
    const auth = readAuth()
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
      fetch: (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
        const h = new Headers(init?.headers)
        h.set("authorization", `Bearer ${auth.accessToken}`)
        const res = await fetch(input, { ...init, headers: h })
        res.headers.forEach((v, k) => {
          if (k.startsWith("x-codex-")) headers[k] = v
        })
        return res
      }) as unknown as typeof fetch,
    })

    return { model: provider.responses(modelId), quota: () => quotaFromHeaders(headers, Date.now(), pool) }
  }

  /**
   * 上流が拒否する既定値を上書きする。`strictJsonSchema` を false にする理由は
   * xai 経路と同じ — valibot 生成のスキーマは任意欄を持ち、strict では 400 になる。
   */
  const prepare = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => ({
    ...options,
    providerOptions: {
      ...options.providerOptions,
      openai: { ...options.providerOptions?.openai, store: false, strictJsonSchema: false },
    },
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
        const gen = await collectResponses(stream)
        return { ...gen, warnings: [], providerMetadata: withQuota(gen.providerMetadata, quota()) }
      } catch (e) {
        throw toCodexError(e, pool)
      }
    },

    async doStream(options) {
      const { model, quota } = build()
      let result: Awaited<ReturnType<LanguageModelV4["doStream"]>>
      try {
        result = await model.doStream(prepare(options))
      } catch (e) {
        throw toCodexError(e, pool)
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
 * Codexを1回呼ぶ構造化処理の入口。src/model/Runner.tsが使う。
 * そちらは道具ループを持たないので、prompt 1つと任意の JSON Schema だけを渡す。
 */
export async function callCodex(opts: ModelCallOptions) {
  const pool = poolForModel(opts.model)
  try {
    return await callResponses(codexResponsesModel(opts.model), opts, {
      images: false,
      quota: (metadata) => (metadata?.[CODEX_PROVIDER_META] as { quota?: QuotaSignal } | undefined)?.quota,
    })
  } catch (e) {
    throw toCodexError(e, pool)
  }
}
