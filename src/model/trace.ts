/**
 * 台帳の `summary` を組む。**これが1回のモデル呼び出しで何をしたかの唯一の記録。**
 *
 * 素の返り値を頭から切ると、道具呼び出しが落ちる。構造化経路の返り値は
 * `{"text": ..., "toolCalls": [...]}` という順の JSON なので、text が長い回ほど
 * **何を呼んだかが先に消える** — 一番読みたい側から失われる。だから畳んでから切る。
 *
 * 畳み方: 発話は頭 `TEXT_MAX` 字、道具は名前を全部残し、引数は1つあたり `ARG_MAX` 字。
 * 引数を落とさないのは、`task` の宛先(`agent`)や `recall` の語が、
 * 「割って投げたか」「同じ語を引き直していないか」を後から見る唯一の手掛かりになるため。
 */

/** 発話に残す長さ。締めの一文が読めればよく、途中の思考は要らない。 */
const TEXT_MAX = 600
/** 引数1件に残す長さ。子への依頼文は長いので、宛先と書き出しが見えるところまで。 */
const ARG_MAX = 300
/** 1行の上限。60行/日で回るので、この長さなら年に数十MBに届かない。 */
const ROW_MAX = 4000

interface Reply {
  text?: unknown
  toolCalls?: unknown
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 道具1件を `名前(引数)` に畳む。引数が無ければ名前だけ。 */
function foldCall(c: unknown): string {
  if (!c || typeof c !== "object") return String(c)
  const { name, arguments: args } = c as { name?: unknown; arguments?: unknown }
  const label = typeof name === "string" && name ? name : "?"
  if (!args || typeof args !== "object") return label
  const parts = Object.entries(args as Record<string, unknown>).map(
    ([k, v]) => `${k}=${clip(typeof v === "string" ? v : (JSON.stringify(v) ?? ""), ARG_MAX)}`,
  )
  return parts.length ? `${label}(${parts.join(", ")})` : label
}

/**
 * モデルの返り値を台帳1行分に畳む。構造化 JSON でなければ素のテキストとして扱う
 * (`claude -p` を道具なしで呼ぶ経路がある)。
 */
export function traceOf(raw: string): string {
  let reply: Reply | undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && "toolCalls" in parsed) reply = parsed as Reply
  } catch {
    // JSON でないなら素のテキスト。畳む対象が無いのでそのまま切る。
  }
  if (!reply) return clip(raw, ROW_MAX)

  const text = typeof reply.text === "string" ? reply.text : ""
  const calls = Array.isArray(reply.toolCalls) ? reply.toolCalls.map(foldCall) : []
  const lines = [clip(text, TEXT_MAX), ...calls.map((c) => `→ ${c}`)].filter(Boolean)
  return clip(lines.join("\n"), ROW_MAX)
}
