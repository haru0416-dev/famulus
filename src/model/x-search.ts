/**
 * X を xAI のサーバ側 `x_search` で調べる(SuperGrok OAuth の同じ pool を消費する)。X には本文の取れる
 * 代替 API が無いので provider の道具を使う。モデル呼び出しへ注入せず独立呼び出しにし、precheck を I/O より先に通す。
 * Runner と同じ統治を通らない x_search の経路を作らない。
 */
import * as Effect from "effect/Effect"
import type { DailyRunLimit, DbFailed, Halt, QuotaCooldown } from "../core/errors.ts"
import { RunnerFailed } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { accountingRole, currentLane, Governance } from "../services/Governance.ts"
import { Ledger } from "../services/Ledger.ts"
import { ModelCallError, XAI_POOL } from "./models.ts"
import { AGENT_PROFILES } from "./profiles.ts"
import { traceOf } from "./trace.ts"
import { loadXaiAccess } from "./xai-auth.ts"
import { classifyXaiFailure, XAI_BASE_URL } from "./xai-responses.ts"

export const X_SEARCH_TIMEOUT_MS = 120_000

/** 上流の仕様は公開されていないので手で決めた。 */
const HANDLE_LIMIT = 10

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface XSearchOptions {
  readonly query: string
  readonly allowedHandles?: readonly string[]
  readonly excludedHandles?: readonly string[]
  /** YYYY-MM-DD。 */
  readonly fromDate?: string
  readonly toDate?: string
  readonly signal?: AbortSignal
}

export interface XSearchResult {
  readonly answer: string
  readonly citations: readonly { url: string; title?: string }[]
  readonly searches: number
  readonly usage: { inTok: number; outTok: number; cacheRead: number; cacheWrite: number }
}

const cleanHandles = (handles: readonly string[] | undefined, label: string): string[] | undefined => {
  if (handles === undefined || handles.length === 0) return undefined
  const cleaned = handles.map((h) => h.trim().replace(/^@/, "")).filter((h) => h.length > 0)
  if (cleaned.length === 0) return undefined
  if (cleaned.length > HANDLE_LIMIT) {
    throw new ModelCallError(`${label} は ${HANDLE_LIMIT} 件まで(${cleaned.length} 件来た)`)
  }
  return cleaned
}

/** 入力の検証はここで落とす。上流の 400 は持ち時間とクォータを使った後の失敗になる。 */
export function buildXSearchBody(opts: XSearchOptions, model: string): Record<string, unknown> {
  const query = opts.query.trim()
  if (!query) throw new ModelCallError("query が空")
  const allowed = cleanHandles(opts.allowedHandles, "allowed_x_handles")
  const excluded = cleanHandles(opts.excludedHandles, "excluded_x_handles")
  if (allowed && excluded) {
    throw new ModelCallError("allowed_x_handles と excluded_x_handles は同時に指定できない")
  }
  for (const [label, value] of [
    ["from_date", opts.fromDate],
    ["to_date", opts.toDate],
  ] as const) {
    if (value !== undefined && !DATE_RE.test(value)) {
      throw new ModelCallError(`${label} は YYYY-MM-DD で書く: ${value}`)
    }
  }
  if (opts.fromDate && opts.toDate && opts.fromDate > opts.toDate) {
    throw new ModelCallError(`from_date が to_date より後: ${opts.fromDate} > ${opts.toDate}`)
  }
  return {
    model,
    input: [{ role: "user", content: query }],
    tools: [
      {
        type: "x_search",
        ...(allowed ? { allowed_x_handles: allowed } : {}),
        ...(excluded ? { excluded_x_handles: excluded } : {}),
        ...(opts.fromDate ? { from_date: opts.fromDate } : {}),
        ...(opts.toDate ? { to_date: opts.toDate } : {}),
      },
    ],
    store: false,
  }
}

/**
 * 観測した形は `display render_inline_citation with citation_id is 25` だけ。引用は annotation(url_citation)から
 * 別に取るので情報は失わない。
 */
const stripCitationMarkers = (text: string): string =>
  // 空白は横方向だけ消す。\s にすると行末のマーカーの後の改行まで消えて文が繋がる。
  text
    .replace(/[ \t]*\(?[ \t]*display render_inline_citation with citation_id (?:is )?\d+[ \t]*\)?/gi, "")
    .trim()

