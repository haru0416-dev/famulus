/**
 * ユーザーとやり取りする経路。**こちらから行ける唯一の経路であり、向こうから返ってくる唯一の経路。**
 *
 * 記録に書くだけのものは、ユーザーが `oz recall` を打つまで誰も読まない。取りに来させる形は、
 * 取りに来なくなった日に全部止まる。押す側を持っていないと、調べたことは溜まるだけで届かない。
 *
 * 出し先は tailnet の中に閉じた ntfy(`tailscale serve --https=8443` の先)。
 * ufw は開けていないので、本文はユーザーの端末以外には届かない。
 *
 * 返りは別トピックで受ける。**同じトピックに混ぜない** — 出したものが自分の受信箱に戻ってきて、
 * 自分の発言をユーザーの発言として取り込む輪ができる。
 *
 * 設定が無ければ**黙って何もしない**。通知の経路が塞がっていることで tick を止めない
 * — 届かないより、動かないほうが困る。
 */
import { Effect } from "effect"

/** ntfy の宛先。トピックが未設定なら通知は出さない(no-op になる)。 */
const endpoint = (): { url: string; topic: string } | undefined => {
  const topic = process.env.OPEN_ZERO_NTFY_TOPIC
  if (!topic) return undefined
  return { url: process.env.OPEN_ZERO_NTFY_URL ?? "http://127.0.0.1:8790", topic }
}

/** 返信を受けるトピック。出す側とは別に設定する — 未設定ならボタンを付けず、受信箱も空のまま。 */
const inTopic = (): string | undefined => process.env.OPEN_ZERO_NTFY_TOPIC_IN

/**
 * 端末から見た ntfy の URL。**押し戻しのボタンはこれを踏む。**
 * 送信側の既定は 127.0.0.1 だが、それはスマホからは自分自身を指してしまう。
 * tailnet の名前を設定していなければボタンは出さない(押しても何も起きないボタンより無いほうがよい)。
 */
const publicUrl = (): string | undefined => process.env.OPEN_ZERO_NTFY_PUBLIC_URL

/** 通知に付ける押し戻し。押すと `reply` がユーザーの発言として受信箱に入る。 */
export interface Action {
  /** ボタンの文字。ロック画面に並ぶので短く。 */
  readonly label: string
  /** 押されたときに受信箱へ入る文。次の tick がこれをユーザーの発言として読む。 */
  readonly reply: string
}

export interface Push {
  /** 通知の1行目。ロック画面で読めるのはここまでなので、ここだけで用が分かる形にする。 */
  readonly title: string
  readonly body: string
  /** 1(最小)〜5(最大)。既定の 3 以外は、鳴らし方が変わることを承知で使う。 */
  readonly priority?: number
  /** スマホ側で開く URL。 */
  readonly click?: string
  /** 押し戻しのボタン。ntfy の上限に合わせて先頭3つまで。 */
  readonly actions?: readonly Action[]
}

/** 受信箱に届いていた1件。 */
export interface Inbound {
  readonly id: string
  readonly text: string
}

/** ヘッダに日本語を載せると符号化が要るので、JSON の発行形式を使う。 */
const body = (topic: string, p: Push) => ({
  topic,
  title: p.title,
  message: p.body,
  ...(p.priority ? { priority: p.priority } : {}),
  ...(p.click ? { click: p.click } : {}),
  ...(buttons(p.actions) ?? {}),
})

/**
 * 押し戻しを ntfy の action に組み立てる。**押すと受信箱に発行する http action** にしてある
 * — ntfy 以外に受信の経路を増やさずに済み、返りの経路が1本で済む。
 * 受信トピックか外向き URL が無ければボタンごと落とす。
 */
const buttons = (actions: readonly Action[] | undefined) => {
  const topic = inTopic()
  const base = publicUrl()
  if (!actions?.length || !topic || !base) return undefined
  return {
    actions: actions.slice(0, 3).map((a) => ({
      action: "http",
      label: a.label,
      url: base,
      method: "POST",
      body: JSON.stringify({ topic, message: a.reply }),
      // 押したら通知を消す。押したのに残っていると、押せていないと思ってもう一度押す。
      clear: true,
    })),
  }
}

export class Notify extends Effect.Service<Notify>()("Notify", {
  effect: Effect.gen(function* () {
    /**
     * 1件押す。**失敗しても例外にしない** — 呼ぶ側は戻り値を見なくてよい。
     * 送れたら true、宛先が未設定・網が繋がらない・ntfy が落ちているときは false。
     */
    const push = (p: Push): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const to = endpoint()
        if (!to) return false
        const res = yield* Effect.tryPromise(() =>
          fetch(to.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body(to.topic, p)),
            signal: AbortSignal.timeout(5000),
          }),
        )
        return res.ok
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))

    /**
     * 受信箱を覗く。`since` は前回読んだ最後の id。**常駐して待たない** — tick が起きたときに
     * 溜まっているぶんを引くだけにしてある。待ち受けを増やすと落ちたときに黙って死ぬ経路が1本増える。
     *
     * 取れなければ空。**「届いていない」と「受信箱が壊れている」を呼ぶ側に区別させない**
     * — どちらの場合も、tick がやることは変わらない。
     */
    const inbox = (since: string): Effect.Effect<readonly Inbound[]> =>
      Effect.gen(function* () {
        const to = endpoint()
        const topic = inTopic()
        if (!to || !topic) return []
        const res = yield* Effect.tryPromise(() =>
          fetch(`${to.url}/${topic}/json?poll=1&since=${encodeURIComponent(since)}`, {
            signal: AbortSignal.timeout(5000),
          }),
        )
        if (!res.ok) return []
        const raw = yield* Effect.tryPromise(() => res.text())
        // 1行1件の JSON。購読の開閉通知など message 以外の行が混ざる。
        return raw
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as { id?: string; event?: string; message?: string })
          .filter((m) => m.event === "message" && typeof m.id === "string" && typeof m.message === "string")
          .map((m) => ({ id: m.id as string, text: m.message as string }))
      }).pipe(Effect.catchAll(() => Effect.succeed([] as readonly Inbound[])))

    /** 宛先が設定されているか。人に「通知は出ない」と伝えるためだけに使う。 */
    const configured = (): boolean => endpoint() !== undefined

    /** 押し戻しを受けられるか。受信トピックと外向き URL の両方が要る。 */
    const canReply = (): boolean => inTopic() !== undefined && publicUrl() !== undefined

    return { push, inbox, configured, canReply } as const
  }),
}) {}
