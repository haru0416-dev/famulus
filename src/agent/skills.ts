/**
 * 組み込み Skill の世代固定登録と SkillPlan の合成(.ward/plans/011 Phase A step 4)。
 *
 * Skill は**1枚の指示層**だけを持つ。道具・モデル・予算・権限・状態は持たない —
 * Skill を足して変わるのは指示だけで、authority は profile と scope の交差からしか出ない。
 * 合成はホスト側の規則(このファイル)で決まり、モデルにも Skill 本文にも決めさせない。
 *
 * 登録は明示選択のみ(routing は plan 011 Phase B で、曖昧な実例が出てから)。
 * スロットは method / presentation の2つまで。exclusive な Skill は単独で走る。
 */
import { canonicalJson, digestOf, type GenerationRef } from "../model/kernel-spec.ts"
import type { AgentProfileId } from "../model/profiles.ts"
import { DRAFTING } from "./drafting.ts"
import { DEEP_TEXT, WIDE_TEMPLATE } from "./explore.ts"

export type SkillSlot = "method" | "presentation"
export type SkillId = "research-wide" | "research-deep" | "draft-presentation"

export interface SkillDefinition {
  readonly id: SkillId
  readonly slot: SkillSlot
  /** exclusive は単独で走る。orthogonal だけが method+presentation の対になれる(ホスト分類)。 */
  readonly composition: "exclusive" | "orthogonal"
  readonly summary: string
  /** 指示の本文。パラメータは `{名前}` の placeholder — 埋めても Skill の世代は変わらない。 */
  readonly instructions: string
  readonly allowedProfiles: readonly AgentProfileId[]
}

export const SKILLS: Record<SkillId, SkillDefinition> = {
  "research-wide": {
    id: "research-wide",
    slot: "method",
    composition: "exclusive",
    summary: "条件を満たすものを目標件数まで列挙する",
    instructions: WIDE_TEMPLATE,
    allowedProfiles: ["researcher"],
  },
  "research-deep": {
    id: "research-deep",
    slot: "method",
    composition: "exclusive",
    summary: "対象1つを一次資料で検証する",
    instructions: DEEP_TEXT,
    allowedProfiles: ["researcher"],
  },
  "draft-presentation": {
    id: "draft-presentation",
    slot: "presentation",
    composition: "orthogonal",
    summary: "外に名前で出す文の規律(1本1話・実測のみ・形の閾値)",
    instructions: DRAFTING,
    allowedProfiles: ["interactive-parent", "autonomous-parent"],
  },
}

export const skillRef = (id: SkillId): GenerationRef => {
  const skill = SKILLS[id]
  const snapshot = canonicalJson({
    formatVersion: 1,
    id: skill.id,
    slot: skill.slot,
    composition: skill.composition,
    instructions: skill.instructions,
  })
  return { id: `skill:${id}`, generation: 1, digest: digestOf(snapshot), snapshot }
}

/** 合成規則そのものの世代。規則を変えたら generation を上げる — hash に混ざるので黙って変わらない。 */
export const COMPOSITION_POLICY: GenerationRef = (() => {
  const snapshot = canonicalJson({
    formatVersion: 1,
    maxSlots: 2,
    slots: ["method", "presentation"],
    pairing: "orthogonal-only",
    exclusiveRunsAlone: true,
  })
  return { id: "composition-policy:core", generation: 1, digest: digestOf(snapshot), snapshot }
})()

export interface SkillPlan {
  readonly method?: GenerationRef
  readonly presentation?: GenerationRef
  readonly compositionPolicy: GenerationRef
  readonly json: string
  readonly hash: string
}

export class SkillPlanRejected extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "SkillPlanRejected"
  }
}

/**
 * 明示選択から SkillPlan を作る。スロット不一致・profile 不許可・exclusive の同居は拒否。
 * 返る json/hash は canonical — 同じ選択は常に同じ hash になり、LoopSpec の同一性に載る。
 */
export function compileSkillPlan(input: {
  readonly profile: AgentProfileId
  readonly method?: SkillId
  readonly presentation?: SkillId
}): SkillPlan {
  const pick = (id: SkillId | undefined, slot: SkillSlot): SkillDefinition | undefined => {
    if (id === undefined) return undefined
    const skill = SKILLS[id]
    if (skill.slot !== slot) throw new SkillPlanRejected(`${id} は ${slot} スロットの Skill ではない`)
    if (!skill.allowedProfiles.includes(input.profile)) {
      throw new SkillPlanRejected(`${id} は profile ${input.profile} に許可されていない`)
    }
    return skill
  }
  const method = pick(input.method, "method")
  const presentation = pick(input.presentation, "presentation")
  if (
    method &&
    presentation &&
    (method.composition === "exclusive" || presentation.composition === "exclusive")
  ) {
    throw new SkillPlanRejected("exclusive な Skill は単独で走る(対にできるのは orthogonal どうしだけ)")
  }
  const methodRef = method ? skillRef(method.id) : undefined
  const presentationRef = presentation ? skillRef(presentation.id) : undefined
  const json = canonicalJson({
    formatVersion: 1,
    method: methodRef
      ? { id: methodRef.id, generation: methodRef.generation, digest: methodRef.digest }
      : null,
    presentation: presentationRef
      ? { id: presentationRef.id, generation: presentationRef.generation, digest: presentationRef.digest }
      : null,
    compositionPolicy: {
      id: COMPOSITION_POLICY.id,
      generation: COMPOSITION_POLICY.generation,
      digest: COMPOSITION_POLICY.digest,
    },
  })
  return {
    ...(methodRef ? { method: methodRef } : {}),
    ...(presentationRef ? { presentation: presentationRef } : {}),
    compositionPolicy: COMPOSITION_POLICY,
    json,
    hash: digestOf(json),
  }
}

/**
 * 合成済み計画から指示の重ねを描画する。順序は method → presentation(plan 011 の層順)。
 * パラメータは placeholder の置換だけ — 文面の追加はできない。
 */
export function renderSkillOverlay(
  plan: SkillPlan,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const render = (ref: GenerationRef | undefined): string | undefined => {
    if (!ref) return undefined
    const id = ref.id.replace(/^skill:/, "") as SkillId
    let text = SKILLS[id].instructions
    for (const [key, value] of Object.entries(params)) {
      text = text.replaceAll(`{${key}}`, String(value))
    }
    return text
  }
  return [render(plan.method), render(plan.presentation)].filter(Boolean).join("\n\n")
}