/** 壊れた応答は欄が空になるだけで例外にしない。 */
export function parseXSearchResponse(payload: unknown): XSearchResult {
  const root = (payload ?? {}) as Record<string, unknown>
  const output = Array.isArray(root.output) ? root.output : []
  const texts: string[] = []
  const citations: { url: string; title?: string }[] = []
  const seen = new Set<string>()
  for (const item of output) {
    const message = item as { type?: unknown; content?: unknown }
    if (message.type !== "message" || !Array.isArray(message.content)) continue
    for (const piece of message.content) {
      const content = piece as { type?: unknown; text?: unknown; annotations?: unknown }
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") {
        texts.push(content.text)
      }
      if (!Array.isArray(content.annotations)) continue
      for (const raw of content.annotations) {
        const a = raw as { type?: unknown; url?: unknown; title?: unknown }
        if (a.type !== "url_citation" || typeof a.url !== "string" || seen.has(a.url)) continue
        seen.add(a.url)
        citations.push({ url: a.url, ...(typeof a.title === "string" && a.title ? { title: a.title } : {}) })
      }
    }
  }
  const usage = (root.usage ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const inputTokens = num(usage.input_tokens)
  const cached = num((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens)
  const tools = (usage.server_side_tool_usage_details ?? {}) as Record<string, unknown>
  return {
    answer: stripCitationMarkers(texts.join("\n\n")),
    citations,
    searches: num(tools.x_search_calls),
    usage: {
      inTok: Math.max(inputTokens - cached, 0),
      outTok: num(usage.output_tokens),
      cacheRead: cached,
      cacheWrite: 0,
    },
  }
}

export const xSearch = (
  opts: XSearchOptions,
): Effect.Effect<
  XSearchResult,
  RunnerFailed | Halt | QuotaCooldown | DailyRunLimit | DbFailed,
  Governance | Ledger
> =>
  Effect.gen(function* () {
    const gov = yield* Governance
    const ledger = yield* Ledger
    const model = AGENT_PROFILES["x-search"].model()
    const lane = currentLane()
    let at = nowIso()
    const body = yield* Effect.try({
      try: () => buildXSearchBody(opts, model),
      catch: (e) => new RunnerFailed({ pool: XAI_POOL, message: e instanceof Error ? e.message : String(e) }),
    })

    yield* gov.precheck({ pool: XAI_POOL, at, nowMs: Date.now(), lane })
    at = yield* gov.claimRun({ lane })

    const result = yield* Effect.tryPromise({
      try: async () => {
        const signal = opts.signal
          ? AbortSignal.any([AbortSignal.timeout(X_SEARCH_TIMEOUT_MS), opts.signal])
          : AbortSignal.timeout(X_SEARCH_TIMEOUT_MS)
        const res = await fetch(`${XAI_BASE_URL}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${await loadXaiAccess()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        })
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300)
          throw new ModelCallError(
            `x_search: HTTP ${res.status} ${detail}`,
            classifyXaiFailure(res.status, detail, Date.now()),
          )
        }
        return parseXSearchResponse(await res.json())
      },
      catch: (e) =>
        new RunnerFailed({
          pool: XAI_POOL,
          message: e instanceof Error ? e.message : String(e),
          ...(e instanceof ModelCallError && e.quota?.exhausted ? { exhausted: true } : {}),
        }),
    }).pipe(
      // 失敗でも枯渇シグナルが取れていれば再実行を抑止する。Runner と同じ規律。
      Effect.tapError((e) =>
        e.exhausted === true
          ? gov.noteQuota({ pool: XAI_POOL, window: "week", exhausted: true }, at, Date.now())
          : Effect.void,
      ),
      Effect.tapError((e) =>
        ledger.record({
          kind: "x-search",
          role: accountingRole("x_search", lane),
          model,
          usage: { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 },
          summary: traceOf(e.message),
          provenance: { pool: XAI_POOL, outcome: "failed" },
          at,
        }),
      ),
    )

    yield* ledger.record({
      kind: "x-search",
      role: accountingRole("x_search", lane), // role を入れないと日次 run 数の上限を適用できない
      model,
      usage: result.usage,
      summary: traceOf(result.answer),
      provenance: { pool: XAI_POOL, xSearchCalls: result.searches, citations: result.citations.length },
      at,
    })
    return result
  })
