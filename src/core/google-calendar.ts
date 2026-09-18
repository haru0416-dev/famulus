/** watch(push)は Pub/Sub と公開エンドポイントが要るので持たない。 */
import { appConfig } from "./config.ts"
import { loadGoogleAccess } from "./google-auth.ts"
import { localStamp } from "./time.ts"

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events"

export interface CalendarEvent {
  readonly id: string
  readonly title: string
  /** 終日なら YYYY-MM-DD。 */
  readonly start: string
  readonly end: string
  readonly allDay: boolean
  readonly location?: string
}

interface ApiEvent {
  readonly id?: string
  readonly summary?: string
  readonly location?: string
  readonly start?: { readonly dateTime?: string; readonly date?: string }
  readonly end?: { readonly dateTime?: string; readonly date?: string }
  readonly status?: string
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const access = await loadGoogleAccess()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${access}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Calendar API が ${res.status} を返した: ${body.slice(0, 200)}`)
  }
  return res.json()
}

const toEvent = (e: ApiEvent): CalendarEvent | undefined => {
  const start = e.start?.dateTime ?? e.start?.date
  const end = e.end?.dateTime ?? e.end?.date
  if (!e.id || !start || !end || e.status === "cancelled") return undefined
  return {
    id: e.id,
    title: e.summary ?? "(無題)",
    start,
    end,
    allDay: e.start?.dateTime === undefined,
    ...(e.location ? { location: e.location } : {}),
  }
}

export async function listCalendarEvents(days: number, nowMs: number = Date.now()): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = []
  const seenTokens = new Set<string>()
  let pageToken: string | undefined
  do {
    const query = new URLSearchParams({
      timeMin: new Date(nowMs).toISOString(),
      timeMax: new Date(nowMs + days * 86_400_000).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    })
    const body = (await call(`?${query.toString()}`)) as {
      items?: ApiEvent[]
      nextPageToken?: string
    }
    for (const item of body.items ?? []) {
      const event = toEvent(item)
      if (event) events.push(event)
    }
    pageToken = body.nextPageToken?.trim() || undefined
    if (pageToken && seenTokens.has(pageToken)) throw new Error("Calendar API が同じ page token を返し続けた")
    if (pageToken) seenTokens.add(pageToken)
  } while (pageToken)
  return events
}

export const renderCalendarEvents = (events: readonly CalendarEvent[]): string =>
  events.length === 0
    ? "予定なし"
    : events
        .map((e) =>
          e.allDay
            ? `- [${e.start} 終日] ${e.title}${e.location ? ` @${e.location}` : ""}`
            : `- [${localStamp(e.start)}〜${localStamp(e.end).slice(11)}] ${e.title}${e.location ? ` @${e.location}` : ""}`,
        )
        .join("\n")

export interface NewEvent {
  readonly title: string
  /** 終日なら YYYY-MM-DD。 */
  readonly start: string
  readonly end?: string
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const HAS_TIME_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/i
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/
const ZONED_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i

const validDate = (value: string): boolean => {
  if (!DATE_ONLY.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day))
  return date.toISOString().slice(0, 10) === value
}

const timeMs = (value: string): number => {
  if (!ZONED_DATE_TIME.test(value) && !LOCAL_DATE_TIME.test(value))
    throw new Error(`日時が ISO 日時ではない: ${value}`)
  const parsed = Date.parse(HAS_TIME_ZONE.test(value) ? value : `${value}Z`)
  if (!Number.isFinite(parsed)) throw new Error(`日時が ISO 日時ではない: ${value}`)
  return parsed
}

/** Google の終日 end は排他(翌日の日付)。 */
const nextDay = (date: string): string => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

const oneHourAfter = (start: string): string => {
  const zoned = HAS_TIME_ZONE.test(start)
  const parsed = timeMs(start)
  const end = new Date(parsed + 3_600_000).toISOString()
  return zoned ? end : end.replace(/\.000Z$/, "").replace(/Z$/, "")
}

export function buildEventBody(input: NewEvent, timeZone: string): Record<string, unknown> {
  const title = input.title.trim()
  if (title === "") throw new Error("予定の題が空")
  if (DATE_ONLY.test(input.start)) {
    if (!validDate(input.start)) throw new Error(`開始日が実在しない: ${input.start}`)
    if (input.end !== undefined && !DATE_ONLY.test(input.end)) throw new Error("終日の終了は日付で指定する")
    if (input.end !== undefined && !validDate(input.end)) throw new Error(`終了日が実在しない: ${input.end}`)
    if (input.end !== undefined && input.end < input.start) throw new Error("終了日は開始日以降が必要")
    const endDate = input.end && DATE_ONLY.test(input.end) ? nextDay(input.end) : nextDay(input.start)
    return { summary: title, start: { date: input.start }, end: { date: endDate } }
  }
  if (input.end !== undefined && DATE_ONLY.test(input.end))
    throw new Error("時刻ありの終了は ISO 日時で指定する")
  if (input.end !== undefined && HAS_TIME_ZONE.test(input.start) !== HAS_TIME_ZONE.test(input.end))
    throw new Error("開始と終了はタイムゾーン表記を揃える")
  const startMs = timeMs(input.start)
  // タイムゾーン表記の無い日時は famulus のタイムゾーンとして送る。表記があれば Google はそちらを使う。
  const endTime = input.end ?? oneHourAfter(input.start)
  if (timeMs(endTime) <= startMs) throw new Error("終了日時は開始日時より後が必要")
  return {
    summary: title,
    start: { dateTime: input.start, timeZone },
    end: { dateTime: endTime, timeZone },
  }
}

export async function insertCalendarEvent(input: NewEvent): Promise<CalendarEvent & { link?: string }> {
  const body = (await call("", {
    method: "POST",
    body: JSON.stringify(buildEventBody(input, appConfig().timeZone)),
  })) as ApiEvent & { htmlLink?: string }
  const ev = toEvent(body)
  if (!ev) throw new Error("挿入の応答に予定が入っていない")
  return { ...ev, ...(body.htmlLink ? { link: body.htmlLink } : {}) }
}
