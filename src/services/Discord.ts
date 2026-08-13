/**
 * Discord。**ユーザーと行き来する唯一の経路。**
 *
 * 前は ntfy も並べていた。届く先は同じ端末で、届いた先で出来ることはこちらのほうが多い
 * (ntfy は短い本文と決め打ちのボタンだけ)。経路が2本あると、片方の位置がずれたことに
 * 誰も気付かないまま入力が落ちるので、1本に寄せた(docs/adr/0029)。
 *
 * **常駐しない。** ボタン(interaction)は3秒以内に応答が要るので gateway 接続が要るが、
 * 絵文字のリアクションなら後から数えられる。返事の待ち時間は、常駐ではなく**読みに行く間隔**で決まる
 * — 30秒ごとに `inbox()` を1回叩くだけならモデルを呼ばず REST 1本で済む(src/poll.ts)。
 * 落ちたら黙って死ぬ常駐を1本増やさずに、待ち時間だけ 15分 から 30秒 に落ちる。
 *
 * **これは受け取りについての決め。** オンライン表示のほうは gateway でしか出ないので、
 * 表示だけを持つ常駐が別に1本ある(`src/presence.ts` / docs/adr/0027)。
 * そちらはメッセージを1通も読まない — 死んでも失われるのは表示だけ。
 *
 * 出す先は用途で分ける(`Desk`)。**通知を切れる単位が用途と一致する**のが分ける理由で、
 * 全部を1本に流すと「読まなくていいもの」をミュートした瞬間に「返事が要るもの」も届かなくなる。
 * 分け先はチャンネル id を env で指す — 名前で引くと、名前を変えた日に黙って出なくなる(docs/adr/0015)。
 *
 * **人が居ない場所には出さない。** チャンネルを指していなければ DM に落ちるし、
 * 指す先をユーザー以外が読める場所にすると、DB の中身がそこに出る(囲いの中かは env を書く側の責任)。
 *
 * 返事は**訊かれた場所に返す**。ユーザーが DM に書いたのにチャンネルへ返すと、
 * 書いた側は返事が無かったことになる。最後に話しかけられた場所を覚えておいてそこへ出す。
 *
 * リアクションを押させるものは**スレッドを1本立てる**。リアクションは「どれに」までしか言えないので、
 * 「直す」の中身を受けるには自由文が要るが、スレッド外に書かれた自由文はどの1件への返事か分からない。
 * スレッドの中なら場所そのものが宛先になる(docs/adr/0016)。
 *
 * 設定が無ければ**黙って何もしない**。経路が塞がっていることで tick を止めない
 * — 届かないより、動かないほうが困る。
 */
import { Effect } from "effect"
import type { DbFailed } from "../core/errors.ts"
import { Db } from "./Db.ts"

/** 叩き先。検査のときだけ差し替える — 本物に出すとユーザーの DM が試し書きで埋まる。 */
const api = (): string => process.env.OPEN_ZERO_DISCORD_API ?? "https://discord.com/api/v10"

/** 1通の上限。Discord は 2000 字で弾くので、超えるぶんは分けて出す。 */
const LIMIT = 2000

/**
 * 1通に入れる行数の上限。**字数だけで切ると縦に長いものが畳まれる。**
 * Discord のクライアントは高いメッセージを途中で閉じて「続きを表示」にするので、
 * 2000字に収まっていても読む側の手数が1回増える。
 */
const LINES = 17

/** 押させるリアクション。絵文字1つに意味を1つ割り当てる。 */
export interface Tap {
  readonly emoji: string
  /** 押されたときにユーザーの発言として DB へ入る文。 */
  readonly reply: string
}

/**
 * 出す先の種類。**チャンネルそのものではなく用途を渡す** — 呼ぶ側は id を知らないでよい。
 *
 * `talk` は会話(訊かれたら返す)。`draft` は名前が出る文で、リアクションを押させる場所。
 * `log` は進み具合(docs/adr/0030)。**返事を求めない** — 用があるものは `talk` へ出す。
 *
 * `talk` と `draft` は指す先が無ければ DM に落ちるが、**`log` は落ちない**。
 * 1回動くたびに1行出るものなので、DM に落ちると会話がそれで埋まる。
 * 指していなければ出さない — 見たい人がチャンネルを1つ作って id を入れる、という形。
 */
export type Desk = "talk" | "draft" | "log"

