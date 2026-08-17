/**
 * Skill 登録と SkillPlan 合成の検査。
 * 合成はホストの規則で決まり、Skill を足しても指示以外(道具・権限)は変わらない。
 * kernel への固定は「同じ計画は同じ hash、違う計画は Conflict」を loop_specs の行で確かめる。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as v from "valibot"
import { test } from "vitest"
import { wideInstructions } from "../../src/agent/explore.ts"
import { compileSkillPlan, renderSkillOverlay, SkillPlanRejected, skillRef } from "../../src/agent/skills.ts"
import { profileRefForModel, resultContractRef } from "../../src/model/kernel-spec.ts"
import { rs } from "../../src/model/schema.ts"
import { Db } from "../../src/services/Db.ts"
import { ExecutionKernel } from "../../src/services/ExecutionKernel.ts"
import { withHarness } from "../helpers.ts"

test("SkillPlan の合成は決定的で、選択が変わると hash が変わる", () => {
  const a = compileSkillPlan({ profile: "researcher", method: "research-wide" })
  const b = compileSkillPlan({ profile: "researcher", method: "research-wide" })
  assert.equal(a.hash, b.hash)
  assert.notEqual(compileSkillPlan({ profile: "researcher", method: "research-deep" }).hash, a.hash)
  assert.equal(a.method?.id, "skill:research-wide")
})

test("スロット不一致・profile 不許可・exclusive の同居は拒否する", () => {
  // presentation スロットに method Skill
  assert.throws(
    () => compileSkillPlan({ profile: "researcher", presentation: "research-wide" as never }),
    SkillPlanRejected,
  )
  // researcher に presentation Skill(親専用)は許可されていない
  assert.throws(
    () => compileSkillPlan({ profile: "researcher", presentation: "draft-presentation" }),
    SkillPlanRejected,
  )
  // exclusive な method は presentation と同居できない
  assert.throws(
    () =>
      compileSkillPlan({
        profile: "autonomous-parent" as never,
        method: "research-wide",
        presentation: "draft-presentation",
      }),
    SkillPlanRejected,
  )
})

test("描画は placeholder 置換だけで、既存の wide 指示と一致する", () => {
  const plan = compileSkillPlan({ profile: "researcher", method: "research-wide" })
  assert.equal(renderSkillOverlay(plan, { targetCount: 12 }), wideInstructions(12))
  // パラメータを埋めても Skill の世代(digest)は変わらない
  assert.equal(skillRef("research-wide").digest, skillRef("research-wide").digest)
})

test("kernel は SkillPlan を LoopSpec に固定し、同じ計画は再入・違う計画は Conflict", async () => {
  await withHarness(async (h) => {
    const plan = compileSkillPlan({ profile: "researcher", method: "research-wide" })
    const base = {
      owner: { kind: "delegation", id: "evt:researcher:0" },
      stableSlot: "researcher",
      role: "worker",
      profile: profileRefForModel("grok-4.3"),
      resultContract: resultContractRef("delegate-text-v1", rs(v.string())),
      taskInput: { task: "t" },
      deadlineAtMs: Date.now() + 60_000,
      budget: { modelCalls: 2, toolCalls: 2, tokens: 10_000, costMicrousd: 1_000 },
      modelTokenAllowance: 10_000,
      modelCostAllowanceMicrousd: 1_000,
    } as const
    await h.run(
      Effect.flatMap(ExecutionKernel, (kernel) =>
        kernel.openSingleLoop({ ...base, skillPlan: { json: plan.json, hash: plan.hash } }),
      ),
    )
    const row = await h.run(
      Effect.flatMap(Db, (db) => db.get("SELECT skill_plan_json, skill_plan_hash FROM loop_specs")),
    )
    assert.equal(row?.skill_plan_json, plan.json)
    assert.equal(row?.skill_plan_hash, plan.hash)

    // 同じ owner・同じ計画 → 既存の loop に再入する(2本目を作らない)
    await h.run(
      Effect.flatMap(ExecutionKernel, (kernel) =>
        kernel.openSingleLoop({ ...base, skillPlan: { json: plan.json, hash: plan.hash } }),
      ),
    )
    const count = await h.run(Effect.flatMap(Db, (db) => db.get("SELECT COUNT(*)n FROM loop_specs")))
    assert.equal(Number(count?.n), 1)

    // 同じ owner・違う計画 → Conflict(黙って差し替えない)
    const other = compileSkillPlan({ profile: "researcher", method: "research-deep" })
    const error = await h.fail(
      Effect.flatMap(ExecutionKernel, (kernel) =>
        kernel.openSingleLoop({ ...base, skillPlan: { json: other.json, hash: other.hash } }),
      ),
    )
    assert.match(String((error as { message?: string }).message ?? error), /LoopSpec|Conflict|変わっている/)
  })
})
