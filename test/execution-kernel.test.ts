import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { test } from "vitest"
import { KEEPER_SCHEMA, keep } from "../src/agent/keeper.ts"
import { profileRefForModel, resultContractRef, ZERO_SKILL_PLAN_JSON } from "../src/model/kernel-spec.ts"
import { Runner } from "../src/model/Runner.ts"
import { Db, DbLive } from "../src/services/Db.ts"
import { ExecutionKernel } from "../src/services/ExecutionKernel.ts"
import { withHarness } from "./helpers.ts"

test("keeperのroot・loop・予約を作りmodel attemptをprovider実行前の境界で消費する", () =>
  withHarness(
    async (h) => {
      const result = await h.run(
        keep({
          material: "owner: 次の予約は9月です",
          executionOwner: { kind: "owner-event", id: "event-kernel-success" },
        }),
      )
      assert.match(result, /保存対象は無かった/)

      const rows = await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          return {
            roots: yield* db.all("SELECT owner_kind,owner_id,max_active_loops FROM execution_roots"),
            loops: yield* db.all("SELECT stable_slot,role,skill_plan_json FROM loop_specs"),
            attempts: yield* db.all("SELECT state,step_ordinal,attempt_ordinal FROM model_attempts"),
            reservations: yield* db.all(
              "SELECT kind,state,model_calls,tool_calls FROM budget_reservations ORDER BY kind",
            ),
            rootState: yield* db.get("SELECT status FROM execution_root_state"),
            loopAttempt: yield* db.get("SELECT state,fence,owner_start_ticks FROM loop_attempts"),
            ledger: yield* db.get(
              `SELECT l.role,l.model,l.model_attempt_id=m.id linked
                 FROM ledger l JOIN model_attempts m ON m.id=l.model_attempt_id`,
            ),
          }
        }),
      )
      assert.deepEqual(rows.roots, [
        { owner_kind: "owner-event", owner_id: "event-kernel-success", max_active_loops: 1 },
      ])
      assert.deepEqual(rows.loops, [
        { stable_slot: "keeper", role: "structurer", skill_plan_json: ZERO_SKILL_PLAN_JSON },
      ])
      assert.deepEqual(rows.attempts, [{ state: "succeeded", step_ordinal: 1, attempt_ordinal: 1 }])
      assert.deepEqual(rows.reservations, [
        { kind: "loop", state: "held", model_calls: 1, tool_calls: 0 },
        { kind: "model", state: "consumed", model_calls: 1, tool_calls: 0 },
        { kind: "root", state: "held", model_calls: 1, tool_calls: 0 },
      ])
      assert.deepEqual(rows.rootState, { status: "completed" })
      assert.equal(rows.loopAttempt?.state, "completed")
      assert.equal(rows.loopAttempt?.fence, 1)
      assert.match(String(rows.loopAttempt?.owner_start_ticks), /^\d+$/)
      assert.deepEqual(rows.ledger, { role: "structurer", model: "gpt-5.6-luna", linked: 1 })
    },
    [{ text: "", structured: { looked: "確認したが保存対象なし", values: [] } }],
  ))

test("provider結果が不明な失敗は予約をunknownのまま保持する", () =>
  withHarness(
    async (h) => {
      const result = await h.run(
        keep({
          material: "owner: 失敗経路",
          executionOwner: { kind: "owner-event", id: "event-kernel-unknown" },
        }),
      )
      assert.match(result, /呼べなかった/)
      const state = await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          return {
            attempt: yield* db.get("SELECT state FROM model_attempts"),
            reservation: yield* db.get(
              "SELECT state,consumed_tokens,consumed_cost_microusd FROM budget_reservations WHERE kind='model'",
            ),
            root: yield* db.get("SELECT status FROM execution_root_state"),
            ledger: yield* db.get("SELECT role,in_tok,out_tok,provenance FROM ledger"),
          }
        }),
      )
      assert.deepEqual(state.attempt, { state: "unknown" })
      assert.deepEqual(state.reservation, {
        state: "unknown",
        consumed_tokens: 100_000,
        consumed_cost_microusd: 5_000_000,
      })
      assert.deepEqual(state.root, { status: "failed" })
      assert.deepEqual(state.ledger, {
        role: "structurer",
        in_tok: 0,
        out_tok: 0,
        provenance: JSON.stringify({ outcome: "unknown", pool: "chatgpt-oauth" }),
      })
    },
    [{ text: "", fail: "provider disconnected" }],
  ))

