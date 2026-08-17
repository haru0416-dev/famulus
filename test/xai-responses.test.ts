/**
 * xaiResponsesModel の送信契約の検査。実際に飛ぶ POST を withFetch で捕まえて、
 * `store: false`(契約枠の必須指定 — プロンプトを x.ai 側に保存させない)と
 * Bearer(auth ファイルの access)が載ることを固定する。応答は見ない。
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "vitest"
import { configureApp } from "../src/core/config.ts"
import { xaiResponsesModel } from "../src/model/xai-responses.ts"
import { withFetch } from "./helpers.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.FAMULUS_XAI_AUTH
  configureApp()
})

test("送信 body に store:false、ヘッダに auth ファイルの Bearer が載る", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xai-resp-test-"))
  roots.push(dir)
  const path = join(dir, "xai-auth.json")
  // 期限の遠い access にして refresh 経路を通さない(そちらは test/xai-auth.test.ts)
  writeFileSync(path, JSON.stringify({ access: "a-live", refresh: "r", expires: Date.now() + 3_600_000 }))
  process.env.FAMULUS_XAI_AUTH = path
  configureApp()

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
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
    async () => {
      // 応答は合成の空ストリーム。ここで見るのは送信側の契約だけなので、応答起因の失敗は無視する。
      try {
        await xaiResponsesModel("grok-4.3").doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "検査" }] }],
        })
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
