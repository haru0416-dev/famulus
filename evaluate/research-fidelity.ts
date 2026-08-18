#!/usr/bin/env bun
/**
 * researcher(外部文献を引く役)のモデル比較。`bun run eval:research [model ...]`。
 *
 * 測るもの(判定器はこのファイルに固定 — 結果を見てから変えない):
 *   - quote一致  … evidence の quote が「その url を fetch した本文」と原文一致する率(主指標)
 *   - url実在    … evidence の url が実際に fetch されたものである率
 *   - claim 数と conclusion の有無、fetch 数・手数・所要(従指標)
 *
 * quote が取得物と一致しない evidence は、捏造か検索索引の写し(原文でないもの)のどちらか。
 * どちらも「出典の無い主張は書かない」の違反として同じ側に数える。
 *
 * 実行は本物の governedModel + 実ネットワーク。クォータを消費する。
 * 生の結果は docs/evals/research/ に残す。
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { Output, stepCountIs, ToolLoopAgent } from "ai"
import * as v from "valibot"
import {
  type FetchedEvidence,
  fetchTool,
  gateTools,
  RESEARCH_SCHEMA,
  RESEARCHER,
  searchTool,
} from "../src/agent/assistant.ts"
import { appConfig, configureApp } from "../src/core/config.ts"
import { loadEnv } from "../src/core/env.ts"
import { governedModel } from "../src/model/governed.ts"
import { vs } from "../src/model/schema.ts"

const OUT = new URL("../docs/evals/research/", import.meta.url).pathname

/** 実際に過去に調べた問い(evaluate/explore.ts の fixture 2・3 と同じ)。答えの検証先が一次資料にある。 */
const FIXTURES = [
  {
    id: "discord-resume",
    seed: "Discord Gateway の再接続でセッションを捨てるとき、シーケンス番号も捨てるべきか",
  },
  {
    id: "sandbox-dns",
    seed: "ネットワークの無い sandbox で名前解決に依存するテストが落ちる問題の扱い",
  },
] as const

const bare = (s: string) => s.replace(/\s+/g, "")

/** 走行中の reasoning effort(引数 "id@low" で指定)。 */
let EFFORT: "low" | "medium" | "high" | undefined

interface Score {
  readonly fixture: string
  readonly claims: number
  readonly conclusions: number
  readonly evidence: number
  readonly quoteMatched: number
  readonly quoteElsewhere: number
  readonly urlReal: number
  readonly fetches: number
  readonly steps: number
  readonly elapsedMs: number
  readonly detail: unknown
}

async function runOne(fixture: (typeof FIXTURES)[number]): Promise<Score> {
  const fetched: FetchedEvidence[] = []
  const began = Date.now()
  const generated = await new ToolLoopAgent({
    model: governedModel(appConfig().models.research, EFFORT ? { reasoningEffort: EFFORT } : undefined),
    instructions: RESEARCHER,
    tools: gateTools({ search: searchTool(), fetch: fetchTool(fetched) }, undefined),
    // RESEARCH_OBJECT(assistant.ts)と同形。検証の正本は下の RESEARCH_SCHEMA.validate。
    output: Output.object({
      schema: vs(
        v.object({
          stopRule: v.string(),
          stopped: v.string(),
          limitations: v.string(),
          claims: v.array(
            v.object({
              statement: v.string(),
              kind: v.picklist(["observation", "hypothesis", "conclusion"]),
              evidence: v.array(
                v.object({
                  url: v.string(),
                  quote: v.string(),
                  polarity: v.picklist(["support", "refute", "context"]),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
    stopWhen: stepCountIs(12),
    maxRetries: 0,
  }).generate({ prompt: fixture.seed })
  const parsed = RESEARCH_SCHEMA.validate(generated.output)
  if (!parsed.success) throw parsed.error
  const out = parsed.value as {
    claims: {
      kind: string
      statement: string
      evidence: { url: string; quote: string }[]
    }[]
  }
  // 同じ URL を offset 違いで複数回 fetch した本文は繋いで照合する。
  const byUrl = new Map<string, string>()
  for (const f of fetched) byUrl.set(f.url, (byUrl.get(f.url) ?? "") + bare(f.content))
  const anywhere = [...byUrl.values()].join("\n")
  const evidence = out.claims.flatMap((c) => c.evidence)
  const urlOf = (u: string) => [...byUrl.keys()].find((k) => k === u || k.startsWith(`${u}?`) || u.startsWith(`${k}?`))
  let quoteMatched = 0
  let quoteElsewhere = 0
  let urlReal = 0
  for (const e of evidence) {
    const page = urlOf(e.url)
    if (page !== undefined) urlReal++
    const q = bare(e.quote)
    if (q.length >= 4 && page !== undefined && (byUrl.get(page) ?? "").includes(q)) quoteMatched++
    else if (q.length >= 4 && anywhere.includes(q)) quoteElsewhere++
  }
  return {
    fixture: fixture.id,
    claims: out.claims.length,
    conclusions: out.claims.filter((c) => c.kind === "conclusion").length,
    evidence: evidence.length,
    quoteMatched,
    quoteElsewhere,
    urlReal,
    fetches: fetched.length,
    steps: generated.steps.length,
    elapsedMs: Date.now() - began,
    detail: parsed.value,
  }
}

const main = async () => {
  loadEnv()
  mkdirSync(OUT, { recursive: true })
  const models = process.argv.slice(2)
  if (models.length === 0) models.push("grok-4.3")
  for (const spec of models) {
    // "grok-4.6@low" の形で reasoning effort を指定できる(既定は API 任せ)。
    const [model, effort] = spec.split("@") as [string, "low" | "medium" | "high" | undefined]
    process.env.FAMULUS_RESEARCH_MODEL = model
    configureApp()
    EFFORT = effort
    console.log(`\n== ${spec} ==`)
    const scores: Score[] = []
    for (const fixture of FIXTURES) {
      // 途中失敗(出力なし・手数切れ)は0点の1走として数える。捨てると失敗しやすい側が有利になる。
      const s = await runOne(fixture).catch(
        (e): Score => ({
          fixture: fixture.id,
          claims: 0,
          conclusions: 0,
          evidence: 0,
          quoteMatched: 0,
          quoteElsewhere: 0,
          urlReal: 0,
          fetches: 0,
          steps: 0,
          elapsedMs: 0,
          detail: `失敗: ${e instanceof Error ? e.message : String(e)}`,
        }),
      )
      scores.push(s)
      console.log(
        `${s.fixture.padEnd(14)} claim ${s.claims}(結論${s.conclusions}) evidence ${s.evidence}` +
          ` quote一致 ${s.quoteMatched} 他所一致 ${s.quoteElsewhere} url実在 ${s.urlReal}` +
          ` / fetch ${s.fetches} ${s.steps}手 ${Math.round(s.elapsedMs / 1000)}秒`,
      )
    }
    const summary = {
      at: new Date().toISOString(),
      route: { harness: "famulus researcher", backend: "api.x.ai/v1 responses", model: spec },
      rev: execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(),
      scores,
    }
    const path = `${OUT}${new Date().toISOString().replace(/[:.]/g, "-")}-${spec.replace("@", "-")}.json`
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`保存: ${path}`)
  }
}

await main()
