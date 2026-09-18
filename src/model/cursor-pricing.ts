/**
 * coder の run を ledger に載せるときの notionalUsd。単価未登録モデルは undefined(黙って0に数えない)。
 * cache write 単価が未公開のモデルはその分を含まない下限見積もり。
 */

export interface ModelPrice {
  /** USD / 1Mトークン */
  readonly inputPerM: number
  readonly outputPerM: number
  /** 公開単価が無いものは発明しない。 */
  readonly cacheReadPerM?: number
  readonly cacheWritePerM?: number
}

export interface PricingTable {
  /** この単価を確認した日付(YYYY-MM-DD)。 */
  readonly asOf: string
  readonly source?: string
  /** Composer の fast 課金は `<model>:fast` の別キー。 */
  readonly models: Record<string, ModelPrice>
}

/** API キーを設定したら `fam code --models` の実IDと公式単価で表を更新すること。 */
export const CURSOR_PRICING: PricingTable = {
  asOf: "2026-07-08",
  source: "https://cursor.com/docs/models-and-pricing",
  models: {
    // cache read 単価のみ公開(write 分は下限見積もり)
    "composer-2.5": { inputPerM: 0.5, outputPerM: 2.5, cacheReadPerM: 0.2 },
    // 公式単価は非公開。標準の約6倍として高めに見積もった参考値。
    "composer-2.5:fast": { inputPerM: 3, outputPerM: 15 },
    "claude-fable-5": { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
    "claude-sonnet-5": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
    "claude-opus-4-8": { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
    "grok-4.5": { inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5 },
    "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
  },
}

export interface CursorUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export function parseUsage(usage: unknown): CursorUsage | undefined {
  if (usage === null || typeof usage !== "object") return undefined
  const u = usage as Record<string, unknown>
  if (typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number") return undefined
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...(typeof u.cacheReadTokens === "number" ? { cacheReadTokens: u.cacheReadTokens } : {}),
    ...(typeof u.cacheWriteTokens === "number" ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
  }
}

export function hasPricing(model: string, fast: boolean, table: PricingTable = CURSOR_PRICING): boolean {
  const key = fast ? `${model}:fast` : model
  return (table.models[key] ?? table.models[model]) !== undefined
}

/**
 * usage 欠落・単価未登録なら undefined(0 ではない)。SDK の inputTokens は cache read/write 込みなので、
 * 差し引いた非キャッシュ入力だけを input 単価で数え、cache 分は単価があるときだけ足す。
 */
export function estimateRunCostUSD(
  run: { model: string; fast?: boolean; usage: unknown },
  table: PricingTable = CURSOR_PRICING,
): number | undefined {
  const usage = parseUsage(run.usage)
  if (!usage) return undefined
  const key = run.fast ? `${run.model}:fast` : run.model
  const price = table.models[key] ?? table.models[run.model]
  if (!price) return undefined
  const cacheR = usage.cacheReadTokens ?? 0
  const cacheW = usage.cacheWriteTokens ?? 0
  const uncachedInput = Math.max(0, usage.inputTokens - cacheR - cacheW)
  let usd = (uncachedInput / 1e6) * price.inputPerM + (usage.outputTokens / 1e6) * price.outputPerM
  if (price.cacheReadPerM !== undefined && cacheR) usd += (cacheR / 1e6) * price.cacheReadPerM
  if (price.cacheWritePerM !== undefined && cacheW) usd += (cacheW / 1e6) * price.cacheWritePerM
  return usd
}
