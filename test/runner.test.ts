/**
 * Runner の検査。ゲートを通さずにモデルへ届く道が無いことを、実行本体を差し替えて確かめる。
 * Stub は precheck・枠の計上・会計の骨格を本番と共有しているので、ここで通る配線は本番でも同じ。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as v from "valibot"
import { test } from "vitest"
import { callClaude } from "../src/model/claude-cli.ts"
import { parseCodexAuth, quotaFromHeaders } from "../src/model/codex-responses.ts"
import { needsResubmit, TOOL_PROTOCOL_SCHEMA } from "../src/model/language-model.ts"
import {
  assertKnownModel,
  baseModel,
  isWebModel,
  poolForModel,
  stripCitationMarkers,
} from "../src/model/models.ts"
import { ROLE_MODEL, Runner } from "../src/model/Runner.ts"
import { rs } from "../src/model/schema.ts"
import { Db } from "../src/services/Db.ts"
import { Governance } from "../src/services/Governance.ts"
import { Ledger } from "../src/services/Ledger.ts"
import { withHarness } from "./helpers.ts"

test("run は結果を返し、role 付きで記録する", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          const r = yield* runner.run({ role: "claude-opus-5", kind: "run", prompt: "こんにちは" })
          const t = yield* (yield* Ledger).today()
          const row = yield* (yield* Db).get("SELECT role, model FROM ledger")
          return { r, t, row }
        }),
      )
      assert.equal(out.r.text, "はい")
      assert.equal(out.r.model, "claude-opus-5")
      assert.equal(out.t.runs, 1)
      assert.equal(out.row?.role, "claude-opus-5")
      assert.equal(h.calls.length, 1)
      assert.equal(h.calls[0]?.prompt, "こんにちは")
    },
    [{ text: "はい" }],
  )
})

test("構造化応答が schema に合わなければ失敗として返す", async () => {
  await withHarness(
    async (h) => {
      const error = await h.fail(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({
            role: "scout",
            kind: "run",
            prompt: "判定して",
            schema: rs(v.object({ ok: v.boolean() })),
          })
        }),
      )
      assert.equal((error as { _tag?: string })._tag, "RunnerFailed")
      assert.match(String((error as { message?: string }).message), /schema に合わない/)
      assert.equal(h.calls.length, 1)
    },
    [{ text: "", structured: { ok: "yes" } }],
  )
})

test("halt が立っていると run はモデルに到達しない", async () => {
  await withHarness(
    async (h) => {
      const e = await h.fail(
        Effect.gen(function* () {
          yield* (yield* Governance).writeHalt("停止", "2026-08-08T09:00:00Z")
          const runner = yield* Runner
          yield* runner.run({ role: "claude-opus-5", kind: "run", prompt: "走るな" })
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

test("クォータ枯渇後はリセット時刻まで再実行を抑止する", async () => {
  await withHarness(
    async (h) => {
      const first = await h.fail(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({ role: "claude-opus-5", kind: "run", prompt: "1回目" })
        }),
      )
      assert.equal((first as { _tag: string })._tag, "RunnerFailed")

      const second = await h.fail(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({ role: "claude-opus-5", kind: "run", prompt: "2回目" })
        }),
      )
      // リセット前のクォータへ毎 run 再試行しない。
      assert.equal((second as { _tag: string })._tag, "QuotaCooldown")
      assert.equal(h.calls.length, 1)
    },
    [{ text: "", fail: "usage limit reached", quota: { pool: "claude-max", window: "5h", exhausted: true } }],
  )
})

test("利用可能なクォータシグナルは再実行抑止を残さない", async () => {
  await withHarness(
    async (h) => {
      const left = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({ role: "scout", kind: "run", prompt: "要約" })
          return yield* (yield* Db).meta("quota:claude-max")
        }),
      )
      assert.equal(left, undefined)
    },
    [{ text: "要約した", quota: { pool: "claude-max", window: "5h", usedPercent: 30 } }],
  )
})

test("役割→モデルは静的表。role 名でなければモデル id そのものとして読む", async () => {
  await withHarness(async (h) => {
    const plans = await h.run(
      Effect.gen(function* () {
        const runner = yield* Runner
        return {
          dialogue: runner.plan("claude-opus-5"),
          scout: runner.plan("scout"),
          raw: runner.plan("claude-haiku-4-5"),
        }
      }),
    )
    assert.equal(plans.dialogue.model, "claude-opus-5")
    assert.equal(plans.scout.model, "gpt-5.6-luna")
    assert.equal(plans.raw.model, "claude-haiku-4-5")
    // クォータは別々に数える。同じ pool になっていると、作業を GPT に振り分けても対話が止まる。
    assert.equal(plans.dialogue.pool, "claude-max")
    assert.equal(plans.scout.pool, "chatgpt-rmod")
    assert.notEqual(plans.dialogue.pool, plans.scout.pool)
  })
})

/**
 * 混在 routing の要点。経路とクォータはモデルで決まる。
 * 環境変数1つで決めていた頃は、GPT に切り替えると対話まで別経路になった。
 */
test("モデルごとに経路とクォータが分かれる", async () => {
  // GPT は `claude -p` 側へ行かない。行くと Claude のサブスクで GPT を呼ぶことになり、上流で失敗する。
  await assert.rejects(
    () => callClaude({ prompt: "x", model: "gpt-5.6-luna" }),
    /codex-responses/,
    "GPT が Claude CLI 経路に入らないこと",
  )

  assert.equal(poolForModel("gpt-5.6-luna"), "chatgpt-rmod")
  assert.equal(poolForModel("claude-opus-5"), "claude-max")
  assert.equal(poolForModel("claude-haiku-4-5"), "claude-max")
})

