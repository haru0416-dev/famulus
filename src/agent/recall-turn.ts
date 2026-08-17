/**
 * 同一ループ内の recall の規律。道具の返り値で引き直しを止める。
 *
 * 実測(2026-08-17): 1応答で model run 15回中11回が同語 recall の引き直し、1 run 平均14秒。
 * 検索ログ研究では同一クエリの再発行は言い換え13分類で唯一の負の変換(AOL 3,600万クエリ、
 * Huang & Efthimiadis 2009)。市場のエージェント記憶12実装に引き直しの回数制御は無く、
 * どこも1回で終わる構造で防いでいる(docs/recall-survey-2026-08-17.md)。
 *
 * プロンプトに書くだけでは止まらないことも実測済み(「該当なし」を約100回読み続けた回がある)。
 * だからコードで止める: 同じ語は検索せずに短文を返し、空振りには次の一手を1つだけ示す。
 *
 * 台帳の寿命は呼び出し側が決める。親はターンごと、委譲(digger)は委譲ごとに独立 —
 * 子は親の検索結果をコンテキストに持たないので、既読の台帳を共有すると子が結果を見られなくなる。
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
