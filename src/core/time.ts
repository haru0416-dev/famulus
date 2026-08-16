/**
 * 日付境界。ユーザーの1日で数える。
 *
 * 記録そのものは UTC で持つが、上限の境界まで UTC にするとユーザーの暦日とずれる。
 * 例えば Asia/Tokyo では日次枠が朝9時に切り替わるため、境界は `OPEN_ZERO_TZ` の1日に合わせる。
 *
 * 保存形式は変えない(`at` は ISO UTC のまま)。範囲を JS 側で instant に直して
 * `at >= ?AND at < ?` で引く。文字列 substr より DST にも強く、索引も使われる。
 */

import { appConfig } from "./config.ts"

/** 集計に使う、起動時に検証済みのタイムゾーン。 */
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

/** この instant におけるタイムゾーンの UTC からのずれ(ms)。 */
function offsetMs(ms: number): number {
  const p = localParts(ms)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - (ms - (ms % 1000))
}

/** ローカルの (y, m, d) 00:00 が指す instant。前後で offset が異なる場合に備えて2回補正する。 */
function startOfLocalDate(year: number, month: number, day: number): number {
  const wall = Date.UTC(year, month - 1, day)
  let t = wall - offsetMs(wall)
  t = wall - offsetMs(t)
  return t
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

/**
 * 記録に押す「いま」。保存は常に UTC で、ユーザーの時計に直すのは見せるときだけ(`localStamp`)。
 * 前は同じ1行が10ファイルに写してあった。書式が1か所だけずれると、
 * `at >= ?AND at < ?` の文字列比較が静かに外れる。
 */
export const nowIso = (): string => iso(Date.now())

/** ユーザーの時計での時刻(0〜23)。1日1回のものを「いつ出すか」で使う。 */
export const localHour = (atIso: string): number => localParts(Date.parse(atIso)).hour

export interface Range {
  /** 'YYYY-MM-DD' または 'YYYY-MM'。人に見せる見出し。 */
  readonly key: string
  /** 半開区間 [startIso, endIso)。どちらも ISO UTC。 */
  readonly startIso: string
  readonly endIso: string
}

const pad = (n: number) => String(n).padStart(2, "0")

/** この instant を含むローカルの1日。 */
export function localDayRange(atIso: string): Range {
  const ms = Date.parse(atIso)
  const p = localParts(ms)
  const start = startOfLocalDate(p.year, p.month, p.day)
  // 翌日の暦日を UTC 算術で出してから、その日の 00:00 を取り直す(日数の繰り上がりだけに使う)。
  const nextWall = new Date(Date.UTC(p.year, p.month - 1, p.day) + 86_400_000)
  const end = startOfLocalDate(nextWall.getUTCFullYear(), nextWall.getUTCMonth() + 1, nextWall.getUTCDate())
  return { key: `${p.year}-${pad(p.month)}-${pad(p.day)}`, startIso: iso(start), endIso: iso(end) }
}

/**
 * 記録の時刻をユーザーの時計で見せる。保存は UTC のまま、見せ方だけ変える。
 *
 * これが無いと、夜中の記録が前日として読まれる。DB は UTC で持つので、日本時間の0時から8時台に
 * 起きたことは UTC 表記では前日になる。モデルには別経路で今日の日付が渡るため、
 * 帯を付けずに時刻だけ見せると数十分前の出来事が昨日の午後になる。
 *
 * @param withTime false なら 'YYYY-MM-DD' まで。
 */
export function localStamp(atIso: string, withTime = true): string {
  const ms = Date.parse(atIso)
  if (Number.isNaN(ms)) return atIso // 解釈できない値は触らずに返す(DB の古い行を壊さない)
  const p = localParts(ms)
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`
  return withTime ? `${date} ${pad(p.hour)}:${pad(p.minute)}` : date
}

/** この instant を含むローカルの1か月。 */
export function localMonthRange(atIso: string): Range {
  const ms = Date.parse(atIso)
  const p = localParts(ms)
  const start = startOfLocalDate(p.year, p.month, 1)
  const nextYear = p.month === 12 ? p.year + 1 : p.year
  const nextMonth = p.month === 12 ? 1 : p.month + 1
  const end = startOfLocalDate(nextYear, nextMonth, 1)
  return { key: `${p.year}-${pad(p.month)}`, startIso: iso(start), endIso: iso(end) }
}
