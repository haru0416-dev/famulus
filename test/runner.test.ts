/**
 * Runner の検査。ゲートを通さずにモデルへ届く道が無いことを、実行本体を差し替えて確かめる。
 * Stub は precheck・枠の計上・会計の骨格を本番と共有しているので、ここで通る配線は本番でも同じ。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as Effect from "effect/Effect"
import {
  baseModel,
  binForModel,
  isWebModel,
  poolForModel,
  stripCitationMarkers,
} from "../src/model/claude-cli.ts"
import { needsResubmit } from "../src/model/language-model.ts"
import { ROLE_MODEL, Runner } from "../src/model/Runner.ts"
import { Db } from "../src/services/Db.ts"
import { Governance } from "../src/services/Governance.ts"
import { Ledger } from "../src/services/Ledger.ts"
import { withHarness } from "./helpers.ts"

test("run は結果を返し、role 付きで記録する(定額枠なので usd=0)", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          const r = yield* runner.run({ role: "dialogue", prompt: "こんにちは" })
          const t = yield* (yield* Ledger).today()
          const row = yield* (yield* Db).get("SELECT role, model, usd, unpriced FROM ledger")
          return { r, t, row }
        }),
      )
      assert.equal(out.r.text, "はい")
      assert.equal(out.r.model, ROLE_MODEL.dialogue)
      assert.equal(out.t.runs, 1)
      assert.equal(out.row?.role, "dialogue")
      assert.equal(out.row?.usd, 0)
      assert.equal(out.row?.unpriced, 0)
      assert.equal(h.calls.length, 1)
      assert.equal(h.calls[0]?.prompt, "こんにちは")
    },
    [{ text: "はい" }],
  )
})

test("halt が立っていると run はモデルに到達しない", async () => {
  await withHarness(
    async (h) => {
      const e = await h.fail(
        Effect.gen(function* () {
          yield* (yield* Governance).writeHalt("停止", "2026-08-08T09:00:00Z")
          const runner = yield* Runner
          yield* runner.run({ role: "dialogue", prompt: "走るな" })
        }),
      )
      assert.equal((e as { _tag: string })._tag, "Halt")
      // ここが 0 でないなら「ゲートを通さずに走れる道」が残っている。
      assert.equal(h.calls.length, 0)

      const t = await h.run(
        Effect.gen(function* () {
          return yield* (yield* Ledger).today()
        }),
      )
      assert.equal(t.runs, 0)
    },
    [{ text: "走ってはいけない" }],
  )
})

test("枠切れで失敗したら枠を冷やし、次の run は QuotaCooldown で止まる", async () => {
  await withHarness(
    async (h) => {
      const first = await h.fail(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({ role: "dialogue", prompt: "1回目" })
        }),
      )
      assert.equal((first as { _tag: string })._tag, "RunnerFailed")

      const second = await h.fail(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({ role: "dialogue", prompt: "2回目" })
        }),
      )
      // 閉じた窓を毎 run 叩き続けない。
      assert.equal((second as { _tag: string })._tag, "QuotaCooldown")
      assert.equal(h.calls.length, 1)
    },
    [{ text: "", fail: "usage limit reached", quota: { pool: "claude-max", window: "5h", exhausted: true } }],
  )
})

test("健全な枠シグナルは冷却を残さない", async () => {
  await withHarness(
    async (h) => {
      const left = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({ role: "scout", prompt: "要約" })
          return yield* (yield* Db).meta("quota:claude-max")
        }),
      )
      assert.equal(left, undefined)
    },
    [{ text: "要約した", quota: { pool: "claude-max", window: "5h", usedPercent: 30 } }],
  )
})

test("役割→モデルは静的表。未知の role は生のモデル id として通す", async () => {
  await withHarness(async (h) => {
    const plans = await h.run(
      Effect.gen(function* () {
        const runner = yield* Runner
        return {
          dialogue: runner.plan("dialogue"),
          scout: runner.plan("scout"),
          raw: runner.plan("claude-haiku-4-5"),
        }
      }),
    )
    assert.equal(plans.dialogue.model, "claude-opus-5")
    assert.equal(plans.scout.model, "gpt-5.6-luna")
    assert.equal(plans.raw.model, "claude-haiku-4-5")
    // 全経路が定額枠。ここが "usd" に化けたら従量課金に戻っている。
    assert.equal(plans.dialogue.meter, "quota")
    assert.equal(plans.scout.meter, "quota")
    assert.equal(plans.raw.meter, "quota")
    // 枠は別々に数える。同じ pool になっていると、作業を GPT に逃がしたのに対話が止まる。
    assert.equal(plans.dialogue.pool, "claude-max")
    assert.equal(plans.scout.pool, "chatgpt-rmod")
    assert.notEqual(plans.dialogue.pool, plans.scout.pool)
  })
})

/**
 * 混在 routing の要。実行ファイルと枠はモデルで決まる。
 * 環境変数1本で決めていた頃は、GPT に切り替えると対話まで rmod に乗った。
 */
