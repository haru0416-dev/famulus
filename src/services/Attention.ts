/**
 * 起きたときに何を見るかを DB 側に持つ。`watchlist`(未決の追跡対象)と
 * `questions`(未検証の仮説)の2枚。
 *
 * `questions` を `belief_slots` と分けてあるのは、確認していないことが事実として溜まらない
 * ようにするため。自走中は答え合わせをする相手がいない。
 *
 * `digest` はモデルを呼ばない。起こすかどうかを SQL だけで決める。
 */
import { randomUUID } from "node:crypto"
import * as Effect from "effect/Effect"
import { Conflict, NotFound } from "../core/errors.ts"
import { dayRange, localHour, nowIso } from "../core/time.ts"
import { Db } from "./Db.ts"

/**
 * 次に動くのは誰か。`famulus` は自分(SOUL.md の名前)。
 * `counterparty`(第三者)は実データ0件のまま落とした(docs/adr/0033)。
 */
export type NextMove = "human" | "famulus"

export interface WatchRow {
  readonly id: string
  readonly subject: string
  readonly opened_at: string
  readonly last_activity_at: string
  readonly next_move_owner: NextMove
  readonly status: "open" | "closed"
  /** 最後に回した時刻。null = 一度も回していない。 */
  readonly last_run_at: string | null
  readonly cooldown_hours: number
  readonly run_count: number
  /** 前回回して分かったこと。次に回すときの起点になる。 */
  readonly last_result: string | null
  /** 最後にプロンプトに載せた時刻。載せたが回さなかった回はここだけ進む。 */
  readonly last_shown_at: string | null
}

/** watch している件に、経過日数と冷却の残りを添えたもの。プロンプトに載せるかの判断材料。 */
export interface WatchView extends WatchRow {
  readonly stalledDays: number
  /** 冷却が明けているか。明けていないものはプロンプトに載せない。 */
  readonly dueNow: boolean
  /** 冷却明けまでの時間。0 なら今すぐ回してよい。 */
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
  /** tick が前に置いた結論。あるものは起こす理由に数えない(承認はユーザーしか出せない)。 */
  readonly settled_note: string | null
}

/**
 * 断られた提案と理由。同じ用件をもう一度出さないためにプロンプトへ渡す(docs/adr/0017)。
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
  readonly at: string
  readonly source: string
  /** 1 なら不信データ由来(gmail/web)。tick はこれを見て境界マーカーで囲う。 */
  readonly taint: number
  readonly content: string
}

/** tick 1回ぶんの入力。`idle` ならモデルを呼ばない。`reasons` は起こした理由。 */
export interface Digest {
  readonly at: string
  readonly cursor: number
  readonly newEvents: readonly ObservedEvent[]
  /** この回に載せるぶんだけ(最大 `STALLED_SHOW_MAX` 件)。冷却明けの全部ではない。 */
  readonly stalled: readonly WatchView[]
  /** 冷却は明けているが、この回は載せなかった件数。プロンプトに数だけ出す。 */
  readonly stalledHeld: number
  readonly openQuestions: readonly QuestionRow[]
  readonly staleBeliefs: readonly StaleBelief[]
  readonly pending: readonly PendingProposal[]
  readonly refused: readonly RefusedProposal[]
  readonly sinceLastActiveHours: number
  readonly reasons: readonly string[]
  /** 理由の組み合わせ(件数を除いたもの)。前回と同じなら次の冷却が伸びる。`commit` に渡す。 */
  readonly reasonKey: string
  /** この tick で満たすべきだった冷却時間。後退が効いているかを外から見るため。 */
  readonly cooldownHours: number
  /** 今日ぶんの下書きがまだ出ていない。冷却を無視して起きる(1日1回しか立たない)。 */
  readonly draftDue: boolean
  readonly idle: boolean
}

/** 現在区間の `valid_from` が古い belief。確認からの経過時間ではない。 */
export interface StaleBelief {
  readonly slot: string
  readonly value: string
  readonly valid_from: string
}

/** human-owned watch を滞留とみなす日数。famulus-owned はこの日数を待たず、個別冷却だけを見る。 */
export const STALLED_DAYS = 3

/**
 * watch を回した後、次にプロンプトに載せるまでの既定時間(docs/adr/0013)。
 *
 * `last_activity_at` では止まらない。`digest` は `next_move_owner = 'famulus'` の watch を
 * 無条件で滞留に入れるので、回して `touchWatch` しても次の tick でまた上がる。列が無かった
 * ときは、モデルが最終走行時刻を subject の文字列に書き込んで登録し直していた。
 * 判定は `last_run_at` と `run_count` で行う。
 */
