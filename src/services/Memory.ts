/**
 * 正本は append-only の `events`。belief_slots と FTS は events から導く projection。
 * `remember` は必須引数を最小にしてある(呼び出しが面倒だと記録が溜まらない)。
 */
import { createHash, randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { currentCycleId } from "../core/cycle-context.ts"
import { DbFailed } from "../core/errors.ts"
import { localStamp, nowIso } from "../core/time.ts"
import { EMBEDDING_DIM, EMBEDDING_MODEL, embedPassage, embedQuery } from "../model/embedding.ts"
import { Db, type DbTx, type Row } from "./Db.ts"

export type EventKind = "observe" | "belief" | "redact" | "import"
export type EventSource = "owner" | "calendar" | "gmail" | "web" | "system"
export type Exposure = "private" | "public"

/** 現在区間の `valid_from` がこの日数より古い belief を再確認候補にする。 */
export const STALE_BELIEF_DAYS = 90

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex")
const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)

/** BM25 と cosine 距離はスケールが違うので順位だけを使う(RRF)。 */
export const rrfMerge = <T extends { readonly id: string }>(
  fts: readonly T[],
  semantic: readonly T[],
  k = 60,
): T[] => {
  const score = new Map<string, { row: T; s: number }>()
  for (const [list, weight] of [
    [fts, 1],
    [semantic, 1],
  ] as const) {
    for (const [rank, row] of list.entries()) {
      const got = score.get(row.id) ?? { row, s: 0 }
      got.s += weight / (k + rank + 1)
      score.set(row.id, got)
    }
  }
  return [...score.values()].sort((x, y) => y.s - x.s).map((x) => x.row)
}

export interface SourceRef {
  readonly kind: string
  readonly ref?: string
  readonly at?: string
}

export interface RememberInput {
  readonly kind?: EventKind
  readonly source?: EventSource
  readonly content: unknown
  readonly taint?: boolean
  readonly exposure?: Exposure
  readonly supersedes?: string
  readonly provenance?: readonly SourceRef[]
  /** 検索用テキスト。省略時は content から導く。"" なら索引に入れない。 */
  readonly text?: string
  readonly at?: string
  readonly origin?: { readonly kind: string; readonly id: string }
}

interface AppendMeta {
  readonly originKind: string | null
  readonly originId: string | null
  readonly beliefSlot: string | null
  readonly validFrom: string | null
  readonly invalidatedReason: string | null
  readonly evidenceEventId: string | null
  readonly evidenceQuote: string | null
}

const EMPTY_META: AppendMeta = {
  originKind: null,
  originId: null,
  beliefSlot: null,
  validFrom: null,
  invalidatedReason: null,
  evidenceEventId: null,
  evidenceQuote: null,
}

export interface EventRow {
  readonly id: string
  readonly at: string
  readonly kind: EventKind
  readonly source: EventSource
  readonly taint: number
  readonly exposure: Exposure
  readonly supersedes: string | null
  readonly provenance: string
  readonly content: string | null
  /** JSON の構造を除いたテキスト。モデルと人にはこちらを見せる。 */
  readonly text: string | null
  readonly is_current: number
}

/**
 * 同じ slot の belief イベントは複数残るので、今の値かは belief_slots で判定する。
 * `resolved_from` の一致だけでは、上書き済みの行も一致し続ける。
 */
const IS_CURRENT =
  "EXISTS (SELECT 1 FROM belief_slots b WHERE b.resolved_from = e.id AND b.valid_until IS NULL)"

/**
 * bm25 は小さいほど関連が強い負の値なので、引くと前に出る。
 * `import` は source が system だが中身はユーザーの判断の要約なので、`source='system'` より先に判定する。
 */
const LAYER_BIAS = `CASE
    WHEN e.kind = 'belief' AND ${IS_CURRENT} THEN -2.5
    WHEN e.kind = 'belief'                   THEN  0.5
    WHEN e.kind = 'import'                   THEN  0.5
    WHEN e.source = 'system'                 THEN  1.5
    ELSE 0.0
  END`

