/**
 * 止まった理由がそのまま DB に残るかを見る。
 *
 * 元の実装は `agent.read` の失敗を全部「300秒で切られた」として記録していた。
 * 実際に自律実行上限へ到達して 211 秒で止まった回も、DB には時間切れとして残っていて、
 * 記録を読んでも何を直せばいいか分からなかった。
 */

import assert from "node:assert/strict"
import { test } from "vitest"
import { causeReason } from "../../src/core/errors.ts"

/**
 * `Error: ` を頭に付けない。いまゲートが投げるのは素の `Error` で、
 * `String(e)` のまま記録すると「止まった: Error: 停止中(halt): …」になる。
 */
test("meta が無ければ一番内側の message を返す", () => {
  assert.equal(causeReason(new Error("接続が切れた")), "接続が切れた")
  assert.equal(
    causeReason(new Error("道具の中で落ちた", { cause: new Error("停止中(halt): 予算を止めた") })),
    "停止中(halt): 予算を止めた",
  )
})

/** message も meta も無いものは埋めない。分からないことを分かったように書かない。 */
test("取り出せるものが無ければ元の文字列を返す", () => {
  assert.equal(causeReason("ただの文字列"), "ただの文字列")
  assert.equal(causeReason(undefined), "undefined")
  assert.equal(causeReason({ _tag: "Halt" }), "[object Object]")
})

test("何段包まれていても辿る", () => {
  const deep = new Error("外", {
    cause: new Error("中", { cause: new Error("pool chatgpt-oauth は再実行抑止中") }),
  })
  assert.equal(causeReason(deep), "pool chatgpt-oauth は再実行抑止中")
})

test("cause が輪になっていても止まる", () => {
  const a: { cause?: unknown } = {}
  const b = { cause: a }
  a.cause = b
  assert.equal(typeof causeReason(a), "string")
})