/**
 * 知らない id は受け付けない。検査せずに通すと、実行を開始してから上流の「不明なモデル」で失敗する。
 * 入力元は env と役割表だけで、どちらも打ち間違えられる。
 */
test("知らないモデル id は経路を選ぶ前に失敗させる", async () => {
  assert.equal(assertKnownModel("gpt-5.6-luna-web"), "gpt-5.6-luna-web")
  assert.throws(() => assertKnownModel("gpt-5.6-lunar"), /知らないモデル id/)
  assert.throws(() => assertKnownModel("claude-opus-4"), /知らないモデル id/)
  assert.throws(() => assertKnownModel(""), /知らないモデル id/)

  // Runner の plan も同じ検査を通る(role 名として解釈できないものは id そのものとして読まれる)。
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const runner = yield* Runner
        assert.throws(() => runner.plan("gpt-5.6-lunar"), /知らないモデル id/)
        assert.equal(runner.plan("scout").model, "gpt-5.6-luna")
      }),
    )
  })
})

/**
 * Codex の資格情報。API キーは受け付けない — 受け付けると定額クォータのつもりで従量課金になる。
 */
test("auth.json から ChatGPT の OAuth トークンだけを読む", () => {
  const id = `x.${Buffer.from(JSON.stringify({ aud: "app_ABC" })).toString("base64url")}.y`
  const auth = parseCodexAuth(
    JSON.stringify({
      OPENAI_API_KEY: "sk-should-be-ignored",
      tokens: { access_token: "at", id_token: id, refresh_token: "rt", account_id: "acc" },
    }),
  )
  assert.equal(auth.accessToken, "at")
  assert.equal(auth.accountId, "acc")
  assert.equal(auth.refreshToken, "rt")
  // client_id は欄として保存されていない。id_token の aud にだけ含まれる。
  assert.equal(auth.clientId, "app_ABC")

  assert.throws(() => parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-x" })), /codex login/)
  assert.throws(() => parseCodexAuth("{"), /JSON/)
})

/**
 * クォータは応答ヘッダから読む。Governance は pool ごとに1つしか持てないので、
 * 先に上限へ達する(使用率の高い)窓を渡す。使用率の低いほうを渡すと、上限に達していても呼び続ける。
 */
test("Codex の応答ヘッダから使用率の高い窓を読む", () => {
  const now = 1_000_000
  const q = quotaFromHeaders(
    {
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-after-seconds": "600",
      "x-codex-secondary-used-percent": "80",
      "x-codex-secondary-window-minutes": "300",
      "x-codex-secondary-reset-after-seconds": "60",
    },
    now,
  )
  assert.equal(q?.pool, "chatgpt-rmod")
  assert.equal(q?.window, "300m")
  assert.equal(q?.usedPercent, 80)
  assert.equal(q?.resetsAtMs, now + 60_000)
  assert.equal(q?.exhausted, false)

  // 窓の長さが 0 のものは契約で使われていない。読むと使用率 0% として選ばれてしまう。
  const zero = quotaFromHeaders(
    {
      "x-codex-primary-used-percent": "40",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-secondary-used-percent": "0",
      "x-codex-secondary-window-minutes": "0",
    },
    now,
  )
  assert.equal(zero?.window, "10080m")
  assert.equal(zero?.usedPercent, 40)

  // ヘッダが無い応答では undefined を返す(前の状態を上書きしない)。
  assert.equal(quotaFromHeaders({}, now), undefined)
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
  // クォータは本体と同じ。外を見たかどうかで会計単位は変わらない。
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
 * ネイティブ呼び出しが拒否された回だけ取り直す。
 * 文面では判定しない — 「ツールが使えない」と書いてあるかどうかで決めると、
 * 呼ぶ必要が無くてそう書いた回までやり直すことになる。見るのは CLI の tool_use_error だけ。
 */
test("ネイティブツール呼び出しが拒否され、提出が0件のときだけ再提出する", () => {
  assert.equal(needsResubmit(true, true, 0), true)
  assert.equal(needsResubmit(true, true, 1), false)
  assert.equal(needsResubmit(true, false, 0), false)
  assert.equal(needsResubmit(true, undefined, 0), false)
  assert.equal(needsResubmit(false, true, 0), false)
})

test("ツール提出中の text は利用者向け経過を書かせない", () => {
  const text = TOOL_PROTOCOL_SCHEMA.properties.text
  assert.match(text.description, /途中.*空文字/)
})

/**
 * 精査役は書いた側と別の系列に置く。同じモデルの2回目は同じ死角を持つ。
 * クォータも分かれていること(CODEX_POOL)まで確認する — 同じ pool に記録すると、精査1回ぶん対話用クォータが減る。
 */
test("精査役は対話と別のモデル・別の枠から出る", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          return { dialogue: runner.plan("claude-opus-5"), reviewer: runner.plan("reviewer") }
        }),
      )
      assert.notEqual(out.reviewer.model, out.dialogue.model)
      assert.notEqual(out.reviewer.pool, out.dialogue.pool)
      assert.equal(out.reviewer.pool, poolForModel(ROLE_MODEL.reviewer))
    },
    [{ text: "" }],
  )
})
