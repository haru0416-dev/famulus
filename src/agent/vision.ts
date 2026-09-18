/**
 * 受け取った画像に検索と返信用の記述を付ける。モデルの裁量に任せず、コードが1画像1回だけ呼ぶ。
 * 記述は引用照合が効かないので belief に昇格させず、taint=1 の system 記録にする
 * (keeper は taint=0 の owner 発言しか材料にしない)。
 */
import * as Effect from "effect/Effect"
import type { DbFailed } from "../core/errors.ts"
import { type MediaRef, readMedia } from "../core/media.ts"
import { nowIso } from "../core/time.ts"
import type { RunError } from "../model/Runner.ts"
import { Runner } from "../model/Runner.ts"
import type { ObservedEvent } from "../services/Attention.ts"
import { Db } from "../services/Db.ts"
import { Memory } from "../services/Memory.ts"

/** 連投されても1回の cycle の実行時間を画像で使い切らないための上限。 */
export const DESCRIBE_MAX = 4

export const LOOKER_PROMPT = `あなたは受け取った画像に、後から検索と返信で使える記述を付ける役です。
見えるものだけを書きます。推測は「〜に見える」と書き、断定しません。
文字が写っているなら、読める文字をそのまま写します(日付・金額・固有名は特に)。
3行以内。文章の飾りは要らない — 何の画像で、何が読み取れるかだけ。`

interface PendingImage {
  readonly eventId: string
  readonly ref: MediaRef
  readonly saidText: string
}

const pendingImages = (events: readonly ObservedEvent[]): PendingImage[] => {
  const out: PendingImage[] = []
  for (const e of events) {
    if (e.source !== "owner") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(e.content)
    } catch {
      continue
    }
    if (typeof parsed !== "object" || parsed === null || !("images" in parsed)) continue
    const said = "said" in parsed && typeof parsed.said === "string" ? parsed.said : ""
    const images = (parsed as { images?: unknown }).images
    if (!Array.isArray(images)) continue
    for (const image of images) {
      if (
        typeof image === "object" &&
        image !== null &&
        typeof (image as MediaRef).sha === "string" &&
        typeof (image as MediaRef).mediaType === "string"
      ) {
        out.push({ eventId: e.id, ref: image as MediaRef, saidText: said })
      }
    }
  }
  return out
}

/** 記述イベントは source=system なので、次回の cycle の実行条件にならない。 */
export const describePendingImages = (
  events: readonly ObservedEvent[],
  opts: { readonly signal?: AbortSignal } = {},
): Effect.Effect<readonly string[], DbFailed | RunError, Runner | Db | Memory> =>
  Effect.gen(function* () {
    const targets = pendingImages(events)
    if (targets.length === 0) return []
    const runner = yield* Runner
    const db = yield* Db
    const mem = yield* Memory
    const notes: string[] = []
    for (const target of targets.slice(0, DESCRIBE_MAX)) {
      const described = yield* db.get(
        "SELECT 1 FROM events WHERE json_extract(content,'$.describedSha') = ? LIMIT 1",
        target.ref.sha,
      )
      if (described) continue
      const bytes = readMedia(target.ref)
      if (!bytes) continue
      const result = yield* runner
        .run({
          role: "looker",
          kind: "vision",
          systemPrompt: LOOKER_PROMPT,
          prompt: target.saidText
            ? `添付された画像。一緒に書かれていた本文: ${target.saidText.slice(0, 300)}`
            : "添付された画像。本文は無い。",
          images: [{ data: bytes, mediaType: target.ref.mediaType }],
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      const description = result?.text.trim()
      if (!description) continue
      yield* mem.remember({
        source: "system",
        taint: true,
        content: { describedSha: target.ref.sha, of: target.eventId, description },
        text: `画像の記述(未検証): ${description}`,
        at: nowIso(),
      })
      notes.push(`- ${target.ref.name ?? target.ref.sha.slice(0, 8)}: ${description}`)
    }
    return notes
  })
