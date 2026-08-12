/**
 * 注意。**自走するために、自分が今なにを気にしているかを DB 側に持つ**。
 *
 * 対話だけなら次に何をするかはユーザーの発話が決める。自走ではその入力が無い時間のほうが長いので、
 * 「起きたとき何を見るか」を DB に置いておく必要がある。それが `watchlist`(watch している未決事項)と
 * `questions`(未 probe の仮説)の2枚。
 *
 * `questions` は `belief_slots` と分けてある。自走中は答え合わせをしてくれる相手がいないので、
 * **推測を belief に昇格させない置き場**が無いと、確認していないことが事実として溜まる。
 *
 * `digest` はモデルを呼ばない。tick のたびに推論を1回回すのではなく、
 * 「回す価値があるか」をまず SQL だけで判定する(定額枠でも窓は有限)。
 */
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { Conflict, NotFound } from "../core/errors.ts"
import { dayRange, localHour, nowIso } from "../core/time.ts"
import { Db } from "./Db.ts"

export type NextMove = "human" | "counterparty" | "famulus"

export interface WatchRow {
  readonly id: string
  readonly subject: string
  readonly opened_at: string
  readonly last_activity_at: string
  readonly next_move_owner: NextMove
  readonly status: "open" | "closed"
  /** 最後に**実際に一周回した**時刻。null = 一度も回していない。 */
  readonly last_run_at: string | null
  readonly cooldown_hours: number
  readonly run_count: number
  /** 前回回して分かったこと。次に回すときの起点になる。 */
  readonly last_result: string | null
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
}

/**
 * 断られた提案と、その理由。**同じ形をもう一度出さないために渡す。**
 *
 * watch に前回の結果を渡すのと同じ理由(docs/adr/0013)。渡さないと、毎回まっさらな状態で
 * 同じ相手に同じ用件を出し直す。実際、同じ用件が3回出されて3回とも断られている。
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
  /** 1 なら不信データ由来(gmail/web)。tick は**これを見て境界マーカーで囲う**。 */
  readonly taint: number
  readonly content: string
}

/**
 * tick1回ぶんの視野。`idle` なら**モデルを呼ばない**。
 * `reasons` は「なぜ起こしたか」— 起きた理由を自分で説明できない tick は作らない。
 */
export interface Digest {
  readonly at: string
  readonly cursor: number
  readonly newEvents: readonly ObservedEvent[]
  readonly stalled: readonly WatchView[]
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
  /** 今日ぶんの下書きがまだ出ていない。**冷却を無視して起きる**(1日1回しか立たない)。 */
  readonly draftDue: boolean
  readonly idle: boolean
}

/** 真だと確かめてから時間が経った belief。「まだ合っているか」を聞くための材料。 */
export interface StaleBelief {
  readonly slot: string
  readonly value: string
  readonly valid_from: string
}

/** これ以上動きが無い watch は滞留として起こす材料にする。 */
export const STALLED_DAYS = 3

/**
 * watch を一周回した後、次にプロンプトに載せるまでの既定時間。
 *
 * **`last_activity_at` では止まらない。** `digest` は `next_move_owner = 'famulus'` の watch を
 * 無条件で滞留に入れるので、回して `touchWatch` しても同じ watch が次の tick でまた上がってくる。
 * 実際にそうなり、モデルは**最終走行時刻を subject の文字列に書き込んで登録し直す**という
 * 回避をしていた(列が無いので文字列で代用するしかない)。
 *
 * 止めるのは経過日数ではなく**回した回数と時刻**でなければならない。回した記録を別の列で持ち、
 * 冷却が明けるまで載せない。OpenClaw の `standing_intents`(`last_fired_at` + `cooldown_seconds` +
 * `fire_count` を見る `canFire`)と同じ形。docs/adr/0013。
 */
export const WATCH_COOLDOWN_HOURS = 24
/** 承認待ちがこの日数以内に期限切れになるなら、tick でユーザーに思い出させる材料にする。 */
export const EXPIRING_DAYS = 2
/** 何も無くてもこの時間が経ったら1回起こす(反応するだけの機械にしないための下限)。 */
export const IDLE_WAKE_HOURS = 24
/**
 * tick のプロンプトに載せる「断られたぶん」の数。
 *
 * **起こす理由には数えない。**断られたことは済んだ話で、それで起きても何も進まない。
 * 別件で起きたときに、同じ形をもう一度出さないための材料として置くだけ。
 */
