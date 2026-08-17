#!/usr/bin/env bun
/**
 * 調査モードの比較評価(現行経路 vs explore fan-out)。`bun run evaluate:explore -- <cmd>`。
 *
 *   list                  … 固定fixture(実際に過去に調べた問い)の一覧
 *   contract <n>          … 評価契約(語彙・予想・除外・rubric)をファイルに固定する。
 *                           **実行より先に呼ぶ。既にあれば上書きしない** — 結果を見てから
 *                           基準を書くと候補経路に有利な分類になる。
 *   run <n> current       … 現行経路(researcher 1本)で実行し、生の結果を保存する
 *   run <n> explore       … explore fan-out(7方向)で実行し、生の結果と dossier を保存する
 *   compare <n>           … 機械で数えられる指標を並べ、判定欄が空の比較表を書き出す
 *
 * 置き場は `docs/explore-eval/`。生の結果は消さない — 判定は raw artifacts に対して行う。
 * 実行はクォータを使う(explore は7分岐)。
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { Output, stepCountIs, ToolLoopAgent } from "ai"
import * as Effect from "effect/Effect"
import * as v from "valibot"
import {
  type FetchedEvidence,
  fetchTool,
  gateTools,
  RESEARCH_SCHEMA,
  RESEARCHER,
  searchTool,
} from "../src/agent/assistant.ts"
import { type BranchOutcome, runExplore } from "../src/agent/explore.ts"
import { appConfig, configureApp } from "../src/core/config.ts"
import { loadEnv } from "../src/core/env.ts"
import { governedModel } from "../src/model/governed.ts"
import { vs } from "../src/model/schema.ts"
import { run, runtime } from "../src/runtime.ts"
import { Research } from "../src/services/Research.ts"

const OUT = new URL("../docs/explore-eval/", import.meta.url).pathname

/**
 * fixture は実際に過去に調べた問い(research_dossiers / questions の実データ)。
 * 結果から題を作らない — 知りたいのは「実際の問いで差が出るか」だけ。
 */
const FIXTURES = [
  {
    id: 1,
    seed: "2026-08-09〜2026-08-16 のあいだに出た、一次資料がある AI 製品・モデル・論文・OSS リリースを探す",
    vocabulary: ["AI", "製品", "モデル", "論文", "OSS", "リリース", "一次資料", "公式"],
    prediction: "OpenAI/Anthropic/xAI の公式発表と GitHub リリースが大半を占め、論文はほぼ出ない",
    exclusions: ["二次記事のまとめ", "リリース日が特定できないもの"],
  },
  {
    id: 2,
    seed: "Discord Gateway の再接続でセッションを捨てるとき、シーケンス番号も捨てるべきか",
    vocabulary: ["Discord", "Gateway", "再接続", "セッション", "シーケンス番号", "IDENTIFY", "RESUME", "heartbeat"],
    prediction: "公式ドキュメントの再接続仕様と、ライブラリ実装の再現例が出る。WebSocket の外には出ない",
    exclusions: ["Discord 以外のチャット製品の一般論"],
  },
  {
    id: 3,
    seed: "ネットワークの無い sandbox で名前解決に依存するテストが落ちる問題の扱い",
    vocabulary: ["DNS", "名前解決", "sandbox", "テスト", "mock", "ネットワーク", "CI"],
    prediction: "テストダブル/hermetic testing の一般論が出る",
    exclusions: ["特定 CI ベンダーの宣伝記事"],
  },
] as const

const RUBRIC = [
  "新分野名: 契約の語彙・予想のどちらにも無い研究/産業分野の固有名",
  "新概念名: 契約の語彙に無い技術概念・手法の固有名",
  "構造差: 種の問いと異なる構造(規格・訴訟・組織論など)で説明された候補",
  "一次確認: fetch で開いた一次資料の quote が付いている claim",
  "予想外れ: 契約の prediction に反する観測",
  "判定は raw artifacts に対して行い、この rubric を実行後に変えない",
].join("\n")

const fixture = (n: number) => {
  const found = FIXTURES.find((f) => f.id === n)
  if (!found) throw new Error(`fixture ${n} は無い(1〜${FIXTURES.length})`)
  return found
}

const contractPath = (n: number) => `${OUT}${n}-contract.json`
// FAMULUS_EVAL_TAG を付けると別ファイルに書く。モデル差し替えの対を取るとき、既存の raw を上書きしない。
const resultPath = (n: number, path: string) =>
  `${OUT}${n}-${path}${process.env.FAMULUS_EVAL_TAG ? `-${process.env.FAMULUS_EVAL_TAG}` : ""}.json`

