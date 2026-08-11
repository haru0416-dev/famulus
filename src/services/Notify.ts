/**
 * 持ち主に届ける口。**こちらから行く唯一の経路。**
 *
 * 記録に書くだけのものは、持ち主が `oz recall` を打つまで誰も読まない。取りに来させる形は、
 * 取りに来なくなった日に全部止まる。押す側を持っていないと、調べたことは溜まるだけで届かない。
 *
 * 出し先は tailnet の中に閉じた ntfy(`tailscale serve --https=8443` の先)。
 * ufw は開けていないので、本文は持ち主の端末以外には届かない。
 *
 * 設定が無ければ**黙って何もしない**。通知の口が塞がっていることで心拍を止めない
 * — 届かないより、動かないほうが困る。
 */
import { Effect } from "effect"

/** ntfy の宛先。トピックが未設定なら通知は出さない(no-op になる)。 */
const endpoint = (): { url: string; topic: string } | undefined => {
  const topic = process.env.OPEN_ZERO_NTFY_TOPIC
  if (!topic) return undefined
  return { url: process.env.OPEN_ZERO_NTFY_URL ?? "http://127.0.0.1:8790", topic }
}

export interface Push {
  /** 通知の1行目。ロック画面で読めるのはここまでなので、ここだけで用が分かる形にする。 */
  readonly title: string
  readonly body: string
  /** 1(最小)〜5(最大)。既定の 3 以外は、鳴らし方が変わることを承知で使う。 */
  readonly priority?: number
  /** スマホ側で開く URL。 */
  readonly click?: string
}

/** ヘッダに日本語を載せると符号化が要るので、JSON の発行口を使う。 */
const body = (topic: string, p: Push) => ({
  topic,
  title: p.title,
  message: p.body,
  ...(p.priority ? { priority: p.priority } : {}),
  ...(p.click ? { click: p.click } : {}),
})

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

    /** 宛先が設定されているか。人に「通知は出ない」と伝えるためだけに使う。 */
    const configured = (): boolean => endpoint() !== undefined

    return { push, configured } as const
  }),
}) {}
