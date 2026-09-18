/**
 * Cursor フック(.cursor/hooks/guard.sh から起動)。exit 0 + stdout の JSON で allow/deny を返す。
 * env を読むのは core/config だけなので、role は guard.sh が argv に展開して渡す。
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
  /** shell 系イベントのみ。 */
  cwd?: string
  workspace_roots?: string[]
  command?: string
  tool_name?: string
  file_path?: string
  mcp_server_name?: string
}

export interface HookDecision {
  verdict: GuardVerdict
  descriptor: string
}

/** 未知のイベント(観測系フック等)は allow。遮断するのは登録済みイベントだけ。 */
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

/** モデル向けの注入文字列は英語で書く。 */
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

/** 正当なコマンドの誤遮断はこのログでしか分からない。 */
function appendDenyLog(cwd: string, entry: Record<string, unknown>): void {
  try {
    const dir = join(cwd, ".agent")
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "guard-denies.jsonl"), `${JSON.stringify(entry)}\n`)
  } catch {
    // best-effort
  }
}

/** 壊れた入力で coder 全体を止めないよう fail-open。 */
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
