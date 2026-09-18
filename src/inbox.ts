/**
 * 受信箱を DB に移す(cycle と poll から呼ぶ)。owner の判定は author id で行う。
 * 取得に失敗した画像は落として本文だけ記録する。画像の記述はしない(poll はモデルを呼ばない)。
 */
import * as Effect from "effect/Effect"
import { type ConnectorFailed, causeReason, type DbFailed } from "./core/errors.ts"
import { type MediaRef, saveMedia } from "./core/media.ts"
import { nowIso } from "./core/time.ts"
import { Discord } from "./services/Discord.ts"
import { Drafts } from "./services/Drafts.ts"
import { Memory } from "./services/Memory.ts"
import { Proposals, REACTION_DENY_REASON } from "./services/Proposals.ts"

const FETCH_IMAGE_TIMEOUT_MS = 20_000

const fetchImage = async (url: string, mediaType: string, name?: string): Promise<MediaRef | undefined> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_IMAGE_TIMEOUT_MS) })
    if (!res.ok) return undefined
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0) return undefined
    return { ...saveMedia(bytes, mediaType), ...(name ? { name } : {}) }
  } catch {
    return undefined
  }
}

export const drainInbox: Effect.Effect<
  number,
  DbFailed | ConnectorFailed,
  Discord | Drafts | Memory | Proposals
> = Effect.gen(function* () {
  const discord = yield* Discord
  const drafts = yield* Drafts
  const mem = yield* Memory
  const proposals = yield* Proposals
  const batch = yield* discord.pollInbound()
  for (const m of batch.items) {
    if (m.draft) yield* drafts.applyDecision(m.draft.id, m.draft.decision, m.id)
    // 受信時点で期限切れ・決定済みのことがある。失敗にすると同じ回の他の発言まで DB へ入らない。
    if (m.proposal) {
      const target = m.proposal
      const decided = yield* Effect.result(
        target.decision === "approve"
          ? proposals.approve(target.id, { approverRef: "owner-discord" })
          : proposals.deny(target.id, REACTION_DENY_REASON),
      )
      if (decided._tag === "Failure") {
        const verb = target.decision === "approve" ? "承認" : "却下"
        const why = causeReason(decided.failure)
        yield* mem.remember({
          kind: "observe",
          source: "system",
          content: { proposal: target.id, decision: target.decision, failed: why },
          text: `提案 ${target.id.slice(0, 8)} の${verb}は適用できなかった: ${why}`,
          at: nowIso(),
        })
      }
    }
    const location = batch.locations?.[m.id]
    const saved: MediaRef[] = []
    for (const image of m.images ?? []) {
      const ref = yield* Effect.promise(() => fetchImage(image.url, image.mediaType, image.name))
      if (ref) saved.push(ref)
    }
    yield* mem.remember({
      source: "owner",
      // sha を FTS に混ぜないため、参照は content に置く
      content: saved.length > 0 ? { said: m.text, images: saved } : m.text,
      ...(saved.length > 0 ? { text: m.text } : {}),
      at: nowIso(),
      origin: { kind: "discord", id: m.id },
      ...(location ? { provenance: [{ kind: "discord", ref: location }] } : {}),
    })
  }
  // 記録してから cursor を進める。逆順だと記録に失敗した項目が二度と読まれない。
  // この順なら最悪でも二重記録で済む。
  yield* discord.commitInboundBatch(batch)
  return batch.items.length
})
