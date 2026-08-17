/**
 * 受信箱を DB に移す。cycle と poll の両方から呼ばれる。
 *
 * 読む先は Discord だけ。ntfy を併用していたときは、片方の cursor が
 * ずれても気付けなかった。
 *
 * source は owner。書き手の判定は author id で見るので、チャンネルに他人が入っても
 * owner にはならない。
 *
 * 添付画像はここで取得して media へ保存し、event には参照(sha256)だけ置く。
 * 取得に失敗した画像は落として本文だけ記録する — 画像の都合でメッセージを失わない。
 * 画像の記述(モデル呼び出し)はここではやらない。poll はモデルを呼ばない決め。
 */
import * as Effect from "effect/Effect"
import type { ConnectorFailed, DbFailed } from "./core/errors.ts"
import { type MediaRef, saveMedia } from "./core/media.ts"
import { nowIso } from "./core/time.ts"
import { Discord } from "./services/Discord.ts"
import { Drafts } from "./services/Drafts.ts"
import { Memory } from "./services/Memory.ts"

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

/** この呼び出しで DB へ移した件数。 */
export const drainInbox: Effect.Effect<number, DbFailed | ConnectorFailed, Discord | Drafts | Memory> =
  Effect.gen(function* () {
    const discord = yield* Discord
    const drafts = yield* Drafts
    const mem = yield* Memory
    const batch = yield* discord.pollInbound()
    for (const m of batch.items) {
      if (m.draft) yield* drafts.applyDecision(m.draft.id, m.draft.decision, m.id)
      const location = batch.locations?.[m.id]
      const saved: MediaRef[] = []
      for (const image of m.images ?? []) {
        const ref = yield* Effect.promise(() => fetchImage(image.url, image.mediaType, image.name))
        if (ref) saved.push(ref)
      }
      yield* mem.remember({
        source: "owner",
        // 参照は content に置き、検索テキストは本文だけにする(sha を FTS に混ぜない)
        content: saved.length > 0 ? { said: m.text, images: saved } : m.text,
        ...(saved.length > 0 ? { text: m.text } : {}),
        at: nowIso(),
        origin: { kind: "discord", id: m.id },
        ...(location ? { provenance: [{ kind: "discord", ref: location }] } : {}),
      })
    }
    // 記録してから cursor を進める。逆順だと `remember` が失敗した回の項目が cursor より前に
    // 残って二度と読まれない。この順なら最悪でも二重に記録するだけ。
    yield* discord.commitInboundBatch(batch)
    return batch.items.length
  })
