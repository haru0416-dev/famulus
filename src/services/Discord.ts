/**
 * Discord の DM。**持ち主が一番長く居る場所に出すための口。**
 *
 * ntfy はロック画面に届くが、届いた先で出来ることが少ない(短い本文と決め打ちのボタンだけ)。
 * 長い下書きを読ませて一言返してもらう相手としては、既に開いている画面のほうが強い。
 *
 * **常駐しない。** ボタン(interaction)は3秒以内に応答が要るので gateway 接続が要るが、
 * 絵文字の印なら後から数えられる。返事の待ち時間は、常駐ではなく**読みに行く間隔**で決まる
 * — 30秒ごとに `inbox()` を1回叩くだけならモデルを呼ばず REST 1本で済む(src/poll.ts)。
 * 落ちたら黙って死ぬ常駐を1本増やさずに、待ち時間だけ 15分 から 30秒 に落ちる。
 *
 * 出す先は DM だけ。サーバのチャンネルに出すと、持ち主以外にも読まれる場所に台帳の中身が出る。
 *
 * 設定が無ければ**黙って何もしない**(Notify と同じ契約)。
 */
import { Effect } from "effect"
import type { DbFailed } from "../core/errors.ts"
import { Db } from "./Db.ts"

/** 叩き先。検査のときだけ差し替える — 本物に出すと持ち主の DM が試し書きで埋まる。 */
const api = (): string => process.env.OPEN_ZERO_DISCORD_API ?? "https://discord.com/api/v10"

/** 1通の上限。Discord は 2000 字で弾くので、超えるぶんは分けて出す。 */
const LIMIT = 2000

/**
 * 1通に入れる行数の上限。**字数だけで切ると縦に長いものが畳まれる。**
 * Discord のクライアントは高いメッセージを途中で閉じて「続きを表示」にするので、
 * 2000字に収まっていても読む側の手数が1回増える。
 */
const LINES = 17

/** 押させる印。絵文字1つに意味を1つ割り当てる。 */
export interface Tap {
  readonly emoji: string
  /** 押されたときに持ち主の発言として台帳へ入る文。 */
  readonly reply: string
}

export interface Post {
  readonly text: string
  /** 付ける印。先に自分で付けておく — 押す側が絵文字を探さずに済む。 */
  readonly taps?: readonly Tap[]
}

/** 持ち主から返ってきた1件。押した印も自由文も、同じ形にして返す。 */
export interface Inbound {
  readonly id: string
  readonly text: string
}

const token = (): string | undefined => process.env.OPEN_ZERO_DISCORD_TOKEN
const ownerId = (): string | undefined => process.env.OPEN_ZERO_DISCORD_OWNER_ID

/** 待っている印。`{ メッセージid: { 絵文字: 返る文 } }` を schema_meta に置く。 */
type Pending = Record<string, Record<string, string>>

/** 覚えておく待ちの数。押されないまま溜まった古いものは落とす — 返事が来ないものは流れたもの。 */
const MAX_PENDING = 20

/** snowflake は数として単調増加する。文字列比較では桁が変わったときに壊れる。 */
const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b)

/** 字数で切る位置。行の途中で切らない — 切れ目が無ければ諦めて長さで切る。 */
const charCut = (s: string): number => {
  if (s.length <= LIMIT) return s.length
  const nl = s.lastIndexOf("\n", LIMIT)
  return nl > LIMIT / 2 ? nl : LIMIT
}

/** 行数で切る位置。LINES 行目の末尾。足りなければ切らない。 */
const lineCut = (s: string): number => {
  let at = -1
  for (let n = 0; n < LINES; n++) {
    const nl = s.indexOf("\n", at + 1)
    if (nl === -1) return s.length
    at = nl
  }
  return at
}

/** 字数と行数の**先に来たほう**で切る。どちらか片方だけだと、もう片方で畳まれる。 */
const chunks = (text: string): string[] => {
  const out: string[] = []
  let rest = text
  for (;;) {
    const at = Math.min(charCut(rest), lineCut(rest))
    if (at <= 0 || at >= rest.length) break
    out.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, "")
  }
  out.push(rest)
  return out
}

