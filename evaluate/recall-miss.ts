#!/usr/bin/env bun
/**
 * recall(FTS trigram + 2文字語 LIKE 併用)の miss 率を測る。`bun run eval:recall`。
 * モデルは呼ばない — 検索機構だけの評価。クォータ消費ゼロ。
 *
 * 目的: sqlite-vec + ローカル埋め込みの採否を数字で決める(2026-08-17 の道具調査 #5)。
 * 分類規則はこのファイルに固定 — 結果を見てから変えない:
 *   - mechanics 系(exact / short-cjk / case / and-overspecify)… trigram+LIKE の機構が受け持つ範囲
 *   - semantic 系(paraphrase / cross-lingual / kana-latin)… 埋め込みでしか埋まらない範囲
 * 判定は hit@10(recall の既定 limit)。
 *
 * Part A は合成コーパス(:memory:)。Part B は実DBの複製(読み取りのみ)に対する probe で、
 * 各 probe は ground-truth の LIKE 語を持つ — LIKE で行が実在するのに recall が返さないときだけ
 * miss と数える(実在しなければ true negative として除外。「grok 移行」の誤判定を繰り返さない)。
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { configureApp } from "../src/core/config.ts"
import { loadEnv } from "../src/core/env.ts"
import { nowIso } from "../src/core/time.ts"
import { type AppServices, makeAppLayer } from "../src/runtime.ts"
import { RunnerStub } from "../src/model/Runner.ts"
import { Db, DbLive } from "../src/services/Db.ts"
import { Memory } from "../src/services/Memory.ts"

const OUT = new URL("../.ward/evals/recall/", import.meta.url).pathname
const SCRATCH = "/tmp/claude-1000/-home-haru-Project-famulus/26059e56-b34f-483b-b348-88375ea485bb/scratchpad"

type Category =
  | "exact"
  | "short-cjk"
  | "case"
  | "and-overspecify"
  | "paraphrase"
  | "cross-lingual"
  | "kana-latin"

/** 合成コーパス。famulus の system 記録の実際の文体に寄せる。 */
const CORPUS: readonly string[] = [
  /* 0 */ "cycle が Conflict で落ちた。cycle-log の dedupe key が実行条件由来で衝突していた。",
  /* 1 */ "SuperGrok OAuth の device flow を通した。トークンは xai-auth.json に保存した。",
  /* 2 */ "presence の再接続で seq を捨てるようにした。4007 と 4009 はセッションごと破棄する。",
  /* 3 */ "watch 2件を回した。x_search で公式ハンドルの新発表を確認した。",
  /* 4 */ "researcher が引用照合で3回失敗したので、照合できた claim だけ残す救済を実装した。",
  /* 5 */ "backup の復元検証が通った。スナップショットは VACUUM INTO で取る。",
  /* 6 */ "explore の比較評価は 21分岐すべて空振りだった。",
  /* 7 */ "Discord の返信が queued のまま次の poll まで待っていた。flush を cycle の締めに足した。",
  /* 8 */ "keeper の capture が 6/9 から 9/9 に上がった。境界は確言か推測か。",
  /* 9 */ "sqlite の trigram FTS は2文字語を索引で引けないので LIKE を併用している。",
  /* 10 */ "The weekly SuperGrok limit is a shared usage pool across chat and API.",
  /* 11 */ "grok-4.6 の入力単価は 20000 ticks、grok-4.3 は 12500。",
  /* 12 */ "selfdev は凍結中。本体の移行が終わるまで触らない。",
  /* 13 */ "通知は Discord に束ねる。回数そのものが割り込みのコスト。",
]

interface SyntheticProbe {
  readonly q: string
  readonly expect: number
  readonly category: Category
  /** 機構上ヒットしないはずの probe(記録して miss 率の分母にも入れる)。 */
  readonly expectMiss?: boolean
}

const SYNTHETIC: readonly SyntheticProbe[] = [
  // exact — 索引語がそのまま入っている
  { q: "dedupe key 衝突", expect: 0, category: "exact" },
  { q: "device flow", expect: 1, category: "exact" },
  { q: "VACUUM INTO", expect: 5, category: "exact" },
  { q: "trigram 索引", expect: 9, category: "exact" },
  { q: "引用照合 失敗", expect: 4, category: "exact" },
  // short-cjk — 2文字語(LIKE 併用の受け持ち)
  { q: "凍結", expect: 12, category: "short-cjk" },
  { q: "移行", expect: 12, category: "short-cjk" },
  { q: "復元", expect: 5, category: "short-cjk" },
  { q: "衝突", expect: 0, category: "short-cjk" },
  { q: "単価", expect: 11, category: "short-cjk" },
  // case — ASCII の大文字小文字
  { q: "SUPERGROK", expect: 1, category: "case" },
  { q: "Grok-4.6", expect: 11, category: "case" },
  { q: "conflict", expect: 0, category: "case" },
  // and-overspecify — 語を盛りすぎた問い(AND 意味論の代償)
  { q: "presence 再接続 seq IDENTIFY", expect: 2, category: "and-overspecify", expectMiss: true },
  { q: "keeper capture 引用照合", expect: 8, category: "and-overspecify", expectMiss: true },
  // paraphrase — 言い換え(埋め込みの受け持ち)
  { q: "返信が遅い", expect: 7, category: "paraphrase", expectMiss: true },
  { q: "自走が止まった", expect: 0, category: "paraphrase", expectMiss: true },
  { q: "料金", expect: 11, category: "paraphrase", expectMiss: true },
  { q: "記憶の取りこぼし", expect: 8, category: "paraphrase", expectMiss: true },
  { q: "調査の並列実行", expect: 6, category: "paraphrase", expectMiss: true },
  // cross-lingual — 言語をまたぐ問い
  { q: "週次 上限 プール", expect: 10, category: "cross-lingual", expectMiss: true },
  { q: "shared pool", expect: 10, category: "cross-lingual" },
  { q: "snapshot", expect: 5, category: "cross-lingual", expectMiss: true }, // 本文は「スナップショット」
  // kana-latin — 表記体系の揺れ
  { q: "バックアップ", expect: 5, category: "kana-latin", expectMiss: true }, // 本文は "backup"
  { q: "フラッシュ", expect: 7, category: "kana-latin", expectMiss: true }, // 本文は "flush"
  { q: "トークン", expect: 1, category: "kana-latin" },
]

