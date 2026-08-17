/**
 * 実行主体の全数登録と scope 交差の検査。
 *
 * - 登録(宣言)と assistant の実体が食い違ったら落ちる — 宣言だけ増える形も、
 *   経路だけ増える形も、ここで見える。
 * - provider-native の外部 I/O 道具が profile に紛れ込んだら落ちる。
 * - 委譲は交差で減るだけ — どの次元も親を超えられない。
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "vitest"
import { configureApp } from "../src/core/config.ts"
import { AGENT_PROFILES, agentProfileRef, PARENT_TOOLS } from "../src/model/profiles.ts"
import { DelegationDenied, type EffectiveScope, intersectScope, withinScope } from "../src/model/scope.ts"
import { registeredTools } from "./helpers.ts"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("親 profile の道具全数は assistant の登録と一致する", () => {
  const actual = registeredTools()
  // 子にだけ渡る道具(search / fetch は researcher・explore の中、recall は digger の中)を除くと親の全数。
  for (const name of PARENT_TOOLS) {
    assert.ok(actual.has(name), `profile が宣言する ${name} が assistant に無い`)
  }
  const children = new Set(["search", "fetch"])
  for (const name of actual) {
    if (children.has(name)) continue
    assert.ok(
      PARENT_TOOLS.includes(name),
      `assistant の ${name} が profile に未分類(未分類の道具は増やせない)`,
    )
  }
})

test("全 profile の道具はローカル実装の閉じた集合に収まり、provider-native が紛れない", () => {
  const local = new Set([...PARENT_TOOLS, "search", "fetch"])
  for (const profile of Object.values(AGENT_PROFILES)) {
    for (const tool of profile.tools) {
      assert.ok(local.has(tool), `${profile.id} の ${tool} はローカル道具ではない`)
    }
  }
  // 回帰網: provider 側で実行される道具名は、委譲先(worker / reviewer)のモデルに見えない。
  // 親の `x_search` はローカル道具名(実体は独立呼び出しへの隔離 — src/model/x-search.ts)なので対象外。
  for (const profile of Object.values(AGENT_PROFILES)) {
    if (profile.loopRole === "interactive" || profile.loopRole === "autonomous") continue
    for (const forbidden of ["web_search", "x_search", "code_interpreter", "file_search"]) {
      assert.ok(!profile.tools.includes(forbidden), `${profile.id} に provider 道具 ${forbidden}`)
    }
  }
})

test("モデル呼び出しの実装が provider 側 tools を注入しない(x-search の隔離だけが例外)", () => {
  // Responses の body に tools を積むのは x-search.ts だけ。xai-responses(全モデル呼び出しの実体)に
  // tools が現れたら、provider 実行の外部 I/O がモデル経路に入った可能性がある。
  const adapter = read("src/model/xai-responses.ts")
  assert.ok(
    !/\btools\s*:/.test(adapter),
    "xai-responses に tools 注入が現れた(provider 実行道具は使わない方針への違反の疑い)",
  )
  const xsearch = read("src/model/x-search.ts")
  assert.ok(/type: "x_search"/.test(xsearch), "x-search の隔離実装が変わった — 隔離の前提から確かめ直す")
})

test("profile 参照は世代固定で、道具の宣言が変わると digest が変わる", () => {
  const a = agentProfileRef("researcher")
  const b = agentProfileRef("researcher")
  assert.deepEqual(a, b)
  assert.notEqual(agentProfileRef("digger").digest, a.digest)
  assert.match(a.id, /^agent-profile:researcher$/)
})

const parent: EffectiveScope = {
  tools: ["search", "fetch", "recall"],
  budget: { modelCalls: 10, toolCalls: 20, tokens: 100_000, costMicrousd: 1_000_000 },
  deadlineAtMs: 1_000_000,
  maxDelegationDepth: 2,
}

test("委譲はどの次元も親を超えられない", () => {
  const child = intersectScope(parent, {
    tools: ["search", "shell"], // shell は親に無い → 落ちる
    budget: { modelCalls: 99, toolCalls: 5, tokens: 999_999_999, costMicrousd: 500 },
    deadlineAtMs: 2_000_000, // 親より遅い締切 → 親に切り詰め
    maxDelegationDepth: 9,
  })
  assert.deepEqual(child.tools, ["search"])
  assert.deepEqual(child.budget, { modelCalls: 10, toolCalls: 5, tokens: 100_000, costMicrousd: 500 })
  assert.equal(child.deadlineAtMs, 1_000_000)
  assert.equal(child.maxDelegationDepth, 1) // 親 2 → 子は最大 1
  assert.ok(withinScope(parent, child))
})

test("要求を省いた委譲も深さは必ず1減る", () => {
  const child = intersectScope(parent, {})
  assert.equal(child.maxDelegationDepth, 1)
  const grandchild = intersectScope(child, {})
  assert.equal(grandchild.maxDelegationDepth, 0)
  // 葉からの委譲は拒否 — 際限のない再委譲を型ではなく実行時にも塞ぐ。
  assert.throws(() => intersectScope(grandchild, {}), DelegationDenied)
})

test("profile ごとのモデル配線は既定 config で固定される", () => {
  configureApp({}, "/tmp/famulus-profiles")
  try {
    const actual = Object.fromEntries(Object.values(AGENT_PROFILES).map((p) => [p.id, p.model()]))
    assert.deepEqual(actual, {
      "interactive-parent": "grok-4.6",
      "autonomous-parent": "grok-4.6",
      researcher: "grok-4.3",
      digger: "grok-4.3",
      "explore-branch": "grok-4.3",
      "x-search": "grok-4.3",
      keeper: "grok-4.3",
      dream: "grok-4.3",
      scout: "grok-4.3",
      reviewer: "grok-4.6",
    })
  } finally {
    configureApp()
  }
})