export const REFUSED_LIMIT = 5
/**
 * 真だと確かめてからこの日数が経った belief は、棚卸しのとき「まだ合っているか」を疑う材料にする。
 *
 * **陳腐化は検索では絶対に見つからない。** 転職が終わっても「転職活動中」は同じ強さで検索に当たるし、
 * 当たった側は最新の1行に見える。古くなったこと自体は「最後に確かめたのがいつか」を
 * 持っている側からしか引けない。
 *
 * ただし**起こす理由には数えない**。理由にすると、答えが返るまで毎回同じ slot で起き続けて
 * 自家中毒になる(watch や問いを理由から外しているのと同じ判断)。
 * 別件で起きたときのプロンプトに載せるだけにして、棚卸しの回で人に聞かせる。
 */
export const STALE_BELIEF_DAYS = 90

/**
 * 一度実際に動いたら、この時間は新しい入力が無いかぎり動かない。
 *
 * **これが無いと自走は自家中毒を起こす**。「未解決の問いがある」「watch が動いていない」は、
 * 動いても解消しない理由になりうる(ユーザーしか答えられない問い、相手待ちの案件)。
 * 起こす条件をそのまま毎回の tick に効かせると、同じ理由で永久に推論を回し続ける。
 * 外から新しい入力が来たときだけ、この冷却を飛び越える。
 */
export const ACTIVE_COOLDOWN_HOURS = 1.5

/**
 * **同じ理由で続けて起きるほど、次に起きるまでを倍にする**。
 *
 * 冷却だけでは足りない。`next_move_owner = famulus` の watch は「自分が動く番」なので
 * 起こす理由になるが、動いても解消しないことがある(相手が要る、道具が無い、ユーザーの判断が要る)。
 * 冷却は間隔を空けるだけなので、そのままだと 1.5 時間ごとに同じ材料で永久に回し続ける。
 * 理由の組み合わせが前回と変わらなければ 1.5h → 3h → 6h → 12h → 24h と引いていき、
 * 最後は「1日1回の棚卸し」に落ち着く。**外から新しい入力が来たら 0 に戻る**。
 */
export const MAX_COOLDOWN_HOURS = 24

