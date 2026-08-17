/**
 * 拒否を人へ見せる一行(describeRefusal)の検査。承認ボード・CLI に出る唯一の文言。
 */

import assert from "node:assert/strict"
import { test } from "vitest"
import {
  DailyRunLimit,
  DeliveryRejected,
  describeRefusal,
  Halt,
  QuotaCooldown,
} from "../../src/core/errors.ts"

test("4種の拒否がそれぞれ理由の載った一行になる", () => {
  assert.match(
    describeRefusal(new Halt({ reason: "手動停止", at: "2026-01-01T00:00:00Z" })),
    /停止中.*手動停止/,
  )
  assert.match(
    describeRefusal(new QuotaCooldown({ pool: "p", window: "week", untilMs: Date.now() + 90_000 })),
    /p\/week.*あと約2分/,
  )
  // 期限を過ぎた値は負の分にしない
  assert.match(
    describeRefusal(new QuotaCooldown({ pool: "p", window: "5h", untilMs: Date.now() - 60_000 })),
    /あと約0分/,
  )
  assert.match(describeRefusal(new DailyRunLimit({ count: 12, limit: 10 })), /12\/10/)
  assert.match(describeRefusal(new DeliveryRejected({ reason: "引用が無い" })), /差し戻し.*引用が無い/)
})
