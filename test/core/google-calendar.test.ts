/**
 * Calendar の読みと挿入。ネットワークは withFetch で止め、送信契約(クエリ・本文の形)と
 * 応答の写像だけを固定する。終日/時刻・end 省略の分岐は純関数(buildEventBody)で踏む。
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import {
  buildEventBody,
  insertCalendarEvent,
  listCalendarEvents,
  renderCalendarEvents,
} from "../../src/core/google-calendar.ts"
import { withFetch } from "../helpers.ts"

const NOW = Date.parse("2026-08-18T00:00:00Z")
const roots: string[] = []

const authed = (): void => {
  const dir = mkdtempSync(join(tmpdir(), "google-cal-test-"))
  roots.push(dir)
  const path = join(dir, "google-auth.json")
  // 期限は実時計基準で先に置く。loadGoogleAccess は Date.now() で判定する — 固定時刻だと日付を跨いだ瞬間に refresh へ落ちる。
  writeFileSync(path, JSON.stringify({ access: "a-live", refresh: "r", expires: Date.now() + 3_600_000 }))
  process.env.FAMULUS_GOOGLE_AUTH = path
  process.env.FAMULUS_GOOGLE_CLIENT_ID = "cid-1"
  process.env.FAMULUS_GOOGLE_CLIENT_SECRET = "cs-1"
  process.env.FAMULUS_TZ = "Asia/Tokyo"
  configureApp()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.FAMULUS_GOOGLE_AUTH
  delete process.env.FAMULUS_GOOGLE_CLIENT_ID
  delete process.env.FAMULUS_GOOGLE_CLIENT_SECRET
  delete process.env.FAMULUS_TZ
  configureApp()
})

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

test("list は期間・展開・並びをクエリで固定し、cancelled を落として写す", async () => {
  authed()
  let url = ""
  let auth: string | null = null
  const events = await withFetch(
    async (input: unknown, init?: RequestInit) => {
      url = String(input)
      auth = new Headers(init?.headers).get("authorization")
      return ok({
        items: [
          {
            id: "e1",
            summary: "病院",
            location: "駅前",
            start: { dateTime: "2026-08-24T10:00:00+09:00" },
            end: { dateTime: "2026-08-24T11:00:00+09:00" },
          },
          {
            id: "e2",
            summary: "消えた",
            status: "cancelled",
            start: { date: "2026-08-25" },
            end: { date: "2026-08-26" },
          },
          { id: "e3", summary: "終日", start: { date: "2026-08-25" }, end: { date: "2026-08-26" } },
        ],
      })
    },
    () => listCalendarEvents(7, NOW),
  )
  const u = new URL(url)
  assert.match(u.pathname, /calendars\/primary\/events$/)
  assert.equal(u.searchParams.get("singleEvents"), "true")
  assert.equal(u.searchParams.get("orderBy"), "startTime")
  assert.equal(u.searchParams.get("timeMin"), new Date(NOW).toISOString())
  assert.equal(u.searchParams.get("timeMax"), new Date(NOW + 7 * 86_400_000).toISOString())
  assert.equal(auth, "Bearer a-live")
  assert.deepEqual(
    events.map((e) => e.id),
    ["e1", "e3"],
  )
  assert.equal(events[0]?.allDay, false)
  assert.equal(events[1]?.allDay, true)
})

test("描画は終日と時刻ありを言い分け、0件は「予定なし」", () => {
  assert.equal(renderCalendarEvents([]), "予定なし")
  const text = renderCalendarEvents([
    {
      id: "e1",
      title: "病院",
      start: "2026-08-24T10:00:00+09:00",
      end: "2026-08-24T11:00:00+09:00",
      allDay: false,
      location: "駅前",
    },
    { id: "e3", title: "終日の用", start: "2026-08-25", end: "2026-08-26", allDay: true },
    {
      id: "e4",
      title: "(無題)",
      start: "2026-08-26T09:00:00+09:00",
      end: "2026-08-26T09:30:00+09:00",
      allDay: false,
    },
  ])
  assert.match(text, /- \[.*10:00〜.*11:00\] 病院 @駅前/)
  assert.match(text, /- \[2026-08-25 終日\] 終日の用/)
  // 場所なしの時刻あり(@ が付かない側)
  assert.match(text, /09:30\] \(無題\)$/m)
})

test("list は nextPageToken が無くなるまで全ページを読む", async () => {
  authed()
  const urls: string[] = []
  const events = await withFetch(
    async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      const token = new URL(url).searchParams.get("pageToken")
      return token === null
        ? ok({
            items: [
              {
                id: "e1",
                summary: "1ページ目",
                start: { date: "2026-08-19" },
                end: { date: "2026-08-20" },
              },
            ],
            nextPageToken: "page-2",
          })
        : ok({
            items: [
              {
                id: "e2",
                summary: "2ページ目",
                start: { date: "2026-08-20" },
                end: { date: "2026-08-21" },
              },
            ],
          })
    },
    () => listCalendarEvents(7, NOW),
  )
  assert.deepEqual(
    events.map((event) => event.id),
    ["e1", "e2"],
  )
  assert.equal(urls.length, 2)
  assert.equal(new URL(urls[1] as string).searchParams.get("pageToken"), "page-2")
})

test("buildEventBody: 終日は排他 end、帯なし日時の end 省略は同じ壁時計の1時間後", () => {
  assert.deepEqual(buildEventBody({ title: "終日", start: "2026-08-24" }, "Asia/Tokyo"), {
    summary: "終日",
    start: { date: "2026-08-24" },
    end: { date: "2026-08-25" },
  })
  assert.deepEqual(buildEventBody({ title: "連日", start: "2026-08-24", end: "2026-08-25" }, "Asia/Tokyo"), {
    summary: "連日",
    start: { date: "2026-08-24" },
    end: { date: "2026-08-26" },
  })
  const timed = buildEventBody({ title: "病院", start: "2026-08-24T10:00:00+09:00" }, "Asia/Tokyo")
  assert.deepEqual(timed.start, { dateTime: "2026-08-24T10:00:00+09:00", timeZone: "Asia/Tokyo" })
  assert.deepEqual(timed.end, { dateTime: "2026-08-24T02:00:00.000Z", timeZone: "Asia/Tokyo" })
  const local = buildEventBody({ title: "病院", start: "2026-08-24T10:00:00" }, "Asia/Tokyo")
  assert.deepEqual(local.start, { dateTime: "2026-08-24T10:00:00", timeZone: "Asia/Tokyo" })
  assert.deepEqual(local.end, { dateTime: "2026-08-24T11:00:00", timeZone: "Asia/Tokyo" })
  assert.throws(() => buildEventBody({ title: " ", start: "2026-08-24" }, "Asia/Tokyo"), /題が空/)
  assert.throws(() => buildEventBody({ title: "病院", start: "2026-02-31" }, "Asia/Tokyo"), /実在しない/)
  assert.throws(
    () => buildEventBody({ title: "病院", start: "2026-08-24Z" }, "Asia/Tokyo"),
    /ISO 日時ではない/,
  )
  assert.throws(
    () => buildEventBody({ title: "病院", start: "2026-08-24", end: "2026-08-23" }, "Asia/Tokyo"),
    /開始日以降/,
  )
  assert.throws(
    () =>
      buildEventBody(
        { title: "病院", start: "2026-08-24T10:00:00+09:00", end: "2026-08-24T09:00:00+09:00" },
        "Asia/Tokyo",
      ),
    /開始日時より後/,
  )
  assert.throws(
    () =>
      buildEventBody(
        { title: "病院", start: "2026-08-24T08:00:00Z", end: "2026-08-24T16:00:00" },
        "Asia/Tokyo",
      ),
    /タイムゾーン表記を揃える/,
  )
})

test("insert は本文を POST し、応答の予定を link 付きで返す", async () => {
  authed()
  let sent: Record<string, unknown> | undefined
  const ev = await withFetch(
    async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return ok({
        id: "new-1",
        summary: "病院",
        htmlLink: "https://calendar.google.com/event?eid=x",
        start: { dateTime: "2026-08-24T10:00:00+09:00" },
        end: { dateTime: "2026-08-24T11:00:00+09:00" },
      })
    },
    () =>
      insertCalendarEvent({
        title: "病院",
        start: "2026-08-24T10:00:00+09:00",
        end: "2026-08-24T11:00:00+09:00",
      }),
  )
  assert.equal(sent?.summary, "病院")
  assert.equal(ev.id, "new-1")
  assert.equal(ev.link, "https://calendar.google.com/event?eid=x")
})

test("API の失敗は status と本文の先頭を持って投げる", async () => {
  authed()
  await withFetch(
    async () => new Response("insufficient scope", { status: 403 }),
    async () => {
      await assert.rejects(() => listCalendarEvents(7, NOW), /403.*insufficient scope/)
    },
  )
})
