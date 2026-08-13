/**
 * 受信箱を DB に移す。**tick と poll の両方から呼ばれる。**
 *
 * 経路は Discord の1本だけ(docs/adr/0029)。前は ntfy も読んでいたが、届く先が同じ端末で、
 * 返せる幅はこちらのほうが広い。**経路が2本あると、片方の位置(cursor)がずれたことに気付けない。**
 *
 * source は owner。Discord はユーザーしか居ない場所だけ(DM と、ユーザーが用意した囲いの中の
 * チャンネル)。**書いた人が誰かは author id で見る**ので、場所に他人が入ってきても owner には
 * ならない。仮に別の端末から投げられても、外に出る行為は予告を経るので実行前にユーザーの目を通る。
 */
import { Effect } from "effect"
import type { DbFailed } from "./core/errors.ts"
import { nowIso } from "./core/time.ts"
import { Discord } from "./services/Discord.ts"
import { Memory } from "./services/Memory.ts"

/** DB へ移した件数。**0 なら tick を起こす理由が無い。** */
export const drainInbox: Effect.Effect<number, DbFailed, Discord | Memory> = Effect.gen(function* () {
  const discord = yield* Discord
  const mem = yield* Memory
  const batch = yield* discord.inbox()
  for (const m of batch.items) yield* mem.remember({ source: "owner", content: m.text, at: nowIso() })
  // **記録してから位置を進める。** 先に進めると、`remember` が落ちた回に読んだぶんが位置の
  // 向こう側に取り残されて二度と来ない。何が消えたかも残らない。この順なら最悪でも二度覚えるだけ。
  yield* discord.seen(batch)
  return batch.items.length
})