test("モデルごとに実行ファイルと枠が分かれる", () => {
  const env = { OPEN_ZERO_CLAUDE_BIN: "/x/claude", OPEN_ZERO_RMOD_BIN: "/x/rmod", PATH: "" }

  assert.equal(binForModel("gpt-5.6-luna", undefined, env), "/x/rmod")
  assert.equal(binForModel("claude-opus-5", undefined, env), "/x/claude")

  assert.equal(poolForModel("gpt-5.6-luna"), "chatgpt-rmod")
  assert.equal(poolForModel("claude-opus-5"), "claude-max")
  // 未知のモデル id は Claude 側に倒す(rmod を勝手に噛ませない)。
  assert.equal(poolForModel("claude-haiku-4-5"), "claude-max")
})

/**
 * 外向きの経路。能力はモデル id が持つので、呼ぶ側にフラグが散らない。
 * 上流に `-web` のまま渡すと「不明なモデル」で落ちる — 目印はこちら側にだけ在る。
 */
test("`-web` は外に出られる目印で、上流には接尾辞を外して渡す", () => {
  assert.equal(isWebModel("gpt-5.6-luna-web"), true)
  assert.equal(isWebModel("gpt-5.6-luna"), false)
  assert.equal(baseModel("gpt-5.6-luna-web"), "gpt-5.6-luna")
  assert.equal(baseModel("gpt-5.6-luna"), "gpt-5.6-luna")
  // 枠は本体と同じ。外を見たかどうかで会計単位は変わらない。
  assert.equal(poolForModel("gpt-5.6-luna-web"), "chatgpt-rmod")
})

test("検索結果の引用マーカーを DB に持ち込まない", () => {
  // 実測した形: U+E200 で開き、U+E202 で区切り、U+E201 で閉じる。
  const raw = "最新版は 3.22.0 です。\ue200cite\ue202turn2search2\ue201 以上。"
  const clean = stripCitationMarkers(raw)
  assert.equal(clean, "最新版は 3.22.0 です。 以上。")
  assert.doesNotMatch(clean, /[\ue200-\ue2ff]/, "見えない文字が索引に混ざらないこと")
  // 閉じ忘れの片割れも残さない。
  assert.equal(stripCitationMarkers("a\ue200b"), "ab")
})

/**
 * ネイティブ呼び出しで弾かれた回だけ取り直す。
 * 文面では判定しない — 「ツールが使えない」と書いてあるかどうかで決めると、
 * 呼ぶ必要が無くてそう書いた回までやり直すことになる。見るのは CLI の tool_use_error だけ。
 */
test("弾かれて手ぶらのときだけ取り直す", () => {
  assert.equal(needsResubmit(true, true, 0), true)
  assert.equal(needsResubmit(true, true, 1), false)
  assert.equal(needsResubmit(true, false, 0), false)
  assert.equal(needsResubmit(true, undefined, 0), false)
  assert.equal(needsResubmit(false, true, 0), false)
})

/**
 * 精査役は書いた側と別の系列に置く(docs/adr/0031)。同じモデルの2回目は同じ死角を持つ。
 * 枠も分かれていること(RMOD_POOL)まで見る — 同じ pool に積むと、精査1回ぶん対話の枠が減る。
 */
test("精査役は対話と別のモデル・別の枠から出る", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          return { dialogue: runner.plan("dialogue"), reviewer: runner.plan("reviewer") }
        }),
      )
      assert.notEqual(out.reviewer.model, out.dialogue.model)
      assert.notEqual(out.reviewer.pool, out.dialogue.pool)
      assert.equal(out.reviewer.pool, poolForModel(ROLE_MODEL.reviewer))
    },
    [{ text: "" }],
  )
})
