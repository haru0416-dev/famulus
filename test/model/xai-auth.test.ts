/** 資格情報は1組しかないので、refresh の競合で再ログイン要求になり自走が止まることを防ぐ。 */

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { loadXaiAccess, readXaiAuth, type XaiAuth } from "../../src/model/xai-auth.ts"
import { withFetch } from "../helpers.ts"

const NOW = 10_000_000
const roots: string[] = []

const authFile = (auth: XaiAuth): string => {
  const dir = mkdtempSync(join(tmpdir(), "xai-auth-test-"))
  roots.push(dir)
  const path = join(dir, "xai-auth.json")
  writeFileSync(path, JSON.stringify(auth))
  process.env.FAMULUS_XAI_AUTH = path
  configureApp()
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.FAMULUS_XAI_AUTH
  configureApp()
})

const EXPIRED: XaiAuth = { access: "a-old", refresh: "r-old", expires: NOW - 1 }

const sentRefresh = (init?: RequestInit): string =>
  new URLSearchParams(String(init?.body)).get("refresh_token") ?? ""

const granted = (access: string, refresh: string): Response =>
  new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const denied = (): Response =>
  new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  })

test("期限まで余裕があれば fetch せずファイルの access を返す", async () => {
  authFile({ access: "a-live", refresh: "r", expires: NOW + 3_600_000 })
  let calls = 0
  const access = await withFetch(
    async () => {
      calls += 1
      return denied()
    },
    () => loadXaiAccess(NOW),
  )
  assert.equal(access, "a-live")
  assert.equal(calls, 0)
})

test("期限が近ければ refresh し、回転した refresh をファイルに書き戻す(0600)", async () => {
  const path = authFile(EXPIRED)
  const calls: string[] = []
  const access = await withFetch(
    async (_: unknown, init?: RequestInit) => {
      calls.push(sentRefresh(init))
      return granted("a-new", "r-new")
    },
    () => loadXaiAccess(NOW),
  )
  assert.equal(access, "a-new")
  assert.deepEqual(calls, ["r-old"])
  const saved = JSON.parse(readFileSync(path, "utf8")) as XaiAuth
  assert.equal(saved.refresh, "r-new")
  assert.equal(saved.expires, NOW + 3600 * 1000)
  assert.equal(statSync(path).mode & 0o777, 0o600)
})

test("refresh 拒否でも別プロセスが回転済みならその access で続行する", async () => {
  const path = authFile(EXPIRED)
  let calls = 0
  const access = await withFetch(
    async () => {
      calls += 1
      // 他プロセスが先に rotation を終えた状態を作ってから拒否を返す
      writeFileSync(path, JSON.stringify({ access: "a-other", refresh: "r-other", expires: NOW + 3_600_000 }))
      return denied()
    },
    () => loadXaiAccess(NOW),
  )
  assert.equal(access, "a-other")
  assert.equal(calls, 1)
})

test("回転済みでも期限が近いままなら、新しい refresh でやり直して保存する", async () => {
  const path = authFile(EXPIRED)
  const calls: string[] = []
  const access = await withFetch(
    async (_: unknown, init?: RequestInit) => {
      const refresh = sentRefresh(init)
      calls.push(refresh)
      if (refresh === "r-old") {
        writeFileSync(path, JSON.stringify({ access: "a-other", refresh: "r-other", expires: NOW - 1 }))
        return denied()
      }
      return granted("a-second", "r-second")
    },
    () => loadXaiAccess(NOW),
  )
  assert.equal(access, "a-second")
  assert.deepEqual(calls, ["r-old", "r-other"])
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as XaiAuth).refresh, "r-second")
})

test("ファイルが同値のままの拒否は本当の失効として投げる", async () => {
  authFile(EXPIRED)
  await withFetch(
    async () => denied(),
    async () => {
      await assert.rejects(loadXaiAccess(NOW), /refresh が拒否された: invalid_grant/)
    },
  )
})

test("auth ファイルが無ければ grok-login への導線付きで落とす", () => {
  const dir = mkdtempSync(join(tmpdir(), "xai-auth-test-"))
  roots.push(dir)
  assert.throws(() => readXaiAuth(join(dir, "nai.json")), /grok-login/)
})

test("token endpoint が error 欄の無い非 2xx を返したら status で落とす", async () => {
  authFile(EXPIRED)
  await withFetch(
    // JSON でない本文なので error 欄が読めず、status を理由にする。
    async () => new Response("busy", { status: 503 }),
    async () => {
      await assert.rejects(loadXaiAccess(NOW), /auth\.x\.ai\/token が 503 を返した/)
    },
  )
})

test("2xx でも欄の揃わないトークン応答は落とす(黙って半端に保存しない)", async () => {
  const path = authFile(EXPIRED)
  await withFetch(
    async () =>
      new Response(JSON.stringify({ access_token: "a-new", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await assert.rejects(loadXaiAccess(NOW), /access\/refresh\/expires_in が揃っていない/)
    },
  )
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as XaiAuth).refresh, "r-old")
})
