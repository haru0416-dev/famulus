import assert from "node:assert/strict"
import fc from "fast-check"
import { test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { localDayRange, localMonthRange, localStamp, timeZone } from "../../src/core/time.ts"

test("FAMULUS_TZ で既定と異なるtimezoneへ差し替えられる", () => {
  const previous = process.env.FAMULUS_TZ
  process.env.FAMULUS_TZ = "UTC"
  try {
    configureApp()
    assert.equal(timeZone(), "UTC")
    assert.equal(localDayRange("2026-08-07T16:55:00Z").key, "2026-08-07")
  } finally {
    if (previous === undefined) delete process.env.FAMULUS_TZ
    else process.env.FAMULUS_TZ = previous
    configureApp()
  }
})

test("UTC の日ではなくローカルの日で切る", () => {
  // JST では 08-08 の 01:55。UTC で切ると 08-07 になる。
  const r = localDayRange("2026-08-07T16:55:00Z")
  assert.equal(r.key, "2026-08-08")
  assert.equal(r.startIso, "2026-08-07T15:00:00Z")
  assert.equal(r.endIso, "2026-08-08T15:00:00Z")
})

test("日跨ぎの直前・直後が別の日に落ちる", () => {
  assert.equal(localDayRange("2026-08-07T14:59:59Z").key, "2026-08-07")
  assert.equal(localDayRange("2026-08-07T15:00:00Z").key, "2026-08-08")
})

test("月末の繰り上がり", () => {
  const r = localMonthRange("2026-12-31T16:00:00Z")
  assert.equal(r.key, "2027-01")
  assert.equal(r.startIso, "2026-12-31T15:00:00Z")
  assert.equal(r.endIso, "2027-01-31T15:00:00Z")
})

test("記録の時刻はユーザーの時計で見せる(夜中の記録を前日にしない)", () => {
  // UTC のまま渡すと、モデルは深夜の記録を前日の午後として読む。
  assert.equal(localStamp("2026-08-10T15:52:00Z"), "2026-08-11 00:52")
  assert.equal(localStamp("2026-08-10T15:52:00Z", false), "2026-08-11")
  assert.equal(localStamp("2026-08-11T03:00:00Z"), "2026-08-11 12:00")
  // DB の古い行を落とさないよう、読めない値はそのまま返す。
  assert.equal(localStamp("いつか"), "いつか")
})

test("範囲は半開区間で、隣の日と重ならない", () => {
  const a = localDayRange("2026-08-08T02:00:00Z")
  const b = localDayRange("2026-08-09T02:00:00Z")
  assert.equal(a.endIso, b.startIso)
  assert.notEqual(a.key, b.key)
})

test("任意の instant は、そのローカル日・月の半開区間に一度だけ収まる", () => {
  fc.assert(
    fc.property(
      fc.date({
        min: new Date("2000-01-01T00:00:00Z"),
        max: new Date("2035-12-31T23:59:59Z"),
        noInvalidDate: true,
      }),
      (at) => {
        const atIso = at.toISOString()
        for (const range of [localDayRange(atIso), localMonthRange(atIso)]) {
          assert.ok(Date.parse(range.startIso) <= at.getTime())
          assert.ok(at.getTime() < Date.parse(range.endIso))
          assert.ok(Date.parse(range.startIso) < Date.parse(range.endIso))
        }
        assert.equal(localDayRange(atIso).key, localStamp(atIso, false))
        assert.ok(localStamp(atIso).startsWith(`${localMonthRange(atIso).key}-`))
      },
    ),
    { numRuns: 1_000 },
  )
})
