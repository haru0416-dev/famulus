/**
 * DB に残る1行が、後から「何をしたか」を読めるかを見る。
 *
 * 元の実装は返り値を頭から 200字で切っていた。構造化経路の返り値は
 * `{"text":…,"toolCalls":[…]}` の順なので、発話が長い回ほど道具呼び出しが丸ごと消える。
 * 実際に cycle を1回走らせたとき、`task` を2つ投げた記録が読めなかった。
 */

import assert from "node:assert/strict"
import { test } from "vitest"
import { traceOf } from "../src/model/trace.ts"

test("本文はそのまま扱う", () => {
  assert.equal(traceOf("ただの文"), "ただの文")
  assert.equal(traceOf('{"text":"道具の欄が無い JSON"}'), '{"text":"道具の欄が無い JSON"}')
})

test("1行が青天井にならない", () => {
  const out = traceOf("あ".repeat(5000))
  assert.ok(out.length <= 4001, `${out.length} 字`)
})
