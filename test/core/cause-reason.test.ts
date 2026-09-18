import assert from "node:assert/strict"
import { test } from "vitest"
import { causeReason } from "../../src/core/errors.ts"

/** `String(e)` で記録すると頭に「Error: 」が付くので、message を取り出す。 */
test("meta が無ければ一番内側の message を返す", () => {
  assert.equal(causeReason(new Error("接続が切れた")), "接続が切れた")
  assert.equal(
    causeReason(new Error("道具の中で落ちた", { cause: new Error("停止中(halt): 予算を止めた") })),
    "停止中(halt): 予算を止めた",
  )
})

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
