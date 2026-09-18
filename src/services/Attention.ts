/**
 * `questions` を `belief_slots` と分けるのは、確認していない推測を事実として溜めないため。
 * `planCycle` はモデルを呼ばず、実行の要否を SQL だけで決める。
 */
import { randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { appConfig } from "../core/config.ts"
import { currentCycleId } from "../core/cycle-context.ts"
import { Conflict, NotFound } from "../core/errors.ts"
import { localDayRange, localHour, nowIso } from "../core/time.ts"
import { Db, type Row } from "./Db.ts"

export type NextMove = "human" | "famulus"

export interface WatchRow {
  readonly id: string
  readonly subject: string
  readonly opened_at: string
  readonly last_activity_at: string
  readonly next_move_owner: NextMove
  readonly status: "open" | "closed"
  readonly last_run_at: string | null
  readonly cooldown_hours: number
  readonly run_count: number
  readonly last_result: string | null
  /** 載せたが実行しなかった回はここだけ進む。 */
  readonly last_shown_at: string | null
}

export interface WatchView extends WatchRow {
  readonly stalledDays: number
  readonly dueNow: boolean
  readonly dueInHours: number
}

export interface QuestionRow {
  readonly id: string
  readonly question: string
  readonly opened_at: string
  readonly status: "open" | "answered" | "dropped"
  readonly confidence: "unverified" | "confirmed"
  readonly answer: string | null
}

export interface PendingProposal {
  readonly id: string
  readonly summary: string
  readonly created_at: string
  readonly expires_at: string
  readonly daysLeft: number
  /** あるものは実行条件に数えない。 */
  readonly settled_note: string | null
}

/** 同じ用件をもう一度出さないためにプロンプトへ渡す。 */
export interface RefusedProposal {
  readonly id: string
  readonly summary: string
  readonly reason: string
  readonly at: string
}

export interface ObservedEvent {
  readonly rowid: number
  readonly id: string
  readonly at: string
  readonly source: string
  /** 1 なら不信データ由来(gmail/web)。 */
  readonly taint: number
  readonly content: string
  readonly origin_id?: string
  /** `[{"kind":"discord","ref":"<channel id>"}]` */
  readonly provenance?: string
}

export interface CyclePlan {
  readonly at: string
  readonly cursor: number
  readonly newEvents: readonly ObservedEvent[]
  /** この回に載せる分だけ(最大 `STALLED_SHOW_MAX` 件)。 */
  readonly stalled: readonly WatchView[]
  /** cooldown は終了しているが、この回は載せなかった件数。 */
  readonly stalledHeld: number
  readonly openQuestions: readonly QuestionRow[]
  readonly pending: readonly PendingProposal[]
  readonly refused: readonly RefusedProposal[]
  readonly sinceLastActiveHours: number
  readonly reasons: readonly string[]
  /** 件数を除いた理由の組み合わせ。前回と同じなら次の cooldown が伸びる。 */
  readonly reasonKey: string
  readonly cooldownHours: number
  /** cooldown を無視して実行条件になる。 */
  readonly draftDue: boolean
  readonly pendingDraft?: {
    readonly title: string
    readonly body: string
    readonly dossierId: string
    readonly state: "review_pending" | "revision_needed" | "delivery_pending"
    readonly reviewFeedback?: string
  }
  readonly idle: boolean
}

/** human-owned の watch にだけ使う。famulus-owned は個別 cooldown だけを見る。 */
export const STALLED_DAYS = 3

/**
 * `last_activity_at` では判定しない。famulus-owned の watch は無条件で滞留に入るので、
 * `touchWatch` しても次の cycle で再び対象になる。判定は `last_run_at` と `run_count` で行う。
 */
export const WATCH_COOLDOWN_HOURS = 24
/** 同じ日に登録した watch は同時に候補になる。載せなかった分は `last_shown_at` の古い順に次の回へ回す。 */
export const STALLED_SHOW_MAX = 3
export const EXPIRING_DAYS = 2
export const IDLE_WAKE_HOURS = 24
export const REFUSED_LIMIT = 5

/** 残っている watch や期限の近い承認待ちは実行しても解消しないので、新しい入力が無いかぎり間を空ける。 */
export const ACTIVE_COOLDOWN_HOURS = 1.5

/** 理由の組み合わせが前回と同じなら cooldown を倍にしていく上限。新しい入力で 0 に戻る。 */
export const MAX_COOLDOWN_HOURS = 24

/** 早すぎるとその日の走行記録がまだ無く、材料が前日分だけになる。 */
export const dailyDraftHour = (): number => appConfig().schedule.dailyDraftHour

const daysBetween = (fromIso: string, toMs: number) => (toMs - Date.parse(fromIso)) / 86_400_000

const resolveWatch = (
  rows: readonly Row[],
  idOrPrefix: string,
):
  | { readonly found: true; readonly value: WatchRow }
  | { readonly found: false; readonly error: NotFound | Conflict } => {
  if (rows.length === 0) return { found: false, error: new NotFound({ what: "watch", id: idOrPrefix }) }
  if (rows.length > 1) {
    return {
      found: false,
      error: new Conflict({ what: "watch", id: idOrPrefix, reason: `${rows.length} 件に当たる` }),
    }
  }
  return { found: true, value: rows[0] as unknown as WatchRow }
}

const makeAttention = () =>
  Effect.gen(function* () {
    const db = yield* Db

    const watch = (
      subject: string,
      nextMoveOwner: NextMove = "famulus",
      opts?: { at?: string; sourceRef?: unknown; cooldownHours?: number },
    ) =>
      Effect.gen(function* () {
        const id = randomUUID()
        const at = opts?.at ?? nowIso()
        yield* db.run(
          `INSERT INTO watchlist (id, subject, opened_at, last_activity_at, next_move_owner, status, source_ref, cooldown_hours)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
          id,
          subject,
          at,
          at,
          nextMoveOwner,
          opts?.sourceRef === undefined ? null : JSON.stringify(opts.sourceRef),
          opts?.cooldownHours ?? WATCH_COOLDOWN_HOURS,
        )
        return id
      })

    const findWatch = (idOrPrefix: string) =>
      Effect.gen(function* () {
        const rows = yield* db.all(
          "SELECT * FROM watchlist WHERE id = ?OR id LIKE ? || '%' LIMIT 5",
          idOrPrefix,
          idOrPrefix,
        )
        const resolved = resolveWatch(rows, idOrPrefix)
        return resolved.found ? resolved.value : yield* Effect.fail(resolved.error)
      })

    // 書き換えた後の行を返す(以下も同じ)。前方一致で受けるので、id から引き直すと同じ行に当たる保証が無い。
    const touchWatch = (idOrPrefix: string, nextMoveOwner?: NextMove, at: string = nowIso()) =>
      Effect.gen(function* () {
        const w = yield* findWatch(idOrPrefix)
        const owner = nextMoveOwner ?? w.next_move_owner
        yield* db.run(
          "UPDATE watchlist SET last_activity_at = ?, next_move_owner = ?WHERE id = ?",
          at,
          owner,
          w.id,
        )
        return { ...w, last_activity_at: at, next_move_owner: owner } satisfies WatchRow
      })

    /**
     * cooldown はここからしか始まらない。`touchWatch` とは別で、何も出てこなかった回も実行に数える。
     * `ranAt` は実行した時刻で、過去は受けるが未来は now に丸める(cooldown を任意に伸ばせないように)。
     */
    const recordWatchRun = (idOrPrefix: string, result: string, ranAt?: string) =>
      db.withImmediateTransaction<WatchRow, NotFound | Conflict>("record watch run", (tx, abort) => {
        const resolved = resolveWatch(
          tx.all("SELECT * FROM watchlist WHERE id = ?OR id LIKE ? || '%' LIMIT 5", idOrPrefix, idOrPrefix),
          idOrPrefix,
        )
        if (!resolved.found) return abort(resolved.error)
        const w = resolved.value
        const now = nowIso()
        const at = ranAt === undefined || ranAt > now ? now : ranAt
        // 後から記録するとき、その間に来た返事のほうが新しいので戻さない。
        const activity = at > w.last_activity_at ? at : w.last_activity_at
        tx.run(
          "INSERT INTO watch_runs (watch_id, at, result, cycle_id)VALUES (?, ?, ?, ?)",
          w.id,
          at,
          result,
          currentCycleId() ?? null,
        )
        tx.run(
          `UPDATE watchlist
                SET last_run_at = ?, last_activity_at = ?, run_count = run_count + 1, last_result = ?
              WHERE id = ?`,
          at,
          activity,
          result,
          w.id,
        )
        return {
          ...w,
          last_run_at: at,
          last_activity_at: activity,
          run_count: w.run_count + 1,
          last_result: result,
        } satisfies WatchRow
      })

    const closeWatch = (idOrPrefix: string) =>
      Effect.gen(function* () {
        const w = yield* findWatch(idOrPrefix)
        yield* db.run("UPDATE watchlist SET status = 'closed' WHERE id = ?", w.id)
        return { ...w, status: "closed" } satisfies WatchRow
      })

    /**
     * `last_run_at` と別の列にするのは、実行しなかった watch が次の回も先頭に残り続けないため。
     * planCycle は idle の回にも走るので、呼ぶのはプロンプトを組み立てる側。
     */
    const noteShown = (ids: readonly string[], at: string = nowIso()) =>
      Effect.gen(function* () {
        if (ids.length === 0) return 0
        yield* db.run(
          `UPDATE watchlist SET last_shown_at = ?WHERE id IN (${ids.map(() => "?").join(",")})`,
          at,
          ...ids,
        )
        return ids.length
      })

    const openWatches = (nowMs: number = Date.now()) =>
      db.all("SELECT * FROM watchlist WHERE status = 'open' ORDER BY last_activity_at ASC").pipe(
        Effect.map((rows) =>
          (rows as unknown as WatchRow[]).map((r) => {
            const dueAtMs =
              r.last_run_at === null ? nowMs : Date.parse(r.last_run_at) + r.cooldown_hours * 3_600_000
            return {
              ...r,
              stalledDays: Math.floor(daysBetween(r.last_activity_at, nowMs)),
              dueNow: dueAtMs <= nowMs,
              dueInHours: Math.max(0, (dueAtMs - nowMs) / 3_600_000),
            }
          }),
        ),
      )

    const ask = (question: string, at: string = nowIso()) =>
      Effect.gen(function* () {
        const id = randomUUID()
        yield* db.run(
          "INSERT INTO questions (id, question, opened_at, status, confidence)VALUES (?, ?, ?, 'open', 'unverified')",
          id,
          question,
          at,
        )
        return id
      })

    const findQuestion = (idOrPrefix: string) =>
      Effect.gen(function* () {
        const rows = yield* db.all(
          "SELECT * FROM questions WHERE id = ?OR id LIKE ? || '%' LIMIT 5",
          idOrPrefix,
          idOrPrefix,
        )
        if (rows.length === 0) return yield* Effect.fail(new NotFound({ what: "問い", id: idOrPrefix }))
        if (rows.length > 1) {
          return yield* Effect.fail(
            new Conflict({ what: "問い", id: idOrPrefix, reason: `${rows.length} 件に当たる` }),
          )
        }
        return rows[0] as unknown as QuestionRow
      })

    const answer = (idOrPrefix: string, text: string, opts?: { eventId?: string; confirmed?: boolean }) =>
      Effect.gen(function* () {
        const q = yield* findQuestion(idOrPrefix)
        const confidence = opts?.confirmed ? "confirmed" : "unverified"
        yield* db.run(
          "UPDATE questions SET status = 'answered', answer = ?, confidence = ?, resolved_event_id = ?WHERE id = ?",
          text,
          confidence,
          opts?.eventId ?? null,
          q.id,
        )
        return { ...q, status: "answered", answer: text, confidence } satisfies QuestionRow
      })

    // 無いと古い問いが `openQuestions` の上限を埋め、新しい問いが cycle に届かない。
    const drop = (idOrPrefix: string, why: string) =>
      Effect.gen(function* () {
        const q = yield* findQuestion(idOrPrefix)
        yield* db.run("UPDATE questions SET status = 'dropped', answer = ?WHERE id = ?", why, q.id)
        return { ...q, status: "dropped", answer: why } satisfies QuestionRow
      })

    const openQuestions = (limit = 20) =>
      db
        .all("SELECT * FROM questions WHERE status = 'open' ORDER BY opened_at ASC LIMIT ?", limit)
        .pipe(Effect.map((rows) => rows as unknown as QuestionRow[]))

    // cursor は進めない。途中で失敗した回の入力を次の cycle で見直すため、`completeCycle` で進める。
    const planCycle = (nowMs: number = Date.now(), draftHour: number = dailyDraftHour()) =>
      Effect.gen(function* () {
        const at = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z")
        const cursorRaw = yield* db.meta("cycle:cursor")
        const cursor = Number(cursorRaw ?? 0)

        // 自分の書き込みと、対話 REPL が処理済みの owner 入力は実行条件にしない。
        const newEvents = (yield* db.all(
          `SELECT seq AS rowid, id, at, source, taint, content, origin_id, provenance FROM events
            WHERE seq > ?AND source != 'system' AND COALESCE(origin_kind,'') != 'chat'
              AND content IS NOT NULL
            ORDER BY seq ASC LIMIT 50`,
          cursor,
        )) as unknown as ObservedEvent[]

        // `dueNow` が無いと famulus-owned の watch は毎回の cycle で対象になる。
        const due = (yield* openWatches(nowMs)).filter(
          (w) => w.dueNow && (w.next_move_owner === "famulus" || w.stalledDays >= STALLED_DAYS),
        )
        // cooldown が同時に終わった watch の順序を決めるのは last_shown_at だけ。NULL が先頭。
        const queued = [...due].sort((a, b) => {
          const sa = a.last_shown_at ?? ""
          const sb = b.last_shown_at ?? ""
          return sa === sb ? a.last_activity_at.localeCompare(b.last_activity_at) : sa.localeCompare(sb)
        })
        const stalled = queued.slice(0, STALLED_SHOW_MAX)
        const stalledHeld = queued.length - stalled.length
        const questions = yield* openQuestions()
        const pendingRows = yield* db.all(
          `SELECT id, summary, created_at, expires_at, settled_note FROM proposals
            WHERE status = 'proposed' AND expires_at > ?ORDER BY expires_at ASC`,
          at,
        )
        const pending: PendingProposal[] = pendingRows.map((r) => ({
          id: String(r.id),
          summary: String(r.summary),
          created_at: String(r.created_at),
          expires_at: String(r.expires_at),
          daysLeft: Math.floor(daysBetween(at, Date.parse(String(r.expires_at)))),
          settled_note:
            r.settled_note === null || r.settled_note === undefined ? null : String(r.settled_note),
        }))

        // 断られた提案は期間では落とさず、件数で切る。
        const refusedRows = yield* db.all(
          `SELECT p.id, p.summary, p.deny_reason, COALESCE(a.at, p.created_at)AS decided_at
             FROM proposals p
              LEFT JOIN proposal_actions a ON a.proposal_id = p.id AND a.action = 'deny'
            WHERE p.status = 'denied' AND p.deny_reason IS NOT NULL
            ORDER BY decided_at DESC LIMIT ?`,
          REFUSED_LIMIT,
        )
        const refused: RefusedProposal[] = refusedRows.map((r) => ({
          id: String(r.id),
          summary: String(r.summary),
          reason: String(r.deny_reason),
          at: String(r.decided_at),
        }))

        const lastActive = yield* db.meta("cycle:last_active")
        const sinceLastActiveHours = lastActive
          ? (nowMs - Date.parse(lastActive)) / 3_600_000
          : Number.POSITIVE_INFINITY

        // 未解決の問いは実行条件にしない。自分で解消できないものが多く、同じ問いで実行し続ける。
        const reasons: string[] = []
        if (newEvents.length > 0) reasons.push(`まだ見ていない入力が ${newEvents.length} 件`)
        // 結論を記録済みのものは数えない。承認はユーザーしか出せず、実行しても同じ結論を書くだけ。
        const expiring = pending.filter((p) => p.daysLeft <= EXPIRING_DAYS && p.settled_note === null)

        // reasonKey に件数も経過時間も入れない。件数だと1件増えただけでバックオフが数え直しになり、
        // 経過時間だとバックオフが上限に達した時点で key が変わって 1.5 時間と 24 時間を往復する。
        const overdue = sinceLastActiveHours >= IDLE_WAKE_HOURS
        const reasonKey = [queued.length > 0 ? "stalled" : "", expiring.length > 0 ? "expiring" : ""]
          .filter(Boolean)
          .join("+")

        const lastKey = yield* db.meta("cycle:reason_key")
        const repeats =
          reasonKey !== "" && reasonKey === lastKey ? Number((yield* db.meta("cycle:repeat")) ?? 0) : 0
        const cooldownHours = Math.min(ACTIVE_COOLDOWN_HOURS * 2 ** repeats, MAX_COOLDOWN_HOURS)

        const cooled = sinceLastActiveHours >= cooldownHours
        if (cooled) {
          // 載せる数ではなく待っている全数を書く。載せる数だと残りの件数が分からない。
          if (queued.length > 0) reasons.push(`対応対象の watch が ${queued.length} 件`)
          if (expiring.length > 0) reasons.push(`期限が近い承認待ちが ${expiring.length} 件`)
          if (overdue) reasons.push(`前回の実働から ${IDLE_WAKE_HOURS} 時間以上`)
        }

        // 下書きは cooldown の対象外。抑えると、別の理由で動いた直後の日は下書きが出ない。
        const draftRow = yield* db.get(
          `SELECT title,body,dossier_id,state,review_feedback,delivered_at FROM drafts
            WHERE delivered_at IS NULL AND state IN ('review_pending','revision_needed','delivery_pending')
            ORDER BY local_day,created_at LIMIT 1`,
        )
        const day = localDayRange(at)
        const deliveredToday = yield* db.get(
          "SELECT 1 FROM drafts WHERE delivered_at>=? AND delivered_at<? LIMIT 1",
          day.startIso,
          day.endIso,
        )
        const failedToday = yield* db.get(
          "SELECT 1 FROM drafts WHERE state='delivery_failed' AND updated_at>=? AND updated_at<? LIMIT 1",
          day.startIso,
          day.endIso,
        )
        const draftDue = Boolean(draftRow) || (localHour(at) >= draftHour && !deliveredToday && !failedToday)
        if (draftDue) reasons.push("今日ぶんの下書きがまだ出ていない")

        return {
          at,
          cursor,
          newEvents,
          stalled,
          stalledHeld,
          openQuestions: questions,
          pending,
          refused,
          sinceLastActiveHours,
          reasons,
          // 新しい入力があればバックオフを 0 に戻す。
          reasonKey: newEvents.length > 0 ? "" : reasonKey,
          cooldownHours,
          draftDue,
          ...(draftRow && draftRow.delivered_at == null
            ? {
                pendingDraft: {
                  title: String(draftRow.title),
                  body: String(draftRow.body),
                  dossierId: String(draftRow.dossier_id),
                  state: draftRow.state as "review_pending" | "revision_needed" | "delivery_pending",
                  ...(draftRow.review_feedback ? { reviewFeedback: String(draftRow.review_feedback) } : {}),
                },
              }
            : {}),
          idle: reasons.length === 0,
        } satisfies CyclePlan
      })

    /**
     * cycle からは `upto`(その回が見た最後の行)を必ず渡す。省略すると最大 seq まで進み、
     * 走行中に届いた行まで既読になる。省略してよいのは対話セッションの終わりだけ。
     */
    const completeCycle = (opts?: { active?: boolean; at?: string; reasonKey?: string; upto?: number }) =>
      db.withImmediateTransaction("complete cycle", (tx) => {
        const meta = (key: string) =>
          tx.get("SELECT value FROM schema_meta WHERE key = ?", key)?.value as string | undefined
        const setMeta = (key: string, value: string) =>
          tx.run("INSERT OR REPLACE INTO schema_meta (key, value)VALUES (?, ?)", key, value)
        const upto = opts?.upto ?? Number(tx.get("SELECT COALESCE(MAX(seq),0)m FROM events")?.m ?? 0)
        // 遅れて終わった回が cursor を戻さないように max を取る。
        setMeta("cycle:cursor", String(Math.max(upto, Number(meta("cycle:cursor") ?? 0))))
        const at = opts?.at ?? nowIso()
        const last = meta("cycle:last")
        setMeta("cycle:last", last && Date.parse(last) > Date.parse(at) ? last : at)
        if (!opts?.active) return
        const lastActive = meta("cycle:last_active")
        setMeta("cycle:last_active", lastActive && Date.parse(lastActive) > Date.parse(at) ? lastActive : at)
        // この組み合わせで起きた回数を数えるので、初回も 1 になる。
        const key = opts.reasonKey ?? ""
        const prev = meta("cycle:reason_key")
        const seen = key === "" ? 0 : (key === prev ? Number(meta("cycle:repeat") ?? 0) : 0) + 1
        setMeta("cycle:reason_key", key)
        setMeta("cycle:repeat", String(seen))
      })

    return {
      watch,
      touchWatch,
      recordWatchRun,
      closeWatch,
      openWatches,
      noteShown,
      findWatch,
      ask,
      answer,
      drop,
      findQuestion,
      openQuestions,
      planCycle,
      completeCycle,
    } as const
  })

export class Attention extends Context.Service<Attention, Effect.Success<ReturnType<typeof makeAttention>>>()(
  "Attention",
) {
  static readonly layer = Layer.effect(Attention, makeAttention())
}
