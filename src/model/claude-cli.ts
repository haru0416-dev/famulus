/**
 * `claude` CLI を呼ぶ唯一の場所。Claude 側の推論の実装はここだけで、他は全部この上位層。
 * GPT 側はここを通らない — src/model/codex-responses.ts が HTTP で Codex を直接呼ぶ。
 *
 * なぜ SDK でも API キーでもなく CLI か:
 * ここでやるのは「本人が本人のサブスクで、第一者クライアント(`claude`)を、自分専用の自動化から呼ぶ」形。
 * pi-ai は Claude Pro/Max の OAuth を内蔵しているが、それは claude.ai ログインを別クライアントに
 * 載せる経路で、上の判断とは別物なので使わない。
 *
 * 1回あたりの入力は CLI 側の前置きで数千 tok から始まり、`--system-prompt` を渡しても消えない。
 * `--bare` なら除外できるが、あれは認証を `ANTHROPIC_API_KEY` に固定するのでサブスクで実行する
 * 目的と両立しない。削減できるのは呼び出し回数で、トークン使用量の多い役を GPT 側に置いてあるのはこの差による
 * (GPT 側は CLI を経由しないのでシステムプロンプトの追加が 0)。
 *
 * `--json-schema` は StructuredOutput というツールとして実装されているため、
 * `--tools ""` と併用すると拒否されて `structured_output` が null になる。
 * 必要なのは全ツールを許可することではなく、StructuredOutput だけを許可すること。
 * この形なら内側の claude に Read/Write/Bash は渡らない。
 *
 * CLI の出力を読むときの前提:
 *  - `api_error_status: 429` がクォータ枯渇の判定根拠。`subtype` は失敗時も "success" のままで当てにならない。
 *  - 5xx は CLI 内で3分ほどリトライする。in-band には何も出ないので掴めるのは timeout だけ。
 *  - `rate_limit_event` が in-band で流れる(`{status, resetsAt, rateLimitType}`)= クォータ再実行抑止の入力。
 *  - `usage.input_tokens` だけでは足りない。前置きは `cache_creation_input_tokens`(初回)と
 *    `cache_read_input_tokens`(2回目以降)へ回る。DB もこの3つを別々に持つ。
 */
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  baseModel,
  CLAUDE_POOL,
  isGptModel,
  ModelCallError,
  type ModelCallOptions,
  type ModelCallResult,
  type QuotaSignal,
  RUNTIME_PROMPT,
  stripCitationMarkers,
  type TokenUsage,
} from "./models.ts"

/**
 * 子プロセスに渡さない環境変数。剥がさないと課金経路が黙って変わる:
 * `ANTHROPIC_API_KEY` があればサブスクでなく従量課金で走り、`ANTHROPIC_BASE_URL` があれば別の宛先に飛ぶ。
 * 接頭辞一致にして、将来増える変数も落ちる側に倒す。
 */
const STRIPPED_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_", "CLAUDE_CONFIG_", "AWS_BEARER_TOKEN_BEDROCK"]
const STRIPPED_EXACT = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "MAX_THINKING_TOKENS"]

/** 素の環境。HOME は残す — 資格情報は `~/.claude` にある。 */
export function sanitizedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    if (STRIPPED_EXACT.includes(k)) continue
    if (STRIPPED_PREFIXES.some((p) => k.startsWith(p))) continue
    out[k] = v
  }
  return out
}

/**
 * `claude` の置き場所。PATH には頼らない。
 * systemd --user から起動すると子に渡る PATH は systemd の既定で `~/.local/bin` を含まないので、
 * PATH 解決にすると tick からの呼び出しだけが `Executable not found` で落ちる。
 * フォールバックがあるとその失敗は表に出ず、片方の枠だけで走り続ける。
 */
const BIN_CANDIDATES = [".local/bin/claude", ".claude/local/claude", ".bun/bin/claude"]

export function resolveClaudeBin(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined
  if (env.OPEN_ZERO_CLAUDE_BIN) return env.OPEN_ZERO_CLAUDE_BIN
  const home = env.HOME ?? homedir()
  for (const rel of BIN_CANDIDATES) {
    const p = join(home, rel)
    if (existsSync(p)) return p
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue
    const p = join(dir, "claude")
    if (existsSync(p)) return p
  }
  return undefined
}

