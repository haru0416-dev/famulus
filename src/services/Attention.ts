/**
 * cycle の実行時に何を見るかを DB 側に持つ。`watchlist`(未決の追跡対象)と
 * `questions`(未検証の仮説)の2枚。
 *
 * `questions` を `belief_slots` と分けてあるのは、確認していないことが事実として溜まらない
 * ようにするため。自走中は答え合わせをする相手がいない。
 *
 * `planCycle` はモデルを呼ばない。モデル実行が必要かを SQL だけで決める。
 */
import { randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { appConfig } from "../core/config.ts"
import { Conflict, NotFound } from "../core/errors.ts"
import { localDayRange, localHour, nowIso } from "../core/time.ts"
import { Db, type Row } from "./Db.ts"

/**
 * 次に処理する主体。`human` か `famulus` の2値。`famulus` は自律エージェント(SOUL.md の名前)。
 */
export type NextMove = "human" | "famulus"

export interface WatchRow {
  readonly id: string
  readonly subject: string
  readonly opened_at: string
  readonly last_activity_at: string
  readonly next_move_owner: NextMove
  readonly status: "open" | "closed"
  /** 最後に実行した時刻。null = 一度も実行していない。 */
  readonly last_run_at: string | null
  readonly cooldown_hours: number
  readonly run_count: number
  /** 前回実行して分かったこと。次に実行するときの起点になる。 */
  readonly last_result: string | null
  /** 最後にプロンプトに載せた時刻。載せたが実行しなかった回はここだけ進む。 */
  readonly last_shown_at: string | null
}

/** watch している件に、経過日数とcooldownの残りを添えたもの。プロンプトに載せるかの判断材料。 */
export interface WatchView extends WatchRow {
  readonly stalledDays: number
  /** cooldownが終了しているか。終了前のものはプロンプトに載せない。 */
  readonly dueNow: boolean
  /** cooldownの残り時間。0 なら今すぐ実行してよい。 */
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
  /** 自動処理が前に記録した結論。あるものは次回の実行条件に数えない(承認はユーザーしか出せない)。 */
  readonly settled_note: string | null
}

/**
 * 断られた提案と理由。同じ用件をもう一度出さないためにプロンプトへ渡す。
 * 渡していなかったときは、同じ用件が3回出されて3回とも断られた。
 */
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
  /** 1 なら不信データ由来(gmail/web)。cycle はこれを見て境界マーカーで囲う。 */
  readonly taint: number
  readonly content: string
}

/** cycle 1回ぶんの入力。`idle` ならモデルを呼ばない。`reasons` は今回の実行条件。 */
export interface CyclePlan {
  readonly at: string
  readonly cursor: number
  readonly newEvents: readonly ObservedEvent[]
  /** この回に載せるぶんだけ(最大 `STALLED_SHOW_MAX` 件)。cooldown終了後の全部ではない。 */
  readonly stalled: readonly WatchView[]
  /** cooldownは終了しているが、この回は載せなかった件数。プロンプトに数だけ出す。 */
  readonly stalledHeld: number
  readonly openQuestions: readonly QuestionRow[]
  readonly pending: readonly PendingProposal[]
  readonly refused: readonly RefusedProposal[]
  readonly sinceLastActiveHours: number
  readonly reasons: readonly string[]
  /** 理由の組み合わせ(件数を除いたもの)。前回と同じなら次のcooldownが伸びる。`completeCycle` に渡す。 */
  readonly reasonKey: string
  /** この cycle で満たすべきだったcooldown時間。指数バックオフの適用状況を外から見るため。 */
  readonly cooldownHours: number
  /** 今日ぶんの下書きがまだ出ていない。cooldownを無視して実行条件になる(1日1回しか成立しない)。 */
  readonly draftDue: boolean
  /** 今日の未配送draft。レビュー再開時は保存済み本文をそのまま渡す。 */
  readonly pendingDraft?: {
    readonly title: string
    readonly body: string
    readonly dossierId: string
    readonly state: "review_pending" | "revision_needed" | "delivery_pending"
    readonly reviewFeedback?: string
  }
  readonly idle: boolean
}