export const WATCH_COOLDOWN_HOURS = 24
/**
 * 1回の tick で載せる watch の上限(docs/adr/0028)。
 *
 * 同じ日に登録した watch は同じ日に冷却が明けるので、明けたぶんが全部そろって上がる。
 * 直近40回を調べると6件が同時に載る状態が続き、watch で起きた9回のうち
 * 7回が道具呼び出し4回以下で終わっていた。載せなかったぶんは `last_shown_at` の古い順で
 * 次の回に上がる。3 は 420 秒の持ち時間から採った。
 *
 * 上限そのものの効き目は測れていない。6件同時の状態を再現して前後1回ずつ走らせたが、
 * 上限なしの回も 11 手 / 305 秒で1件を回しており、短い終わり方は再現しなかった。
 * 検査で押さえてあるのは順番が回ることだけ。
 */
export const STALLED_SHOW_MAX = 3
/** 承認待ちがこの日数以内に期限切れになるなら、tick でユーザーに思い出させる材料にする。 */
export const EXPIRING_DAYS = 2
/** 何も無くてもこの時間が経ったら1回起こす(反応するだけの機械にしないための下限)。 */
export const IDLE_WAKE_HOURS = 24
/** tick のプロンプトに載せる「断られたぶん」の数。起こす理由には数えない。 */
export const REFUSED_LIMIT = 5
/**
 * 現在区間の `valid_from` がこの日数より古い belief を、棚卸しの材料にする。
 *
 * これは確認鮮度ではなく、事実が真になった時点からの経過を見る。古いだけで誤りとは限らないため、
 * 起こす理由には数えず、別の理由で起きた回に確認候補として渡す。
 *
 * 起こす理由には数えない。理由にすると、答えが返るまで毎回同じ slot で起き続ける。
 */
export const STALE_BELIEF_DAYS = 90

/**
 * 一度動いたら、この時間は新しい入力が無いかぎり動かない。
 *
 * 「未解決の問いがある」「watch が動いていない」は、動いても解消しない理由になりうる
 * (ユーザーしか答えられない問い、相手待ちの案件)。冷却が無いと同じ理由で回り続ける。
 * 外から新しい入力が来たときだけ飛び越える。
 */
export const ACTIVE_COOLDOWN_HOURS = 1.5

/**
 * 同じ理由で続けて起きるほど、次に起きるまでを倍にする。
 *
 * `ACTIVE_COOLDOWN_HOURS` は間隔を空けるだけなので、動いても解消しない理由だと
 * 1.5 時間ごとに同じ材料で回り続ける。理由の組み合わせが前回と同じなら
 * 1.5h → 3h → 6h → 12h → 24h と伸ばす。外から新しい入力が来たら 0 に戻る。
 */
export const MAX_COOLDOWN_HOURS = 24

/**
 * 1日1本の下書きを出す時刻(ユーザーの時計)。これより前には出さない。
 * 早い時刻だと、その日の走行記録がまだ無く、材料が前日ぶんだけになる。
 */
export const dailyDraftHour = (): number => Number(process.env.OPEN_ZERO_DAILY_HOUR ?? 20)

const daysBetween = (fromIso: string, toMs: number) => (toMs - Date.parse(fromIso)) / 86_400_000