export interface Post {
  readonly text: string
  /** 付けるリアクション。先に自分で付けておく — 押す側が絵文字を探さずに済む。 */
  readonly taps?: readonly Tap[]
  /** 出す先。既定は会話。 */
  readonly to?: Desk
  /**
   * ユーザーを呼ぶ。**チャンネルをミュートしていても届く**ので、返事が要るものにだけ付ける。
   * DM には付けない — 既に本人しか居ない場所で、呼びかけは字が増えるだけ。
   */
  readonly ping?: boolean
  /**
   * スレッドの名前。渡すと、出した1通からスレッドを立ててそこも聞きに行く。
   * **この1件への返事を、場所で受け取るため** — スレッド外の自由文はどれへの返事か分からない。
   */
  readonly thread?: string
}

/** ユーザーから返ってきた1件。押したリアクションも自由文も、同じ形にして返す。 */
export interface Inbound {
  readonly id: string
  readonly text: string
}

/**
 * 1回読んだぶんと、**まだ DB に書いていない既読の位置**。
 *
 * 読むことと「読んだ」と記録することを分けてあるのは、記録する前に位置が進むと、
 * 記録が落ちた回のぶんが二度と来ないから。Discord は `after` ではなく id の比較で絞るので、
 * 位置が進んだメッセージはチャンネルに残っていても拾われない。**消えたことも残らない。**
 * 後から進めるなら、最悪でも同じものを二度読むだけで済む(docs/adr/0029)。
 */
export interface Batch {
  /** 届いていた順に並べたもの。 */
  readonly items: readonly Inbound[]
  /** 場所ごとの新しい位置。`seen` を呼ぶまで DB には入らない。 */
  readonly marks: Readonly<Record<string, string>>
  /** 押されたぶんを落とした後の、リアクション待ちの一覧。 */
  readonly taps: Readonly<Record<string, Record<string, string>>>
  /** 最後に自由文が来た場所。返事はここへ出す。来ていなければ undefined。 */
  readonly heard?: string
}

const token = (): string | undefined => process.env.OPEN_ZERO_DISCORD_TOKEN
const ownerId = (): string | undefined => process.env.OPEN_ZERO_DISCORD_OWNER_ID

/** 用途ごとの出し先。空文字は「指していない」と読む(env を消さずに空にすることがある)。 */
const ENV_CHANNEL: Readonly<Record<Desk, string>> = {
  talk: "OPEN_ZERO_DISCORD_CH_TALK",
  draft: "OPEN_ZERO_DISCORD_CH_DRAFT",
  log: "OPEN_ZERO_DISCORD_CH_LOG",
}

const fixedChannel = (to: Desk): string | undefined => {
  const raw = process.env[ENV_CHANNEL[to]]
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim()
}

/** 待っているリアクション。`{ メッセージid: { 絵文字: 返る文 } }` を schema_meta に置く。 */
type Pending = Record<string, Record<string, string>>

/** 覚えておく待ちの数。押されないまま溜まった古いものは落とす — 返事が来ないものは流れたもの。 */
const MAX_PENDING = 20

/**
 * 聞き続けるスレッドの数。**押された時点では閉じない** — 「直す」を押した人は、その後に
 * 何を直すかを書く。決着で閉じると、その自由文の行き先が無くなる。
 * 古いものから落ちる。1つ増えるごとに、poll が30秒ごとに叩く先が1つ増える。
 */
