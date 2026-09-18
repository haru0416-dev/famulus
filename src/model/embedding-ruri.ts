/**
 * 初回はネットワークからモデルを取るのでゲートからは実行できない(カバレッジ除外)。
 * ONNX 配布(onnx-community)に tokenizer が無いので本家 cl-nagoya から読み、mean pooling を自前で行う。
 */

export type Embedder = (text: string) => Promise<Float32Array>

const ONNX_REPO = "onnx-community/ruri-v3-30m-ONNX"
const TOKENIZER_REPO = "cl-nagoya/ruri-v3-30m"

export const loadRuri = async (): Promise<Embedder> => {
  const { AutoModel, AutoTokenizer } = await import("@huggingface/transformers")
  const tokenizer = await AutoTokenizer.from_pretrained(TOKENIZER_REPO)
  const model = await AutoModel.from_pretrained(ONNX_REPO, { dtype: "q8" })
  return async (text: string) => {
    const inputs = tokenizer(text)
    const out = await model(inputs)
    const hidden = out.last_hidden_state
    const [, seq, dim] = hidden.dims as [number, number, number]
    const data = hidden.data as Float32Array
    const v = new Float32Array(dim)
    for (let t = 0; t < seq; t++) {
      for (let d = 0; d < dim; d++) v[d] = (v[d] ?? 0) + (data[t * dim + d] ?? 0)
    }
    let norm = 0
    for (let d = 0; d < dim; d++) {
      v[d] = (v[d] ?? 0) / seq
      norm += (v[d] ?? 0) ** 2
    }
    norm = Math.sqrt(norm) || 1
    for (let d = 0; d < dim; d++) v[d] = (v[d] ?? 0) / norm
    return v
  }
}
