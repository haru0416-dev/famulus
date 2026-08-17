/**
 * xaiResponsesModel / callXai / collect の検査。ネットワークは withFetch で全部止め、
 * 応答は Responses API の SSE をここで合成する(形は @ai-sdk/openai 4.x の chunk schema 準拠)。
 * 固定するのは3点: 送信契約(store:false / Bearer / strict:false)、応答の畳み込みと usage の写し、
 * 失敗→クォータシグナルの変換(統治はこのシグナルだけを頼りに再実行を抑止する)。
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { afterEach, test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { ModelCallError, XAI_POOL } from "../../src/model/models.ts"
import { callXai, collect, xaiResponsesModel } from "../../src/model/xai-responses.ts"
import { withFetch } from "../helpers.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.FAMULUS_XAI_AUTH
  configureApp()
})

/** 期限の遠い合成 auth を置き、既定パスをそこへ向ける(refresh 経路は test/model/xai-auth.test.ts)。 */
const authFile = (): void => {
  const dir = mkdtempSync(join(tmpdir(), "xai-resp-test-"))
  roots.push(dir)
  const path = join(dir, "xai-auth.json")
  writeFileSync(path, JSON.stringify({ access: "a-live", refresh: "r", expires: Date.now() + 3_600_000 }))
  process.env.FAMULUS_XAI_AUTH = path
  configureApp()
}

const OPTS = {
  prompt: [{ role: "user", content: [{ type: "text", text: "検査" }] }],
} as unknown as Parameters<LanguageModelV4["doGenerate"]>[0]

const sse = (...events: unknown[]): Response =>
  new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

