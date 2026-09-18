import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test, vi } from "vitest"
import { xaiDeviceLogin } from "../../src/model/xai-auth.ts"
import { withFetch } from "../helpers.ts"

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const authPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "xai-device-test-"))
  roots.push(dir)
  return join(dir, "xai-auth.json")
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const isDeviceEndpoint = (input: unknown): boolean =>
  (input instanceof Request ? input.url : String(input)).endsWith("/device/code")

test("pending/slow_down を経て承認され、600 で保存して返す", async () => {
  vi.useFakeTimers()
  const path = authPath()
  const polls: string[] = []
  const prompts: [string, string][] = []
  await withFetch(
    async (input: unknown, init?: RequestInit) => {
      if (isDeviceEndpoint(input)) {
        return json({
          device_code: "dev-1",
          user_code: "USER-1",
          verification_uri: "https://auth.x.ai/activate",
          verification_uri_complete: "https://auth.x.ai/activate?user_code=USER-1",
          interval: 1,
          expires_in: 600,
        })
      }
      polls.push(new URLSearchParams(String(init?.body)).get("device_code") ?? "")
      if (polls.length === 1) return json({ error: "authorization_pending" }, 400)
      if (polls.length === 2) return json({ error: "slow_down" }, 400)
      return json({ access_token: "a-dev", refresh_token: "r-dev", expires_in: 3600 })
    },
    async () => {
      const pending = xaiDeviceLogin((uri, code) => prompts.push([uri, code]), path)
      await vi.advanceTimersByTimeAsync(1000) // 1回目: authorization_pending
      await vi.advanceTimersByTimeAsync(1000) // 2回目: slow_down → 間隔が +5 秒
      await vi.advanceTimersByTimeAsync(5_999) // まだ3回目のポーリングに届かない
      assert.equal(polls.length, 2)
      await vi.advanceTimersByTimeAsync(1)
      const auth = await pending
      assert.equal(auth.access, "a-dev")
      assert.deepEqual(polls, ["dev-1", "dev-1", "dev-1"])
    },
  )
  assert.deepEqual(prompts, [["https://auth.x.ai/activate?user_code=USER-1", "USER-1"]])
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as { refresh: string }).refresh, "r-dev")
  assert.equal(statSync(path).mode & 0o777, 0o600)
})

test("承認が来ないまま期限が切れたら落とす(URI は素の verification_uri へ倒す)", async () => {
  vi.useFakeTimers()
  const path = authPath()
  const prompts: string[] = []
  await withFetch(
    async (input: unknown) => {
      if (isDeviceEndpoint(input)) {
        return json({
          device_code: "d",
          user_code: "U",
          verification_uri: "https://auth.x.ai/activate",
          interval: 1,
          expires_in: 1,
        })
      }
      return json({ error: "authorization_pending" }, 400)
    },
    async () => {
      const pending = xaiDeviceLogin((uri) => prompts.push(uri), path)
      // advance の最中に未処理拒否にしないため、先に rejects を掴んでおく。
      const expectation = assert.rejects(pending, /期限切れ/)
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(1000)
      await expectation
    },
  )
  assert.deepEqual(prompts, ["https://auth.x.ai/activate"])
})

test("pending/slow_down 以外のエラーはログイン拒否として落とす", async () => {
  vi.useFakeTimers()
  const path = authPath()
  const prompts: string[] = []
  await withFetch(
    async (input: unknown) => {
      if (isDeviceEndpoint(input)) {
        // URI が両方無いので案内は auth.x.ai になる。
        return json({ device_code: "d", user_code: "U", interval: 1, expires_in: 600 })
      }
      return json({ error: "access_denied", error_description: "user denied" }, 400)
    },
    async () => {
      const pending = xaiDeviceLogin((uri) => prompts.push(uri), path)
      const expectation = assert.rejects(pending, /ログインが拒否された: access_denied user denied/)
      await vi.advanceTimersByTimeAsync(1000)
      await expectation
    },
  )
  assert.deepEqual(prompts, ["https://auth.x.ai"])
})

test("device/code の非 2xx とコード欠落は入口で落とす", async () => {
  const path = authPath()
  await withFetch(
    async () => new Response("no", { status: 403 }),
    async () => {
      await assert.rejects(
        xaiDeviceLogin(() => {}, path),
        /device\/code が 403 を返した/,
      )
    },
  )
  await withFetch(
    async () => json({ user_code: "U" }),
    async () => {
      await assert.rejects(
        xaiDeviceLogin(() => {}, path),
        /device_code\/user_code が無い/,
      )
    },
  )
})
