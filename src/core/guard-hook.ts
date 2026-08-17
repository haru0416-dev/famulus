/**
 * Cursor フックランタイムの入口。stdin の JSON を hook_event_name でディスパッチし、
 * permission JSON を stdout に返す(exit 0 + JSON で allow/deny)。
 *
 * coder の workspace に置いた .cursor/hooks/guard.sh から起動される。role は環境変数
 * ではなく argv で受ける(env を読むのは core/config だけ、の境界を子プロセスでも守る
 * — guard.sh 側が $FAMULUS_CODER_ROLE を argv に展開する)。
 *
 * 対応イベント:
 * - beforeShellExecution: tokenize 評価器(guard.ts)でコマンド評価
 * - preToolUse:           reviewer ロール時に変異系 tool_name を deny
 * - beforeReadFile:       秘密ファイル(.env等)の読取を deny(入口側データフェンス)
 * - beforeMCPExecution:   reviewer は MCP を deny(executor は allowlist 未設定なら素通し)
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  evaluateCommand,
  evaluateFileRead,
  evaluateMcp,
  evaluateToolUse,
  type GuardVerdict,
} from "./guard.ts"

export interface HookInput {
  hook_event_name?: string
  /** shell 系イベントのみ。他イベントは workspace_roots から解決する。 */
  cwd?: string
  workspace_roots?: string[]
  command?: string
  tool_name?: string
  file_path?: string
  mcp_server_name?: string
}

export interface HookDecision {
  verdict: GuardVerdict
  /** deny 記録に使う説明文字列(コマンド or 疑似コマンド)。 */
  descriptor: string
}

/**
 * フック入力をイベント別に評価する(純関数、副作用なし)。
 * hook_event_name 欠落時は beforeShellExecution として扱う。
 * 未知のイベント(観測系フック等)は allow — 遮断は登録済みイベントのみの明示設計。
 */
export function evaluateHookInput(
  input: HookInput,
  role?: string,
  opts: { mcpAllowlist?: readonly string[] } = {},
): HookDecision {
  const event = input.hook_event_name ?? "beforeShellExecution"
  switch (event) {
    case "beforeShellExecution": {
      const command = input.command ?? ""
      return { verdict: evaluateCommand(command, { ...(role ? { role } : {}) }), descriptor: command }
    }
    case "preToolUse": {
      const toolName = input.tool_name ?? ""
      return {
        verdict: evaluateToolUse(toolName, { ...(role ? { role } : {}) }),
        descriptor: `[preToolUse] ${toolName}`,
      }
    }
    case "beforeReadFile": {
      const filePath = input.file_path ?? ""
      return { verdict: evaluateFileRead(filePath), descriptor: `[beforeReadFile] ${filePath}` }
    }
    case "beforeMCPExecution": {
      const server = input.mcp_server_name ?? ""
      return {
        verdict: evaluateMcp(server, {
          ...(role ? { role } : {}),
          ...(opts.mcpAllowlist ? { allowlist: [...opts.mcpAllowlist] } : {}),
        }),
        descriptor: `[beforeMCPExecution] ${server}:${input.tool_name ?? ""}`,
      }
    }
    default:
      return { verdict: { permission: "allow" }, descriptor: `[${event}]` }
  }
}

/** deny 時にモデルへ返す説明(英語 — モデル向け注入文字列の方針)。 */
export function buildAgentMessage(verdict: GuardVerdict): string {
  const rule = verdict.reason ?? "unknown"
  if (rule.startsWith("reviewer-")) {
    return (
      `famulus guard denied this call (rule: ${rule}). You are a read-only reviewer: ` +
      `do not modify files, git state, or dependencies. Investigate with read-only tools and report findings.`
    )
  }
  if (rule === "secret-file-read" || rule === "secret-file-arg") {
    return (
      `famulus guard denied access to a secret file (rule: ${rule}). Files like .env or private ` +
      `keys must never enter the model context. Continue without the secret value; if it is truly ` +
      `required, ask a human.`
    )
  }
  return (
    `famulus guard denied a shell command (rule: ${rule}, category: ${verdict.category}). ` +
    `This is a safety mechanism; rephrase without the destructive operation or ask a human.`
  )
}

/** 全 deny を workspace 側の jsonl に残す(ガード誤爆=正当プローブの遮断はここでしか観測できない)。 */
function appendDenyLog(cwd: string, entry: Record<string, unknown>): void {
  try {
    const dir = join(cwd, ".agent")
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "guard-denies.jsonl"), `${JSON.stringify(entry)}\n`)
  } catch {
    // 計装は best-effort
  }
}

/** stdin → 判定 → stdout。失敗は fail-open(壊れた入力で coder 全体を止めない)。 */
export async function runGuardHook(
  role: string | undefined,
  stdinText: () => Promise<string>,
): Promise<void> {
  let input: HookInput = {}
  try {
    input = JSON.parse(await stdinText()) as HookInput
  } catch {
    process.stdout.write(`${JSON.stringify({ permission: "allow" })}\n`)
    return
  }
  const { verdict, descriptor } = evaluateHookInput(input, role || undefined)
  if (verdict.permission === "deny") {
    const cwd = input.cwd ?? input.workspace_roots?.[0]
    if (cwd) {
      appendDenyLog(cwd, {
        ts: new Date().toISOString(),
        rule: verdict.reason ?? "unknown",
        category: verdict.category ?? "security",
        ...(role ? { role } : {}),
        command: descriptor.slice(0, 300),
      })
    }
    process.stdout.write(
      `${JSON.stringify({
        permission: "deny",
        agent_message: buildAgentMessage(verdict),
        user_message: `famulus guard blocked [${verdict.category}]: ${verdict.reason} — \`${descriptor.slice(0, 120)}\``,
      })}\n`,
    )
    return
  }
  process.stdout.write(`${JSON.stringify({ permission: "allow" })}\n`)
}
