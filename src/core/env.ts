/**
 * `.env` を読む。入口(cli / cycle / agent)の先頭で1回だけ呼ぶ。
 *
 * systemd から起きる cycle はログインシェルを通らないので、シェルに書いた値は届かない。
 * かといって unit ファイルに書くと、644 の設定ファイルに秘密を置くことになる。
 * 600 の `.env`(git 管理外)を読む側で解決すれば、どの入口から起きても同じ値が見える。
 *
 * 無くても失敗しない。設定が無いのは異常ではない — 通知先を決めていない状態は普通にある。
 *
 * 解析は自前。前は `process.loadEnvFile()` を呼んでいたが、あれは Node にしか無い。
 * Bun 1.3.14 では未実装で、`try/catch` に落ちて `.env` が丸ごと読まれないまま静かに進んだ
 * (Discord のトークンも宛先も未設定として動く)。必要な構文が限定されているため、
 * Node 固有 API に依存しない小さな parser を持つ。
 */
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url))

/** このプロセスが起動した時点の環境。`.env` より外から渡された値のほうを勝たせるために取っておく。 */
const OUTER = new Set(Object.keys(process.env))

let done = false

/** `KEY=値` / 先頭の `export` / 前後の空白。ここに合わない行は落とす。 */
const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

/**
 * 1行を `[鍵, 値]` にする。合わない行(空行・`#` で始まる行・`=` の無い行)は `undefined`。
 *
 * 引用符で囲んだ値は中身を取り、二重引用符では `\n` を改行へ戻した後、
 * 残る backslash escape から backslash を外す。単一引用符では変換しない。
 * 囲んでいない値は、空白を挟んだ `#` から後ろをコメントとして捨てる —
 * 値そのものに ` #` を含めたいときは引用符で囲む。
 */
function entry(raw: string): [string, string] | undefined {
  const line = raw.trim()
  if (!line || line.startsWith("#")) return undefined
  const m = LINE.exec(line)
  if (!m) return undefined
  const key = m[1] as string
  const rest = (m[2] as string).trim()
  const quote = rest[0]
  if ((quote === '"' || quote === "'") && rest.length > 1 && rest.endsWith(quote)) {
    const body = rest.slice(1, -1)
    return [key, quote === "'" ? body : body.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1")]
  }
  return [key, rest.replace(/\s+#.*$/, "").trimEnd()]
}

/**
 * `.env` の値を `process.env` に載せる。2回目以降は何もしない。
 * 既にプロセスに入っていた値は `.env` で上書きしない(systemd の `Environment=` と
 * `FOO=x fam ...` が常に勝つ)。
 */
export function loadEnv(path: string = ENV_PATH): void {
  if (done) return
  done = true
  if (!existsSync(path)) return
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return
  }
  for (const raw of text.split("\n")) {
    const kv = entry(raw)
    if (!kv || OUTER.has(kv[0])) continue
    process.env[kv[0]] = kv[1]
  }
}