function writeContract(n: number): string {
  const p = contractPath(n)
  if (existsSync(p)) return `既にある(上書きしない — 予告は固定): ${p}`
  mkdirSync(OUT, { recursive: true })
  writeFileSync(
    p,
    `${JSON.stringify({ ...fixture(n), rubric: RUBRIC, fixedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  return `固定した: ${p}`
}

/** 現行経路。researcher 道具の中身と同じ組み立て(instructions・道具・schema・手数)。 */
async function runCurrent(seed: string) {
  const fetched: FetchedEvidence[] = []
  const began = Date.now()
  const generated = await new ToolLoopAgent({
    model: governedModel(appConfig().models.research),
    instructions: RESEARCHER,
    tools: gateTools({ search: searchTool(), fetch: fetchTool(fetched) }, undefined),
    output: Output.object({
      schema: vs(
        v.object({
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
      name: "research_dossier",
      description: "fetchで開いた資料だけに基づくclaimと引用",
    }),
    stopWhen: stepCountIs(10),
    maxRetries: 0,
  }).generate({ prompt: seed })
  const parsed = RESEARCH_SCHEMA.validate(generated.output)
  if (!parsed.success) throw parsed.error
  return {
    path: "current" as const,
    route: { harness: "famulus researcher", backend: "api.x.ai/v1 responses", model: appConfig().models.research },
    rev: execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(),
    elapsedMs: Date.now() - began,
    steps: generated.steps.length,
    fetches: fetched.length,
    output: parsed.value,
  }
}

async function runExplorePath(seed: string) {
  const began = Date.now()
  const { branches, duplicates } = await runExplore(
    {
      model: governedModel(appConfig().models.research),
      makeTools: (collector) => gateTools({ search: searchTool(), fetch: fetchTool(collector) }, undefined),
      maxSteps: 6,
    },
    seed,
  )
  return {
    path: "explore" as const,
    route: { harness: "famulus explore", backend: "api.x.ai/v1 responses", model: appConfig().models.research },
    rev: execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(),
    elapsedMs: Date.now() - began,
    duplicates,
    branches,
  }
}

/** explore の分岐を実DBの dossier に固定する。捏造 quote は記録側の検証で落ちる。 */
const recordExplore = (
  f: (typeof FIXTURES)[number],
  branches: readonly BranchOutcome[],
  duplicates: readonly { statement: string; transforms: readonly string[] }[],
) =>
  Effect.gen(function* () {
    const research = yield* Research
    return yield* research.recordExploreDossier({
      seed: f.seed,
      prediction: f.prediction,
      exclusions: [...f.exclusions],
      branches: branches.map((b) => ({
        transform: b.transform,
        empty: b.output.empty,
        summary: b.output.summary,
        limitations: b.output.limitations,
        ...(b.failed ? { failed: b.failed } : {}),
        snapshots: b.snapshots,
        claims: b.output.claims,
      })),
      duplicates,
    })
  })

function compare(n: number): string {
  const read = (path: string): Record<string, unknown> | undefined =>
    existsSync(resultPath(n, path)) ? JSON.parse(readFileSync(resultPath(n, path), "utf8")) : undefined
  const current = read("current")
  const explore = read("explore")
  if (!current || !explore) return "current と explore の両方を先に run する"
  type Claim = { evidence: unknown[] }
  const currentClaims = (current.output as { claims: Claim[] }).claims
  const branches = explore.branches as {
    steps: number
    snapshots: unknown[]
    output: { empty: boolean; claims: Claim[] }
  }[]
  const exploreClaims = branches.flatMap((b) => b.output.claims)
  const confirmed = (claims: Claim[]) => claims.filter((c) => c.evidence.length > 0).length
  const lines = [
    `# fixture ${n} 比較(機械集計のみ。判定欄は raw を読んで埋める)`,
    "",
    "| 指標 | current | explore |",
    "|---|---|---|",
    `| claim 総数 | ${currentClaims.length} | ${exploreClaims.length} |`,
    `| 一次確認(evidence 付き) | ${confirmed(currentClaims)} | ${confirmed(exploreClaims)} |`,
    `| 空振りとして明示された方向 | - | ${branches.filter((b) => b.output.empty).length} |`,
    `| 重複 | - | ${(explore.duplicates as unknown[]).length} |`,
    `| 手数(モデル呼び出し) | ${current.steps} | ${branches.reduce((a, b) => a + b.steps, 0)} |`,
    `| 外向き取得 | ${current.fetches} | ${branches.reduce((a, b) => a + b.snapshots.length, 0)} |`,
    `| 実時間 | ${Math.round(Number(current.elapsedMs) / 1000)}s | ${Math.round(Number(explore.elapsedMs) / 1000)}s |`,
    "",
    "## 判定欄(rubric は contract に固定済み。raw を読んで埋める)",
    "| 指標 | current | explore |",
    "|---|---|---|",
    "| 新分野名 | | |",
    "| 新概念名 | | |",
    "| 構造差のある説明 | | |",
    "| 予想を外した結果 | | |",
  ]
  const p = `${OUT}${n}-comparison.md`
  writeFileSync(p, `${lines.join("\n")}\n`)
  return `書き出した: ${p}\n\n${lines.join("\n")}`
}

const main = async () => {
  const [cmd, arg1, arg2] = process.argv.slice(2)
  if (cmd === "list") {
    for (const f of FIXTURES) console.log(`${f.id}: ${f.seed}`)
    return
  }
  const n = Number(arg1)
  if (cmd === "contract") return console.log(writeContract(n))
  if (cmd === "compare") return console.log(compare(n))
  if (cmd === "run") {
    if (!existsSync(contractPath(n))) throw new Error(`先に contract ${n} を固定する(予告が先、実行が後)`)
    const f = fixture(n)
    loadEnv()
    configureApp()
    const rt = runtime()
    try {
      if (arg2 === "explore") {
        const result = await runExplorePath(f.seed)
        const dossier = await run(recordExplore(f, result.branches, result.duplicates))
        writeFileSync(resultPath(n, "explore"), `${JSON.stringify({ ...result, dossier: dossier.id }, null, 2)}\n`)
        console.log(`保存した: ${resultPath(n, "explore")} / dossier: ${dossier.id}`)
      } else {
        const result = await runCurrent(f.seed)
        writeFileSync(resultPath(n, "current"), `${JSON.stringify(result, null, 2)}\n`)
        console.log(`保存した: ${resultPath(n, "current")}`)
      }
    } finally {
      await rt.dispose()
    }
    return
  }
  console.log("使い方: evaluate:explore -- list | contract <n> | run <n> current|explore | compare <n>")
}

await main()
