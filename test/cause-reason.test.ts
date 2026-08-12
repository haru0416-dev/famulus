/**
 * 止まった理由が**そのまま台帳に残るか**を見る。
 *
 * 元の実装は `agent.read` の失敗を全部「300秒で切られた」として記録していた。
 * 実際に自走枠を使い切って 211 秒で止まった回も、台帳には時間切れとして残っていて、
 * **記録を読んでも何を直せばいいか分からなかった**(docs/adr/0011)。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { causeReason } from "../src/core/errors.ts"

/** Flue が実際に投げてくる形。理由は外側に出ず、内側の `meta.reason` にだけある。 */
const flueError = (reason: string): Error => {
  const inner = Object.assign(new Error("dispatch failed"), {
    meta: { operation: "dispatch(sub_01X)", reason },
  })
  return Object.assign(new Error("[flue] Agent run failed (submission sub_01X)."), { cause: inner })
}

test("包まれた理由を取り出す", () => {
  assert.equal(causeReason(flueError("日次 run 上限に到達(60/60)")), "日次 run 上限に到達(60/60)")
})

test("理由が無ければ元の文字列を返す(分からないことを埋めない)", () => {
  assert.equal(causeReason(new Error("接続が切れた")), "Error: 接続が切れた")
  assert.equal(causeReason("ただの文字列"), "ただの文字列")
  assert.equal(causeReason(undefined), "undefined")
})

test("何段包まれていても辿る", () => {
  const deep = Object.assign(new Error("外"), {
    cause: { cause: flueError("枠 claude-max はクールダウン中") },
  })
  assert.equal(causeReason(deep), "枠 claude-max はクールダウン中")
})

test("cause が輪になっていても止まる", () => {
  const a: { cause?: unknown } = {}
  const b = { cause: a }
  a.cause = b
  assert.equal(typeof causeReason(a), "string")
})