/** text 1件と usage(cached 30 込み input 100 / output 10)だけの応答。 */
const textEvents = (...deltas: string[]): unknown[] => [
  { type: "response.created", response: { id: "resp_1", created_at: 1_755_000_000, model: "grok-4.3" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  ...deltas.map((delta) => ({
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 0,
    delta,
  })),
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
  {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
  },
]

const apiError = (status: number, message: string): Response =>
  new Response(
    JSON.stringify({ error: { message, type: "invalid_request_error", param: null, code: null } }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  )

test("送信 body に store:false、ヘッダに auth ファイルの Bearer が載る", async () => {
  authFile()
  let captured: { url: string; store: unknown; stream: unknown; auth: string | null } | undefined
  await withFetch(
    async (input: unknown, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      captured = {
        url,
        store: body.store,
        stream: body.stream,
        auth: new Headers(init?.headers).get("authorization"),
      }
      return sse()
    },
    async () => {
      // 応答は合成の空ストリーム。ここで見るのは送信側の契約だけなので、応答起因の失敗は無視する。
      try {
        await xaiResponsesModel("grok-4.3").doGenerate(OPTS)
      } catch {
        // 送信の検査だけが目的
      }
    },
  )
  assert.ok(captured, "POST が飛んでいない")
  assert.match(captured.url, /\/responses$/)
  assert.equal(captured.store, false)
  assert.equal(captured.stream, true)
  assert.equal(captured.auth, "Bearer a-live")
})

test("doGenerate は SSE を1回ぶんに畳み、notionalUsd 0 のメタを付ける", async () => {
  authFile()
  await withFetch(
    async () => sse(...textEvents("こん", "にちは")),
    async () => {
      const result = await xaiResponsesModel("grok-4.3").doGenerate(OPTS)
      assert.deepEqual(result.content, [{ type: "text", text: "こんにちは" }])
      assert.equal(result.finishReason.unified, "stop")
      assert.equal(result.usage.inputTokens.total, 100)
      assert.equal(result.usage.inputTokens.noCache, 70)
      assert.equal(result.usage.inputTokens.cacheRead, 30)
      assert.equal(result.usage.outputTokens.total, 10)
      assert.deepEqual(result.warnings, [])
      assert.deepEqual(result.providerMetadata?.["supergrok-oauth"], { notionalUsd: 0 })
    },
  )
})

test("doStream は finish part にだけメタを足し、他の part はそのまま流す", async () => {
  authFile()
  await withFetch(
    async () => sse(...textEvents("こん", "にちは")),
    async () => {
      const { stream } = await xaiResponsesModel("grok-4.3").doStream(OPTS)
      const parts: LanguageModelV4StreamPart[] = []
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
      const finish = parts.find((p) => p.type === "finish")
      assert.ok(finish !== undefined && finish.type === "finish")
      assert.deepEqual(finish.providerMetadata?.["supergrok-oauth"], { notionalUsd: 0 })
      const deltas = parts.filter((p) => p.type === "text-delta")
      assert.equal(deltas.length, 2)
      for (const d of deltas) assert.equal(d.providerMetadata?.["supergrok-oauth"], undefined)
    },
  )
})

test("429 は枯渇シグナル付きの ModelCallError になる", async () => {
  authFile()
  await withFetch(
    async () => apiError(429, "Too many requests"),
    async () => {
      const err = await xaiResponsesModel("grok-4.3")
        .doGenerate(OPTS)
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      assert.ok(err instanceof ModelCallError)
      assert.match(err.message, /^xai: /)
      assert.deepEqual(err.quota, { pool: XAI_POOL, window: "week", exhausted: true })
    },
  )
})

test("403 の entitlement 誤ブロックは30分の短い回避シグナルになる", async () => {
  authFile()
  const before = Date.now()
  await withFetch(
    async () => apiError(403, "personal-team-blocked: spending-limit"),
    async () => {
      const err = await xaiResponsesModel("grok-4.3")
        .doStream(OPTS)
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      assert.ok(err instanceof ModelCallError)
      assert.equal(err.quota?.window, "entitlement")
      assert.ok((err.quota?.resetsAtMs ?? 0) >= before + 30 * 60 * 1000)
      assert.ok((err.quota?.resetsAtMs ?? 0) <= Date.now() + 30 * 60 * 1000)
    },
  )
})

test("callXai は text と usage を写し、onText に差分を流す", async () => {
  authFile()
  await withFetch(
    async () => sse(...textEvents("こん", "にちは")),
    async () => {
      const deltas: string[] = []
      const result = await callXai({ prompt: "p", model: "grok-4.3", onText: (d) => deltas.push(d) })
      assert.equal(result.text, "こんにちは")
      assert.deepEqual(deltas, ["こん", "にちは"])
      assert.deepEqual(result.usage, { inTok: 70, outTok: 10, cacheRead: 30, cacheWrite: 0, notionalUsd: 0 })
      assert.equal(result.model, "grok-4.3")
      assert.equal("structured" in result, false)
    },
  )
})

test("jsonSchema は strict:false の json_schema として送られ、応答が structured に入る", async () => {
  authFile()
  let sent: Record<string, unknown> | undefined
  await withFetch(
    async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sse(...textEvents('{"ok":', "true}"))
    },
    async () => {
      const schema = { type: "object", properties: { ok: { type: "boolean" } } }
      const result = await callXai({ prompt: "p", model: "grok-4.3", jsonSchema: schema })
      assert.deepEqual(result.structured, { ok: true })
      assert.equal(result.text, '{"ok":true}')
      const format = (sent?.text as { format?: Record<string, unknown> } | undefined)?.format
      assert.equal(format?.type, "json_schema")
      assert.equal(format?.name, "reply")
      // strict は valibot 生成の任意欄スキーマが 400 で拒否されるため false 固定。
      assert.equal(format?.strict, false)
      assert.deepEqual(format?.schema, schema)
      assert.equal(sent?.store, false)
      // systemPrompt 未指定なら RUNTIME_PROMPT が入る。
      assert.ok(JSON.stringify(sent?.input).includes("famulus"))
    },
  )
})

test("structured は JSON でない応答なら undefined(欄は残す)", async () => {
  authFile()
  await withFetch(
    async () => sse(...textEvents("JSONじゃない")),
    async () => {
      const result = await callXai({ prompt: "p", model: "grok-4.3", jsonSchema: { type: "object" } })
      assert.equal("structured" in result, true)
      assert.equal(result.structured, undefined)
    },
  )
})

test("timeoutMs で中断され ModelCallError になる", async () => {
  authFile()
  await withFetch(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("中断された", "AbortError")))
      }),
    async () => {
      await assert.rejects(
        callXai({ prompt: "p", model: "grok-4.3", timeoutMs: 20 }),
        (e: unknown) => e instanceof ModelCallError,
      )
    },
  )
})

const streamOf = (parts: readonly LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> =>
  new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })

test("collect は reasoning を畳み、tool/source を透過し、finish 無しでも usage 0 で返す", async () => {
  const toolCall = { type: "tool-call", toolCallId: "t1", toolName: "x", input: "{}" }
  const source = { type: "source", sourceType: "url", id: "s1", url: "https://example.com" }
  const parts = [
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-delta", id: "r1", delta: "思" },
    { type: "reasoning-delta", id: "r1", delta: "考" },
    { type: "reasoning-end", id: "r1" },
    toolCall,
    source,
    // 畳み込み対象外の part(tool-input-*)は捨てる。
    { type: "tool-input-start", id: "t1", toolName: "x" },
  ] as unknown as readonly LanguageModelV4StreamPart[]
  const gen = await collect(streamOf(parts))
  assert.deepEqual(gen.content, [{ type: "reasoning", text: "思考" }, toolCall, source])
  assert.equal(gen.usage.inputTokens.total, 0)
  assert.equal(gen.usage.outputTokens.total, 0)
  assert.equal(gen.finishReason.unified, "stop")
  assert.equal("providerMetadata" in gen, false)
})

test("collect は error part を素のまま投げ直す", async () => {
  const sentinel = new Error("上流の失敗")
  const parts = [{ type: "error", error: sentinel }] as unknown as readonly LanguageModelV4StreamPart[]
  await assert.rejects(collect(streamOf(parts)), (e: unknown) => e === sentinel)
})
