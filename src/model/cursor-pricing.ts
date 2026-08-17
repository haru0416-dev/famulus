/**
 * Cursor モデル単価による概算コスト算出。coder の run を ledger に載せるときの notionalUsd を出す。
 *
 * 単価は変動が速いためコード内定数を真実にせず、**日付つきテーブル**として扱う。
 * 概算は input/output(+単価があれば cache read/write)。cache write 未公開のモデルは
 * その分を含まない下限見積もり。単価未登録モデルは undefined(黙って0円に数えない)。
 */

export interface ModelPrice {
  /** USD / 1Mトークン */
  readonly inputPerM: number
  readonly outputPerM: number
  /** 未指定なら概算に含めない(公開単価が無いものを発明しない) */
  readonly cacheReadPerM?: number
  readonly cacheWritePerM?: number
}

export interface PricingTable {
  /** この単価が有効と確認した日付(YYYY-MM-DD)。古さを可視化する。 */
  readonly asOf: string
  readonly source?: string
  /** キーはモデルID。Composer の fast 課金は `<model>:fast` の別キー。 */
  readonly models: Record<string, ModelPrice>
}

/** 鍵を刺したら `fam code --models` の実IDと公式単価で表を更新すること。 */
export const CURSOR_PRICING: PricingTable = {
  asOf: "2026-07-08",
  source: "https://cursor.com/docs/models-and-pricing",
  models: {
    // composer は cache read 単価のみ公開(write 未公開=その分は下限見積もり)
    "composer-2.5": { inputPerM: 0.5, outputPerM: 2.5, cacheReadPerM: 0.2 },
    // fast=true バリアントは二次情報で約6倍(公式は標準単価のみ公開)。上限側の参考値。
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

/** SDK の usage(unknown)を TokenUsage 形として安全に解釈する。 */
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

/** USD予算層の事前検査: このモデルの run が概算集計に乗るか(単価登録の有無)。 */
export function hasPricing(model: string, fast: boolean, table: PricingTable = CURSOR_PRICING): boolean {
  const key = fast ? `${model}:fast` : model
  return (table.models[key] ?? table.models[model]) !== undefined
}

/**
 * 1run の概算コスト(USD)。usage 欠落・単価未登録なら undefined(=不明。0ではない)。
 *
 * SDK の inputTokens は cache read/write **込み**の総入力(実測: reviewer 3run すべてで
 * input − cacheR − cacheW = 16トークン)。cache 分を差し引いた非キャッシュ入力のみを
 * input 単価で数え、cache 分は単価があるときだけ加算する。cache 分を input 単価でも
 * 数えると、cache 比率の高い run を最大3倍過大評価する。
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
