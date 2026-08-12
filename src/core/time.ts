/**
 * 日付境界。**持ち主の1日**で数える。
 *
 * 記録そのものは UTC で持つのが正しいが、**上限が切り替わる瞬間を UTC にすると
 * 日本時間の朝9時に日次枠がリセットされる**。「今日はあと何回使えるか」を人が判断する量なので、
 * 境界は人の1日に合わせる。
 *
 * 保存形式は変えない(`at` は ISO UTC のまま)。範囲を JS 側で instant に直して
 * `at >= ? AND at < ?` で引く。文字列 substr より DST にも強く、索引も効く。
 */

/** 集計に使うタイムゾーン。既定はこのホストの設定。 */
export const TZ = process.env.OPEN_ZERO_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

interface LocalParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

function localParts(ms: number): LocalParts {
  const p = partsFmt.formatToParts(new Date(ms))
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

/** ローカルの (y, m, d) 00:00 が指す instant。DST の切り替え日でもずれないよう2回で収束させる。 */
function startOfLocalDate(year: number, month: number, day: number): number {
  const wall = Date.UTC(year, month - 1, day)
  let t = wall - offsetMs(wall)
  t = wall - offsetMs(t)
  return t
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

/**
 * 記録に押す「いま」。**保存は常に UTC** で、持ち主の時計に直すのは見せるときだけ(`localStamp`)。
 * 前は同じ1行が10ファイルに写してあった。書式が1か所だけずれると、
 * `at >= ? AND at < ?` の文字列比較が静かに外れる。
 */
export const nowIso = (): string => iso(Date.now())

/** 持ち主の時計での時刻(0〜23)。1日1回のものを「いつ出すか」で使う。 */
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
export function dayRange(atIso: string): Range {
  const ms = Date.parse(atIso)
  const p = localParts(ms)
  const start = startOfLocalDate(p.year, p.month, p.day)
  // 翌日の暦日を UTC 算術で出してから、その日の 00:00 を取り直す(日数の繰り上がりだけに使う)。
  const nextWall = new Date(Date.UTC(p.year, p.month - 1, p.day) + 86_400_000)
  const end = startOfLocalDate(nextWall.getUTCFullYear(), nextWall.getUTCMonth() + 1, nextWall.getUTCDate())
  return { key: `${p.year}-${pad(p.month)}-${pad(p.day)}`, startIso: iso(start), endIso: iso(end) }
}

/**
 * 記録の時刻を**持ち主の時計で**見せる。保存は UTC のまま、見せ方だけ変える。
 *
 * **これが無いと、夜中の記録が前日として読まれる。** 台帳は UTC で持つので、日本時間の 0〜9時に
 * 起きたことは前日の日付で入る。モデルには別口で今日の日付が渡るため、
 * 帯を付けずに時刻だけ見せると数十分前の出来事が昨日の午後になる。
 *
 * @param withTime false なら 'YYYY-MM-DD' まで。
 */
export function localStamp(atIso: string, withTime = true): string {
  const ms = Date.parse(atIso)
  if (Number.isNaN(ms)) return atIso // 解釈できない値は触らずに返す(台帳の古い行を壊さない)
  const p = localParts(ms)
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`
  return withTime ? `${date} ${pad(p.hour)}:${pad(p.minute)}` : date
}

/** この instant を含むローカルの1か月。 */
export function monthRange(atIso: string): Range {
  const ms = Date.parse(atIso)
  const p = localParts(ms)
  const start = startOfLocalDate(p.year, p.month, 1)
  const nextYear = p.month === 12 ? p.year + 1 : p.year
  const nextMonth = p.month === 12 ? 1 : p.month + 1
  const end = startOfLocalDate(nextYear, nextMonth, 1)
  return { key: `${p.year}-${pad(p.month)}`, startIso: iso(start), endIso: iso(end) }
}