const MAX_THREADS = 3

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

    /** DM のチャンネル。ユーザーごとに固定なので一度引いたら覚えておく。 */
    const dm = (): Effect.Effect<string | undefined, DbFailed> =>
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

    /**
     * 出す先を決める。**最後に話しかけられた場所が最優先** — 返事は訊かれた場所に返す。
     * リアクションを押させるものは、指してあれば専用の場所へ出す(ミュートの単位を会話と分けるため)。
     *
     * `log` だけは**指してある場所にしか出さない**。落とす先を持たせると、進み具合の1行が
     * 会話や DM に混ざる — 混ざった瞬間に、その場所は読み飛ばす場所になる(docs/adr/0030)。
     */
    const channel = (to: Desk = "talk"): Effect.Effect<string | undefined, DbFailed> =>
      Effect.gen(function* () {
        if (!token()) return undefined
        if (to === "log") return fixedChannel("log")
        if (to === "draft") {
          const fixed = fixedChannel("draft") ?? fixedChannel("talk")
          if (fixed) return fixed
        } else {
          const heard = yield* db.meta("discord:heard_in")
          if (heard) return heard
          const fixed = fixedChannel("talk")
          if (fixed) return fixed
        }
        return yield* dm()
      })

    /** リアクションを1つ付ける。**押す側が絵文字を探さずに済むように、出した直後に自分で置く。** */
    const mark = (ch: string, messageId: string, emoji: string): Effect.Effect<void> =>
      call(`/channels/${ch}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
        method: "PUT",
      }).pipe(Effect.ignore)

    /**
     * スレッドを1本立てる。**返事の宛先を場所で持つため。**
     * スレッドの中の発言は `channel_id` がそのまま元の1通を指すので、どれへの返事かを当てずに済む。
     *
     * 生やした直後に既読位置を起点へ置く。置かないと「位置を持たない場所」の規則に当たって、
     * **ユーザーがスレッドに書いた最初の1通が、取り込まれないまま位置だけ進む**(docs/adr/0015 の影響)。
     */
    const branch = (ch: string, messageId: string, name: string): Effect.Effect<void, DbFailed> =>
      Effect.gen(function* () {
        const made = yield* call(`/channels/${ch}/messages/${messageId}/threads`, {
          method: "POST",
          // 名前は 100 字まで。超えると 400 で弾かれる(スレッドが立たない)。
          body: JSON.stringify({ name: name.slice(0, 100), auto_archive_duration: 1440 }),
        }).pipe(
          Effect.flatMap((r) => Effect.tryPromise(() => r.json() as Promise<{ id?: string }>)),
          Effect.map((j) => j.id),
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
        if (!made) return
        yield* db.setMeta(`discord:last:${made}`, made)
        const open = yield* meta<string[]>("discord:threads", [])
        yield* db.setMeta("discord:threads", JSON.stringify([...open, made].slice(-MAX_THREADS)))
      })

    /**
     * 1通出す。**失敗しても例外にしない** — 送れたらメッセージ id、駄目なら undefined。
     * リアクションは自分で先に付ける。押す側が絵文字を選ぶ手間を消すため。
     */
    const post = (p: Post): Effect.Effect<string | undefined, DbFailed> =>
      Effect.gen(function* () {
        const ch = yield* channel(p.to)
        if (!ch) return undefined
        // 呼びかけは本文に混ぜてから割る。後から足すと、分けた最後の1通だけに付く。
        const owner = ownerId()
        const head = p.ping && owner && ch !== (yield* dm()) ? `<@${owner}>\n` : ""
        let last: string | undefined
        for (const part of chunks(head + p.text)) {
          last = yield* call(`/channels/${ch}/messages`, {
            method: "POST",
            body: JSON.stringify({ content: part }),
          }).pipe(
            Effect.flatMap((r) => Effect.tryPromise(() => r.json() as Promise<{ id?: string }>)),
            Effect.map((j) => j.id),
            Effect.catchAll(() => Effect.succeed(undefined)),
          )
        }
        if (!last) return last
        // スレッドはリアクションより先に。リアクションを付けてから落ちても、返事の行き先だけは立っている。
        if (p.thread) yield* branch(ch, last, p.thread)
        if (!p.taps?.length) return last
        for (const t of p.taps) yield* mark(ch, last, t.emoji)
        const pending = yield* meta<Pending>("discord:taps", {})
        pending[last] = Object.fromEntries(p.taps.map((t) => [t.emoji, t.reply]))
        const kept = Object.entries(pending).slice(-MAX_PENDING)
        yield* db.setMeta("discord:taps", JSON.stringify(Object.fromEntries(kept)))
        return last
      })

    /**
     * 読みに行く場所。**出す先を全部聞く** — 出した場所に返事が来るし、
     * DM は出し先をチャンネルに移した後も残る(ユーザーがそちらに書いたら黙って落ちる、が起きない)。
     * 立てたスレッドも聞く。スレッドは自分で出した1件に紐づくので、そこに他人は書けない。
     */
    const listening = (): Effect.Effect<readonly string[], DbFailed> =>
      Effect.gen(function* () {
        if (!token()) return []
        const out = new Set<string>()
        // **出す先は全部聞く。log も。** こちらから返事を求めない場所でも、ユーザーが
        // そこに書くことはある。聞かない場所に位置だけ進む形にすると、書いたものが黙って消える。
        for (const to of ["talk", "draft", "log"] as const) {
          const fixed = fixedChannel(to)
          if (fixed) out.add(fixed)
        }
        const d = yield* dm()
        if (d) out.add(d)
        for (const t of yield* meta<string[]>("discord:threads", [])) out.add(t)
        return [...out]
      })

    /**
     * その場所の既読位置。持っていない場所は**取り込まずに位置だけ進める**(初回の規則)。
     * DM だけは場所ごとに分ける前の位置を引き継ぐ — 引き継がないと、DM の過去ログを一度だけ全部読む。
     */
    const cursorOf = (ch: string): Effect.Effect<string | undefined, DbFailed> =>
      Effect.gen(function* () {
        const own = yield* db.meta(`discord:last:${ch}`)
        if (own) return own
        return ch === (yield* dm()) ? yield* db.meta("discord:last") : undefined
      })

    /**
     * 返ってきたものを読む。**リアクションと自由文を同じ形で返す** — 呼ぶ側はどちらで来たかを気にしない。
     * 一覧を1回引くだけで両方見る(リアクションは古いメッセージに後から付くので、`after` では拾えない)。
     *
     * **位置は進めない。** 進めるのは `seen` で、呼ぶのは読んだものを記録し終えた側。
     * ここで進めると、記録が落ちた回のぶんが二度と来ない(`Batch` の説明)。
     *
     * 位置を持っていない初回は**自由文を取り込まずに位置だけ返す** — DM には過去の会話が
     * 残っているので、位置なしで引くと去年の一言が今日の指示として流れ込む。
     * リアクションはこの制限を受けない(自分が出した通知に対してしか登録されていない)。
     *
     * 取れなければ空 — 「届いていない」と「Discord が落ちている」を呼ぶ側に区別させない。
     */
    const inbox = (): Effect.Effect<Batch, DbFailed> =>
      Effect.gen(function* () {
        const owner = ownerId()
        const pending = yield* meta<Pending>("discord:taps", {})
        const out: Inbound[] = []
        const marks: Record<string, string> = {}
        let heard: string | undefined

        for (const ch of yield* listening()) {
          const msgs = yield* readJson<
            {
              id: string
              content: string
              author: { id: string }
              reactions?: { emoji: { name: string }; count: number; me: boolean }[]
            }[]
          >(`/channels/${ch}/messages?limit=50`)
          if (!msgs?.length) continue

          const cursor = yield* cursorOf(ch)

          // 古い順に見る。API は新しい順で返すので、そのまま流すと DB の並びが逆になる。
          for (const m of [...msgs].reverse()) {
            if (cursor && m.author.id === owner && m.content.trim() !== "" && newer(m.id, cursor)) {
              out.push({ id: m.id, text: m.content })
              // **返す先はここ。** 一番新しい自由文の場所を覚える(リアクションは場所を動かさない —
              // 押すのは前に出したものへの返事で、話しかけられたのとは違う)。
              if (heard === undefined || newer(m.id, heard)) heard = ch
            }
            const waiting = pending[m.id]
            if (!waiting) continue
            for (const r of m.reactions ?? []) {
              const reply = waiting[r.emoji.name]
              // 自分で付けたぶんは数に入っている。それを超えていたらユーザーが押した。
              if (reply && r.count > (r.me ? 1 : 0)) {
                out.push({ id: `${m.id}:${r.emoji.name}`, text: reply })
                delete pending[m.id]
                break
              }
            }
          }

          marks[ch] = msgs.reduce((a, m) => (newer(m.id, a) ? m.id : a), msgs[0]?.id ?? "0")
        }

        return {
          // 場所をまたいでも届いた順に並べる。snowflake は時刻で単調増加するので id で並べ直せる。
          items: out.sort((a, b) => (newer(a.id.split(":")[0] ?? "0", b.id.split(":")[0] ?? "0") ? 1 : -1)),
          marks,
          taps: pending,
          ...(heard === undefined ? {} : { heard }),
        } satisfies Batch
      })

    /**
     * 読んだものを記録し終えたことを DB に書く。**`inbox` で読んだ後に、呼ぶ側が呼ぶ。**
     *
     * ここを呼ばずに終えた回は、次に同じものをもう一度読む。二度覚えるのは直せるが、
     * 位置の向こう側に取り残されたものは取りに行く手立てが無い(docs/adr/0029)。
     */
    const seen = (b: Batch): Effect.Effect<void, DbFailed> =>
      Effect.gen(function* () {
        for (const [ch, id] of Object.entries(b.marks)) yield* db.setMeta(`discord:last:${ch}`, id)
        if (b.heard !== undefined) yield* db.setMeta("discord:heard_in", b.heard)
        yield* db.setMeta("discord:taps", JSON.stringify(b.taps))
      })

    /** 出せるか。人に「Discord には出ない」と伝えるためだけに使う。 */
    const configured = (): boolean => token() !== undefined && ownerId() !== undefined

    /**
     * いまどこに出て、どこを聞いているか。**人が読むためだけ**に使う。
     * 出し先は状態(最後に話しかけられた場所)で動くので、env を読むだけでは分からない。
     */
    const where = (): Effect.Effect<{ talk?: string; draft?: string; log?: string; dm?: string }, DbFailed> =>
      Effect.gen(function* () {
        const talk = yield* channel("talk")
        const draft = yield* channel("draft")
        const lg = yield* channel("log")
        const d = yield* dm()
        return {
          ...(talk ? { talk } : {}),
          ...(draft ? { draft } : {}),
          ...(lg ? { log: lg } : {}),
          ...(d ? { dm: d } : {}),
        }
      })

    return { post, inbox, seen, configured, where } as const
  }),
}) {}