export class Discord extends Effect.Service<Discord>()("Discord", {
  effect: Effect.gen(function* () {
    const db = yield* Db

    const call = (path: string, init?: RequestInit) =>
      Effect.tryPromise(() =>
        fetch(`${api()}${path}`, {
          ...init,
          headers: {
            authorization: `Bot ${token()}`,
            "content-type": "application/json",
            ...(init?.headers ?? {}),
          },
          signal: AbortSignal.timeout(10_000),
        }),
      )

    const readJson = <T>(path: string): Effect.Effect<T | undefined> =>
      call(path).pipe(
        Effect.flatMap((r) =>
          r.ok ? Effect.tryPromise(() => r.json() as Promise<T>) : Effect.succeed(undefined),
        ),
        Effect.catchAll(() => Effect.succeed(undefined)),
      )

    const meta = <T>(key: string, fallback: T): Effect.Effect<T, DbFailed> =>
      db.meta(key).pipe(
        Effect.map((raw) => {
          if (!raw) return fallback
          try {
            return JSON.parse(raw) as T
          } catch {
            return fallback
          }
        }),
      )

    /** DM のチャンネル。持ち主ごとに固定なので一度引いたら覚えておく。 */
    const channel = (): Effect.Effect<string | undefined, DbFailed> =>
      Effect.gen(function* () {
        const owner = ownerId()
        if (!token() || !owner) return undefined
        const cached = yield* db.meta("discord:dm")
        if (cached) return cached
        // 既にあれば同じものが返る(作り直しにはならない)。
        const opened = yield* call("/users/@me/channels", {
          method: "POST",
          body: JSON.stringify({ recipient_id: owner }),
        }).pipe(
          Effect.flatMap((r) => Effect.tryPromise(() => r.json() as Promise<{ id?: string }>)),
          Effect.map((j) => j.id),
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
        if (opened) yield* db.setMeta("discord:dm", opened)
        return opened
      })

    /** 印を1つ付ける。**押す側が絵文字を探さずに済むように、出した直後に自分で置く。** */
    const mark = (messageId: string, emoji: string): Effect.Effect<void, DbFailed> =>
      Effect.gen(function* () {
        const ch = yield* channel()
        if (!ch) return
        yield* call(`/channels/${ch}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
          method: "PUT",
        }).pipe(Effect.ignore)
      })

    /**
     * 1通出す。**失敗しても例外にしない** — 送れたらメッセージ id、駄目なら undefined。
     * 印は自分で先に付ける。押す側が絵文字を選ぶ手間を消すため。
     */
    const post = (p: Post): Effect.Effect<string | undefined, DbFailed> =>
      Effect.gen(function* () {
        const ch = yield* channel()
        if (!ch) return undefined
        let last: string | undefined
        for (const part of chunks(p.text)) {
          last = yield* call(`/channels/${ch}/messages`, {
            method: "POST",
            body: JSON.stringify({ content: part }),
          }).pipe(
            Effect.flatMap((r) => Effect.tryPromise(() => r.json() as Promise<{ id?: string }>)),
            Effect.map((j) => j.id),
            Effect.catchAll(() => Effect.succeed(undefined)),
          )
        }
        if (!last || !p.taps?.length) return last
        for (const t of p.taps) yield* mark(last, t.emoji)
        const pending = yield* meta<Pending>("discord:taps", {})
        pending[last] = Object.fromEntries(p.taps.map((t) => [t.emoji, t.reply]))
        const kept = Object.entries(pending).slice(-MAX_PENDING)
        yield* db.setMeta("discord:taps", JSON.stringify(Object.fromEntries(kept)))
        return last
      })

    /**
     * 返ってきたものを読む。**印と自由文を同じ形で返す** — 呼ぶ側はどちらで来たかを気にしない。
     * 一覧を1回引くだけで両方見る(印は古いメッセージに後から付くので、`after` では拾えない)。
     *
     * 読んだものは二度返さない(既読位置と待ちリストをここで進める)。
     * 位置を持っていない初回は**自由文を取り込まずに位置だけ進める** — DM には過去の会話が
     * 残っているので、位置なしで引くと去年の一言が今日の指示として流れ込む。
     * 印はこの制限を受けない(自分が出した通知に対してしか登録されていない)。
     *
     * 取れなければ空 — 「届いていない」と「Discord が落ちている」を呼ぶ側に区別させない。
     */
    const inbox = (): Effect.Effect<readonly Inbound[], DbFailed> =>
      Effect.gen(function* () {
        const ch = yield* channel()
        if (!ch) return []
        const msgs = yield* readJson<
          {
            id: string
            content: string
            author: { id: string }
            reactions?: { emoji: { name: string }; count: number; me: boolean }[]
          }[]
        >(`/channels/${ch}/messages?limit=50`)
        if (!msgs?.length) return []

        const owner = ownerId()
        const cursor = yield* db.meta("discord:last")
        const pending = yield* meta<Pending>("discord:taps", {})
        const out: Inbound[] = []

        // 古い順に見る。API は新しい順で返すので、そのまま流すと台帳の並びが逆になる。
        for (const m of [...msgs].reverse()) {
          if (cursor && m.author.id === owner && m.content.trim() !== "" && newer(m.id, cursor)) {
            out.push({ id: m.id, text: m.content })
          }
          const waiting = pending[m.id]
          if (!waiting) continue
          for (const r of m.reactions ?? []) {
            const reply = waiting[r.emoji.name]
            // 自分で付けたぶんは数に入っている。それを超えていたら持ち主が押した。
            if (reply && r.count > (r.me ? 1 : 0)) {
              out.push({ id: `${m.id}:${r.emoji.name}`, text: reply })
              delete pending[m.id]
              break
            }
          }
        }

        const newest = msgs.reduce((a, m) => (newer(m.id, a) ? m.id : a), msgs[0]?.id ?? "0")
        yield* db.setMeta("discord:last", newest)
        yield* db.setMeta("discord:taps", JSON.stringify(pending))
        return out
      })

    /** 出せるか。人に「Discord には出ない」と伝えるためだけに使う。 */
    const configured = (): boolean => token() !== undefined && ownerId() !== undefined

    return { post, inbox, configured } as const
  }),
}) {}
