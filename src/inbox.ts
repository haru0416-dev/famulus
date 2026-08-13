/**
 * 受信箱を DB に移す。tick と poll の両方から呼ばれる。
 *
 * 読む先は Discord だけ(docs/adr/0029)。ntfy を併用していたときは、片方の cursor が
 * ずれても気付けなかった。
 *
 * source は owner。書き手の判定は author id で見るので、チャンネルに他人が入っても
 * owner にはならない。
 */
import * as Effect from "effect/Effect"
import type { DbFailed } from "./core/errors.ts"
import { nowIso } from "./core/time.ts"
import { Discord } from "./services/Discord.ts"
import { Memory } from "./services/Memory.ts"

/** この呼び出しで DB へ移した件数。 */
export const drainInbox: Effect.Effect<number, DbFailed, Discord | Memory> = Effect.gen(function* () {
  const discord = yield* Discord
  const mem = yield* Memory
  const batch = yield* discord.inbox()
  for (const m of batch.items) yield* mem.remember({ source: "owner", content: m.text, at: nowIso() })
  // 記録してから cursor を進める。逆順だと `remember` が落ちた回のぶんが cursor の
  // 向こう側に残って二度と読まれない。この順なら最悪でも二度記録するだけ。
  yield* discord.seen(batch)
  return batch.items.length
})