test("同じownerのLoopSpec変更とimmutable root更新を拒否する", () =>
  withHarness(async (h) => {
    const base = {
      owner: { kind: "owner-event", id: "event-kernel-conflict" },
      stableSlot: "keeper",
      role: "structurer",
      profile: profileRefForModel("gpt-5.6-luna"),
      resultContract: resultContractRef("keeper-v1", KEEPER_SCHEMA),
      deadlineAtMs: Date.now() + 45_000,
      budget: { modelCalls: 1, toolCalls: 0, tokens: 100_000, costMicrousd: 5_000_000 },
      modelTokenAllowance: 100_000,
      modelCostAllowanceMicrousd: 5_000_000,
    } as const
    await h.run(
      Effect.flatMap(ExecutionKernel, (kernel) => kernel.openSingleLoop({ ...base, taskInput: { n: 1 } })),
    )
    const error = await h.fail(
      Effect.flatMap(ExecutionKernel, (kernel) => kernel.openSingleLoop({ ...base, taskInput: { n: 2 } })),
    )
    assert.equal((error as { _tag?: string })._tag, "DbFailed")
    await assert.rejects(() =>
      h.run(Effect.flatMap(Db, (db) => db.run("UPDATE execution_roots SET owner_id='x'"))),
    )
  }))

test("固定Profileと違うmodelはattempt作成前に拒否する", () =>
  withHarness(async (h) => {
    const context = await h.run(
      Effect.flatMap(ExecutionKernel, (kernel) =>
        kernel.openSingleLoop({
          owner: { kind: "test", id: "profile-mismatch" },
          stableSlot: "review",
          role: "reviewer",
          profile: profileRefForModel("gpt-5.6-luna"),
          resultContract: resultContractRef("keeper-v1", KEEPER_SCHEMA),
          taskInput: {},
          deadlineAtMs: Date.now() + 45_000,
          budget: { modelCalls: 1, toolCalls: 0, tokens: 1000, costMicrousd: 100_000 },
          modelTokenAllowance: 1000,
          modelCostAllowanceMicrousd: 100_000,
        }),
      ),
    )
    const error = await h.fail(
      Effect.flatMap(Runner, (runner) =>
        runner.run({ role: "reviewer", kind: "mismatch", prompt: "x", execution: context }),
      ),
    )
    assert.match(String((error as { message?: string }).message), /Profile/)
    assert.equal(h.calls.length, 0)
    assert.deepEqual(await h.run(Effect.flatMap(Db, (db) => db.all("SELECT id FROM model_attempts"))), [])
  }))

test("同じrequestだけ成功済みresponseを再利用し別requestはproviderへ送る", () =>
  withHarness(
    async (h) => {
      const context = await h.run(
        Effect.flatMap(ExecutionKernel, (kernel) =>
          kernel.openSingleLoop({
            owner: { kind: "test", id: "two-attempts" },
            stableSlot: "worker",
            role: "structurer",
            profile: profileRefForModel("gpt-5.6-luna"),
            resultContract: resultContractRef("keeper-v1", KEEPER_SCHEMA),
            taskInput: {},
            deadlineAtMs: Date.now() + 45_000,
            budget: { modelCalls: 2, toolCalls: 0, tokens: 1000, costMicrousd: 100_000 },
            modelTokenAllowance: 500,
            modelCostAllowanceMicrousd: 50_000,
          }),
        ),
      )
      const run = Effect.flatMap(Runner, (runner) =>
        runner.run({ role: "structurer", kind: "retry", prompt: "x", execution: context }),
      )
      const first = await h.run(run)
      const replay = await h.run(run)
      assert.equal(replay.text, first.text)
      assert.equal(h.calls.length, 1)
      const different = await h.run(
        Effect.flatMap(Runner, (runner) =>
          runner.run({ role: "structurer", kind: "retry", prompt: "y", execution: context }),
        ),
      )
      assert.notEqual(different.text, first.text)
      assert.equal(h.calls.length, 2)
      assert.deepEqual(
        await h.run(
          Effect.flatMap(Db, (db) =>
            db.all("SELECT attempt_ordinal,state FROM model_attempts ORDER BY attempt_ordinal"),
          ),
        ),
        [
          { attempt_ordinal: 1, state: "succeeded" },
          { attempt_ordinal: 2, state: "succeeded" },
        ],
      )
      assert.equal(
        Number(
          await h.run(Effect.flatMap(Db, (db) => db.get("SELECT COUNT(*) n FROM ledger"))).then((r) => r?.n),
        ),
        2,
      )
    },
    [{ text: "first" }, { text: "second" }],
  ))

