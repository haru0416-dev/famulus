/**
 * 実効 scope の交差。
 *
 * 委譲で渡せる権限は**交差で減るだけ**。子の要求が親を超える次元は親の値へ切り詰め、
 * 親に無い道具は子から落ちる。ここは純関数 — 授権の実体(道具の構築・統治)は呼ぶ側が持ち、
 * この関数は「超えられない」ことだけを保証する。
 */

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
  /** ここから先に委譲できる残り段数。0 なら葉 — さらに委譲はできない。 */
  readonly maxDelegationDepth: number
}

export class DelegationDenied extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "DelegationDenied"
  }
}

/**
 * 親 scope と子の要求から、子の実効 scope を作る。
 *
 * - budget: 次元ごとに min。親の残りを別勘定で渡したい場合も、ここを通した値しか渡せない。
 * - deadline: min。子が親より長く生きる形を作らない。
 * - tools: 交差。親に見えない道具は子にも見えない(Skill のヒントでも増えない)。
 * - depth: 親から1減らし、子の要求とで小さいほう。親が 0(葉)なら委譲そのものを拒否する。
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

/** 子が親を超えていないか。intersectScope を通した値なら常に真 — テストはその契約の回帰検査。 */
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
