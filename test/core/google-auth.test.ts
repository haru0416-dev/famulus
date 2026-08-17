/**
 * Google OAuth(installed app + PKCE)の検査。ネットワークは withFetch で全部止める。
 * 固定するのは3点: 交換の送信契約(PKCE verifier / secret / redirect)、state の照合、
 * refresh が rotation しない前提(返らなければ今の refresh を使い続ける)。
 */

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import {
  type GoogleAuth,
  googleConfigured,
  googleLoginFinish,
  googleLoginStart,
  loadGoogleAccess,
  parsePasted,
  readGoogleAuth,
} from "../../src/core/google-auth.ts"
import { withFetch } from "../helpers.ts"

const NOW = 10_000_000
const roots: string[] = []

/** client を設定し、auth の既定パスをテンポラリへ向ける。 */
const configured = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "google-auth-test-"))
  roots.push(dir)
  const path = join(dir, "google-auth.json")
  process.env.FAMULUS_GOOGLE_AUTH = path
  process.env.FAMULUS_GOOGLE_CLIENT_ID = "cid-1"
  process.env.FAMULUS_GOOGLE_CLIENT_SECRET = "cs-1"
  configureApp()
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.FAMULUS_GOOGLE_AUTH
  delete process.env.FAMULUS_GOOGLE_CLIENT_ID
  delete process.env.FAMULUS_GOOGLE_CLIENT_SECRET
  configureApp()
})

const token = (body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

test("未設定なら configured が false で、start は設定を要求する", () => {
  configureApp()
  assert.equal(googleConfigured(), false)
})

test("start は PKCE と state 付きの URL を返し、pending を 600 で置く", () => {
  const path = configured()
  assert.equal(googleConfigured(), true)
  const url = new URL(googleLoginStart())
  assert.equal(url.origin, "https://accounts.google.com")
  assert.equal(url.searchParams.get("client_id"), "cid-1")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1/")
  assert.match(String(url.searchParams.get("scope")), /calendar\.events/)
  assert.equal(url.searchParams.get("access_type"), "offline")
  assert.ok(url.searchParams.get("state"))
  const pending = `${path}.pending`
  assert.equal(statSync(pending).mode & 0o777, 0o600)
  assert.ok(JSON.parse(readFileSync(pending, "utf8")).verifier)
})

test("finish は貼られた URL から code を取り、verifier と secret 付きで交換して 600 で保存する", async () => {
  const path = configured()
  const url = new URL(googleLoginStart())
  const state = url.searchParams.get("state")
  let sent: URLSearchParams | undefined
  await withFetch(
    async (_input: unknown, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body))
      return token({ access_token: "a-1", refresh_token: "r-1", expires_in: 3600 })
    },
    async () => {
      await googleLoginFinish(`http://localhost:1/?state=${state}&code=c-123&scope=x`, NOW)
    },
  )
  assert.equal(sent?.get("grant_type"), "authorization_code")
  assert.equal(sent?.get("code"), "c-123")
  assert.equal(sent?.get("client_secret"), "cs-1")
  assert.ok(sent?.get("code_verifier"))
  const saved = readGoogleAuth(path)
  assert.deepEqual(saved, { access: "a-1", refresh: "r-1", expires: NOW + 3_600_000 })
  assert.equal(statSync(path).mode & 0o777, 0o600)
})

test("state が一致しない貼り付けは拒否する", async () => {
  configured()
  googleLoginStart()
  await assert.rejects(
    () => googleLoginFinish("http://localhost:1/?state=someone-else&code=c-9"),
    /state が一致しない/,
  )
})

test("貼り付けは URL 全体・クエリ・素の code のどれでも読める", () => {
  assert.deepEqual(parsePasted("  c-raw  "), { code: "c-raw" })
  assert.deepEqual(parsePasted("state=s1&code=c1"), { code: "c1", state: "s1" })
  assert.deepEqual(parsePasted("http://localhost:1/?code=c2&state=s2"), { code: "c2", state: "s2" })
})

test("期限内は fetch せず、期限切れは refresh して保存する — refresh は rotation しない", async () => {
  const path = configured()
  const live: GoogleAuth = { access: "a-live", refresh: "r-keep", expires: NOW + 3_600_000 }
  writeFileSync(path, JSON.stringify(live))
  await withFetch(
    async () => {
      throw new Error("期限内に fetch した")
    },
    async () => {
      assert.equal(await loadGoogleAccess(NOW, path), "a-live")
    },
  )

  writeFileSync(path, JSON.stringify({ access: "a-old", refresh: "r-keep", expires: NOW - 1 }))
  let sent: URLSearchParams | undefined
  await withFetch(
    async (_input: unknown, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body))
      // Google は refresh_token を返し直さないことが多い
      return token({ access_token: "a-new", expires_in: 3600 })
    },
    async () => {
      assert.equal(await loadGoogleAccess(NOW, path), "a-new")
    },
  )
  assert.equal(sent?.get("grant_type"), "refresh_token")
  assert.equal(sent?.get("refresh_token"), "r-keep")
  assert.deepEqual(readGoogleAuth(path), { access: "a-new", refresh: "r-keep", expires: NOW + 3_600_000 })
})