/** 実DB probe。ground-truth の LIKE 語で実在を確かめてから miss を数える。 */
interface RealProbe {
  readonly q: string
  /** この語を含む索引行が実在するときだけ、この probe は分母に入る。 */
  readonly truthLike: string
}

const REAL_PROBES: readonly RealProbe[] = [
  { q: "watch 発表", truthLike: "watch" },
  { q: "selfdev テスト", truthLike: "selfdev" },
  { q: "wrapStream", truthLike: "wrapStream" },
  { q: "下書き Zenn", truthLike: "Zenn" },
  { q: "DNS 名前解決", truthLike: "名前解決" },
  { q: "web.test", truthLike: "web.test" },
  { q: "再接続", truthLike: "再接続" },
  { q: "dream 見直し", truthLike: "dream" },
]

async function partA() {
  const stub = RunnerStub([{ text: "" }])
  const rt = ManagedRuntime.make(makeAppLayer(DbLive(":memory:"), stub.layer))
  const run = <A, E>(e: Effect.Effect<A, E, AppServices>) => rt.runPromise(e)
  try {
    await run(
      Effect.gen(function* () {
        const mem = yield* Memory
        for (const text of CORPUS) {
          yield* mem.remember({ source: "system", kind: "observe", content: text, text, at: nowIso() })
        }
      }),
    )
    const results = []
    for (const probe of SYNTHETIC) {
      const rows = await run(Effect.flatMap(Memory, (m) => m.recall(probe.q, 10)))
      const hit = rows.some((r) => (r as { text?: string }).text === CORPUS[probe.expect])
      results.push({ ...probe, hit })
    }
    return results
  } finally {
    await rt.dispose()
  }
}

async function partB() {
  // 実DBは複製に対して読む。走行中の cycle と足を踏み合わない。
  const copy = `${SCRATCH}/recall-eval.db`
  execFileSync("sqlite3", [`${process.cwd()}/.data/famulus.db`, `.backup ${copy}`])
  const stub = RunnerStub([{ text: "" }])
  const rt = ManagedRuntime.make(makeAppLayer(DbLive(copy), stub.layer))
  const run = <A, E>(e: Effect.Effect<A, E, AppServices>) => rt.runPromise(e)
  try {
    const results = []
    for (const probe of REAL_PROBES) {
      const exists = await run(
        Effect.flatMap(Db, (db) =>
          db.get("SELECT COUNT(*)n FROM events_fts WHERE text LIKE '%' || ? || '%'", probe.truthLike),
        ),
      )
      const present = Number((exists as { n?: unknown })?.n ?? 0) > 0
      if (!present) {
        results.push({ ...probe, present, hit: false, verdict: "true-negative(分母外)" })
        continue
      }
      const rows = await run(Effect.flatMap(Memory, (m) => m.recall(probe.q, 10)))
      const hit = rows.some((r) => String((r as { text?: string }).text ?? "").includes(probe.truthLike))
      results.push({ ...probe, present, hit, verdict: hit ? "hit" : "miss" })
    }
    return results
  } finally {
    await rt.dispose()
  }
}

const main = async () => {
  loadEnv()
  configureApp()
  mkdirSync(OUT, { recursive: true })
  const a = await partA()
  const byCategory = new Map<Category, { hit: number; total: number }>()
  for (const r of a) {
    const entry = byCategory.get(r.category) ?? { hit: 0, total: 0 }
    entry.total += 1
    if (r.hit) entry.hit += 1
    byCategory.set(r.category, entry)
  }
  console.log("Part A(合成・hit@10)")
  for (const [category, { hit, total }] of byCategory) {
    console.log(`  ${category.padEnd(16)} ${hit}/${total}`)
  }
  const b = await partB()
  const denominator = b.filter((r) => r.present)
  console.log(`Part B(実DB)hit ${denominator.filter((r) => r.hit).length}/${denominator.length}` +
    `(true-negative 除外 ${b.length - denominator.length}件)`)
  for (const r of b) console.log(`  ${r.verdict.padEnd(22)} ${r.q}`)
  const summary = {
    at: new Date().toISOString(),
    route: { harness: "Memory.recall", backend: "SQLite FTS5 trigram + LIKE", model: "なし" },
    rev: execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(),
    partA: a,
    partB: b,
  }
  const path = `${OUT}${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`保存: ${path}`)
}

await main()
