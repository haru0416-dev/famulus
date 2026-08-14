/**
 * Discord。ユーザーとの入出力はここだけ。
 *
 * gateway でメッセージを受信しない。ボタン(interaction)は3秒以内の応答が要るため使わず、
 * リアクションと自由文を `src/poll.ts` から30秒ごとに REST で取得する。
 * オンライン表示だけは別プロセスの gateway 接続が担う(src/presence.ts)。
 *
 * 出す先は用途で分ける(`Desk`)。ミュートの単位が用途と一致する。チャンネルは id を env で
 * 指す。名前で引くと改名した日に出なくなる。
 *
 * 返事は最後に話しかけられた場所へ返す。リアクションを押させるものはスレッドを立てる
 * — スレッド外の自由文はどの1件への返事か判定できない。
 *
 * token / owner id が無ければ何もせず undefined を返す。tick を止めない。
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { DbFailed } from "../core/errors.ts"
import { Db } from "./Db.ts"

/** API の base URL。テストだけ差し替える。 */
const api = (): string => process.env.OPEN_ZERO_DISCORD_API ?? "https://discord.com/api/v10"

/** 1通の上限。Discord は 2000 字で弾くので、超えるぶんは分けて出す。 */
const LIMIT = 2000

/**
 * 携帯クライアントで縦長の投稿が畳まれにくいように設けた、ローカルな1通あたりの行数上限。
 * Discord API 自体の制限ではない。
 */
const LINES = 17

/** 押させるリアクション。絵文字1つに意味を1つ割り当てる。 */
export interface Tap {
  readonly emoji: string
  /** 押されたときにユーザーの発言として DB へ入る文。 */
  readonly reply: string
}

/**
 * 出す先の種類。呼ぶ側はチャンネル id を知らなくてよい。
 *
 * `talk` は会話、`draft` は外に出す文(リアクションを押させる)、`log` は進み具合。
 * `talk` と `draft` は指す先が無ければ DM に落ちるが、`log` は落ちない
 * — 1回動くたびに1行出るので、DM に混ぜると会話が埋まる。
 */
export type Desk = "talk" | "draft" | "log"

export interface Post {
  readonly text: string
  /** 付けるリアクション。出した直後に自分で付ける。 */
  readonly taps?: readonly Tap[]
  /** 出す先。既定は `talk`。 */
  readonly to?: Desk
  /** メンションを付ける。ミュートしていても届くので、返事が要るものだけ。DM には付けない。 */
  readonly ping?: boolean
  /** スレッドの名前。渡すと出した1通からスレッドを立て、そこも読みに行く。 */
  readonly thread?: string
}

/** ユーザーから返ってきた1件。押したリアクションも自由文も、同じ形にして返す。 */
export interface Inbound {
  readonly id: string
  readonly text: string
}

/**
 * 1回読んだぶんと、まだ DB に書いていない既読位置。
 *
 * 読むことと記録することを分けてあるのは、記録前に cursor が進むと、記録が失敗した回の項目が
 * 二度と読まれないから。絞り込みは id の比較なので、cursor 以前の項目はチャンネルに残って
 * いても拾えない。
 */
export interface Batch {
  /** 届いた順に並べたもの。 */
  readonly items: readonly Inbound[]
  /** チャンネルごとの新しい cursor。`seen` を呼ぶまで DB には入らない。 */
  readonly marks: Readonly<Record<string, string>>
  /** 処理済みリアクションを除外した後の、リアクション待ち一覧。 */
  readonly taps: Readonly<Record<string, Record<string, string>>>
  /** 最後に自由文が来たチャンネル。返事はここへ出す。 */
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

/** 覚えておくリアクション待ちの数。押されないまま溜まった古いものから落とす。 */
const MAX_PENDING = 20

/**
 * 読み続けるスレッドの数。リアクションが押されても閉じない — 「直す」を押した後に何を直すかが
 * 書かれる。古いものから落ちる。1つ増えるごとに poll が30秒ごとに読む先が1つ増える。
 */
const MAX_THREADS = 3

/**
 * `inbox()` が同時に出す GET の上限。
 * 読む先は talk / draft / log / DM の最大4件と、スレッド最大3件で合計7件。
 * rate-limit bucket の分離は保証ではないため、ここでは並列数だけを8に制限する。
 */
const FETCH_AT_ONCE = 8

/** `GET /channels/{id}/messages` の応答のうち使うフィールド。 */
interface RawMessage {
  readonly id: string
  readonly content: string
  readonly author: { id: string }
  readonly reactions?: { emoji: { name: string }; count: number; me: boolean }[]
}

/** snowflake は上位ビットに生成時刻を持つ。文字列比較を避け、同時刻内は数値順で扱う。 */
const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b)