/** stream-json の各行。必要な形だけ書く(未知フィールドは無視)。 */
interface StreamLine {
  type?: string
  event?: { type?: string; delta?: { type?: string; text?: string } }
  rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string }
  subtype?: string
  is_error?: boolean
  api_error_status?: number | null
  result?: string
  structured_output?: unknown
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

/** `rate_limit_event` → QuotaSignal。status が allowed 系以外なら枯渇扱い(安全側)。 */
export function toQuotaSignal(
  info: NonNullable<StreamLine["rate_limit_info"]>,
  pool: string = CLAUDE_POOL,
): QuotaSignal {
  const status = info.status ?? "unknown"
  return {
    pool,
    window: info.rateLimitType ?? "unknown",
    ...(info.resetsAt ? { resetsAtMs: info.resetsAt * 1000 } : {}),
    exhausted: status !== "allowed" && status !== "allowed_warning",
  }
}

/** 構造化応答の文字列にも同じマーカーが乗る。JSON を一度文字列にして落とす。 */
function stripDeep(v: unknown): unknown {
  try {
    return JSON.parse(stripCitationMarkers(JSON.stringify(v)))
  } catch {
    return v
  }
}

const EMPTY_USAGE: TokenUsage = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, notionalUsd: 0 }

/** CLI が未知のツール名に対して返す文言(バンドル内の tengu_tool_use_error / NO_SUCH_TOOL)。 */
const NO_SUCH_TOOL = "No such tool available"

/**
 * `claude -p` を1回呼ぶ。空の一時ディレクトリと `--setting-sources ""` を使い、
 * プロジェクトのファイル、CLAUDE.md、ユーザー設定、MCP 設定をこの呼び出しへ持ち込まない。
 */
