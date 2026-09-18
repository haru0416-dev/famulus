/** 委譲で渡せる権限は交差で減るだけ。純関数で、授権の実体は呼ぶ側が持つ。 */

export interface ScopeBudget {
  readonly modelCalls: number
  readonly toolCalls: number
  readonly tokens: number
  readonly costMicrousd: number
}

export interface EffectiveScope {
  readonly tools: readonly string[]
  readonly budget: ScopeBudget
  readonly deadlineAtMs: number
  /** 0 なら葉で、さらに委譲はできない。 */
  readonly maxDelegationDepth: number
}

export class DelegationDenied extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "DelegationDenied"
  }
}

/**
 * budget と deadline は min、tools は交差(Skill のヒントでも増えない)、depth は親から1減らした値と要求の小さいほう。
 * 親が 0(葉)なら委譲を拒否する。
 */
export function intersectScope(parent: EffectiveScope, request: Partial<EffectiveScope>): EffectiveScope {
  if (parent.maxDelegationDepth <= 0) {
    throw new DelegationDenied("葉のループは委譲できない(maxDelegationDepth = 0)")
  }
  const requestedTools = request.tools ?? parent.tools
  const budget = request.budget ?? parent.budget
  return {
    tools: requestedTools.filter((tool) => parent.tools.includes(tool)),
    budget: {
      modelCalls: Math.min(budget.modelCalls, parent.budget.modelCalls),
      toolCalls: Math.min(budget.toolCalls, parent.budget.toolCalls),
      tokens: Math.min(budget.tokens, parent.budget.tokens),
      costMicrousd: Math.min(budget.costMicrousd, parent.budget.costMicrousd),
    },
    deadlineAtMs: Math.min(request.deadlineAtMs ?? parent.deadlineAtMs, parent.deadlineAtMs),
    maxDelegationDepth: Math.min(
      request.maxDelegationDepth ?? parent.maxDelegationDepth - 1,
      parent.maxDelegationDepth - 1,
    ),
  }
}

/** intersectScope を通した値なら常に真。 */
export function withinScope(parent: EffectiveScope, child: EffectiveScope): boolean {
  return (
    child.tools.every((tool) => parent.tools.includes(tool)) &&
    child.budget.modelCalls <= parent.budget.modelCalls &&
    child.budget.toolCalls <= parent.budget.toolCalls &&
    child.budget.tokens <= parent.budget.tokens &&
    child.budget.costMicrousd <= parent.budget.costMicrousd &&
    child.deadlineAtMs <= parent.deadlineAtMs &&
    child.maxDelegationDepth < parent.maxDelegationDepth
  )
}
