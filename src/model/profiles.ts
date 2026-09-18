/**
 * 直接モデルを持つ経路の全数登録。`AgentProfileId` に名前を足さないと `AGENT_PROFILES` が型で落ちるので、
 * 登録漏れの経路は増えない。授権はここから出ない(道具の実体と統治は各実装が持つ)。
 * 親道具の宣言と実体の一致は `buildTools()` の型検査で強制する。
 */
import { appConfig } from "../core/config.ts"
import { digestOf, type GenerationRef } from "./kernel-spec.ts"
import { ROLE_MODEL } from "./Runner.ts"

/** coordinator / synthesizer は複数枝の統合が入るまでの予約。 */
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
  /** 静的表(Runner)か設定のどちらか。LLM に選択と課金経路を開かない。 */
  readonly model: () => string
  /** 空 = 道具なし。ここに無い道具が見えたら分類漏れ。 */
  readonly tools: readonly string[]
}

/** assistant の登録キーはこの型に一致しなければならない。 */
export const PARENT_TOOLS = [
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
] as const

export type ParentToolName = (typeof PARENT_TOOLS)[number]

export const DELEGATED_TOOLS = ["search", "fetch"] as const
export type DelegatedToolName = (typeof DELEGATED_TOOLS)[number]

/** 委譲先の中でだけ見える道具(search / fetch)を含む。委譲の scope 交差はこの集合を親の tools として使う。 */
export const PARENT_AUTHORITY: readonly string[] = [...PARENT_TOOLS, ...DELEGATED_TOOLS]

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
    tools: DELEGATED_TOOLS,
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
    tools: DELEGATED_TOOLS,
  },
  // x_search はモデル呼び出しにローカル道具を渡さない(独立呼び出しに隔離。src/model/x-search.ts)。
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
 * モデル id は含めない。含めると設定変更のたびに全 profile の世代が変わる。
 * モデルの固定は kernel-spec の `profileRefForModel` が持つ。
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
