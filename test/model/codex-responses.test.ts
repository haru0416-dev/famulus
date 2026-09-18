import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { callCodex, parseCodexAuth, quotaFromHeaders } from "../../src/model/codex-responses.ts"
import { CODEX_POOL, ModelCallError } from "../../src/model/models.ts"
import { withFetch } from "../helpers.ts"

const roots: string[] = []

const authFile = (tokens: Record<string, unknown>): void => {
  const dir = mkdtempSync(join(tmpdir(), "codex-test-"))
  roots.push(dir)
  const path = join(dir, "auth.json")
  writeFileSync(path, JSON.stringify({ tokens }))
  process.env.FAMULUS_CODEX_AUTH = path
  configureApp()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.FAMULUS_CODEX_AUTH
  configureApp()
})

test("auth.json は ChatGPT トークンだけを受ける — API キーは従量課金なので拒否", () => {
  const auth = parseCodexAuth(JSON.stringify({ tokens: { access_token: "at", account_id: "acc" } }))
  assert.deepEqual(auth, { accessToken: "at", accountId: "acc" })
  assert.throws(() => parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-x" })), ModelCallError)
  assert.throws(() => parseCodexAuth("not json"), ModelCallError)
})

test("クォータは使用率の高い窓を選び、0m 窓は読まない", () => {
  const q = quotaFromHeaders(
    {
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-used-percent": "12",
      "x-codex-secondary-window-minutes": "300",
      "x-codex-secondary-used-percent": "80",
      "x-codex-secondary-reset-after-seconds": "600",
    },
    1_000_000,
  )
  assert.deepEqual(q, {
    pool: CODEX_POOL,
    window: "300m",
    usedPercent: 80,
    resetsAtMs: 1_000_000 + 600_000,
    exhausted: false,
  })
  // 0m 窓は契約で使われていないので、読むと使用率 0% として選ばれる。
  const only = quotaFromHeaders(
    {
      "x-codex-primary-window-minutes": "0",
      "x-codex-primary-used-percent": "0",
      "x-codex-secondary-window-minutes": "300",
      "x-codex-secondary-used-percent": "5",
    },
    0,
  )
  assert.equal(only?.window, "300m")
  assert.equal(quotaFromHeaders({}, 0), undefined)
  assert.equal(
    quotaFromHeaders({ "x-codex-primary-used-percent": "10" }, 0, "codex-team")?.pool,
    "codex-team",
  )
})

/** @ai-sdk/openai 4.x の chunk schema に合わせた SSE。 */
const sse = (...events: unknown[]): Response =>
  new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-used-percent": "42",
    },
  })

const textEvents = (text: string): unknown[] => [
  { type: "response.created", response: { id: "r1", created_at: 1_755_000_000, model: "gpt-5.6-sol" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1" } },
  { type: "response.output_text.delta", item_id: "m1", output_index: 0, delta: text },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1" } },
  {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 200,
        input_tokens_details: { cached_tokens: 50 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 4 },
      },
    },
  },
]

test("送信契約 — Bearer / account-id / originator / store:false / json_schema。応答ヘッダがクォータになる", async () => {
  authFile({ access_token: "at-1", account_id: "acc-1" })
  let captured: { url: string; body: Record<string, unknown>; headers: Headers } | undefined
  const result = await withFetch(
    async (input: unknown, init?: RequestInit) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      }
      return sse(...textEvents('{"verdict":"出す","problems":[]}'))
    },
    () =>
      callCodex({
        prompt: "精査して",
        model: "gpt-5.6-sol",
        jsonSchema: { type: "object" },
      }),
  )
  assert.ok(captured)
  assert.match(captured.url, /^https:\/\/chatgpt\.com\/backend-api\/codex\//)
  assert.equal(captured.headers.get("authorization"), "Bearer at-1")
  assert.equal(captured.headers.get("chatgpt-account-id"), "acc-1")
  assert.equal(captured.headers.get("originator"), "codex_cli_rs")
  assert.equal(captured.body.store, false)
  assert.equal(captured.body.stream, true)
  const format = (captured.body.text as { format?: { type?: string; name?: string } })?.format
  assert.equal(format?.type, "json_schema")
  assert.equal(format?.name, "reply")
  assert.deepEqual(result.structured, { verdict: "出す", problems: [] })
  assert.equal(result.usage.inTok, 150)
  assert.equal(result.usage.cacheRead, 50)
  assert.equal(result.usage.outTok, 20)
  assert.equal(result.model, "gpt-5.6-sol")
  assert.deepEqual(result.quota, {
    pool: CODEX_POOL,
    window: "10080m",
    usedPercent: 42,
    exhausted: false,
  })
})

test("呼び出し前に中断済みの signal を provider へそのまま伝える", async () => {
  authFile({ access_token: "at-1", account_id: "acc-1" })
  let forwardedAborted = false
  await withFetch(
    async (_input: unknown, init?: RequestInit) => {
      forwardedAborted = init?.signal?.aborted === true
      throw new DOMException("中断された", "AbortError")
    },
    async () => {
      await assert.rejects(
        callCodex({ prompt: "p", model: "gpt-5.6-sol", signal: AbortSignal.abort("止める") }),
        (e: unknown) => e instanceof ModelCallError,
      )
    },
  )
  assert.equal(forwardedAborted, true)
})

test("429 は枯渇シグナル付きの失敗になる", async () => {
  authFile({ access_token: "at-1" })
  await withFetch(
    async () =>
      new Response(JSON.stringify({ error: { message: "quota" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await assert.rejects(
        () => callCodex({ prompt: "p", model: "gpt-5.6-sol" }),
        (e: unknown) =>
          e instanceof ModelCallError && e.quota?.pool === CODEX_POOL && e.quota.exhausted === true,
      )
    },
  )
})
