/**
 * この回に使える残り時間を、道具の側から見えるところに置く。
 *
 * cycle は `FAMULUS_CYCLE_TIMEOUT_MS`(現在の既定は7分)で切られる。切られるとその回は丸ごと落ちて、
 * `completeCycle` に辿り着かないので既読位置も冷却の起点も進まない。次のタイマーが同じ理由で
 * また起きて、持ち時間を使って、また落ちる。冷却は「実際に動いた」記録を起点に数えるので、
 * 落ち続けるかぎり後退が一度も掛からない。
 *
 * 実際に、走行は9回とも数秒で終わって記録も残っていたのに、
 * 止めどきだけが判断されなかった。モデル側に残り時間を知る手立てが無かったから。
 *
 * だから時計を渡す。プロンプトに「数分で切られる」と書くだけでは足りない —
 * 書いてあるのは起動時の話で、9 回目を走らせるかどうかを決める時点では既に過去の文になっている。
 *
 * process 単位の可変にしてあるのは、1プロセスで同時に走る cycle が1つだけで、
 * AI SDK の tool 実行へ締切を個別引数として渡していないため。
 */

/** 締切(epoch ms)。未設定なら締切なし = 対話。 */
let deadlineAtMs: number | undefined

/** この回の持ち時間を宣言する。cycle が dispatch の直前に1回だけ呼ぶ。 */
export const startDeadline = (budgetMs: number): void => {
  deadlineAtMs = Date.now() + budgetMs
}

/** 締切を外す。対話(`bun run agent` / `fam`)は時間で切られないので、既定はこちら。 */
export const clearDeadline = (): void => {
  deadlineAtMs = undefined
}

/** 残り時間(ms)。締切が無ければ `Infinity` — 呼ぶ側で場合分けを書かずに済ませるため。 */
export const remainingMs = (): number =>
  deadlineAtMs === undefined ? Number.POSITIVE_INFINITY : deadlineAtMs - Date.now()

/** 残り時間の日本語表記。`Infinity` は「締切なし」。道具の返り値に添える。 */
export const remainingLabel = (): string => {
  const left = remainingMs()
  return Number.isFinite(left) ? `残り ${Math.max(0, Math.round(left / 1000))} 秒` : "締切なし"
}
