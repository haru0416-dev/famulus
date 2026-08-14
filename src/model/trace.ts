/**
 * DB の `summary` を組む。1回のモデル呼び出しで何をしたかは、ここにしか残らない。
 *
 * 道具の並びは tick の event に別の構造化記録として残る。ここは最終本文だけを短く持つ。
 */

/** DB の summary 1行に保存する最大長。 */
const ROW_MAX = 4000

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

export const traceOf = (text: string): string => clip(text, ROW_MAX)