/** human-owned watch を滞留とみなす日数。famulus-owned はこの日数を待たず、個別cooldownだけを見る。 */
export const STALLED_DAYS = 3

/**
 * watch を実行した後、次にプロンプトに載せるまでの既定時間。
 *
 * `last_activity_at` では止まらない。`planCycle` は `next_move_owner = 'famulus'` の watch を
 * 無条件で滞留に入れるので、実行して `touchWatch` しても次の cycle で再び処理対象になる。列が無かった
 * ときは、モデルが最終走行時刻を subject の文字列に書き込んで登録し直していた。
 * 判定は `last_run_at` と `run_count` で行う。
 */
export const WATCH_COOLDOWN_HOURS = 24
/**
 * 1回の cycle で載せる watch の上限。
 *
 * 同じ日に登録した watch は同じ時刻に再提示可能になり、対象がすべて同時に掲載候補になる。
 * 直近40回を調べると6件が同時に載る状態が続き、watch が実行条件になった9回のうち
 * 7回が道具呼び出し4回以下で終わっていた。載せなかったぶんは `last_shown_at` の古い順で
 * 次の回に掲載する。3 は 420 秒の持ち時間から採った。
 *
 * 上限そのものの結果は測れていない。6件同時の状態を再現して前後1回ずつ走らせたが、
 * 上限なしの回も 11 手 / 305 秒で1件を実行しており、短い終わり方は再現しなかった。
 * 検査で押さえてあるのは順番が回ることだけ。
 */
export const STALLED_SHOW_MAX = 3
/** 承認待ちがこの日数以内に期限切れになるなら、自動処理でユーザーに思い出させる材料にする。 */
export const EXPIRING_DAYS = 2
/** 外部入力が無くても、この時間が経過したら定期確認を実行条件に追加する。 */
export const IDLE_WAKE_HOURS = 24
/** cycle のプロンプトに載せる「断られたぶん」の数。実行条件には数えない。 */
export const REFUSED_LIMIT = 5

/**
 * 一度実行したら、この時間は新しい入力が無いかぎり再実行しない。
 *
 * 「対応対象のwatchが残っている」「承認待ちの期限が近い」は、実行しても解消しない理由になりうる。
 * cooldownが無いと同じ理由で回り続ける。
 * 外部から新しい入力が来た場合だけ、このcooldownを適用しない。
 */
export const ACTIVE_COOLDOWN_HOURS = 1.5

/**
 * 同じ理由で実行が続くほど、次回までのcooldownを倍にする。
 *
 * `ACTIVE_COOLDOWN_HOURS` は間隔を空けるだけなので、実行しても解消しない理由だと
 * 1.5 時間ごとに同じ材料で回り続ける。理由の組み合わせが前回と同じなら
 * 1.5h → 3h → 6h → 12h → 24h と伸ばす。外から新しい入力が来たら 0 に戻る。
 */
export const MAX_COOLDOWN_HOURS = 24