/** 字数で切る位置。改行で切る。後半に改行が無ければ LIMIT で切る。 */
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

/** 字数と行数の、先に来たほうで切る。 */
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

const makeDiscord = () =>
  Effect.gen(function* () {
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
        Effect.catch(() => Effect.succeed(undefined)),
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
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (opened) yield* db.setMeta("discord:dm", opened)
        return opened
      })

    /**
     * 出す先を決める。`talk` は最後に話しかけられたチャンネルが最優先。
     * `log` は指してあるチャンネルにしか出さない — 落とす先を持たせると進み具合の1行が
     * 会話や DM に混ざる。
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

    /** リアクションを1つ付ける。押す側が絵文字を探さずに済むよう、出した直後に自分で置く。 */
    const mark = (ch: string, messageId: string, emoji: string): Effect.Effect<void> =>
      call(`/channels/${ch}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
        method: "PUT",
      }).pipe(Effect.ignore)

    /**
     * スレッドを1本立てる。作成されたスレッドの id は起点メッセージ id と同じなので、
     * スレッド内メッセージの channel_id から返事の宛先を特定できる。
     *
     * 立てた直後に cursor を起点へ置く。置かないと「cursor を持たないチャンネル」の扱いになり、
     * 最初の1通が取り込まれないまま cursor だけ進む。
     */
    const branch = (ch: string, messageId: string, name: string): Effect.Effect<void, DbFailed> =>
      Effect.gen(function* () {
        const made = yield* call(`/channels/${ch}/messages/${messageId}/threads`, {
          method: "POST",
          // 名前は 100 字まで。超えると 400 で拒否される(スレッドが立たない)。
          body: JSON.stringify({ name: name.slice(0, 100), auto_archive_duration: 1440 }),
        }).pipe(
          Effect.flatMap((r) => Effect.tryPromise(() => r.json() as Promise<{ id?: string }>)),
          Effect.map((j) => j.id),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (!made) return
        yield* db.setMeta(`discord:last:${made}`, made)
        const open = yield* meta<string[]>("discord:threads", [])
        yield* db.setMeta("discord:threads", JSON.stringify([...open, made].slice(-MAX_THREADS)))
      })

    /** 1通出す。失敗しても例外にしない。送れたらメッセージ id、駄目なら undefined。 */
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
            Effect.catch(() => Effect.succeed(undefined)),
          )
        }
        if (!last) return last
        // スレッドをリアクションより先に立てる。途中で落ちても返事の宛先は残る。
        if (p.thread) yield* branch(ch, last, p.thread)
        if (!p.taps?.length) return last
        for (const t of p.taps) yield* mark(ch, last, t.emoji)
        const pending = yield* meta<Pending>("discord:taps", {})
        pending[last] = Object.fromEntries(p.taps.map((t) => [t.emoji, t.reply]))
        const kept = Object.entries(pending).slice(-MAX_PENDING)
        yield* db.setMeta("discord:taps", JSON.stringify(Object.fromEntries(kept)))
        return last
      })

    /** 読みに行くチャンネル。出す先すべてと DM、立てたスレッド。 */
    const listening = (): Effect.Effect<readonly string[], DbFailed> =>
      Effect.gen(function* () {
        if (!token()) return []
        const out = new Set<string>()
        // log も読む。返事を求めないチャンネルでもユーザーが書くことはある。
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
     * そのチャンネルの cursor。持っていなければ undefined(取り込まずに cursor だけ進める)。
     */
    const cursorOf = (ch: string): Effect.Effect<string | undefined, DbFailed> =>
      db.meta(`discord:last:${ch}`)

    /**
     * 返ってきたものを読む。リアクションと自由文を同じ形で返す。一覧を1回引いて両方見る
     * (リアクションは古いメッセージに後から付くので `after` では拾えない)。
     *
     * cursor は進めない。進めるのは `seen`。
     *
     * cursor を持たないチャンネルは自由文を取り込まず cursor だけ返す。DM には過去の会話が
     * 残っていて、cursor なしで引くと去年の発言が今日の入力になる。リアクションは対象外
     * (自分が出したメッセージにしか登録されていない)。
     *
     * 取れなければ空を返す。呼ぶ側は「届いていない」と「Discord が落ちている」を区別しない。
     */
    const inbox = (): Effect.Effect<Batch, DbFailed> =>
      Effect.gen(function* () {
        const owner = ownerId()
        const pending = yield* meta<Pending>("discord:taps", {})
        const out: Inbound[] = []
        const marks: Record<string, string> = {}
        let heard: string | undefined
        // 比較用に、`heard` を決めたときのメッセージ id を別に持つ。`heard` はチャンネル id なので、
        // それと m.id を比べると常に m.id のほうが新しくなる(チャンネルはその中のどの
        // メッセージよりも先に作られる)。
        let heardAt: string | undefined

        // GET だけ並列にする。逐次だとチャンネル数ぶん往復が加算される(3 本で実測 1082〜2349ms、
        // 並列で 325〜932ms)。下のループは直列のまま — `pending` の消し込み、`heard`、`marks` の
        // 並びがチャンネルの順序に依存する。`Effect.all` は入力順で返す。
        const fetched = yield* Effect.all(
          (yield* listening()).map((ch) =>
            readJson<RawMessage[]>(`/channels/${ch}/messages?limit=50`).pipe(
              Effect.map((msgs) => ({ ch, msgs })),
            ),
          ),
          { concurrency: FETCH_AT_ONCE },
        )

        for (const { ch, msgs } of fetched) {
          if (!msgs?.length) continue

          const cursor = yield* cursorOf(ch)

          // 古い順に見る。API は新しい順で返す。
          for (const m of [...msgs].reverse()) {
            if (cursor && m.author.id === owner && m.content.trim() !== "" && newer(m.id, cursor)) {
              out.push({ id: m.id, text: m.content })
              // 一番新しい自由文のチャンネルを覚える。リアクションでは動かさない
              // (押すのは前に出したものへの返事で、話しかけられたのとは違う)。
              if (heardAt === undefined || newer(m.id, heardAt)) {
                heard = ch
                heardAt = m.id
              }
            }
            const waiting = pending[m.id]
            if (!waiting) continue
            for (const r of m.reactions ?? []) {
              const reply = waiting[r.emoji.name]
              // 自分で付けたぶんを超えていれば、bot 以外の誰かが押している。
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
          // チャンネルをまたいで snowflake の時刻順に並べる。同一ミリ秒内は id の数値順。
          items: out.sort((a, b) => (newer(a.id.split(":")[0] ?? "0", b.id.split(":")[0] ?? "0") ? 1 : -1)),
          marks,
          taps: pending,
          ...(heard === undefined ? {} : { heard }),
        } satisfies Batch
      })

    /**
     * cursor を DB に書く。`inbox` の返り値を記録し終えた側が呼ぶ。
     * 呼ばずに終えた回は次に同じものをもう一度読む。
     */
    const seen = (b: Batch): Effect.Effect<void, DbFailed> =>
      Effect.gen(function* () {
        for (const [ch, id] of Object.entries(b.marks)) yield* db.setMeta(`discord:last:${ch}`, id)
        if (b.heard !== undefined) yield* db.setMeta("discord:heard_in", b.heard)
        yield* db.setMeta("discord:taps", JSON.stringify(b.taps))
      })

    /** 出せるか。CLI の表示にだけ使う。 */
    const configured = (): boolean => token() !== undefined && ownerId() !== undefined

    /**
     * いまどのチャンネルに出るか。CLI の表示にだけ使う。
     * `talk` は最後に話しかけられたチャンネルで動くので、env を読むだけでは分からない。
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
  })

export class Discord extends Context.Service<Discord, Effect.Success<ReturnType<typeof makeDiscord>>>()(
  "Discord",
) {
  static readonly layer = Layer.effect(Discord, makeDiscord())
}
