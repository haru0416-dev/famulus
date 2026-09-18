/**
 * cycle が `FAMULUS_CYCLE_TIMEOUT_MS` で切られると `completeCycle` に届かず既読位置も冷却の起点も進まないので、
 * 残り時間を道具の返り値でモデルに渡す。process 単位の可変なのは、同時に走る cycle が1つで、
 * AI SDK の tool 実行へ締切を引数で渡していないため。
 */

/** 未設定は対話。 */
let deadlineAtMs: number | undefined

/** cycle が dispatch の直前に1回だけ呼ぶ。 */
export const startDeadline = (budgetMs: number): void => {
  deadlineAtMs = Date.now() + budgetMs
}

export const clearDeadline = (): void => {
  deadlineAtMs = undefined
}

export const remainingMs = (): number =>
  deadlineAtMs === undefined ? Number.POSITIVE_INFINITY : deadlineAtMs - Date.now()

export const remainingLabel = (): string => {
  const left = remainingMs()
  return Number.isFinite(left) ? `残り ${Math.max(0, Math.round(left / 1000))} 秒` : "締切なし"
}
