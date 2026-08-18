/**
 * 実行主体(直接モデルを持つ経路)の全数登録。
 *
 * 直接モデルを持つ経路を足すときは、まず `AgentProfileId` に名前を足さないと
 * `AGENT_PROFILES` の Record が型で落ちる — 登録漏れのまま経路だけ増える形を塞ぐ。
 *
 * ここに置くのは「その主体が何のループで、どのモデル系で、どの道具を見るか」の宣言だけ。
 * 授権はここからは出ない — 道具の実体と統治は今までどおり実装側にある(宣言と実体の一致は
 * test/profiles.test.ts が assistant のソースと突き合わせて確かめる)。
 */
import { appConfig } from "../core/config.ts"
import { digestOf, type GenerationRef } from "./kernel-spec.ts"
import { ROLE_MODEL } from "./Runner.ts"

/** ループの役割。coordinator / synthesizer は複数枝の統合が入るまでの予約。 */
export type LoopRole = "interactive" | "autonomous" | "coordinator" | "worker" | "reviewer" | "synthesizer"

export type AgentProfileId =
  | "interactive-parent"
  | "autonomous-parent"
  | "researcher"
  | "digger"
  | "explore-branch"
  | "x-search"
  | "keeper"
  | "dream"
  | "scout"
  | "reviewer"

export interface AgentProfile {
  readonly id: AgentProfileId
  readonly loopRole: LoopRole
  /** モデルの出所。静的表(Runner)か設定のどちらか — LLM に選択と課金経路を開かない。 */
  readonly model: () => string
  /**
   * この主体のモデルに見える道具名の全数。空 = 道具なし(素の構造化推論)。
   * ここに無い道具が見えたら分類漏れ(deny-by-default の前段)。
   */
  readonly tools: readonly string[]
}

/** 親(道具ループ)の道具全数。assistant の登録と一致することをテストが強制する。 */
export const PARENT_TOOLS: readonly string[] = [
  "recall",
  "researcher",
  "digger",
  "x_search",
  "remember",
  "belief",
  "propose",
  "record_pending_conclusion",
  "watch",
  "record_watch_run",
  "unwatch",
  "ask",
  "answer",
  "drop",
  "shell",
  "experiment",
  "workspaces",
  "tell",
  "draft",
  "stats",
  "chart",
  "diagram",
  "card",
  "calendar",
  "calendar_add",
  "gmail",
  "gmail_read",
  "budget",
  "confusion",
]

/**
 * 親の authority の上限。親のモデルに見える道具(PARENT_TOOLS)に加え、委譲先の中でだけ
 * 見える道具(search / fetch)を含む — 委譲の scope 交差はこの集合を親側の tools として使う。
 */
export const PARENT_AUTHORITY: readonly string[] = [...PARENT_TOOLS, "search", "fetch"]

export const AGENT_PROFILES: Record<AgentProfileId, AgentProfile> = {
  "interactive-parent": {
    id: "interactive-parent",
    loopRole: "interactive",
    model: () => appConfig().models.default,
    tools: PARENT_TOOLS,
  },
  "autonomous-parent": {
    id: "autonomous-parent",
    loopRole: "autonomous",
    model: () => appConfig().models.cycle,
    tools: PARENT_TOOLS,
  },
  researcher: {
    id: "researcher",
    loopRole: "worker",
    model: () => appConfig().models.research,
    tools: ["search", "fetch"],
  },
  digger: {
    id: "digger",
    loopRole: "worker",
    model: () => appConfig().models.work,
    tools: ["recall"],
  },
  "explore-branch": {
    id: "explore-branch",
    loopRole: "worker",
    model: () => appConfig().models.research,
    tools: ["search", "fetch"],
  },
  // x_search はモデル呼び出しにローカル道具を渡さない(サーバ側 x_search はモデル注入ではなく
  // 独立呼び出しの隔離 — src/model/x-search.ts の逸脱記録)。
  "x-search": {
    id: "x-search",
    loopRole: "worker",
    model: () => appConfig().models.research,
    tools: [],
  },
  keeper: { id: "keeper", loopRole: "worker", model: () => ROLE_MODEL.structurer, tools: [] },
  dream: { id: "dream", loopRole: "worker", model: () => ROLE_MODEL.structurer, tools: [] },
  scout: { id: "scout", loopRole: "worker", model: () => ROLE_MODEL.scout, tools: [] },
  reviewer: { id: "reviewer", loopRole: "reviewer", model: () => ROLE_MODEL.reviewer, tools: [] },
}

/**
 * generation-pinned な参照。モデル id は含めない — env で切り替わる値を含めると、
 * 設定変更のたびに全 profile の世代が変わる。モデルの固定は kernel-spec の
 * `profileRefForModel`(モデル単位)が持ち、両方が LoopSpec に載る。
 */
export const agentProfileRef = (id: AgentProfileId): GenerationRef => {
  const profile = AGENT_PROFILES[id]
  const snapshot = JSON.stringify({
    formatVersion: 1,
    id: profile.id,
    loopRole: profile.loopRole,
    tools: [...profile.tools],
  })
  return { id: `agent-profile:${id}`, generation: 1, digest: digestOf(snapshot), snapshot }
}
