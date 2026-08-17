/**
 * Runner の検査。ゲートを通さずにモデルへ届く道が無いことを、実行本体を差し替えて確かめる。
 * Stub は precheck・枠の計上・会計の主要な経路を本番と共有しているので、ここで通る配線は本番でも同じ。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as v from "valibot"
import { test } from "vitest"
import { PROFILE_REFS, profileRefForModel } from "../../src/model/kernel-spec.ts"
import { assertKnownModel, poolForModel } from "../../src/model/models.ts"
import { ROLE_MODEL, Runner, RunnerLive } from "../../src/model/Runner.ts"
import { rs } from "../../src/model/schema.ts"
import { makeAppLayer } from "../../src/runtime.ts"
import { Db, DbLive } from "../../src/services/Db.ts"
import { Governance } from "../../src/services/Governance.ts"
import { Ledger } from "../../src/services/Ledger.ts"
import { withHarness } from "../helpers.ts"

test("run は結果を返し、role 付きで記録する", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const runner = yield* Runner
          const r = yield* runner.run({ role: "grok-4.6", kind: "run", prompt: "こんにちは" })
          const t = yield* (yield* Ledger).today()
          const row = yield* (yield* Db).get("SELECT role, model FROM ledger")
          return { r, t, row }
        }),
      )
      assert.equal(out.r.text, "はい")
      assert.equal(out.r.model, "grok-4.6")
      assert.equal(out.t.runs, 1)
      assert.equal(out.row?.role, "grok-4.6")
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
          yield* runner.run({ role: "grok-4.6", kind: "run", prompt: "走るな" })
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
          yield* runner.run({ role: "grok-4.6", kind: "run", prompt: "1回目" })
        }),
      )
      assert.equal((first as { _tag: string })._tag, "RunnerFailed")

      const second = await h.fail(
        Effect.gen(function* () {
          const runner = yield* Runner
          yield* runner.run({ role: "grok-4.6", kind: "run", prompt: "2回目" })
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
        quota: { pool: "supergrok-oauth", window: "5h", exhausted: true },
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
          return yield* (yield* Db).meta("quota:supergrok-oauth")
        }),
      )
      assert.equal(left, undefined)
    },
    [{ text: "要約した", quota: { pool: "supergrok-oauth", window: "5h", usedPercent: 30 } }],
  )
})

test("全roleを静的表でモデルへ解決し、生のmodel idも受け付ける", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const runner = yield* Runner
        for (const [role, model] of Object.entries(ROLE_MODEL)) {
          const plan = runner.plan(role)
          assert.equal(plan.model, model, role)
          assert.equal(plan.pool, poolForModel(model), role)
        }
        const raw = runner.plan("grok-4.6")
        assert.equal(raw.model, "grok-4.6")
        assert.equal(raw.pool, "supergrok-oauth")
      }),
    )
  })
})

test("production Runnerは任意model IDをprovider I/O前に拒否する", async () => {
  const rt = ManagedRuntime.make(makeAppLayer(DbLive(":memory:"), RunnerLive))
  try {
    await assert.rejects(
      () =>
        rt.runPromise(
          Effect.flatMap(Runner, (runner) =>
            runner.run({ role: "grok-4.6", kind: "raw-model", prompt: "呼ばない" }),
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
test("全modelが同じSuperGrokクォータに載る", () => {
  assert.equal(poolForModel("grok-4.3"), "supergrok-oauth")
  assert.equal(poolForModel("grok-4.6"), "supergrok-oauth")
})

/**
 * 知らない id は受け付けない。検査せずに通すと、実行を開始してから上流の「不明なモデル」で失敗する。
 * 入力元は env と役割表だけで、どちらも打ち間違えられる。
 */
test("知らないモデル id は経路を選ぶ前に失敗させる", async () => {
  assert.equal(assertKnownModel("grok-4.3"), "grok-4.3")
  assert.throws(() => assertKnownModel("grok-9.9"), /知らないモデル id/)
  assert.throws(() => assertKnownModel("claude-opus-4"), /知らないモデル id/)
  assert.throws(() => assertKnownModel(""), /知らないモデル id/)

  // Runner の plan も同じ検査を通る(role 名として解釈できないものは id そのものとして読まれる)。
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const runner = yield* Runner
        assert.throws(() => runner.plan("grok-9.9"), /知らないモデル id/)
        assert.equal(runner.plan("scout").model, "grok-4.3")
      }),
    )
  })
})
