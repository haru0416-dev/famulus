/**
 * 同じ語の recall の引き直しをコードで止める。プロンプトの指示では止まらなかった(実測)。
 *
 * 台帳は親はターンごと、委譲(digger)は委譲ごとに持つ。子は親の検索結果を持たないので共有しない。
 */

export interface RecallTurn {
  /** 正規化した語 → ヒット件数。 */
  readonly seen: Map<string, number>
  /** 連続空振り数。当たったら 0 に戻す — 「2回続いたら無い」の判定は連続でだけ数える。 */
  misses: number
}

export const newRecallTurn = (): RecallTurn => ({ seen: new Map(), misses: 0 })

/** 空白の揺れだけを吸収する。言い換えの同一性判定はしない — 別の語は別の検索として通す。 */
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

/**
 * 検索結果を台帳に記録し、モデルへ返す文にする。当たった回は素通し。
 * 空振りの一手は直前の結果で分ける(空振り後は綴り・別名系、が検索ログ研究の実測)。
 */
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
