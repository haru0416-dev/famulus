/**
 * 同一ループ内の recall 規律。実際の失敗は「同じ語を11回引き直す」「該当なしを読んでも
 * 止まらない」だったので、検査もその2点を踏む: 同じ語が検索へ抜けないこと、
 * 空振りの返り文が回数で変わり、当たったら連続空振りの数え直しになること。
 */

import assert from "node:assert/strict"
import { test } from "vitest"
import { newRecallTurn, recallKey, recordRecall, repeatNotice } from "../../src/agent/recall-turn.ts"

test("初出の語は素通しで、ヒットは描画のまま返る", () => {
  const turn = newRecallTurn()
  assert.equal(repeatNotice(turn, "grok 移行"), undefined)
  const rendered = "- [2026-08-17 21:00 システム記録] grok へ移行した"
  assert.equal(recordRecall(turn, "grok 移行", rendered, 1), rendered)
})

test("同じ語の2回目は検索へ抜けず、件数つきで止める文が返る", () => {
  const turn = newRecallTurn()
  recordRecall(turn, "grok 移行", "- [row]", 3)
  const notice = repeatNotice(turn, "grok 移行")
  assert.ok(notice?.includes("3件"))
  assert.ok(notice?.includes("前の結果"))
})

test("空白の揺れは同じ語として扱い、別の語は通す", () => {
  const turn = newRecallTurn()
  recordRecall(turn, "grok  移行", "該当なし", 0)
  assert.equal(recallKey(" grok 移行 "), "grok 移行")
  assert.ok(repeatNotice(turn, " grok 移行 ")?.includes("0件"))
  assert.equal(repeatNotice(turn, "Grok 乗り換え"), undefined)
})

test("空振りの1回目は言い換えの一手、2回目は不在の結論を返す", () => {
  const turn = newRecallTurn()
  const first = recordRecall(turn, "計器", "該当なし", 0)
  assert.ok(first.startsWith("該当なし"))
  assert.ok(first.includes("別の語"))
  const second = recordRecall(turn, "ダッシュボード", "該当なし", 0)
  assert.ok(second.startsWith("該当なし"))
  assert.ok(second.includes("無いと結論"))
})

test("当たると連続空振りは数え直しになる", () => {
  const turn = newRecallTurn()
  recordRecall(turn, "計器", "該当なし", 0)
  recordRecall(turn, "利用量", "- [row]", 2)
  // 直前に当たっているので、次の空振りは1回目の文(言い換えの一手)に戻る。
  assert.ok(recordRecall(turn, "週次レポート", "該当なし", 0).includes("別の語"))
})

test("引き直しの短絡を挟んでも、別の語の空振りは2回目として結論に進む", () => {
  const turn = newRecallTurn()
  recordRecall(turn, "計器", "該当なし", 0)
  assert.ok(repeatNotice(turn, "計器")?.includes("0件"))
  assert.ok(recordRecall(turn, "メトリクス", "該当なし", 0).includes("無いと結論"))
})
