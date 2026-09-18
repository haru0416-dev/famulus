/**
 * `at` は ISO UTC で保存し、日の境界は `FAMULUS_TZ` で決める。範囲を instant に直して `at >= ? AND at < ?` で引くと
 * substr より DST に強く索引も使われる。
 */

import { appConfig } from "./config.ts"

export const timeZone = (): string => appConfig().timeZone

let formatter: { readonly timeZone: string; readonly value: Intl.DateTimeFormat } | undefined
const partsFormatter = (): Intl.DateTimeFormat => {
  const zone = timeZone()
  if (formatter?.timeZone === zone) return formatter.value
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  formatter = { timeZone: zone, value }
  return value
}

interface LocalParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

function localParts(ms: number): LocalParts {
  const p = partsFormatter().formatToParts(new Date(ms))
  const n = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0)
  return {
    year: n("year"),
    month: n("month"),
    day: n("day"),
    // 24 時制で 24:00 を返す実装があるため丸める。
    hour: n("hour") % 24,
    minute: n("minute"),
    second: n("second"),
  }
}

function offsetMs(ms: number): number {
  const p = localParts(ms)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - (ms - (ms % 1000))
}

/** 00:00 の前後で offset が異なる場合に備えて2回補正する。 */
function startOfLocalDate(year: number, month: number, day: number): number {
  const wall = Date.UTC(year, month - 1, day)
  let t = wall - offsetMs(wall)
  t = wall - offsetMs(t)
  return t
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

/** 書式が1か所でもずれると `at >= ? AND at < ?` の文字列比較が黙って外れるので、ここだけで作る。 */
export const nowIso = (): string => iso(Date.now())

export const localHour = (atIso: string): number => localParts(Date.parse(atIso)).hour

export interface Range {
  readonly key: string
  /** 半開区間 [startIso, endIso)。 */
  readonly startIso: string
  readonly endIso: string
}

const pad = (n: number) => String(n).padStart(2, "0")

export function localDayRange(atIso: string): Range {
  const ms = Date.parse(atIso)
  const p = localParts(ms)
  const start = startOfLocalDate(p.year, p.month, p.day)
  // UTC 算術は翌日の暦日を出すのにだけ使い、00:00 はローカルで取り直す。
  const nextWall = new Date(Date.UTC(p.year, p.month - 1, p.day) + 86_400_000)
  const end = startOfLocalDate(nextWall.getUTCFullYear(), nextWall.getUTCMonth() + 1, nextWall.getUTCDate())
  return { key: `${p.year}-${pad(p.month)}-${pad(p.day)}`, startIso: iso(start), endIso: iso(end) }
}

/** モデルには今日の日付がローカルで渡るので、UTC のまま見せると深夜の出来事が前日に読まれる。 */
export function localStamp(atIso: string, withTime = true): string {
  const ms = Date.parse(atIso)
  if (Number.isNaN(ms)) return atIso
  const p = localParts(ms)
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`
  return withTime ? `${date} ${pad(p.hour)}:${pad(p.minute)}` : date
}

export function localMonthRange(atIso: string): Range {
  const ms = Date.parse(atIso)
  const p = localParts(ms)
  const start = startOfLocalDate(p.year, p.month, 1)
  const nextYear = p.month === 12 ? p.year + 1 : p.year
  const nextMonth = p.month === 12 ? 1 : p.month + 1
  const end = startOfLocalDate(nextYear, nextMonth, 1)
  return { key: `${p.year}-${pad(p.month)}`, startIso: iso(start), endIso: iso(end) }
}
