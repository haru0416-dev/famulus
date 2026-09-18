/**
 * systemd の cycle はログインシェルを通らず、unit ファイルに秘密を書くと 644 になるので、600 の `.env` を読む。
 * `process.loadEnvFile()` は Bun に無く、失敗が黙って握りつぶされるので自前で解析する。
 */
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url))

/** 外から渡された値を `.env` より優先するため、起動時点の鍵を取っておく。 */
const OUTER = new Set(Object.keys(process.env))

let done = false

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

/** 囲んでいない値は空白を挟んだ `#` 以降を捨てる。` #` を含めたい値は引用符で囲む。 */
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
