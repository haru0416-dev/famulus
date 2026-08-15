/**
 * Runner の検査。ゲートを通さずにモデルへ届く道が無いことを、実行本体を差し替えて確かめる。
 * Stub は precheck・枠の計上・会計の骨格を本番と共有しているので、ここで通る配線は本番でも同じ。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as v from "valibot"
import { test } from "vitest"
import { parseCodexAuth, quotaFromHeaders } from "../src/model/codex-responses.ts"
import { PROFILE_REFS, profileRefForModel } from "../src/model/kernel-spec.ts"
import { assertKnownModel, poolForModel } from "../src/model/models.ts"
import { ROLE_MODEL, Runner, RunnerLive } from "../src/model/Runner.ts"
import { rs } from "../src/model/schema.ts"
import { makeAppLayer } from "../src/runtime.ts"
import { Db, DbLive } from "../src/services/Db.ts"
import { Governance } from "../src/services/Governance.ts"
import { Ledger } from "../src/services/Ledger.ts"
import { withHarness } from "./helpers.ts"

test("run は結果を返し、role 付きで記録する", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          const r = yield* runner.run({ role: "gpt-5.6-sol", kind: "run", prompt: "こんにちは" })
          const t = yield* (yield* Ledger).today()
          const row = yield* (yield* Db).get("SELECT role, model FROM ledger")
          return { r, t, row }
        }),
      )
      assert.equal(out.r.text, "はい")
      assert.equal(out.r.model, "gpt-5.6-sol")
      assert.equal(out.t.runs, 1)
      assert.equal(out.row?.role, "gpt-5.6-sol")
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
          yield* runner.run({ role: "gpt-5.6-sol", kind: "run", prompt: "走るな" })
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
          yield* runner.run({ role: "gpt-5.6-sol", kind: "run", prompt: "1回目" })
        }),
      )
      assert.equal((first as { _tag: string })._tag, "RunnerFailed")

      const second = await h.fail(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({ role: "gpt-5.6-sol", kind: "run", prompt: "2回目" })
        }),
      )
      // リセット前のクォータへ毎 run 再試行しない。
      assert.equal((second as { _tag: string })._tag, "QuotaCooldown")
      assert.equal(h.calls.length, 1)
    },
    [
      {
        text: "",
        fail: "usage limit reached",
        quota: { pool: "chatgpt-oauth", window: "5h", exhausted: true },
      },
    ],
  )
})

test("利用可能なクォータシグナルは再実行抑止を残さない", async () => {
  await withHarness(
    async (h) => {
      const left = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({ role: "scout", kind: "run", prompt: "要約" })
          return yield* (yield* Db).meta("quota:chatgpt-oauth")
        }),
      )
      assert.equal(left, undefined)
    },
    [{ text: "要約した", quota: { pool: "chatgpt-oauth", window: "5h", usedPercent: 30 } }],
  )
})

test("役割→モデルは静的表。role 名でなければモデル id そのものとして読む", async () => {
  await withHarness(async (h) => {
    const plans = await h.run(
      Effect.gen(function* () {
        const runner = yield* Runner
        return {
          dialogue: runner.plan("gpt-5.6-sol"),
          scout: runner.plan("scout"),
          raw: runner.plan("gpt-5.6-sol"),
        }
      }),
    )
    assert.equal(plans.dialogue.model, "gpt-5.6-sol")
    assert.equal(plans.scout.model, "gpt-5.6-luna")
    assert.equal(plans.raw.model, "gpt-5.6-sol")
    // modelは役割で分けるが、クォータは同じChatGPT OAuth枠に載る。
    assert.equal(plans.dialogue.pool, "chatgpt-oauth")
    assert.equal(plans.scout.pool, "chatgpt-oauth")
  })
})

test("production Runnerは任意model IDをprovider I/O前に拒否する", async () => {
  const rt = ManagedRuntime.make(makeAppLayer(DbLive(":memory:"), RunnerLive))
  try {
    await assert.rejects(
      () =>
        rt.runPromise(
          Effect.flatMap(Runner, (runner) =>
            runner.run({ role: "gpt-5.6-sol", kind: "raw-model", prompt: "呼ばない" }),
          ),
        ),
      /固定roleのみ/,
    )
    const rows = await rt.runPromise(Effect.flatMap(Db, (db) => db.all("SELECT id FROM ledger")))
    assert.deepEqual(rows, [])
  } finally {
    await rt.dispose()
  }
})

test("production roleの全modelに固定Profileがある", () => {
  for (const model of Object.values(ROLE_MODEL)) {
    assert.equal(profileRefForModel(model), PROFILE_REFS[model as keyof typeof PROFILE_REFS])
  }
})

/**
 * 混在 routing の要点。経路とクォータはモデルで決まる。
 * 環境変数1つで決めていた頃は、GPT に切り替えると対話まで別経路になった。
 */
test("全modelが同じChatGPT OAuthクォータに載る", () => {
  assert.equal(poolForModel("gpt-5.6-luna"), "chatgpt-oauth")
  assert.equal(poolForModel("gpt-5.6-sol"), "chatgpt-oauth")
})

/**
 * 知らない id は受け付けない。検査せずに通すと、実行を開始してから上流の「不明なモデル」で失敗する。
 * 入力元は env と役割表だけで、どちらも打ち間違えられる。
 */
test("知らないモデル id は経路を選ぶ前に失敗させる", async () => {
  assert.equal(assertKnownModel("gpt-5.6-luna"), "gpt-5.6-luna")
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
  const auth = parseCodexAuth(
    JSON.stringify({
      OPENAI_API_KEY: "sk-should-be-ignored",
      tokens: { access_token: "at", refresh_token: "rt", account_id: "acc" },
    }),
  )
  assert.equal(auth.accessToken, "at")
  assert.equal(auth.accountId, "acc")

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
  assert.equal(q?.pool, "chatgpt-oauth")
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
 * ネイティブ呼び出しが拒否された回だけ取り直す。
 * 文面では判定しない — 「ツールが使えない」と書いてあるかどうかで決めると、
 * 呼ぶ必要が無くてそう書いた回までやり直すことになる。見るのは CLI の tool_use_error だけ。
 */
/**
 * 精査役は書いた側と別の系列に置く。同じモデルの2回目は同じ死角を持つ。
 * クォータも分かれていること(CODEX_POOL)まで確認する — 同じ pool に記録すると、精査1回ぶん対話用クォータが減る。
 */
test("精査役は実測済みのsolに固定する", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          return runner.plan("reviewer")
        }),
      )
      assert.equal(out.model, "gpt-5.6-sol")
      assert.equal(out.pool, poolForModel(ROLE_MODEL.reviewer))
    },
    [{ text: "" }],
  )
})
