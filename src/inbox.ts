/**
 * 受信箱を DB に移す。cycle と poll の両方から呼ばれる。
 *
 * 読む先は Discord だけ。ntfy を併用していたときは、片方の cursor が
 * ずれても気付けなかった。
 *
 * source は owner。書き手の判定は author id で見るので、チャンネルに他人が入っても
 * owner にはならない。
 */
import * as Effect from "effect/Effect"
import type { ConnectorFailed, DbFailed } from "./core/errors.ts"
import { nowIso } from "./core/time.ts"
import { Discord } from "./services/Discord.ts"
import { Drafts } from "./services/Drafts.ts"
import { Memory } from "./services/Memory.ts"

/** この呼び出しで DB へ移した件数。 */
export const drainInbox: Effect.Effect<number, DbFailed | ConnectorFailed, Discord | Drafts | Memory> =
  Effect.gen(function* () {
    const discord = yield* Discord
    const drafts = yield* Drafts
    const mem = yield* Memory
    const batch = yield* discord.pollInbound()
    for (const m of batch.items) {
      if (m.draft) yield* drafts.applyDecision(m.draft.id, m.draft.decision, m.id)
      yield* mem.remember({
        source: "owner",
        content: m.text,
        at: nowIso(),
        origin: { kind: "discord", id: m.id },
      })
    }
    // 記録してから cursor を進める。逆順だと `remember` が失敗した回の項目が cursor より前に
    // 残って二度と読まれない。この順なら最悪でも二重に記録するだけ。
    yield* discord.commitInboundBatch(batch)
    return batch.items.length
  })
