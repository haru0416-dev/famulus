/** 1回のモデル呼び出しで何をしたかは DB の `summary` にしか残らない。道具の並びは cycle の event が持つ。 */

const ROW_MAX = 4000

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

export const traceOf = (text: string): string => clip(text, ROW_MAX)
