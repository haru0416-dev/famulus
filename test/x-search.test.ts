/**
 * x_search の検査。ネットワークは呼ばない — 要求 body の組み立て・応答の解析と、
 * 失敗時の統治(ledger 記録と枯渇→cooldown の伝播)を見る。
 * 実疎通は 2026-08-17 に実測済み(grok-4.3 + handle filter で 200 / 約10秒)。
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { configureApp } from "../src/core/config.ts"
import { nowIso } from "../src/core/time.ts"
import { XAI_POOL } from "../src/model/models.ts"
import { buildXSearchBody, parseXSearchResponse, xSearch } from "../src/model/x-search.ts"
import { Db } from "../src/services/Db.ts"
import { Governance } from "../src/services/Governance.ts"
import { withFetch, withHarness } from "./helpers.ts"

test("要求 body は filter を検証してから組む", () => {
  const body = buildXSearchBody(
    {
      query: "AI エージェントの話題",
      allowedHandles: ["@karpathy", " simonw "],
      fromDate: "2026-08-01",
      toDate: "2026-08-16",
    },
    "grok-4.3",
  ) as { model: string; tools: Record<string, unknown>[]; store: boolean }
  assert.equal(body.model, "grok-4.3")
  assert.equal(body.store, false)
  // @ と空白は正規化してから渡す。上流での 400 は持ち時間を使った後の失敗になる。
  assert.deepEqual(body.tools[0], {
    type: "x_search",
    allowed_x_handles: ["karpathy", "simonw"],
    from_date: "2026-08-01",
    to_date: "2026-08-16",
  })

  assert.throws(() => buildXSearchBody({ query: "  " }, "grok-4.3"), /query が空/)
  assert.throws(
    () => buildXSearchBody({ query: "q", allowedHandles: ["a"], excludedHandles: ["b"] }, "grok-4.3"),
    /同時に指定できない/,
  )
  assert.throws(() => buildXSearchBody({ query: "q", fromDate: "8月1日" }, "grok-4.3"), /YYYY-MM-DD/)
  assert.throws(
    () => buildXSearchBody({ query: "q", fromDate: "2026-08-16", toDate: "2026-08-01" }, "grok-4.3"),
    /より後/,
  )
  assert.throws(
    () =>
      buildXSearchBody(
        { query: "q", allowedHandles: Array.from({ length: 11 }, (_, i) => `h${i}`) },
        "grok-4.3",
      ),
    /10 件まで/,
  )
})

/**
 * 応答の解析。実測した応答(2026-08-17)の形をそのまま縮めた fixture。
 * 本文に混ざる引用の描画マーカーは落とし、引用は annotation から別に取る。
 */
test("応答から回答・引用・使用量を取り出し、描画マーカーを落とす", () => {
  const r = parseXSearchResponse({
    output: [
      { type: "reasoning" },
      { type: "custom_tool_call" },
      {
        type: "message",
        content: [
          {
            type: "text",
            text: "@icoxfog417 が記事を投稿。 display render_inline_citation with citation_id is 25\n@toraaiuser2 が体験を共有。 (display render_inline_citation with citation_id is 17)",
            annotations: [
              { type: "url_citation", url: "https://x.com/i/status/1", title: "post1" },
              { type: "url_citation", url: "https://x.com/i/status/1", title: "重複は1回だけ" },
              { type: "url_citation", url: "https://x.com/i/status/2" },
              { type: "other", url: "https://x.com/i/status/3" },
            ],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 9625,
      input_tokens_details: { cached_tokens: 1024 },
      output_tokens: 915,
      server_side_tool_usage_details: { x_search_calls: 3 },
    },
  })
  assert.equal(r.answer, "@icoxfog417 が記事を投稿。\n@toraaiuser2 が体験を共有。")
  assert.deepEqual(r.citations, [
    { url: "https://x.com/i/status/1", title: "post1" },
    { url: "https://x.com/i/status/2" },
  ])
  assert.equal(r.searches, 3)
  // 入力は「キャッシュに載らなかった分」と cacheRead に割る。足すと桁が合う(Ledger の読み方と同じ)。
  assert.deepEqual(r.usage, { inTok: 8601, outTok: 915, cacheRead: 1024, cacheWrite: 0 })
})

test("壊れた応答は投げずに空で返す", () => {
  const r = parseXSearchResponse({})
  assert.equal(r.answer, "")
  assert.deepEqual(r.citations, [])
  assert.equal(r.searches, 0)
})

test("429 で落ちたら ledger に失敗が残り、続く precheck はクールダウンで拒否される", async () => {
  // refresh に行かないよう期限の遠い合成 auth を置く(token 網を回避)。
  const dir = mkdtempSync(join(tmpdir(), "fam-xai-auth-"))
  const authPath = join(dir, "xai-auth.json")
  writeFileSync(
    authPath,
    JSON.stringify({
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() + 24 * 60 * 60 * 1000,
    }),
  )
  process.env.FAMULUS_XAI_AUTH = authPath
  try {
    await withHarness(async (h) => {
      const failure = await withFetch(
        async (input: unknown) => {
          const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input)
          assert.ok(url.endsWith("/responses"), `想定外の送信先: ${url}`)
          return new Response("Too Many Requests: credits exhausted", { status: 429 })
        },
        () => h.fail(xSearch({ query: "検査" })),
      )
      assert.equal(failure._tag, "RunnerFailed")
      const failed = failure as Extract<typeof failure, { _tag: "RunnerFailed" }>
      assert.match(failed.message, /HTTP 429/)
      assert.equal(failed.exhausted, true)

      const row = await h.run(
        Effect.flatMap(Db, (db) => db.get("SELECT provenance FROM ledger WHERE kind='x-search'")),
      )
      assert.equal(JSON.parse(String(row?.provenance)).outcome, "failed")

      const refusal = await h.fail(
        Effect.flatMap(Governance, (gov) =>
          gov.precheck({ pool: XAI_POOL, at: nowIso(), nowMs: Date.now() }),
        ),
      )
      assert.equal(refusal._tag, "QuotaCooldown")
    })
  } finally {
    delete process.env.FAMULUS_XAI_AUTH
    configureApp()
    rmSync(dir, { recursive: true, force: true })
  }
})
