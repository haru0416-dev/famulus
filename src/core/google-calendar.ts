/**
 * Google Calendar(primary)の読みと1件挿入。REST 直(googleapis SDK は使わない —
 * 認証以外に要るものが無く、市場実勢も REST 直: docs/integration-survey-2026-08-18.md)。
 *
 * pull のみ。watch(push)は持たない — Pub/Sub + 公開エンドポイントの4段構成は
 * この規模(利用者1人)では割に合わないことを市場調査で確認済み。
 */
import { appConfig } from "./config.ts"
import { loadGoogleAccess } from "./google-auth.ts"
import { localStamp } from "./time.ts"

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events"

export interface CalendarEvent {
  readonly id: string
  readonly title: string
  /** ISO 日時、または終日なら YYYY-MM-DD。 */
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

/** これから days 日ぶんの予定。繰り返しは1回ごとに展開し、開始順で返す。 */
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

/** 終日は日付のまま、時刻付きはユーザーの時計で見せる。 */
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
  /** ISO 日時(時刻あり)か YYYY-MM-DD(終日)。 */
  readonly start: string
  readonly end?: string
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const HAS_TIME_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/i

/** Google の終日 end は排他(翌日の日付)。 */
const nextDay = (date: string): string => {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

const oneHourAfter = (start: string): string => {
  const zoned = HAS_TIME_ZONE.test(start)
  const parsed = Date.parse(zoned ? start : `${start}Z`)
  if (!Number.isFinite(parsed)) throw new Error(`開始日時が ISO 日時ではない: ${start}`)
  const end = new Date(parsed + 3_600_000).toISOString()
  return zoned ? end : end.replace(/\.000Z$/, "").replace(/Z$/, "")
}

/** API へ送る形。挙動が分かれる(終日/時刻・end 省略)ので純関数に切って検査する。 */
export function buildEventBody(input: NewEvent, timeZone: string): Record<string, unknown> {
  if (DATE_ONLY.test(input.start)) {
    const endDate = input.end && DATE_ONLY.test(input.end) ? nextDay(input.end) : nextDay(input.start)
    return { summary: input.title, start: { date: input.start }, end: { date: endDate } }
  }
  // 帯なしの日時は famulus 側のタイムゾーンとして送る。帯付きなら Google がそちらを読む。
  const endTime = input.end ?? oneHourAfter(input.start)
  return {
    summary: input.title,
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
