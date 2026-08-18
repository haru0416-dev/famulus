/**
 * Gmail 読み取りの検査。ネットワークは withFetch で止める。
 * 固定するのは3点: 検索の送信契約(q / maxResults / metadata)、multipart の本文抽出
 * (text/plain 優先・HTML はタグ落とし)、本文の切り詰め表示。
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { extractBody, readMail, renderMailHeads, searchMail } from "../../src/core/gmail.ts"
import { withFetch } from "../helpers.ts"

const NOW = Date.parse("2026-08-18T00:00:00Z")
const roots: string[] = []

const authed = (): void => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-test-"))
  roots.push(dir)
  const path = join(dir, "google-auth.json")
  // 期限は実時計基準で先に置く。loadGoogleAccess は Date.now() で判定する — 固定時刻だと日付を跨いだ瞬間に refresh へ落ちる。
  writeFileSync(path, JSON.stringify({ access: "a-live", refresh: "r", expires: Date.now() + 3_600_000 }))
  process.env.FAMULUS_GOOGLE_AUTH = path
  process.env.FAMULUS_GOOGLE_CLIENT_ID = "cid-1"
  process.env.FAMULUS_GOOGLE_CLIENT_SECRET = "cs-1"
  configureApp()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.FAMULUS_GOOGLE_AUTH
  delete process.env.FAMULUS_GOOGLE_CLIENT_ID
  delete process.env.FAMULUS_GOOGLE_CLIENT_SECRET
  configureApp()
})

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url")

test("search は q と maxResults を送り、1通ずつ metadata で頭書きを取る", async () => {
  authed()
  const urls: string[] = []
  const heads = await withFetch(
    async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.includes("/messages?")) return ok({ messages: [{ id: "m1" }, { id: "m2" }] })
      return ok({
        id: url.includes("m1") ? "m1" : "m2",
        snippet: "抜粋",
        internalDate: String(NOW),
        payload: {
          headers: [
            { name: "From", value: "someone@example.com" },
            { name: "Subject", value: "件名A" },
          ],
        },
      })
    },
    () => searchMail("is:unread", 5),
  )
  const first = new URL(urls[0] ?? "")
  assert.equal(first.searchParams.get("q"), "is:unread")
  assert.equal(first.searchParams.get("maxResults"), "5")
  assert.match(urls[1] ?? "", /format=metadata/)
  assert.equal(heads.length, 2)
  assert.equal(heads[0]?.subject, "件名A")
  const rendered = renderMailHeads(heads)
  assert.match(rendered, /件名A/)
  assert.match(rendered, /id m1/)
  assert.equal(renderMailHeads([]), "該当なし")
})

test("本文は text/plain 優先で multipart を辿り、HTML しか無ければタグを落とす", () => {
  assert.equal(
    extractBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>HTML側</p>") } },
        { mimeType: "text/plain", body: { data: b64("プレーン側") } },
      ],
    }),
    "プレーン側",
  )
  assert.equal(
    extractBody({
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/html",
          body: { data: b64("<style>p{color:red}</style><p>本文だけ&nbsp;残る</p>") },
        },
      ],
    }),
    "本文だけ 残る",
  )
  assert.equal(extractBody(undefined), "")
})

test("read は長い本文を切り詰め、切ったことを言う", async () => {
  authed()
  const long = "あ".repeat(5000)
  const { head, body } = await withFetch(
    async () =>
      ok({
        id: "m9",
        snippet: "s",
        payload: {
          headers: [{ name: "Subject", value: "長文" }],
          mimeType: "text/plain",
          body: { data: b64(long) },
        },
      }),
    () => readMail("m9"),
  )
  assert.equal(head.subject, "長文")
  assert.match(body, /^あ{4000}…/)
  assert.match(body, /5000字あるうちの先頭/)
})

test("欠け欄に耐える — id 無しは飛ばし、件名・日時・本文の無い通も形が崩れない", async () => {
  authed()
  const heads = await withFetch(
    async (input: unknown) => {
      const url = String(input)
      if (url.includes("/messages?")) return ok({ messages: [{}, { id: "m3" }] })
      return ok({ id: "m3", payload: { headers: [] } })
    },
    () => searchMail("in:inbox", 10),
  )
  assert.equal(heads.length, 1)
  assert.equal(heads[0]?.subject, "(件名なし)")
  assert.equal(heads[0]?.at, undefined)
  assert.match(renderMailHeads(heads), /日時不明/)

  await withFetch(
    async () => ok({ snippet: "idの無い応答" }),
    async () => {
      await assert.rejects(() => readMail("mx"), /メールが読めない/)
    },
  )
})

test("空リストと本文なしの通", async () => {
  authed()
  const heads = await withFetch(
    async () => ok({}),
    () => searchMail("from:nobody", 3),
  )
  assert.deepEqual(heads, [])
  const { body } = await withFetch(
    async () => ok({ id: "m4", payload: { headers: [{ name: "Subject", value: "空" }] } }),
    () => readMail("m4"),
  )
  assert.equal(body, "")
})