/**
 * 1日1本の下書きを出す時刻(ユーザーの時計)。これより前には出さない。
 * 早い時刻だと、その日の走行記録がまだ無く、材料が前日ぶんだけになる。
 */
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

    // ── watch(watchlist)

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

    /**
     * 動きがあったことを記録する。滞留日数の起点を今に戻す。
     * 書き換えた後の行を返す(以下の書き換えも同じ)。id だけ返すと呼んだ側が引き直すことになり、
     * 前方一致で受けている以上それが同じ行に当たる保証が無い。
     */
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
     * 実行した記録を付ける。cooldownはここからしか始まらない。
     *
     * `touchWatch`(動きがあった)と分けてある。相手から返事が来たのは動きだが自分は実行していない。
     * 逆に、何も出てこなかった回も実行したことに数える。
     *
     * `result` は次に実行するときの起点にする。無かったときは AI追跡の watch 3件が全部
     * 「HN の新着を全部見る」になり、差分を言えたことが無かった。
     *
     * `at` は実行した時刻で、記録した時刻ではない。後から記録するとき今の時刻を入れるとcooldownが
     * その分ずれるので、過去は渡せる。未来は取らない(渡せるとcooldownを好きなだけ伸ばせる)。
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
        // 動きの時刻は戻さない。後から記録するとき、その間に来た返事のほうが新しい。
        const activity = at > w.last_activity_at ? at : w.last_activity_at
        tx.run("INSERT INTO watch_runs (watch_id, at, result)VALUES (?, ?, ?)", w.id, at, result)
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
     * プロンプトに載せたことを記録する。実行したことではない。`recordWatchRun` と同じ列にすると、
     * 実行しなかった watch が次の回もまた先頭に来て同じ数件が残り続ける。
     *
     * 呼ぶのは planCycle ではなくプロンプトを組み立てる側。planCycle は実行条件が無い回にも走るので、
     * そこで記録すると誰も見ていない一覧を載せたことになる。
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
            // 一度も実行していないものは今すぐ実行してよい(NULL を「大昔に実行した」とは読まない)。
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

    // ── 問い(questions)。推測を belief に昇格させないための置き場。

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

    /**
     * 答えないまま問いを取り下げる。`answer` しか終了方法が無いと、答える意味を失った問いも open のまま残る。
     * `openQuestions` は古い順に上限件数だけ渡すので、それが上限を埋めると新しい問いが cycle に届かない。
     * 理由を残して閉じる。
     */
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

    // ── cycle の処理対象

    /**
     * 何を処理するために実行するかを SQL だけで決める。モデルは呼ばない。
     * 見た位置(cursor)は進めない — cycle が最後まで走り切ってから `completeCycle` で進める
     * (途中で失敗したら、次の cycle が同じ入力をもう一度見る = 未処理のまま保持する)。
     */
    const planCycle = (nowMs: number = Date.now(), draftHour: number = dailyDraftHour()) =>
      Effect.gen(function* () {
        const at = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z")
        const cursorRaw = yield* db.meta("cycle:cursor")
        const cursor = Number(cursorRaw ?? 0)

        // 自分が書いたもの(source='system')は実行条件にしない。外部入力だけを対象にする。
        const newEvents = (yield* db.all(
          `SELECT seq AS rowid, id, at, source, taint, content FROM events
            WHERE seq > ?AND source != 'system' AND content IS NOT NULL
            ORDER BY seq ASC LIMIT 50`,
          cursor,
        )) as unknown as ObservedEvent[]

        // cooldownが終了したものだけ。`next_move_owner = 'famulus'` は無条件で候補に入るので、
        // `dueNow` を挟まないと自分持ちの watch は確認後も毎回の cycle で処理対象になり続ける。
        const due = (yield* openWatches(nowMs)).filter(
          (w) => w.dueNow && (w.next_move_owner === "famulus" || w.stalledDays >= STALLED_DAYS),
        )
        // 載せた時刻の古い順。cooldownが同時に終了した対象に順番を付けるのはこの列だけ。
        // NULL(一度も載せていない)を先頭に置く。同着は最後の動きが古いほうから。
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
            WHERE status = 'proposed' ORDER BY expires_at ASC`,
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

        // 断られたぶんは古くなっても落とさない。件数で切る。
        // 落とすなら、その理由を確定値として置いてからにする。
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

        // 実行条件。未解決の問いは条件にしない — 自分では解消できないものが多く、
        // 条件に数えると同じ問いで実行し続ける。実行時の材料としてだけ渡す。
        const reasons: string[] = []
        if (newEvents.length > 0) reasons.push(`まだ見ていない入力が ${newEvents.length} 件`)
        // 結論を置いたものは数えない。承認を出せるのはユーザーだけなので、cycle を実行しても
        // 「あなた待ちです」をもう一度書くだけになる。承認はまだ要るので一覧には残す。
        const expiring = pending.filter((p) => p.daysLeft <= EXPIRING_DAYS && p.settled_note === null)

        // 組み合わせはプロンプトに何が載っているかだけ。件数も経過時間も入れない。
        // 件数を入れると watch が1件増えただけで新しい条件になり、指数バックオフが適用されない。
        // 経過時間(24時間超え)を入れると、バックオフが上限に達した瞬間に組み合わせが変わって
        // 数え直しになり、1.5時間と24時間を往復する。
        const overdue = sinceLastActiveHours >= IDLE_WAKE_HOURS
        const reasonKey = [queued.length > 0 ? "stalled" : "", expiring.length > 0 ? "expiring" : ""]
          .filter(Boolean)
          .join("+")

        // 前回と同じ組み合わせで実行した回数だけ、次回実行までを倍にする。
        const lastKey = yield* db.meta("cycle:reason_key")
        const repeats =
          reasonKey !== "" && reasonKey === lastKey ? Number((yield* db.meta("cycle:repeat")) ?? 0) : 0
        const cooldownHours = Math.min(ACTIVE_COOLDOWN_HOURS * 2 ** repeats, MAX_COOLDOWN_HOURS)

        // 新しい入力が無いなら、直前に動いたばかりの cycle は実行しない(自己起動ループを止める)。
        const cooled = sinceLastActiveHours >= cooldownHours
        if (cooled) {
          // cooldownが終了した全部の数を書く。載せる数で書くと、6件待っている回と
          // 3件しか無い回が同じ文になり、後ろに何件溜まっているかが出ない。
          if (queued.length > 0) reasons.push(`対応対象の watch が ${queued.length} 件`)
          if (expiring.length > 0) reasons.push(`期限が近い承認待ちが ${expiring.length} 件`)
          if (overdue) reasons.push(`前回の実働から ${IDLE_WAKE_HOURS} 時間以上`)
        }

        // cooldownの対象外にする。1日に1回しか成立しない条件で、抑えると夕方に別の理由で動いた日は
        // 下書きが生成されない。
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
          // 新しい入力で起きたなら組み合わせは「新しい」— 後退を 0 に戻す。
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
     * cycle を見終えた位置を確定する。
     *
     * `upto` はその回が実際に見た最後の行。渡さないと今の最大 rowid まで進むので、
     * 走っている最中に届いた行(planCycle に載っていない行)まで既読になる。cycle からは必ず渡す。
     *
     * 渡さない経路(対話セッションの終わり)は、自分が書いた行ごと消費してよい場面に限る。
     * cycle 自身の書き込みで cycle が起きることは無い(planCycle が `source='system'` を外している)。
     */
    const completeCycle = (opts?: { active?: boolean; at?: string; reasonKey?: string; upto?: number }) =>
      Effect.gen(function* () {
        let upto = opts?.upto
        if (upto === undefined) {
          const max = yield* db.get("SELECT COALESCE(MAX(seq),0)m FROM events")
          upto = Number(max?.m ?? 0)
        }
        yield* db.setMeta("cycle:cursor", String(upto))
        const at = opts?.at ?? nowIso()
        yield* db.setMeta("cycle:last", at)
        if (!opts?.active) return
        yield* db.setMeta("cycle:last_active", at)
        // 理由の組み合わせが前回と同じなら後退を1段深くする。違えば数え直し。
        // 数えるのはこの組み合わせで起きた回数なので、初めて記録する回も 1 になる。
        const key = opts.reasonKey ?? ""
        const prev = yield* db.meta("cycle:reason_key")
        const seen = key === "" ? 0 : (key === prev ? Number((yield* db.meta("cycle:repeat")) ?? 0) : 0) + 1
        yield* db.setMeta("cycle:reason_key", key)
        yield* db.setMeta("cycle:repeat", String(seen))
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
