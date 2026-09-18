#!/usr/bin/env bun
// 分類規則は結果を見てから変えない。
// quote の原文一致は keepGrounded がコードで強制するので、違反が出たら評価ではなくコードの回帰。
// fixture は全部合成。結果の置き場は git 管理下なので実在の私的データを使わない。
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { keep } from "../src/agent/keeper.ts"
import { configureApp } from "../src/core/config.ts"
import { loadEnv } from "../src/core/env.ts"
import { nowIso } from "../src/core/time.ts"
import { ROLE_MODEL, RunnerLive } from "../src/model/Runner.ts"
import { type AppServices, makeAppLayer } from "../src/runtime.ts"
import { Db, DbLive } from "../src/services/Db.ts"
import { Memory } from "../src/services/Memory.ts"

const OUT = new URL("../docs/evals/keeper/", import.meta.url).pathname

interface Fixture {
  readonly id: string
  readonly material: string
  readonly expect: readonly string[]
  readonly reject: readonly string[]
}

// expect は確定した・ユーザー自身の・次に参照して意味を持つ値の断片。
// reject は一時的状態・疑問・伝聞・推測・雑談の断片。
const FIXTURES: readonly Fixture[] = [
  {
    id: "single-fact",
    material: "引っ越し終わった。新しい住所は青葉町2-14ね。",
    expect: ["青葉町2-14"],
    reject: [],
  },
  {
    id: "two-facts",
    material: "4月から仕事はRust側のチームに移ることになった。あと朝のコーヒーはやめて紅茶にした。",
    expect: ["Rust", "紅茶"],
    reject: [],
  },
  {
    id: "correction",
    material: "この前言った歯医者の予約、金曜じゃなくて木曜の16時だったわ。",
    expect: ["木曜"],
    reject: [],
  },
  {
    id: "temporary-state",
    material: "今日は頭痛いから早めに寝る。",
    expect: [],
    reject: ["頭痛", "早めに寝る"],
  },
  {
    id: "question-only",
    material: "そういえばgrokの週次の上限っていくらだったっけ?",
    expect: [],
    reject: ["上限"],
  },
  {
    id: "hearsay",
    material: "隣の部署の田口さん、来月で辞めるらしいよ。",
    expect: [],
    reject: ["辞める"],
  },
  {
    id: "numbers-verbatim",
    material: "サーバー移行の期限は9月30日で確定。予算は12万円に決めた。",
    expect: ["9月30日", "12万"],
    reject: [],
  },
  {
    id: "speculation",
    material: "たぶん来年あたり車買うかもなー。",
    expect: [],
    reject: ["車"],
  },
  {
    id: "preference",
    material: "通知はDiscordだけでいい。ntfyはもう見てないから外して。",
    expect: ["Discord"],
    reject: [],
  },
  {
    id: "buried-fact",
    material:
      "昨日は散歩して、帰りに本屋寄って、そういえば決めたんだけどブログの名前は「灰色の実測」にする。夜は早く寝た。",
    expect: ["灰色の実測"],
    reject: ["散歩", "早く寝た"],
  },
  {
    id: "path-verbatim",
    material: "APIキーの置き場は .data/xai-auth.json に統一したから。",
    expect: [".data/xai-auth.json"],
    reject: [],
  },
  {
    id: "smalltalk-only",
    material: "今日はほんと暑いねー。",
    expect: [],
    reject: ["暑い"],
  },
]

interface CaseResult {
  readonly id: string
  readonly captured: string[]
  readonly missed: string[]
  readonly falsePositives: string[]
  readonly extras: string[]
  readonly fidelityViolations: string[]
  readonly saved: { slot: string; value: string; quote: string | null }[]
  readonly said: string
}

const bare = (s: string) => s.replace(/\s+/g, "")

async function runCase(fixture: Fixture): Promise<CaseResult> {
  // belief が fixture 間で混ざらないよう fixture ごとに runtime を分ける。
  const rt = ManagedRuntime.make(makeAppLayer(DbLive(":memory:"), RunnerLive))
  const run = <A, E>(e: Effect.Effect<A, E, AppServices>) => rt.runPromise(e)
  try {
    const eventId = await run(
      Effect.flatMap(Memory, (mem) =>
        mem.remember({ source: "owner", content: fixture.material, at: nowIso() }),
      ),
    )
    const said = await run(
      keep({
        material: fixture.material,
        evidence: [{ id: String(eventId), text: fixture.material }],
        signal: AbortSignal.timeout(60_000),
      }),
    )
    const saved = (await run(
      Effect.flatMap(Db, (db) =>
        db.all("SELECT belief_slot slot, content value, evidence_quote quote FROM events WHERE kind='belief'"),
      ),
    )) as { slot: string; value: string; quote: string | null }[]

    const haystack = saved.map((s) => `${s.slot} ${s.value} ${s.quote ?? ""}`).join("\n")
    const captured = fixture.expect.filter((k) => haystack.includes(k))
    const missed = fixture.expect.filter((k) => !haystack.includes(k))
    const falsePositives = fixture.reject.filter((k) => haystack.includes(k))
    const matchedAny = (s: { slot: string; value: string; quote: string | null }) =>
      [...fixture.expect, ...fixture.reject].some((k) => `${s.slot} ${s.value} ${s.quote ?? ""}`.includes(k))
    const extras = saved.filter((s) => !matchedAny(s)).map((s) => `${s.slot}=${s.value}`)
    const fidelityViolations = saved
      .filter((s) => s.quote !== null && !bare(fixture.material).includes(bare(String(s.quote))))
      .map((s) => `${s.slot}: ${s.quote}`)
    return { id: fixture.id, captured, missed, falsePositives, extras, fidelityViolations, saved, said }
  } finally {
    await rt.dispose()
  }
}

const runModel = async (model: string | undefined) => {
  // Runner は生の model id を拒否するので、役割表の中身を替えて比較する。
  if (model !== undefined) ROLE_MODEL.structurer = model
  const label = model ?? `${ROLE_MODEL.structurer}(ROLE_MODEL.structurer)`
  console.log(`\n== ${label} ==`)
  const results: CaseResult[] = []
  for (const fixture of FIXTURES) {
    const r = await runCase(fixture)
    results.push(r)
    console.log(
      `${r.id.padEnd(16)} capture ${r.captured.length}/${r.captured.length + r.missed.length}` +
        ` false+ ${r.falsePositives.length} 余剰 ${r.extras.length} 照合違反 ${r.fidelityViolations.length}`,
    )
  }
  const expectTotal = FIXTURES.reduce((a, f) => a + f.expect.length, 0)
  const captured = results.reduce((a, r) => a + r.captured.length, 0)
  const falsePositives = results.reduce((a, r) => a + r.falsePositives.length, 0)
  const violations = results.reduce((a, r) => a + r.fidelityViolations.length, 0)
  const summary = {
    at: new Date().toISOString(),
    // モデル名だけでは再現しないので harness・backend も残す。
    route: { harness: "famulus keeper", backend: "api.x.ai/v1 responses", model: label },
    rev: execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim(),
    cases: FIXTURES.length,
    capture: `${captured}/${expectTotal}`,
    falsePositives,
    fidelityViolations: violations,
    results,
  }
  const path = `${OUT}${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(
    `capture ${captured}/${expectTotal} / false+ ${falsePositives} / 照合違反 ${violations}\n保存: ${path}`,
  )
}

const main = async () => {
  loadEnv()
  configureApp()
  mkdirSync(OUT, { recursive: true })
  const models = process.argv.slice(2)
  for (const m of models.length === 0 ? [undefined] : models) await runModel(m)
}

await main()
