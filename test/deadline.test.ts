/**
 * 締切の検査。残り時間そのものではなく、締切が無いときの形を見る。
 *
 * 実測で壊れたのは「締切があるのに道具が知らない」側だったが、検査で守りたいのは逆側 —
 * 対話には締切が無く、そこで `Infinity` 以外が返ると `shell` が呼ぶ前に降りるようになる。
 * 数ミリ秒の誤差を突く検査は書かない(時計を止められないので、書けば揺れる検査になる)。
 */

import assert from "node:assert/strict"
import { test } from "vitest"
import { clearDeadline, remainingLabel, remainingMs, startDeadline } from "../src/core/deadline.ts"

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
  // 下限は緩く取る。検査機が詰まっても落ちない幅にしておく — ここで見たいのは
  // 宣言が効いていることであって、時計の精度ではない。
  assert.ok(left > 290_000, `${left} が減りすぎている`)
  assert.match(remainingLabel(), /^残り \d+ 秒$/)
  clearDeadline()
})

test("締切を過ぎたら負になる(0 で止めない)", () => {
  clearDeadline()
  startDeadline(-1_000)
  // 0 に丸めない。丸めると「ちょうど尽きた」と「とっくに過ぎた」が同じ値になり、
  // 呼ぶ側が「引き算した残り」でコンテナの上限を決めているので、負のまま渡らないと気付けない。
  assert.ok(remainingMs() < 0)
  assert.equal(remainingLabel(), "残り 0 秒")
  clearDeadline()
})

test("外したら元に戻る。1回の起動が次の起動に締切を持ち越さない", () => {
  startDeadline(1_000)
  clearDeadline()
  assert.equal(remainingMs(), Number.POSITIVE_INFINITY)
})
