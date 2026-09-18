#!/usr/bin/env bun
// 分類規則は結果を見てから変えない。
// exact / short-cjk / case / and-overspecify は trigram+LIKE が届く範囲、
// paraphrase / cross-lingual / kana-latin は埋め込みでしか届かない範囲。
// 判定は hit@10(recall の既定 limit)。
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { appConfig, configureApp } from "../src/core/config.ts"
import { loadEnv } from "../src/core/env.ts"
import { nowIso } from "../src/core/time.ts"
import { type AppServices, makeAppLayer } from "../src/runtime.ts"
import { RunnerStub } from "../src/model/Runner.ts"
import { Db, DbLive } from "../src/services/Db.ts"
import { Memory } from "../src/services/Memory.ts"

const OUT = new URL("../docs/evals/recall/", import.meta.url).pathname

type Category =
  | "exact"
  | "short-cjk"
  | "case"
  | "and-overspecify"
  | "paraphrase"
  | "cross-lingual"
  | "kana-latin"

// system 記録の実際の文体に寄せる。
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
  // miss 率の分母には入れる。
  readonly expectMiss?: boolean
}

const SYNTHETIC: readonly SyntheticProbe[] = [
  { q: "dedupe key 衝突", expect: 0, category: "exact" },
  { q: "device flow", expect: 1, category: "exact" },
  { q: "VACUUM INTO", expect: 5, category: "exact" },
  { q: "trigram 索引", expect: 9, category: "exact" },
  { q: "引用照合 失敗", expect: 4, category: "exact" },
  { q: "凍結", expect: 12, category: "short-cjk" },
  { q: "移行", expect: 12, category: "short-cjk" },
  { q: "復元", expect: 5, category: "short-cjk" },
  { q: "衝突", expect: 0, category: "short-cjk" },
  { q: "単価", expect: 11, category: "short-cjk" },
  { q: "SUPERGROK", expect: 1, category: "case" },
  { q: "Grok-4.6", expect: 11, category: "case" },
  { q: "conflict", expect: 0, category: "case" },
  { q: "presence 再接続 seq IDENTIFY", expect: 2, category: "and-overspecify", expectMiss: true },
  { q: "keeper capture 引用照合", expect: 8, category: "and-overspecify", expectMiss: true },
  { q: "返信が遅い", expect: 7, category: "paraphrase", expectMiss: true },
  { q: "自走が止まった", expect: 0, category: "paraphrase", expectMiss: true },
  { q: "料金", expect: 11, category: "paraphrase", expectMiss: true },
  { q: "記憶の取りこぼし", expect: 8, category: "paraphrase", expectMiss: true },
  { q: "調査の並列実行", expect: 6, category: "paraphrase", expectMiss: true },
  { q: "週次 上限 プール", expect: 10, category: "cross-lingual", expectMiss: true },
  { q: "shared pool", expect: 10, category: "cross-lingual" },
  { q: "snapshot", expect: 5, category: "cross-lingual", expectMiss: true }, // 本文は「スナップショット」
  { q: "バックアップ", expect: 5, category: "kana-latin", expectMiss: true }, // 本文は "backup"
  { q: "フラッシュ", expect: 7, category: "kana-latin", expectMiss: true }, // 本文は "flush"
  { q: "トークン", expect: 1, category: "kana-latin" },
]

interface RealProbe {
  readonly q: string
  // この語を含む行が実在しないときは、recall が返さなくても miss と数えない。
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
  // scout が言い換えて要約するため、語では届かない。
  { q: "誤前提", truthLike: "誤定義" },
  { q: "誤前提シリーズの実験", truthLike: "誤定義" },
  { q: "カードゲームの通販", truthLike: "ポケカ" },
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
  // 走行中の cycle と競合しないよう複製を読む。
  const copy = join(mkdtempSync(join(tmpdir(), "recall-eval-")), "recall-eval.db")
  execFileSync("sqlite3", [appConfig().paths.db, `.backup ${copy}`])
  const stub = RunnerStub([{ text: "" }])
  const rt = ManagedRuntime.make(makeAppLayer(DbLive(copy), stub.layer))
  const run = <A, E>(e: Effect.Effect<A, E, AppServices>) => rt.runPromise(e)
  try {
    // 本番でまだ埋め込んでいない行があるので、probe の前に埋める。
    let embedded = 0
    for (;;) {
      const batch = await run(Effect.flatMap(Memory, (m) => m.embedMissing(200)))
      embedded += batch
      if (batch === 0) break
    }
    console.log(`Part B: 複製へ埋め込み ${embedded} 件`)
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
