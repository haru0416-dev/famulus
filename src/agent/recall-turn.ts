/**
 * 同じ語の recall の引き直しをコードで止める。プロンプトの指示では止まらなかった。
 * 引いた語の記録は親はターンごと、digger は委譲ごとに持つ。子は親の検索結果を持たないので共有しない。
 */

export interface RecallTurn {
  /** 正規化した語 → ヒット件数。 */
  readonly seen: Map<string, number>
  /** 連続空振り数。「2回続いたら無い」の判定は連続でだけ数える。 */
  misses: number
}

export const newRecallTurn = (): RecallTurn => ({ seen: new Map(), misses: 0 })

/** 空白の揺れだけを吸収する。言い換えは別の語として通す。 */
export const recallKey = (query: string): string => query.replace(/\s+/g, " ").trim()

/** 既に引いた語なら、検索せずに返す文。初出なら undefined。 */
export function repeatNotice(turn: RecallTurn, query: string): string | undefined {
  const key = recallKey(query)
  const hits = turn.seen.get(key)
  if (hits === undefined) return undefined
  return hits === 0
    ? `「${key}」は既に引いて0件だった。同じ語で引き直しても増えない。別の語にするか、無いと結論する。`
    : `「${key}」は既に引いた(${hits}件)。結果は変わらない — 前の結果を読み直す。`
}

export function recordRecall(turn: RecallTurn, query: string, rendered: string, hits: number): string {
  turn.seen.set(recallKey(query), hits)
  if (hits > 0) {
    turn.misses = 0
    return rendered
  }
  turn.misses += 1
  return turn.misses === 1
    ? "該当なし。同じ語では増えない — 引き直すなら別の語(綴り違い・別名・上位語・関係する人や場所)で1回だけ。"
    : "該当なし。言い換えても無い — この話題は DB に無いと結論して、次へ進む。"
}
