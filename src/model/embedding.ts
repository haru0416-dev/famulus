/**
 * recall の意味検索に使うローカル埋め込み。推論は完全にこの箱の中で行う —
 * 私的データを外に出さないという制約が先にあり、API 埋め込みは選択肢にない。
 * モデルは ruri-v3-30m(q8 ONNX・256次元)。実ロードの詳細は embedding-ruri.ts。
 * プレフィックスは ruri v3 の規約(検索クエリ: / 検索文書:)。
 *
 * 失敗はすべて undefined に落とす。埋め込みが無くても recall は FTS で動く —
 * 意味検索は上乗せであって、記憶の書き込みや検索を埋め込みの都合で止めない。
 */
import { appConfig } from "../core/config.ts"
import type { Embedder } from "./embedding-ruri.ts"

export const EMBEDDING_MODEL = "ruri-v3-30m-q8"
export const EMBEDDING_DIM = 256

let loading: Promise<Embedder | undefined> | undefined
let warned = false

const loadReal = async (): Promise<Embedder | undefined> => {
  try {
    const { loadRuri } = await import("./embedding-ruri.ts")
    return await loadRuri()
  } catch (e) {
    if (!warned) {
      warned = true
      console.error("[embedding] モデルを読めなかった(FTS だけで続ける):", String(e).slice(0, 200))
    }
    return undefined
  }
}

/**
 * 検査用の決定的埋め込み。文字2-gram の出現を 256 次元に畳んで正規化する。
 * 意味は持たないが、共有 2-gram が多い文ほど近くなるので、機構の検査には足りる。
 */
export const stubEmbed = (text: string): Float32Array => {
  const v = new Float32Array(EMBEDDING_DIM)
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2)
    let h = 0
    for (let j = 0; j < gram.length; j++) h = (h * 31 + gram.charCodeAt(j)) >>> 0
    const idx = h % EMBEDDING_DIM
    v[idx] = (v[idx] ?? 0) + 1
  }
  let norm = 0
  for (let d = 0; d < EMBEDDING_DIM; d++) norm += (v[d] ?? 0) ** 2
  norm = Math.sqrt(norm) || 1
  for (let d = 0; d < EMBEDDING_DIM; d++) v[d] = (v[d] ?? 0) / norm
  return v
}

const embedder = (): Promise<Embedder | undefined> => {
  const mode = appConfig().models.embedding
  if (mode === "off") return Promise.resolve(undefined)
  if (mode === "stub") return Promise.resolve((text: string) => Promise.resolve(stubEmbed(text)))
  loading ??= loadReal()
  return loading
}

const embed = async (prefix: string, text: string): Promise<Float32Array | undefined> => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const run = await embedder()
  if (!run) return undefined
  try {
    return await run(`${prefix}${trimmed}`)
  } catch (e) {
    if (!warned) {
      warned = true
      console.error("[embedding] 埋め込みに失敗した(FTS だけで続ける):", String(e).slice(0, 200))
    }
    return undefined
  }
}

export const embedQuery = (text: string): Promise<Float32Array | undefined> => embed("検索クエリ: ", text)
export const embedPassage = (text: string): Promise<Float32Array | undefined> => embed("検索文書: ", text)
