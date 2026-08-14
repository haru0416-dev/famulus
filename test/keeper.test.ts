/**
 * 締めの keeper の検査。保存条件を満たす値だけが保存されるかを見る。
 *
 * ここで通したものは、後の回が「今の事実」として無検査で使う。だから問題なのは保存漏れよりも、
 * 根拠の無い値が保存されることのほう。引用の照合はコード側にあり(`keepGrounded`)、
 * 指示が守られなかったときに落ちる場所がそこしかない — そこを固定する。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { keep, keepGrounded } from "../src/agent/keeper.ts"
import { Db } from "../src/services/Db.ts"
import { Memory } from "../src/services/Memory.ts"
import { withHarness } from "./helpers.ts"

const MATERIAL = "[2026-08-08T09:00:00Z] owner: 歯医者、来週の水曜18時に変更した。さくら歯科ね"

test("材料からそのまま写した引用のものだけ残る", () => {
  const kept = keepGrounded(
    [
      { slot: "dentist.next_appt", value: "8/12(水)18:00", quote: "来週の水曜18時に変更した" },
      { slot: "dentist.clinic", value: "さくら歯科", quote: "歯医者はさくら歯科です" },
    ],
    MATERIAL,
  )
  assert.deepEqual(
    kept.map((v) => v.slot),
    ["dentist.next_appt"],
  )
})

test("空白の違いは無視する(写すときに改行や字下げが揃い直る)", () => {
  const kept = keepGrounded([{ slot: "a.b", value: "v", quote: "来週の水曜 18時に\n変更した" }], MATERIAL)
  assert.equal(kept.length, 1)
})

test("短すぎる引用は照合として働かないので落とす", () => {
  const kept = keepGrounded([{ slot: "a.b", value: "v", quote: "歯" }], MATERIAL)
  assert.equal(kept.length, 0)
})

test("同じ slot を1回で2度保存しない(同じ開始時刻の区間を2本作らない)", () => {
  const kept = keepGrounded(
    [
      { slot: "dentist.next_appt", value: "8/12 18:00", quote: "来週の水曜18時に変更した" },
      { slot: "dentist.next_appt", value: "8/12 19:00", quote: "さくら歯科ね" },
    ],
    MATERIAL,
  )
  assert.equal(kept.length, 1)
  assert.equal(kept[0]?.value, "8/12 18:00")
})

test("ユーザーの発言が無い回はモデルを呼ばない", async () => {
  await withHarness(async (h) => {
    const line = await h.run(keep({ material: "  \n " }))
    assert.match(line, /判定対象が無い/)
    assert.equal(h.calls.length, 0, "枠を1回も食わない")
  })
})

test("上げたものは確定値になり、既存の slot は区間が継がれる", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const mem = yield* Memory
          const db = yield* Db
          yield* mem.believe("dentist.next_appt", "8/5(水)18:00", { validFrom: "2026-07-01T00:00:00Z" })
          const evidence = yield* mem.remember({ source: "owner", content: MATERIAL })
          const line = yield* keep({ material: MATERIAL, evidence: [{ id: evidence, text: MATERIAL }] })
          const grounded = yield* db.get(
            "SELECT evidence_event_id,evidence_quote FROM events WHERE belief_slot='dentist.next_appt' ORDER BY seq DESC LIMIT 1",
          )
          return {
            line,
            cur: yield* mem.belief("dentist.next_appt"),
            hist: yield* mem.beliefHistory("dentist.next_appt"),
            grounded,
            evidence,
          }
        }),
      )
      assert.equal(out.cur?.value, "8/12(水)18:00")
      // 上書きしない。前の値は区間が閉じた形で残る。
      assert.equal(out.hist.length, 2)
      assert.equal(out.hist[0]?.value, "8/5(水)18:00")
      assert.equal(out.hist[0]?.validUntil, "2026-08-08T00:00:00Z")
      assert.equal(out.grounded?.evidence_event_id, out.evidence)
      // 引用が写せずに除外した件数は、保存対象が無かったのとは別に残す。
      assert.match(out.line, /1 件を確定値として保存/)
      assert.match(out.line, /引用が判定対象に無く 1 件を除外した/)
    },
    [
      {
        text: "",
        structured: {
          looked: "歯医者の予約が変わった旨と医院名を見た",
          values: [
            {
              slot: "dentist.next_appt",
              value: "8/12(水)18:00",
              quote: "来週の水曜18時に変更した",
              validFrom: "2026-08-08T00:00:00Z",
              reason: "ユーザーが変更したと言った",
            },
            { slot: "dentist.clinic", value: "さくら歯科", quote: "通っているのはさくら歯科" },
          ],
        },
      },
    ],
  )
})

/**
 * 二人目の書き手にしない。本体が既に確定させた slot は触らない。
 *
 * 触ると、本体が書いた値を数十秒後に言い換えた区間が追加される。端から端まで走らせた回で実際に起き、
 * 有効期間が23秒の区間が2本追加され、keeper の短い言い換えが本体の値より上位に表示された。
 */
test("この回で本体が確定させた slot は、keeper が書き直さない", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const mem = yield* Memory
          const since = "2026-08-08T09:00:00Z"
          yield* mem.believe("dentist.next_appt", "さくら歯科の次回予約は8/12(水)18:00。担当は鈴木さん")
          const line = yield* keep({ material: MATERIAL, since })
          return {
            line,
            cur: yield* mem.belief("dentist.next_appt"),
            hist: yield* mem.beliefHistory("dentist.next_appt"),
          }
        }),
      )
      assert.match(out.cur?.value ?? "", /担当は鈴木さん/, "本体の書いた値が残っている")
      assert.equal(out.hist.length, 1, "言い換えた区間が上に乗らない")
      assert.match(out.line, /1 件はこの回で確定済み/)
    },
    [
      {
        text: "",
        structured: {
          looked: "予約の変更を見た",
          values: [{ slot: "dentist.next_appt", value: "8/12 18:00", quote: "来週の水曜18時に変更した" }],
        },
      },
    ],
  )
})

test("保存対象が無い回でも、何を見たかは残る", async () => {
  await withHarness(
    async (h) => {
      const line = await h.run(keep({ material: MATERIAL }))
      assert.match(line, /保存対象は無かった/)
      assert.match(line, /確言していない/)
    },
    [{ text: "", structured: { looked: "予定の話だけで、確言していない", values: [] } }],
  )
})

test("引用に対応するowner eventが無ければbeliefを保存しない", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const mem = yield* Memory
          const evidence = yield* mem.remember({ source: "owner", content: "別の発言" })
          const line = yield* keep({
            material: MATERIAL,
            evidence: [{ id: evidence, text: "owner: 別の発言" }],
          })
          return { line, belief: yield* mem.belief("dentist.next_appt") }
        }),
      )
      assert.equal(out.belief, undefined)
      assert.match(out.line, /引用が判定対象に無く 1 件を除外した/)
    },
    [
      {
        text: "",
        structured: {
          looked: "予約変更を見た",
          values: [{ slot: "dentist.next_appt", value: "8/12 18:00", quote: "来週の水曜18時に変更した" }],
        },
      },
    ],
  )
})

test("keeper が呼べなくても回全体は失敗しない", async () => {
  await withHarness(
    async (h) => {
      const line = await h.run(keep({ material: MATERIAL }))
      assert.match(line, /呼べなかった/)
    },
    [{ text: "", fail: "モデルが落ちた" }],
  )
})