test("予約超過でも実使用量を保存してattemptを終端化する", () =>
  withHarness(
    async (h) => {
      const context = await h.run(
        Effect.flatMap(ExecutionKernel, (kernel) =>
          kernel.openSingleLoop({
            owner: { kind: "test", id: "usage-overrun" },
            stableSlot: "worker",
            role: "structurer",
            profile: profileRefForModel("gpt-5.6-luna"),
            resultContract: resultContractRef("keeper-v1", KEEPER_SCHEMA),
            taskInput: {},
            deadlineAtMs: Date.now() + 45_000,
            budget: { modelCalls: 1, toolCalls: 0, tokens: 100, costMicrousd: 100_000 },
            modelTokenAllowance: 100,
            modelCostAllowanceMicrousd: 100_000,
          }),
        ),
      )
      const result = await h.run(
        Effect.flatMap(Runner, (runner) =>
          runner.run({ role: "structurer", kind: "overrun", prompt: "x", execution: context }),
        ),
      )
      assert.equal(result.text, "overrun")
      assert.deepEqual(
        await h.run(
          Effect.flatMap(Db, (db) =>
            db.get(
              `SELECT m.state,m.actual_tokens,m.actual_cost_microusd,b.state reservation_state,
                      b.consumed_tokens,b.consumed_cost_microusd
                 FROM model_attempts m JOIN budget_reservations b ON b.id=m.reservation_id`,
            ),
          ),
        ),
        {
          state: "succeeded",
          actual_tokens: 120,
          actual_cost_microusd: 1000,
          reservation_state: "unknown",
          consumed_tokens: 100,
          consumed_cost_microusd: 100_000,
        },
      )
    },
    [
      {
        text: "overrun",
        usage: { inTok: 100, outTok: 20, cacheRead: 0, cacheWrite: 0, notionalUsd: 0.001 },
      },
    ],
  ))

test("死亡確認できた旧incarnationだけを高いfenceで回復する", async () => {
  const root = mkdtempSync(join(tmpdir(), "oz-execution-recovery-"))
  const path = join(root, "open-zero.db")
  const first = {
    hostId: "host",
    bootId: "boot",
    pidNamespace: "pid:[1]",
    pid: 101,
    startTicks: "1001",
    hostname: "first",
  }
  const second = { ...first, pid: 202, startTicks: "2002", hostname: "second" }
  const input = {
    owner: { kind: "test", id: "recover-owner" },
    stableSlot: "keeper",
    role: "structurer",
    profile: profileRefForModel("gpt-5.6-luna"),
    resultContract: resultContractRef("keeper-v1", KEEPER_SCHEMA),
    taskInput: {},
    deadlineAtMs: Date.now() + 45_000,
    budget: { modelCalls: 1, toolCalls: 0, tokens: 1000, costMicrousd: 100_000 },
    modelTokenAllowance: 1000,
    modelCostAllowanceMicrousd: 100_000,
  } as const
  try {
    const firstRuntime = ManagedRuntime.make(
      Layer.provideMerge(ExecutionKernel.layerWith({ current: () => first }), DbLive(path)),
    )
    const original = await firstRuntime.runPromise(
      Effect.flatMap(ExecutionKernel, (kernel) => kernel.openSingleLoop(input)),
    )
    assert.equal(original.fence, 1)
    await firstRuntime.runPromise(
      Effect.flatMap(ExecutionKernel, (kernel) => kernel.startModelAttempt(original, "probe-request")),
    )
    await firstRuntime.dispose()

    const secondRuntime = ManagedRuntime.make(
      Layer.provideMerge(
        ExecutionKernel.layerWith({
          current: () => second,
          liveness: () => ({ kind: "dead", proof: "start-mismatch" }),
        }),
        DbLive(path),
      ),
    )
    const recovered = await secondRuntime.runPromise(
      Effect.flatMap(ExecutionKernel, (kernel) => kernel.openSingleLoop(input)),
    )
    assert.equal(recovered.fence, 2)
    assert.equal(recovered.incarnation.pid, second.pid)
    const reopened = await secondRuntime.runPromise(
      Effect.flatMap(ExecutionKernel, (kernel) => kernel.openSingleLoop(input)),
    )
    assert.equal(reopened.fence, 2)
    assert.deepEqual(
      await secondRuntime.runPromise(
        Effect.flatMap(Db, (db) => db.all("SELECT ordinal,state,fence FROM loop_attempts ORDER BY ordinal")),
      ),
      [
        { ordinal: 1, state: "unknown", fence: 1 },
        { ordinal: 2, state: "active", fence: 2 },
      ],
    )
    assert.deepEqual(
      await secondRuntime.runPromise(
        Effect.flatMap(Db, (db) =>
          db.get(
            `SELECT m.state model_state,b.state reservation_state,b.consumed_tokens,b.consumed_cost_microusd
               FROM model_attempts m JOIN budget_reservations b ON b.id=m.reservation_id`,
          ),
        ),
      ),
      {
        model_state: "unknown",
        reservation_state: "unknown",
        consumed_tokens: 1000,
        consumed_cost_microusd: 100_000,
      },
    )
    assert.deepEqual(
      await secondRuntime.runPromise(
        Effect.flatMap(Db, (db) =>
          db.get(
            `SELECT l.kind,l.role,l.model,l.provenance
               FROM ledger l JOIN model_attempts m ON m.id=l.model_attempt_id
              WHERE m.state='unknown'`,
          ),
        ),
      ),
      {
        kind: "recovered-model-attempt",
        role: "structurer",
        model: "gpt-5.6-luna",
        provenance: JSON.stringify({ outcome: "unknown", recovered: true }),
      },
    )
    await secondRuntime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
