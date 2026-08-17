/**
 * looker(画像の記述役)の検査。モデルは RunnerStub。実画像の判定品質はここでは見ない —
 * それは実走で確かめる。ここで固定するのは前処理の規律:
 * 1画像1回・記述は taint=1 の system 記録・実体の無い参照は飛ばす。
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { describePendingImages } from "../../src/agent/vision.ts"
import { configureApp } from "../../src/core/config.ts"
import { saveMedia } from "../../src/core/media.ts"
import type { ObservedEvent } from "../../src/services/Attention.ts"
import { Db } from "../../src/services/Db.ts"
import { Memory } from "../../src/services/Memory.ts"
import { withHarness } from "../helpers.ts"

const ownerEvent = (id: string, content: unknown, rowid = 1): ObservedEvent => ({
  rowid,
  id,
  at: "2026-08-08T09:00:00Z",
  source: "owner",
  taint: 0,
  content: JSON.stringify(content),
})

test("未記述の画像に記述を1回だけ付け、taint=1 の system 記録に残す", async () => {
  const saved = process.env.FAMULUS_DATA
  const dir = mkdtempSync(join(tmpdir(), "vision-test-"))
  try {
    process.env.FAMULUS_DATA = dir
    configureApp()
    const ref = saveMedia(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), "image/png")

    await withHarness(
      async (h) => {
        const events = [
          ownerEvent("ev-1", { said: "予約票の写真", images: [{ ...ref, name: "yoyaku.png" }] }),
        ]
        const first = await h.run(describePendingImages(events))
        assert.equal(first.length, 1)
        assert.match(first[0] ?? "", /yoyaku\.png/)
        assert.match(first[0] ?? "", /病院の予約票/)

        const row = await h.run(
          Effect.flatMap(Db, (db) =>
            db.get(
              "SELECT source, taint, json_extract(content,'$.description') d FROM events WHERE json_extract(content,'$.describedSha') = ?",
              ref.sha,
            ),
          ),
        )
        assert.equal(row?.source, "system")
        assert.equal(Number(row?.taint), 1)
        assert.match(String(row?.d), /病院の予約票/)

        // 2回目は記述済みなので何もしない(stub の残り台本も消費しない)
        const second = await h.run(describePendingImages(events))
        assert.equal(second.length, 0)

        // 記述は recall で引ける(検索テキストに入っている)
        const hits = await h.run(Effect.flatMap(Memory, (m) => m.recall("予約票")))
        assert.ok(hits.some((r) => String(r.text ?? "").includes("画像の記述(未検証)")))
      },
      [{ text: "病院の予約票の写真。「8/24 10:00」と読める。" }],
    )
  } finally {
    if (saved === undefined) delete process.env.FAMULUS_DATA
    else process.env.FAMULUS_DATA = saved
    configureApp()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("実体の無い参照と画像なしイベントは飛ばす", async () => {
  await withHarness(async (h) => {
    const notes = await h.run(
      describePendingImages([
        ownerEvent("ev-2", {
          said: "参照だけ残った",
          images: [{ sha: "f".repeat(64), mediaType: "image/png" }],
        }),
        ownerEvent("ev-3", "ただの本文"),
      ]),
    )
    assert.equal(notes.length, 0)
  })
})
