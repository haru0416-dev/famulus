/**
 * 対話には締切が無く、そこで `Infinity` 以外が返ると `shell` が呼ぶ前に止まる。
 * 時計を止められないので、数ミリ秒の誤差を見る検査は書かない。
 */

import assert from "node:assert/strict"
import { test } from "vitest"
import { clearDeadline, remainingLabel, remainingMs, startDeadline } from "../../src/core/deadline.ts"

test("締切を宣言していなければ無限。対話は時間で切られない", () => {
  clearDeadline()
  assert.equal(remainingMs(), Number.POSITIVE_INFINITY)
  assert.equal(remainingLabel(), "締切なし")
})

test("宣言した持ち時間より多くは残らない", () => {
  clearDeadline()
  startDeadline(300_000)
  const left = remainingMs()
  assert.ok(left <= 300_000, `${left} が持ち時間を超えている`)
  // 検査機が詰まっても落ちないよう下限は緩く取る。
  assert.ok(left > 290_000, `${left} が減りすぎている`)
  assert.match(remainingLabel(), /^残り \d+ 秒$/)
  clearDeadline()
})

test("締切を過ぎたら負になる(0 で止めない)", () => {
  clearDeadline()
  startDeadline(-1_000)
  // 呼ぶ側は残り時間からコンテナの上限を決めるので、超過は負のまま渡す。
  assert.ok(remainingMs() < 0)
  assert.equal(remainingLabel(), "残り 0 秒")
  clearDeadline()
})

test("外したら元に戻る。1回の起動が次の起動に締切を持ち越さない", () => {
  startDeadline(1_000)
  clearDeadline()
  assert.equal(remainingMs(), Number.POSITIVE_INFINITY)
})
