import { createHash } from "node:crypto"
import { MODEL_IDS, poolForModel } from "./models.ts"
import type { RuntimeSchema } from "./schema.ts"

export interface GenerationRef {
  readonly id: string
  readonly generation: number
  readonly digest: string
  readonly snapshot: string
}

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalValue(item)]),
    )
  return value
}

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value))
export const digestOf = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex")

const generationRef = (id: string, generation: number, value: unknown): GenerationRef => {
  const snapshot = canonicalJson(value)
  return { id, generation, snapshot, digest: digestOf(snapshot) }
}

export const PROFILE_REFS: Readonly<Record<(typeof MODEL_IDS)[number], GenerationRef>> = Object.fromEntries(
  MODEL_IDS.map((model) => [
    model,
    generationRef(`model:${model}`, 1, {
      formatVersion: 1,
      model,
      pool: poolForModel(model),
      providerExternalIo: false,
      transportRetryVisibility: "explicit",
    }),
  ]),
) as Readonly<Record<(typeof MODEL_IDS)[number], GenerationRef>>

export const profileRefForModel = (model: string): GenerationRef => {
  const ref = PROFILE_REFS[model as keyof typeof PROFILE_REFS]
  if (!ref) throw new Error(`profileが無いmodel: ${model}`)
  return ref
}

export const ZERO_SKILL_PLAN = {
  formatVersion: 1,
  method: null,
  presentation: null,
  compositionPolicy: null,
} as const

export const ZERO_SKILL_PLAN_JSON = canonicalJson(ZERO_SKILL_PLAN)
export const ZERO_SKILL_PLAN_HASH = digestOf(ZERO_SKILL_PLAN_JSON)

export const NO_TOOL_POLICY = generationRef("core-tool-policy:none", 1, {
  formatVersion: 1,
  effectAtoms: [],
})

export const NO_TOOL_IMPLEMENTATION = generationRef("core-tool-implementation:none", 1, {
  formatVersion: 1,
  codeGeneration: "none",
  inputSchemaDigest: digestOf({}),
  outputSchemaDigest: digestOf({}),
})

export const resultContractRef = (id: string, schema: RuntimeSchema<unknown>): GenerationRef =>
  generationRef(`result-contract:${id}`, 1, { formatVersion: 1, jsonSchema: schema.jsonSchema })