export class Attention extends Effect.Service<Attention>()("Attention", {
  effect: Effect.gen(function* () {
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
        if (rows.length === 0) return yield* Effect.fail(new NotFound({ what: "watch", id: idOrPrefix }))
        if (rows.length > 1) {
          return yield* Effect.fail(
            new Conflict({ what: "watch", id: idOrPrefix, reason: `${rows.length} 件に当たる` }),
          )
        }
        return rows[0] as unknown as WatchRow
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
     * 回した記録を付ける。冷却はここからしか始まらない。
     *
     * `touchWatch`(動きがあった)と分けてある。相手から返事が来たのは動きだが自分は回していない。
     * 逆に、何も出てこなかった回も回したことに数える。
     *
     * `result` は次に回すときの起点にする。無かったときは AI追跡の watch 3件が全部
     * 「HN の新着を全部見る」になり、差分を言えたことが無かった。
     *
     * `at` は回した時刻で、記録した時刻ではない。後から記録するとき今の時刻を入れると冷却が
     * その分ずれるので、過去は渡せる。未来は取らない(渡せると冷却を好きなだけ伸ばせる)。
     */
    const ranWatch = (idOrPrefix: string, result: string, ranAt?: string) =>
      Effect.gen(function* () {
        const w = yield* findWatch(idOrPrefix)
        const now = nowIso()
        const at = ranAt === undefined || ranAt > now ? now : ranAt
        // 動きの時刻は戻さない。後から記録するとき、その間に来た返事のほうが新しい。
        const activity = at > w.last_activity_at ? at : w.last_activity_at
        yield* db.run(
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
     * プロンプトに載せたことを記録する。回したことではない。`ranWatch` と同じ列にすると、
     * 回さなかった watch が次の回もまた先頭に来て同じ数件が居座る。
     *
     * 呼ぶのは digest ではなくプロンプトを組み立てる側。digest は起きる理由が無い回にも走るので、
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
            // 一度も回していないものは今すぐ回してよい(NULL を「大昔に回した」とは読まない)。
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
     * 答えないまま問いを畳む。`answer` しか出口が無いと、答える意味を失った問いも開いたまま残る。
     * `openQuestions` は古い順に上限件数だけ渡すので、それが上限を埋めると新しい問いが tick に届かない。
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

    // ── tick の視野

    /**
     * 何を見て起きるべきかを SQL だけで決める。モデルは呼ばない。
     * 見た位置(cursor)は進めない — tick が最後まで走り切ってから `commit` で進める
     * (途中で落ちたら、次の tick が同じ入力をもう一度見る = 取りこぼさない)。
     */
    const digest = (nowMs: number = Date.now()) =>
      Effect.gen(function* () {
        const at = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z")
        const cursorRaw = yield* db.meta("tick:cursor")
        const cursor = Number(cursorRaw ?? 0)

        // 自分が書いたもの(source='system')では起きない。起こすのは外から来た入力だけ。
        const newEvents = (yield* db.all(
          `SELECT rowid, at, source, taint, content FROM events
            WHERE rowid > ?AND source != 'system' AND content IS NOT NULL
            ORDER BY rowid ASC LIMIT 50`,
          cursor,
        )) as unknown as ObservedEvent[]

        // 冷却が明けたものだけ。`next_move_owner = 'famulus'` は無条件で滞留に入るので、
        // `dueNow` を挟まないと自分持ちの watch は回しても毎回の tick に上がり続ける。
        const due = (yield* openWatches(nowMs)).filter(
          (w) => w.dueNow && (w.next_move_owner === "famulus" || w.stalledDays >= STALLED_DAYS),
        )
        // 載せた時刻の古い順。冷却が同時に明けたぶんに順番を付けるのはこの列だけ。
        // NULL(一度も載せていない)を先頭に置く。同着は最後の動きが古いほうから。
        const queued = [...due].sort((a, b) => {
          const sa = a.last_shown_at ?? ""
          const sb = b.last_shown_at ?? ""
          return sa === sb ? a.last_activity_at.localeCompare(b.last_activity_at) : sa.localeCompare(sb)
        })
        const stalled = queued.slice(0, STALLED_SHOW_MAX)
        const stalledHeld = queued.length - stalled.length
        const questions = yield* openQuestions()
        // 現在区間の valid_from が古い事実。確認鮮度ではないので、消さずに棚卸し材料として渡す。
        const staleBefore = new Date(nowMs - STALE_BELIEF_DAYS * 86_400_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z")
        const staleBeliefs = (yield* db.all(
          `SELECT slot, value, valid_from FROM belief_slots
            WHERE valid_until IS NULL AND valid_from < ?
            ORDER BY valid_from ASC LIMIT 10`,
          staleBefore,
        )) as unknown as StaleBelief[]
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
          `SELECT p.id, p.summary, p.deny_reason, COALESCE(d.at, p.created_at)AS decided_at
             FROM proposals p
             LEFT JOIN decisions d ON d.proposal_id = p.id AND d.verb = 'deny'
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

        const lastActive = yield* db.meta("tick:last_active")
        const sinceLastActiveHours = lastActive
          ? (nowMs - Date.parse(lastActive)) / 3_600_000
          : Number.POSITIVE_INFINITY

        // 起こす理由。未解決の問いは理由にしない — 自分では解消できないものが多く、
        // 理由に数えると同じ問いで起き続ける。起きたときの材料としてだけ渡す。
        const reasons: string[] = []
        if (newEvents.length > 0) reasons.push(`まだ見ていない入力が ${newEvents.length} 件`)
        // 結論を置いたものは数えない。承認を出せるのはユーザーだけなので、tick が起きても
        // 「あなた待ちです」をもう一度書くだけになる。承認はまだ要るので一覧には残す。
        const expiring = pending.filter((p) => p.daysLeft <= EXPIRING_DAYS && p.settled_note === null)

        // 組み合わせはプロンプトに何が載っているかだけ。件数も経過時間も入れない。
        // 件数を入れると watch が1件増えただけで新しい理由になり、後退が掛からない。
        // 経過時間(24時間超え)を入れると、後退が上限に達した瞬間に組み合わせが変わって
        // 数え直しになり、1.5時間と24時間を往復する。
        const overdue = sinceLastActiveHours >= IDLE_WAKE_HOURS
        const reasonKey = [queued.length > 0 ? "stalled" : "", expiring.length > 0 ? "expiring" : ""]
          .filter(Boolean)
          .join("+")

        // 前回と同じ組み合わせで起きた回数だけ、次に起きるまでを倍にする。
        const lastKey = yield* db.meta("tick:reason_key")
        const repeats =
          reasonKey !== "" && reasonKey === lastKey ? Number((yield* db.meta("tick:repeat")) ?? 0) : 0
        const cooldownHours = Math.min(ACTIVE_COOLDOWN_HOURS * 2 ** repeats, MAX_COOLDOWN_HOURS)

        // 新しい入力が無いなら、直前に動いたばかりの tick は動かない(自家中毒を止める)。
        const cooled = sinceLastActiveHours >= cooldownHours
        if (cooled) {
          // 冷却が明けた全部の数を書く。載せる数で書くと、6件待っている回と
          // 3件しか無い回が同じ文になり、後ろに何件溜まっているかが出ない。
          if (queued.length > 0) reasons.push(`動いていない watch が ${queued.length} 件`)
          if (expiring.length > 0) reasons.push(`期限が近い承認待ちが ${expiring.length} 件`)
          if (overdue) reasons.push(`前回の棚卸しから ${IDLE_WAKE_HOURS} 時間以上`)
        }

        // 冷却の外に出す。1日に1回しか立たない理由で、抑えると夕方に別の理由で動いた日は
        // 下書きが丸ごと落ちる。
        const draftDue =
          localHour(at) >= dailyDraftHour() && (yield* db.meta("daily:draft")) !== dayRange(at).key
        if (draftDue) reasons.push("今日ぶんの下書きがまだ出ていない")

        return {
          at,
          cursor,
          newEvents,
          stalled,
          stalledHeld,
          openQuestions: questions,
          staleBeliefs,
          pending,
          refused,
          sinceLastActiveHours,
          reasons,
          // 新しい入力で起きたなら組み合わせは「新しい」— 後退を 0 に戻す。
          reasonKey: newEvents.length > 0 ? "" : reasonKey,
          cooldownHours,
          draftDue,
          idle: reasons.length === 0,
        } satisfies Digest
      })

    /**
     * tick を見終えた位置を確定する。
     *
     * `upto` はその回が実際に見た最後の行。渡さないと今の最大 rowid まで進むので、
     * 走っている最中に届いた行(digest に載っていない行)まで既読になる。tick からは必ず渡す。
     *
     * 渡さない経路(対話セッションの終わり)は、自分が書いた行ごと消費してよい場面に限る。
     * tick 自身の書き込みで tick が起きることは無い(digest が `source='system'` を外している)。
     */
    const commit = (opts?: { active?: boolean; at?: string; reasonKey?: string; upto?: number }) =>
      Effect.gen(function* () {
        let upto = opts?.upto
        if (upto === undefined) {
          const max = yield* db.get("SELECT COALESCE(MAX(rowid),0)m FROM events")
          upto = Number(max?.m ?? 0)
        }
        yield* db.setMeta("tick:cursor", String(upto))
        const at = opts?.at ?? nowIso()
        yield* db.setMeta("tick:last", at)
        if (!opts?.active) return
        yield* db.setMeta("tick:last_active", at)
        // 理由の組み合わせが前回と同じなら後退を1段深くする。違えば数え直し。
        // 数えるのはこの組み合わせで起きた回数なので、初めて記録する回も 1 になる。
        const key = opts.reasonKey ?? ""
        const prev = yield* db.meta("tick:reason_key")
        const seen = key === "" ? 0 : (key === prev ? Number((yield* db.meta("tick:repeat")) ?? 0) : 0) + 1
        yield* db.setMeta("tick:reason_key", key)
        yield* db.setMeta("tick:repeat", String(seen))
      })

    return {
      watch,
      touchWatch,
      ranWatch,
      closeWatch,
      openWatches,
      noteShown,
      findWatch,
      ask,
      answer,
      drop,
      findQuestion,
      openQuestions,
      digest,
      commit,
    } as const
  }),
}) {}
