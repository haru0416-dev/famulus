/**
 * Skill の世代固定登録と SkillPlan の合成。Skill が変えるのは指示だけで、道具・モデル・予算・権限は
 * 持たない(権限は profile と scope の交差から出る)。合成はこのファイルの規則で決め、
 * モデルにも Skill 本文にも決めさせない。選択は明示のみ。
 */
import { appConfig } from "../core/config.ts"
import { canonicalJson, digestOf, type GenerationRef } from "../model/kernel-spec.ts"
import type { AgentProfileId } from "../model/profiles.ts"
import { DRAFTING } from "./drafting.ts"
import { DEEP_TEXT, WIDE_TEMPLATE } from "./explore.ts"
import { type ImportedSkill, importSkillsFrom } from "./skill-import.ts"

export type SkillSlot = "method" | "presentation"
type SkillId = "research-wide" | "research-deep" | "draft-presentation"

export interface SkillDefinition {
  readonly id: string
  readonly slot: SkillSlot
  /** exclusive は単独で走る。orthogonal だけが method+presentation の対になれる。 */
  readonly composition: "exclusive" | "orthogonal"
  readonly summary: string
  /** パラメータは `{名前}` の placeholder。埋めても Skill の世代は変わらない。 */
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

/**
 * ここに無い取り込み skill は読み込まれても使えない。SKILL.md 自身の記述で権限やスロットは決まらない。
 * 分類を変えると SkillPlan の hash も変わる。
 */
export const IMPORTED_CLASSIFICATION: Record<
  string,
  { slot: SkillSlot; composition: "exclusive" | "orthogonal"; allowedProfiles: readonly AgentProfileId[] }
> = {
  // DRAFTING と重ねる前提なので orthogonal。
  "jissoku-writing": {
    slot: "presentation",
    composition: "orthogonal",
    allowedProfiles: ["interactive-parent", "autonomous-parent"],
  },
  "probspace-moves": {
    slot: "method",
    composition: "exclusive",
    allowedProfiles: ["interactive-parent", "autonomous-parent"],
  },
  "measuring-optimizations": {
    slot: "method",
    composition: "exclusive",
    allowedProfiles: ["interactive-parent", "autonomous-parent"],
  },
}

/** 起動時に1回読む。正本の書き換えはプロセス再起動で反映する。 */
let importedCache: { root: string; result: ReturnType<typeof importSkillsFrom> } | undefined

export function importedSkills(root: string = appConfig().paths.skills): ReturnType<typeof importSkillsFrom> {
  if (importedCache?.root !== root) importedCache = { root, result: importSkillsFrom(root) }
  return importedCache.result
}

const importedDefinition = (id: string, root?: string): SkillDefinition | undefined => {
  const classification = IMPORTED_CLASSIFICATION[id]
  if (!classification) return undefined
  const found: ImportedSkill | undefined = importedSkills(root).skills.find((s) => s.name === id)
  if (!found) return undefined
  return {
    id,
    slot: classification.slot,
    composition: classification.composition,
    summary: found.description.slice(0, 120),
    instructions: found.body,
    allowedProfiles: classification.allowedProfiles,
  }
}

export function resolveSkill(id: string, root?: string): SkillDefinition | undefined {
  return (SKILLS as Record<string, SkillDefinition>)[id] ?? importedDefinition(id, root)
}

export const skillRef = (id: string, root?: string): GenerationRef => {
  const skill = resolveSkill(id, root)
  if (!skill) throw new SkillPlanRejected(`${id} という skill は登録に無い(未分類の取り込みは使えない)`)
  const snapshot = canonicalJson({
    formatVersion: 1,
    id: skill.id,
    slot: skill.slot,
    composition: skill.composition,
    instructions: skill.instructions,
  })
  return { id: `skill:${id}`, generation: 1, digest: digestOf(snapshot), snapshot }
}

/** 合成規則を変えたら generation を上げる(SkillPlan の hash に入る)。 */
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

/** 同じ選択は常に同じ hash になる。LoopSpec の同一性判定に使われる。 */
export function compileSkillPlan(input: {
  readonly profile: AgentProfileId
  readonly method?: string
  readonly presentation?: string
}): SkillPlan {
  const pick = (id: string | undefined, slot: SkillSlot): SkillDefinition | undefined => {
    if (id === undefined) return undefined
    const skill = resolveSkill(id)
    if (!skill) throw new SkillPlanRejected(`${id} という skill は登録に無い(未分類の取り込みは使えない)`)
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

/** パラメータは placeholder の置換だけで、文面は足せない。 */
export function renderSkillOverlay(
  plan: SkillPlan,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const render = (ref: GenerationRef | undefined): string | undefined => {
    if (!ref) return undefined
    const id = ref.id.replace(/^skill:/, "")
    const skill = resolveSkill(id)
    if (!skill) throw new SkillPlanRejected(`${id} という skill は登録に無い(正本が消えたか未分類)`)
    let text = skill.instructions
    for (const [key, value] of Object.entries(params)) {
      text = text.replaceAll(`{${key}}`, String(value))
    }
    return text
  }
  return [render(plan.method), render(plan.presentation)].filter(Boolean).join("\n\n")
}
