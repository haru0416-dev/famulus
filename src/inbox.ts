/**
 * 受信箱を台帳に移す。**心拍と口(poll)の両方から呼ばれる。**
 *
 * 口は2つ。ntfy はロック画面まで届くが返せる幅が狭く、Discord は持ち主が一番長く開いている。
 * どちらから来ても同じ owner イベントにする — 台帳の側で経路を気にする理由が無い。
 *
 * ntfy は位置を持っていない初回だけ**取り込まずに位置を進める**。数十時間ぶん抱えているので、
 * 位置なしで引くと昨日の返事が今日の指示として流れ込む(Discord 側は同じ規則を自分で持つ)。
 *
 * source は owner。ntfy の宛先は tailnet の中にしか出ておらず、Discord は持ち主との DM だけ。
 * 仮に別の端末から投げられても、外に出る行為は予告を経るので実行前に持ち主の目を通る。
 */
import { Effect } from "effect"
import type { DbFailed } from "./core/errors.ts"
import { nowIso } from "./core/time.ts"
import { Db } from "./services/Db.ts"
import { Discord } from "./services/Discord.ts"
import { Memory } from "./services/Memory.ts"
import { Notify } from "./services/Notify.ts"

export interface Drained {
  readonly count: number
  /**
   * 印を付け返す先。**自由文の最新1件だけ。** 印を押して返ってきたぶんは対象にしない
   * — 押した相手はこちらが出した下書きで、そこに受領の印を足しても何を指すのか読めない。
   */
  readonly ackId: string | undefined
}

export const drainInbox: Effect.Effect<Drained, DbFailed, Notify | Discord | Db | Memory> = Effect.gen(
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

    const inbound = yield* discord.inbox()
    said.push(...inbound.map((m) => m.text))

    for (const text of said) yield* mem.remember({ source: "owner", content: text, at: nowIso() })
    return {
      count: said.length,
      ackId: inbound.filter((m) => m.id === m.msgId).at(-1)?.msgId,
    }
  },
)
