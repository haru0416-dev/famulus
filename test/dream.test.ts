/**
 * 何日ぶんかの見直しの検査。材料の集め方を固定する。
 *
 * 判定そのものは keeper と共通なので、そちらの検査(test/keeper.test.ts)で押さえてある。
 * ここで見るのは、渡してはいけないものが材料に混ざらないことと、
 * 同じ材料を毎晩読み直さないこと。混ざると未検証の値が確定対象になり、
 * 読み直すと有効期間が1日だけの履歴行が増え続ける。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"

// 回す時刻の判定はユーザーの時計で切る。TZ はモジュール読み込み時に確定するので、import より先に差す。
process.env.OPEN_ZERO_TZ = "Asia/Tokyo"
const { DREAM_CURSOR, dream, dreamDue, dreamMaterial } = await import("../src/agent/dream.ts")
const { Db } = await import("../src/services/Db.ts")
const { Memory } = await import("../src/services/Memory.ts")
const { withHarness } = await import("./helpers.ts")

const AT = "2026-08-12T00:00:00Z"

const seed = Effect.gen(function* () {
  const mem = yield* Memory
  yield* mem.remember({ kind: "observe", source: "owner", content: "月曜の発言", at: "2026-08-10T01:00:00Z" })
  yield* mem.remember({ kind: "observe", source: "owner", content: "火曜の発言", at: "2026-08-11T01:00:00Z" })
  // 自分が書いたもの。ユーザーが言ったことではないので確定値の保存対象ではない。
  yield* mem.remember({
    kind: "observe",
    source: "system",
    content: "自分の記録",
    at: "2026-08-11T02:00:00Z",
  })
  // 外から来たもの。taint=1 は点を引くのではなく候補から外す。
  yield* mem.remember({ kind: "observe", source: "web", content: "拾ってきた文", at: "2026-08-11T03:00:00Z" })
  // 窓の外。7 日より前は見ない。
  yield* mem.remember({ kind: "observe", source: "owner", content: "先月の発言", at: "2026-07-01T01:00:00Z" })
})

test("材料はユーザーの発言だけ(自分の記録も外から来たものも入らない)", async () => {
  await withHarness(async (h) => {
    const out = await h.run(seed.pipe(Effect.andThen(dreamMaterial({ at: AT }))))
    assert.deepEqual(
      out.rows.map((r) => r.text),
      ["月曜の発言", "火曜の発言"],
    )
  })
})

test("窓より古い発言は入らない", async () => {
  await withHarness(async (h) => {
    const out = await h.run(seed.pipe(Effect.andThen(dreamMaterial({ at: AT, days: 1 }))))
    assert.deepEqual(
      out.rows.map((r) => r.text),
      ["火曜の発言"],
    )
  })
})

test("上限で切ったぶんは次の回に残る(古い順に返る)", async () => {
  await withHarness(async (h) => {
    const out = await h.run(seed.pipe(Effect.andThen(dreamMaterial({ at: AT, limit: 1 }))))
    assert.deepEqual(
      out.rows.map((r) => r.text),
      ["月曜の発言"],
    )
  })
})

test("--dry はモデルを呼ばずに件数だけ返す", async () => {
  await withHarness(async (h) => {
    const line = await h.run(seed.pipe(Effect.andThen(dream({ at: AT, dry: true }))))
    assert.match(line, /2 件の発言が対象/)
    assert.equal(h.calls.length, 0, "枠を1回も食わない")
  })
})

test("材料が無ければモデルを呼ばない", async () => {
  await withHarness(async (h) => {
    const line = await h.run(dream({ at: AT }))
    assert.match(line, /材料が無い/)
    assert.equal(h.calls.length, 0)
  })
})

/**
 * 最後に処理した位置を保存する。これが無いと同じ材料を毎晩読み直すことになり、
 * 同じ値が毎晩再保存されて有効期間が1日だけの履歴行が増え続ける。
 */
test("見たところまで進み、次の回はその先だけを見る", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          yield* seed
          const first = yield* dream({ at: AT })
          const db = yield* Db
          return {
            first,
            cursor: yield* db.meta(DREAM_CURSOR),
            second: yield* dreamMaterial({ at: AT }),
          }
        }),
      )
      assert.match(out.first, /2 件を見た/)
      assert.equal(out.cursor, "2026-08-11T01:00:00Z", "最後に読んだ発言の時刻まで進む")
      assert.equal(out.second.rows.length, 0, "同じ材料を読み直さない")
    },
    [{ text: "", structured: { looked: "繰り返しは無かった", values: [] } }],
  )
})

test("材料の見出しに、1回ぶんではないと書いてある", async () => {
  await withHarness(
    async (h) => {
      await h.run(seed.pipe(Effect.andThen(dream({ at: AT }))))
      const prompt = h.calls[0]?.prompt ?? ""
      assert.match(prompt, /1回ぶんではない/)
      // 対象期間を広げたぶんの判定は system 側に足す。keeper の本文は書き換えない。
      const system = h.calls[0]?.systemPrompt ?? ""
      assert.match(system, /別々の機会/)
      // 足すだけで、keeper の本文は残っている(判定を2本に割らない)。
      assert.match(system, /写せないなら保存しません/)
      // 繰り返しから保存する値の名前空間を固定する(割れると片方しか引けない)。
      assert.match(system, /`interest\.` で始めます/)
    },
    [{ text: "", structured: { looked: "見た", values: [] } }],
  )
})

test("保存候補は keeper と同じ照合を通る(写せない引用は除外される)", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          yield* seed
          const line = yield* dream({ at: AT })
          const mem = yield* Memory
          return { line, cur: yield* mem.belief("week.topic") }
        }),
      )
      assert.match(out.line, /1 件を確定値として保存/)
      assert.match(out.line, /引用が判定対象に無く 1 件を除外した/)
      assert.equal(out.cur?.value, "月曜と火曜に同じ話をしている")
    },
    [
      {
        text: "",
        structured: {
          looked: "日をまたいで同じ話が出ている",
          values: [
            { slot: "week.topic", value: "月曜と火曜に同じ話をしている", quote: "月曜の発言" },
            { slot: "week.other", value: "別の話", quote: "水曜にも言っていた" },
          ],
        },
      },
    ],
  )
})

test("その日ぶんが済んでいれば回さない", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const db = yield* Db
        const before = yield* dreamDue("2026-08-12T00:00:00Z") // ローカル 9:00
        yield* db.setMeta("daily:dream", "2026-08-12")
        return { before, after: yield* dreamDue("2026-08-12T00:00:00Z") }
      }),
    )
    assert.equal(out.before, true)
    assert.equal(out.after, false)
  })
})

test("ユーザーの時計で早すぎる時刻には回さない", async () => {
  await withHarness(async (h) => {
    // 2026-08-12T18:30:00Z = JST 翌 3:30。日付は変わっているが既定の 4 時より前。
    assert.equal(await h.run(dreamDue("2026-08-12T18:30:00Z")), false)
  })
})
