/**
 * 日付境界の検査。ユーザーの1日で切れているかだけを見る。
 * TZ はモジュール読み込み時に確定するので、import より先に環境変数を差す。
 */

import { test } from "bun:test"
import assert from "node:assert/strict"

process.env.OPEN_ZERO_TZ = "Asia/Tokyo"
const { TZ, dayRange, localStamp, monthRange } = await import("../src/core/time.ts")

test("TZ は OPEN_ZERO_TZ で差せる", () => {
  assert.equal(TZ, "Asia/Tokyo")
})

test("UTC の日ではなくローカルの日で切る", () => {
  // 2026-08-07T16:55Z は JST では 08-08 の 01:55。UTC 切りだと 08-07 になる。
  const r = dayRange("2026-08-07T16:55:00Z")
  assert.equal(r.key, "2026-08-08")
  assert.equal(r.startIso, "2026-08-07T15:00:00Z")
  assert.equal(r.endIso, "2026-08-08T15:00:00Z")
})

test("日跨ぎの直前・直後が別の日に落ちる", () => {
  assert.equal(dayRange("2026-08-07T14:59:59Z").key, "2026-08-07")
  assert.equal(dayRange("2026-08-07T15:00:00Z").key, "2026-08-08")
})

test("月末の繰り上がり", () => {
  const r = monthRange("2026-12-31T16:00:00Z")
  assert.equal(r.key, "2027-01")
  assert.equal(r.startIso, "2026-12-31T15:00:00Z")
  assert.equal(r.endIso, "2027-01-31T15:00:00Z")
})

test("記録の時刻はユーザーの時計で見せる(夜中の記録を前日にしない)", () => {
  // 実際に起きた形。2026-08-11 00:52 JST に書いた行は DB では 2026-08-10T15:52Z。
  // これを帯なしで渡すと、モデルには別経路で「今日は 2026年8月11日」と入っているので、
  // 51分前の出来事を昨日の午後として読む。
  assert.equal(localStamp("2026-08-10T15:52:00Z"), "2026-08-11 00:52")
  assert.equal(localStamp("2026-08-10T15:52:00Z", false), "2026-08-11")
  assert.equal(localStamp("2026-08-11T03:00:00Z"), "2026-08-11 12:00")
  // 読めない値は握り潰さずそのまま返す。DB の古い行を落とさないため。
  assert.equal(localStamp("いつか"), "いつか")
})

test("範囲は半開区間で、隣の日と重ならない", () => {
  const a = dayRange("2026-08-08T02:00:00Z")
  const b = dayRange("2026-08-09T02:00:00Z")
  assert.equal(a.endIso, b.startIso)
  assert.notEqual(a.key, b.key)
})