// 時刻は `localStamp` で出す。UTC のままだと夜中の記録が前日として読まれる。
export function renderRecall(rows: readonly EventRow[], perRow = 180): string {
  if (rows.length === 0) return "該当なし"
  return rows
    .map((r) => {
      const label =
        r.kind === "belief"
          ? r.is_current
            ? "確定"
            : "確定(旧版)"
          : r.kind === "import"
            ? "取り込み"
            : r.source === "system"
              ? r.taint === 1
                ? "システム記録(未検証)"
                : "システム記録"
              : r.source
      const body = (r.text && r.text.length > 0 ? r.text : safeText(r.content)).replace(/\s+/g, " ").trim()
      const shown = body.length > perRow ? `${body.slice(0, perRow)}…` : body
      return `- [${localStamp(r.at)} ${label}] ${shown}`
    })
    .join("\n")
}

function safeText(content: string | null): string {
  if (content === null) return ""
  try {
    return deriveText(JSON.parse(content))
  } catch {
    return content
  }
}

/** 除外しないと、繰り返し言われた1つの話題が結果の上限を埋める。 */
function dedupe(rows: readonly EventRow[], limit: number): EventRow[] {
  const seen = new Set<string>()
  const out: EventRow[] = []
  for (const r of rows) {
    const key = (r.text ?? String(r.content ?? "")).slice(0, 120)
    if (key.length > 0 && seen.has(key)) continue
    seen.add(key)
    out.push(r)
    if (out.length >= limit) break
  }
  return out
}

/** trigram tokenizer は2文字以下を引けない。 */
export const FTS_MIN_QUERY = 3

function deriveText(content: unknown): string {
  if (typeof content === "string") return content
  if (content === null || content === undefined) return ""
  if (typeof content !== "object") return String(content)
  const parts: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4) return
    if (typeof v === "string") parts.push(v)
    else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v))
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1)
  }
  walk(content, 0)
  return parts.join(" ")
}