/**
 * 1日1本の下書きを出す時刻(ユーザーの時計)。**ここより前には出さない。**
 *
 * 早い時刻に出すと、その日の走行記録がまだ無い状態で書くことになり、材料が前日ぶんだけになる。
 * 夜に寄せてあるのは、読む側が1日の作業を終えた後に受け取るため — 割り込みの回数は同じでも、
 * 集中している最中に切るのと、終わった後に届くのとでは落ちるものが違う。
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
     *
     * 書き換えたあとの行を返す(以下の書き換えも同じ)。**id だけ返すと、呼んだ側が
     * 何を触ったのかを言うためにもう一度引く必要が出る** — 前方一致で受けている以上、
     * その引き直しは同じ行に当たる保証が無い。
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
     * 一周回した記録を付ける。**冷却はここからしか始まらない。**
     *
     * `touchWatch`(動きがあった)と分けてあるのは、両者が別のことを言っているから。
     * 相手から返事が来たのは「動き」だが自分は何もしていない。自分が回したのなら、
     * 何も出てこなくても回した — 空振りこそ、次の tick に「もう見た」と伝える必要がある。
     *
     * `result` を残すのは、**次に回すときの起点にするため**。これが無いと毎回まっさらな状態で
     * 同じ一覧を読み直すことになり、先週見たものを踏まえた文が一度も出ない。実際にそうなっていた
     * (AI追跡のwatch3件が全部「HN の新着を全部見る」で、差分を言えたことが無い)。
     *
     * `at` は**回した時刻**で、記録した時刻ではない。数時間前に回したものを後から記録するとき、
     * ここを今にすると冷却がその分だけ後ろへずれる。**ずれるくらいなら呼ばないほうがまし**という
     * 判断が実際に起き(記録を見送った回がある)、watch はプロンプトに残り続けた。だから過去を渡せる。
     * **先の時刻は取らない。** 未来を渡せると、一度の記録で好きなだけ冷却を伸ばせてしまう。
     */
    const ranWatch = (idOrPrefix: string, result: string, ranAt?: string) =>
      Effect.gen(function* () {
        const w = yield* findWatch(idOrPrefix)
        const now = nowIso()
        const at = ranAt === undefined || ranAt > now ? now : ranAt
        // 動きの時刻は**戻さない**。後から記録するとき、その間に来た返事のほうが新しい。
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

    // ── 問い(questions)。**推測を belief に昇格させないための置き場**。

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
     * 答えないまま問いを畳む。**答えるのと取り下げるのは別の出口**。
     *
     * `answer` しか無いと、問いは正しい答えが出たときにしか消えない。ユーザーの向きが変われば
     * 前の向きで立てた問いは答える意味を失うが、出口が無いぶん開いたまま残り、
     * tick が起きるたびプロンプトに載り続ける。`openQuestions` は古い順に上限件数だけ渡すので、
     * 死んだ問いが上限を埋めると**新しく立てた問いは一度も tick に届かない**。
     * 理由を残して閉じる — 何を追わないと決めたかは、答えと同じくらい後から要る。
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
     * 何を見て起きるべきかを SQL だけで決める。**モデルは呼ばない**。
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

        // **冷却が明けたものだけ。** `next_move_owner = 'famulus'` は無条件で滞留に入るので、
        // ここで `dueNow` を挟まないと自分持ちの watch は回しても静かにならず、毎回の tick で上がり続ける。
        const stalled = (yield* openWatches(nowMs)).filter(
          (w) => w.dueNow && (w.next_move_owner === "famulus" || w.stalledDays >= STALLED_DAYS),
        )
        const questions = yield* openQuestions()
        // 確かめてから時間が経った事実。**古いだけで間違いとは限らない**ので、消さずに聞く材料にする。
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
          "SELECT id, summary, created_at, expires_at FROM proposals WHERE status = 'proposed' ORDER BY expires_at ASC",
        )
        const pending: PendingProposal[] = pendingRows.map((r) => ({
          id: String(r.id),
          summary: String(r.summary),
          created_at: String(r.created_at),
          expires_at: String(r.expires_at),
          daysLeft: Math.floor(daysBetween(at, Date.parse(String(r.expires_at)))),
        }))

        // 断られたぶん。**古くなっても落とさない** — 「その用件ごと畳んだ」は日が経っても効いている。
        // 件数で切る(理由は1行ずつ短い)。落とすなら、その理由を確定値として置いてからにする。
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

        // 起こす理由。**未解決の問いは理由にしない** — 自分では解消できないものが多く、
        // 理由に数えると同じ問いで永久に起き続ける。起きたときの材料としてだけ渡す。
        const reasons: string[] = []
        if (newEvents.length > 0) reasons.push(`まだ見ていない入力が ${newEvents.length} 件`)
        const expiring = pending.filter((p) => p.daysLeft <= EXPIRING_DAYS)

        // 理由の「組み合わせ」= **プロンプトに何が載っているか**。件数も経過時間も入れない。
        // 件数を入れると watch が1件増えただけで「新しい理由」になって後退が掛からない。
        // 経過時間(24時間超え)を入れると、後退が上限に達した瞬間に組み合わせが変わって
        // 数え直しになり、1.5時間と24時間を往復し続ける — 上限が上限でなくなる。
        const overdue = sinceLastActiveHours >= IDLE_WAKE_HOURS
        const reasonKey = [stalled.length > 0 ? "stalled" : "", expiring.length > 0 ? "expiring" : ""]
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
          if (stalled.length > 0) reasons.push(`動いていない watch が ${stalled.length} 件`)
          if (expiring.length > 0) reasons.push(`期限が近い承認待ちが ${expiring.length} 件`)
          if (overdue) reasons.push(`前回の棚卸しから ${IDLE_WAKE_HOURS} 時間以上`)
        }

        // **冷却の外に出す。** 1日に1回しか立たない理由なので、直前に動いたかどうかで抑える対象ではない。
        // 抑えると、夕方に別の理由で動いた日は下書きが丸ごと落ちる。
        const draftDue =
          localHour(at) >= dailyDraftHour() && (yield* db.meta("daily:draft")) !== dayRange(at).key
        if (draftDue) reasons.push("今日ぶんの下書きがまだ出ていない")

        return {
          at,
          cursor,
          newEvents,
          stalled,
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
     * `upto` は**その回が実際に見た最後の行**。渡さないと「今の最大 rowid」まで進むので、
     * 走っている最中に届いたぶん — digest には載っていない行 — まで読んだことになり、
     * 誰も答えないまま既読になる。tick からは必ず渡す。
     *
     * 渡さない経路(対話セッションの終わり)は、自分が書いた行ごと消費してよい場面に限る。
     * tick 自身の書き込みで tick が起きることは無い — digest が `source='system'` を外している。
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
        // 数えているのは「この組み合わせで**何回起きたか**」なので、初めて記録する回も 1 になる
        // (次に同じ組み合わせで起きたとき、それが2回目だと分かる)。
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
