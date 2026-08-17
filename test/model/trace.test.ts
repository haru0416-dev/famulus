/**
 * DB の summary に最終本文をそのまま残しつつ、1行の保存上限を守る。
 */

import assert from "node:assert/strict"
import { test } from "vitest"
import { traceOf } from "../../src/model/trace.ts"

test("本文はそのまま扱う", () => {
  assert.equal(traceOf("ただの文"), "ただの文")
  assert.equal(traceOf('{"text":"道具の欄が無い JSON"}'), '{"text":"道具の欄が無い JSON"}')
})

test("1行が青天井にならない", () => {
  const out = traceOf("あ".repeat(5000))
  assert.ok(out.length <= 4001, `${out.length} 字`)
})