/** 入力を FTS5 のクエリ構文として解釈させない。 */
function sanitizeFts(q: string): string {
  return q.replace(/["'*(){}:^-]/g, " ").trim()
}

const makeMemory = () =>
  Effect.gen(function* () {
    const db = yield* Db

    const append = (tx: DbTx, input: RememberInput, id: string, at: string, meta: AppendMeta): string => {
      if (meta.originKind !== null) {
        const existing = tx.get(
          "SELECT id FROM events WHERE origin_kind = ?AND origin_id = ?AND content IS NOT NULL",
          meta.originKind,
          meta.originId,
        )
        if (existing) return String(existing.id)
      }
      const source = input.source ?? "owner"
      const kind = input.kind ?? "observe"
      const taint = input.taint ?? (source === "gmail" || source === "web")
      const provenance = JSON.stringify(input.provenance ?? [{ kind: source, at }])
      const content = JSON.stringify(input.content ?? null)
      const text = input.text ?? deriveText(input.content)

      tx.run(
        `INSERT INTO events
           (id, at, kind, source, taint, exposure, supersedes, provenance, content, search_text,
            origin_kind, origin_id, belief_slot, valid_from, invalidated_reason,
            evidence_event_id, evidence_quote, cycle_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        at,
        kind,
        source,
        taint ? 1 : 0,
        input.exposure ?? "private",
        input.supersedes ?? null,
        provenance,
        content,
        text.length > 0 ? text : null,
        meta.originKind,
        meta.originId,
        meta.beliefSlot,
        meta.validFrom,
        meta.invalidatedReason,
        meta.evidenceEventId,
        meta.evidenceQuote,
        currentCycleId() ?? null,
      )
      if (text.length > 0) tx.run("INSERT INTO events_fts (event_id, text)VALUES (?, ?)", id, text)
      return id
    }

    const writeEmbedding = (tx: DbTx, eventId: string, text: string, vec: Float32Array, at: string) => {
      // rowid は seq の別名なので、素の `SELECT rowid` は {seq} で返る。
      const row = tx.get("SELECT rowid AS r FROM events WHERE id = ?", eventId)
      if (!row) return
      // append が既存 id を返した場合は埋め込みも既にある。
      if (tx.get("SELECT 1 FROM events_embedding WHERE rowid = ?", Number(row.r))) return
      tx.run("INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)", Number(row.r), toBlob(vec))
      tx.run(
        "INSERT INTO events_embedding(rowid, model, dim, content_sha, embedded_at) VALUES (?,?,?,?,?)",
        Number(row.r),
        EMBEDDING_MODEL,
        EMBEDDING_DIM,
        sha256Hex(text),
        at,
      )
    }

    const remember = (input: RememberInput) =>
      Effect.gen(function* () {
        const id = randomUUID()
        const at = input.at ?? nowIso()
        const meta = input.origin
          ? { ...EMPTY_META, originKind: input.origin.kind, originId: input.origin.id }
          : EMPTY_META
        // 埋め込みの失敗で書き込みを止めない。取りこぼしは embedMissing が埋め直す。
        const text = input.text ?? deriveText(input.content)
        const vec = text.length > 0 ? yield* Effect.promise(() => embedPassage(text)) : undefined
        return yield* db.withImmediateTransaction("remember event", (tx) => {
          const eventId = append(tx, input, id, at, meta)
          if (vec) writeEmbedding(tx, eventId, text, vec, at)
          return eventId
        })
      })

    /**
     * slot は上書きせず、今の区間を `valid_until` で閉じて次の区間を足す(過去の時点の値を問えるように)。
     * `validFrom` は事実が真になった時刻で記録時刻とは別。不明なら記録時刻にする。
     */
    const recordBelief = (
      slot: string,
      value: unknown,
      opts?: {
        exposure?: Exposure
        supersedes?: string
        validFrom?: string
        reason?: string
        evidenceEventId?: string
        evidenceQuote?: string
      },
    ) =>
      Effect.gen(function* () {
        const at = nowIso()
        const exposure = opts?.exposure ?? "private"
        return yield* db.withImmediateTransaction<string, DbFailed>("record belief", (tx, abort) => {
          if (opts?.evidenceEventId) {
            const evidence = tx.get("SELECT source FROM events WHERE id=?", opts.evidenceEventId)
            if (evidence?.source !== "owner") {
              abort(new DbFailed({ op: "record belief", message: "Belief evidence must be an owner event" }))
            }
          }
          const cur = tx.get(
            "SELECT resolved_from, valid_from FROM belief_slots WHERE slot = ?AND valid_until IS NULL",
            slot,
          )
          // 前の区間より前には戻さない。区間が逆転すると順序の前提が崩れる。
          const prevFrom = cur === undefined ? undefined : String(cur.valid_from)
          const asked = opts?.validFrom ?? at
          const validFrom = prevFrom !== undefined && asked < prevFrom ? prevFrom : asked
          const eventId = randomUUID()
          append(
            tx,
            {
              kind: "belief",
              source: "system",
              content: value,
              exposure,
              // belief_slots を捨てても訂正の系譜を events から辿れるようにする。
              ...((opts?.supersedes ?? cur)
                ? { supersedes: opts?.supersedes ?? String(cur?.resolved_from) }
                : {}),
              text: `${slot} ${deriveText(value)}`,
              at,
            },
            eventId,
            at,
            {
              ...EMPTY_META,
              beliefSlot: slot,
              validFrom,
              invalidatedReason: opts?.reason ?? null,
              evidenceEventId: opts?.evidenceEventId ?? null,
              evidenceQuote: opts?.evidenceQuote ?? null,
            },
          )
          return eventId
        })
      })

    const view = (slot: string, r: Row | undefined) =>
      r === undefined
        ? undefined
        : {
            slot,
            value: r.value === null ? null : JSON.parse(r.value as string),
            exposure: r.exposure as Exposure,
            resolvedFrom: r.resolved_from as string,
            updatedAt: r.updated_at as string,
            validFrom: r.valid_from as string,
            validUntil: (r.valid_until ?? null) as string | null,
            invalidatedReason: (r.invalidated_reason ?? null) as string | null,
          }

    const SLOT_COLS =
      "value, exposure, resolved_from, updated_at, valid_from, valid_until, invalidated_reason"

    /** 閉じていない区間は slot ごとに高々1本(部分 UNIQUE)。 */
    const currentBelief = (slot: string) =>
      db
        .get(`SELECT ${SLOT_COLS} FROM belief_slots WHERE slot = ?AND valid_until IS NULL`, slot)
        .pipe(Effect.map((r) => view(slot, r)))

    /** 半開区間 `[valid_from, valid_until)`。隣り合う区間が同じ時刻で重ならない。 */
    const beliefAsOf = (slot: string, at: string) =>
      db
        .get(
          `SELECT ${SLOT_COLS} FROM belief_slots
            WHERE slot = ?AND valid_from <= ?AND (valid_until IS NULL OR valid_until > ?)`,
          slot,
          at,
          at,
        )
        .pipe(Effect.map((r) => view(slot, r)))

    const beliefHistory = (slot: string) =>
      db
        .all(`SELECT ${SLOT_COLS} FROM belief_slots WHERE slot = ?ORDER BY valid_from ASC`, slot)
        .pipe(Effect.map((rows) => rows.map((r) => view(slot, r)).filter((v) => v !== undefined)))

    /** `updated_at`(記録時刻)ではなく valid_from で切るので、最後に確認してからの経過ではない。 */
    const staleBeliefs = (before: string, limit = 20) =>
      db
        .all(
          `SELECT slot, ${SLOT_COLS} FROM belief_slots
            WHERE valid_until IS NULL AND valid_from < ?
            ORDER BY valid_from ASC LIMIT ?`,
          before,
          limit,
        )
        .pipe(Effect.map((rows) => rows.map((r) => view(String(r.slot), r)).filter((v) => v !== undefined)))

    /** 書く前に既存の slot 名を見せ、同じ事柄に別名の slot が作られるのを防ぐ。検索では防げない。 */
    const currentBeliefs = (limit = 50) =>
      db
        .all(
          `SELECT slot, ${SLOT_COLS} FROM belief_slots
            WHERE valid_until IS NULL ORDER BY updated_at DESC LIMIT ?`,
          limit,
        )
        .pipe(Effect.map((rows) => rows.map((r) => view(String(r.slot), r)).filter((v) => v !== undefined)))

    // vec0 の KNN は事前フィルタできないので、多めに引いて events 側の条件で絞る。
    const semanticRows = (query: string, wide: number, exclude?: string) =>
      Effect.gen(function* () {
        const vec = yield* Effect.promise(() => embedQuery(query))
        if (!vec) return [] as EventRow[]
        const hits = yield* db.all(
          "SELECT rowid, distance FROM events_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
          toBlob(vec),
          wide,
        )
        if (hits.length === 0) return [] as EventRow[]
        const rowids = hits.map((hit) => Number(hit.rowid))
        const rows = yield* db.all(
          `SELECT e.*, f.text AS text, ${IS_CURRENT} AS is_current FROM events e
             JOIN events_fts f ON f.event_id = e.id
            WHERE e.rowid IN (${rowids.map(() => "?").join(",")})
              AND e.content IS NOT NULL ${exclude ? "AND e.id <> ?" : ""}`,
          ...rowids,
          ...(exclude ? [exclude] : []),
        )
        const byRowid = new Map(rows.map((row) => [Number(row.seq), row as unknown as EventRow]))
        return rowids.flatMap((rowid) => {
          const row = byRowid.get(rowid)
          return row ? [row] : []
        })
      })

    /**
     * 並びは bm25 の関連度。`at DESC` だと cycle が毎回書く長い記録が上位を占める。
     * @param exclude 今のターンの入力の event id。入力はモデル呼び出し前に DB に入るので、
     *   除外しないと今の発言が過去の記録として当たる。
     */
    const recall = (query: string, limit = 10, exclude?: string) =>
      Effect.gen(function* () {
        // 1本のフレーズにすると空白ごと含む行しか当たらない。
        const terms = sanitizeFts(query)
          .split(/\s+/)
          .filter((t) => t.length > 0)
        if (terms.length === 0) return [] as EventRow[]
        // 重複を除外した後に limit 件残るよう多めに取る。
        const wide = Math.max(limit * 3, 30)
        // 2文字以下の語は trigram で引けない(日本語の常用語の多くがこれ)ので LIKE で重ねる。
        const indexed = terms.filter((t) => t.length >= FTS_MIN_QUERY)
        const short = terms.filter((t) => t.length < FTS_MIN_QUERY)
        const likes = short.map(() => "f.text LIKE '%' || ? || '%' ESCAPE '\\'").join(" AND ")
        const args = short.map((t) => t.replace(/[\\%_]/g, "\\$&"))
        const notSelf = exclude ? "AND e.id <> ?" : ""
        const selfArg = exclude ? [exclude] : []

        const rows =
          indexed.length === 0
            ? // 内部結合で、索引を持たない行(`text: ""`)を FTS 経路と同じく検索から外す。
              yield* db.all(
                `SELECT e.*, f.text AS text, ${IS_CURRENT} AS is_current FROM events e
                   JOIN events_fts f ON f.event_id = e.id
                  WHERE e.content IS NOT NULL AND ${likes} ${notSelf}
                  ORDER BY ${LAYER_BIAS} ASC, e.at DESC, e.rowid DESC
                  LIMIT ?`,
                ...args,
                ...selfArg,
                wide,
              )
            : yield* db.all(
                `SELECT e.*, f.text AS text, ${IS_CURRENT} AS is_current FROM events_fts f
                   JOIN events e ON e.id = f.event_id
                  WHERE events_fts MATCH ?
                    AND e.content IS NOT NULL
                    ${short.length > 0 ? `AND ${likes}` : ""}
                    ${notSelf}
                  ORDER BY bm25(events_fts) + ${LAYER_BIAS} ASC, e.at DESC
                  LIMIT ?`,
                indexed.map((t) => `"${t}"`).join(" AND "),
                ...args,
                ...selfArg,
                wide,
              )
        if (rows.length > 0) return dedupe(rows as unknown as EventRow[], limit)

        // 意味検索は FTS が0件のときだけ。当たっている回に足すと AND で絞った結果が薄まる。
        const semantic = yield* semanticRows(query, wide, exclude)
        if (terms.length < 2) return dedupe(semantic, limit)

        // AND で0件なら、語ごとに引き直して束ねる(1回だけ)。
        const loose: Row[] = []
        for (const term of terms.slice(0, 4)) {
          const one =
            term.length >= FTS_MIN_QUERY
              ? yield* db.all(
                  `SELECT e.*, f.text AS text, ${IS_CURRENT} AS is_current FROM events_fts f
                     JOIN events e ON e.id = f.event_id
                    WHERE events_fts MATCH ?
                      AND e.content IS NOT NULL
                      ${notSelf}
                    ORDER BY bm25(events_fts) + ${LAYER_BIAS} ASC, e.at DESC
                    LIMIT ?`,
                  `"${term}"`,
                  ...selfArg,
                  wide,
                )
              : yield* db.all(
                  `SELECT e.*, f.text AS text, ${IS_CURRENT} AS is_current FROM events e
                     JOIN events_fts f ON f.event_id = e.id
                    WHERE e.content IS NOT NULL AND f.text LIKE '%' || ? || '%' ESCAPE '\\' ${notSelf}
                    ORDER BY ${LAYER_BIAS} ASC, e.at DESC, e.rowid DESC
                    LIMIT ?`,
                  term.replace(/[\\%_]/g, "\\$&"),
                  ...selfArg,
                  wide,
                )
          loose.push(...one)
        }
        return dedupe(rrfMerge(loose as unknown as EventRow[], semantic), limit)
      })

    const recent = (limit = 20) =>
      db
        .all(
          `SELECT e.*, f.text AS text FROM events e
             LEFT JOIN events_fts f ON f.event_id = e.id
            ORDER BY e.at DESC, e.rowid DESC LIMIT ?`,
          limit,
        )
        .pipe(Effect.map((rows) => rows as unknown as EventRow[]))

    const redact = (eventId: string, reason: string) =>
      Effect.gen(function* () {
        const id = randomUUID()
        const at = nowIso()
        return yield* db.withImmediateTransaction("redact event", (tx) => {
          tx.run(
            "UPDATE events SET content = NULL, search_text = NULL, evidence_quote = NULL WHERE id = ?",
            eventId,
          )
          tx.run(
            "UPDATE events SET evidence_quote = NULL WHERE evidence_event_id = ? AND evidence_quote IS NOT NULL",
            eventId,
          )
          tx.run("DELETE FROM events_fts WHERE event_id = ?", eventId)
          // 埋め込みは原文から作られるので一緒に消す。
          const row = tx.get("SELECT rowid AS r FROM events WHERE id = ?", eventId)
          if (row) {
            tx.run("DELETE FROM events_vec WHERE rowid = ?", Number(row.r))
            tx.run("DELETE FROM events_embedding WHERE rowid = ?", Number(row.r))
          }
          return append(
            tx,
            {
              kind: "redact",
              source: "system",
              content: { redacted: eventId, reason },
              supersedes: eventId,
              text: "",
            },
            id,
            at,
            EMPTY_META,
          )
        })
      })

    const count = db.get("SELECT COUNT(*)n FROM events").pipe(Effect.map((r) => Number(r?.n ?? 0)))

    /** 書き込みロックを長く持たないよう、1件ずつ tx を分ける。 */
    const embedMissing = (limit = 200) =>
      Effect.gen(function* () {
        const targets = yield* db.all(
          `SELECT e.rowid AS rowid, e.search_text AS text FROM events e
            WHERE e.search_text IS NOT NULL AND e.content IS NOT NULL
              AND e.rowid NOT IN (SELECT rowid FROM events_embedding)
            ORDER BY e.rowid LIMIT ?`,
          limit,
        )
        let done = 0
        for (const target of targets) {
          const text = String(target.text)
          const vec = yield* Effect.promise(() => embedPassage(text))
          if (!vec) return done
          yield* db.withImmediateTransaction("embed event", (tx) => {
            // redact と並んでも、消えた行へは書かない
            const still = tx.get(
              "SELECT 1 FROM events WHERE rowid = ? AND content IS NOT NULL",
              Number(target.rowid),
            )
            if (!still) return
            tx.run(
              "INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)",
              Number(target.rowid),
              toBlob(vec),
            )
            tx.run(
              "INSERT INTO events_embedding(rowid, model, dim, content_sha, embedded_at) VALUES (?,?,?,?,?)",
              Number(target.rowid),
              EMBEDDING_MODEL,
              EMBEDDING_DIM,
              sha256Hex(text),
              nowIso(),
            )
          })
          done++
        }
        return done
      })

    return {
      remember,
      recordBelief,
      currentBelief,
      beliefAsOf,
      beliefHistory,
      staleBeliefs,
      currentBeliefs,
      recall,
      recent,
      redact,
      embedMissing,
      count,
    } as const
  })

export class Memory extends Context.Service<Memory, Effect.Success<ReturnType<typeof makeMemory>>>()(
  "Memory",
) {
  static readonly layer = Layer.effect(Memory, makeMemory())
}
