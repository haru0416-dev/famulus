/**
 * 受信箱を DB に移す。**tick と poll の両方から呼ばれる。**
 *
 * 経路は2つ。ntfy はロック画面まで届くが返せる幅が狭く、Discord はユーザーが一番長く開いている。
 * どちらから来ても同じ owner イベントにする — DB の側で経路を気にする理由が無い。
 *
 * ntfy は位置を持っていない初回だけ**取り込まずに位置を進める**。数十時間ぶん抱えているので、
 * 位置なしで引くと昨日の返事が今日の指示として流れ込む(Discord 側は同じ規則を自分で持つ)。
 *
 * source は owner。ntfy の宛先は tailnet の中にしか出ておらず、Discord はユーザーしか居ない場所だけ
 * (DM と、ユーザーが用意した囲いの中のチャンネル)。**書いた人が誰かは author id で見る**ので、
 * 場所に他人が入ってきても owner にはならない。仮に別の端末から投げられても、
 * 外に出る行為は予告を経るので実行前にユーザーの目を通る。
 */
import { Effect } from "effect"
import type { DbFailed } from "./core/errors.ts"
import { nowIso } from "./core/time.ts"
import { Db } from "./services/Db.ts"
import { Discord } from "./services/Discord.ts"
import { Memory } from "./services/Memory.ts"
import { Notify } from "./services/Notify.ts"

/** DB へ移した件数。**0 なら tick を起こす理由が無い。** */
export const drainInbox: Effect.Effect<number, DbFailed, Notify | Discord | Db | Memory> = Effect.gen(
  function* () {
    const notify = yield* Notify
    const discord = yield* Discord
    const db = yield* Db
    const mem = yield* Memory
    const said: string[] = []

    const cursor = yield* db.meta("ntfy:in_cursor")
    const msgs = yield* notify.inbox(cursor ?? "all")
    const last = msgs.at(-1)
    if (last) {
      yield* db.setMeta("ntfy:in_cursor", last.id)
      if (cursor) said.push(...msgs.map((m) => m.text))
    }

    said.push(...(yield* discord.inbox()).map((m) => m.text))

    for (const text of said) yield* mem.remember({ source: "owner", content: text, at: nowIso() })
    return said.length
  },
)