export async function callClaude(opts: ModelCallOptions): Promise<ModelCallResult> {
  if (isGptModel(opts.model)) {
    // 検査せずに実行しない。実行すると Claude のサブスクで GPT を呼ぶことになり、上流で失敗する。
    throw new ModelCallError(`${opts.model} はこの経路では呼べない(GPT は src/model/codex-responses.ts)`)
  }
  const bin = resolveClaudeBin(opts.bin)
  if (!bin) {
    throw new ModelCallError(
      "claude 実行ファイルが見つからない(PATH にも既定の置き場所にも無い)。OPEN_ZERO_CLAUDE_BIN で指定できる",
    )
  }

  const pool = CLAUDE_POOL

  const cwd = mkdtempSync(join(tmpdir(), "open-zero-run-"))
  // prompt は argv に載せない。Linux は argv の1要素を 128KB (MAX_ARG_STRLEN) に制限していて、
  // ツール結果を抱えた会話はすぐそこを越えるので、載せると `spawn E2BIG` で落ちる。
  // `-p` に値を付けなければ stdin から読む。
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose", // stream-json は verbose を要求する
    "--model",
    baseModel(opts.model),
    "--system-prompt",
    opts.systemPrompt ?? RUNTIME_PROMPT,
    "--setting-sources",
    "",
    // MCP を子に持ち込ませない。`--mcp-config` を渡さずにこれだけ立てると、
    // 他の設定源にある MCP サーバは全部無視される。ユーザーのシェルから起きた場合に
    // 「親の Claude Code に繋がっている連携」が子の一覧に混ざるのを塞ぐ。
    "--strict-mcp-config",
    "--no-session-persistence",
  ]
  // ツール封じの2形。ここ以外の組み合わせは、ヘッダに書いたとおり拒否されるか高くつく。
  if (opts.jsonSchema !== undefined) {
    args.push("--tools", "StructuredOutput", "--json-schema", JSON.stringify(opts.jsonSchema))
  } else {
    args.push("--tools", "")
  }

  const env = sanitizedEnv()
  env.PATH = [dirname(bin), env.PATH].filter(Boolean).join(":")

  const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  // 子が先に死ぬと書き込み中に EPIPE が飛ぶ。落とすのは stdin だけで、失敗の理由は
  // result 行 / exit code 側から出す(ここで throw すると本当の理由が隠れる)。
  child.stdin.on("error", () => {})
  child.stdin.end(opts.prompt)

  let quota: QuotaSignal | undefined
  let final: StreamLine | undefined
  let streamed = ""
  let stopped: "timeout" | "quota" | "abort" | undefined
  let nativeToolAttempt = false

  // kill だけでは足りない: 子が孫を残すと stdout の書き込み端が開いたままで EOF を待ち続ける
  // (= タイムアウトが効かない)。読み取り端も明示的に破棄する。
  const halt = (why: "timeout" | "quota" | "abort"): void => {
    if (stopped) return
    stopped = why
    child.kill("SIGKILL")
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  }
  const timer = setTimeout(() => halt("timeout"), opts.timeoutMs ?? 180_000)
  const onAbort = () => halt("abort")
  opts.signal?.addEventListener("abort", onAbort, { once: true })

  const onLine = (line: string): void => {
    const t = line.trim()
    if (!t) return
    // JSON に起こす前に生の行で見る。この文字列は CLI が組み立てる tool_use_error の中にあり、
    // 構造化された欄には出てこない(assistant/user メッセージの本文に埋まっている)。
    if (t.includes(NO_SUCH_TOOL)) nativeToolAttempt = true
    let ev: StreamLine
    try {
      ev = JSON.parse(t) as StreamLine
    } catch {
      return // 非 JSON 行(進捗・警告)は無視
    }
    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
      const d = ev.event.delta
      if (d?.type === "text_delta" && d.text) {
        streamed += d.text
        opts.onText?.(d.text)
      }
    } else if (ev.type === "rate_limit_event" && ev.rate_limit_info) {
      quota = toQuotaSignal(ev.rate_limit_info, pool)
      if (quota.exhausted) halt("quota")
    } else if (ev.type === "result") {
      final = ev
    }
  }

  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (c: string) => {
    stderr += c
  })

  let buf = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buf += chunk
    let nl: number
    // biome-ignore lint/suspicious/noAssignInExpressions: 行分割の定型
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  })

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? -1))
    child.on("error", () => resolve(-1))
  })
  if (buf) onLine(buf)

  clearTimeout(timer)
  opts.signal?.removeEventListener("abort", onAbort)
  rmSync(cwd, { recursive: true, force: true })

  const fail: (message: string) => never = (message) => {
    throw new ModelCallError(message, quota)
  }

  if (stopped === "quota") fail(`claude -p: 推論枠が閉じている(${quota?.window ?? "unknown"})`)
  if (stopped === "abort") fail("claude -p: 中断された")
  if (stopped === "timeout") fail(`claude -p: ${opts.timeoutMs ?? 180_000}ms で応答しない`)

  const done: StreamLine | undefined = final
  if (!done) {
    fail(`claude -p: result 行が返らなかった(exit=${exitCode})${stderr ? `: ${stderr.slice(0, 300)}` : ""}`)
  }

  // 429 は result 行の api_error_status にだけ出る。`subtype` は失敗時も "success" のまま。
  if (done.api_error_status === 429) {
    quota = { ...(quota ?? { pool, window: "unknown" }), exhausted: true }
    fail("claude -p: 429(クォータ枯渇)")
  }
  if (done.is_error || done.api_error_status) {
    fail(`claude -p: 失敗(status=${done.api_error_status ?? "?"}) ${String(done.result ?? "").slice(0, 300)}`)
  }

  const u = done.usage ?? {}
  const usage: TokenUsage = {
    inTok: u.input_tokens ?? 0,
    outTok: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    notionalUsd: done.total_cost_usd ?? 0,
  }

  return {
    text: stripCitationMarkers(done.result ?? streamed),
    ...(done.structured_output !== undefined && done.structured_output !== null
      ? { structured: stripDeep(done.structured_output) }
      : {}),
    usage: usage ?? EMPTY_USAGE,
    ...(quota ? { quota } : {}),
    ...(nativeToolAttempt ? { nativeToolAttempt: true } : {}),
    model: opts.model,
  }
}
