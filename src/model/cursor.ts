/**
 * coder の1タスクを doom-loop ガード付きで走らせる。branch/snapshot/記帳は src/agent/coder.ts、shell の遮断は
 * .cursor/hooks(src/core/guard.ts)が持つ。入口は CLI だけで、コスト上限が governance に入るまで cycle からは呼ばない。
 */
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { SDKMessage } from "@cursor/sdk"
import { Agent, Cursor, JsonlLocalAgentStore } from "@cursor/sdk"
import { appConfig } from "../core/config.ts"

export interface CursorRunOptions {
  readonly cwd: string
  readonly task: string
  readonly model?: string
  /** SDK の公称は読み取り志向だが、plan 中でも edit で Markdown を書ける。 */
  readonly mode?: "agent" | "plan"
  readonly onMessage?: (m: SDKMessage) => void
}

export type CursorAbort = "doomloop-toolcalls" | "doomloop-duration" | "budget-tokens"

export interface CursorRunSummary {
  readonly status: string
  readonly aborted?: CursorAbort
  readonly toolCalls: number
  readonly toolErrors: number
  readonly durationMs: number
  readonly firstEventMs?: number
  readonly usage?: unknown
  readonly gitBefore?: string
  readonly gitAfter?: string
  readonly diffStat?: string
  readonly error?: string
}

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

export function requireCursorKey(): string {
  const key = appConfig().cursor.apiKey
  if (!key)
    throw new Error("FAMULUS_CURSOR_API_KEY が未設定(cursor.com → Settings → API Keys で発行して .env へ)")
  return key
}

/** 鍵の有効確認を兼ねる。課金 run ではない。 */
export async function listCursorModels(): Promise<readonly { id: string; displayName?: string }[]> {
  const models = await Cursor.models.list({ apiKey: requireCursorKey() })
  return models.map((m) => ({ id: m.id, ...(m.displayName ? { displayName: m.displayName } : {}) }))
}

/** doom-loop ガード3層(道具回数・時間・非キャッシュ token)は stream の消費地点でまとめて掛ける。 */
export async function runCursorTask(options: CursorRunOptions): Promise<CursorRunSummary> {
  const cfg = appConfig().cursor
  const { cwd, task, mode, onMessage } = options
  const model = options.model ?? cfg.model
  const storeDir = join(cwd, ".agent", "store")
  mkdirSync(storeDir, { recursive: true })
  const gitBefore = git(cwd, "rev-parse", "HEAD")
  const startedAt = Date.now()

  // Composer 系は fast=true が既定で高額なので、明示的に標準を指定する。fast 非対応のモデルには付けない。
  const modelSelection = model.includes("composer")
    ? { id: model, params: [{ id: "fast", value: "false" }] }
    : { id: model }

  const agent = await Agent.create({
    apiKey: requireCursorKey(),
    model: modelSelection,
    mode: mode ?? "agent",
    local: {
      cwd,
      autoReview: true,
      // .cursor/ 配下の rules / hooks を読み込ませる。
      settingSources: ["project"],
      // 実行前遮断は .cursor/hooks(guard)が持つ。SDK sandbox は既定で使わない。
      sandboxOptions: { enabled: false },
      store: new JsonlLocalAgentStore(storeDir),
    },
  })

  let toolCalls = 0
  let toolErrors = 0
  let firstEventMs: number | undefined
  let aborted: CursorAbort | undefined
  let runTokens = 0

  try {
    const run = await agent.send(task)
    // stream が停止していても時間上限で確実に中断させる
    const durationGuard = setTimeout(() => {
      aborted = "doomloop-duration"
      void run.cancel().catch(() => {})
    }, cfg.maxDurationMs)

    try {
      for await (const message of run.stream()) {
        firstEventMs ??= Date.now() - startedAt
        if (message.type === "tool_call") {
          if (message.status === "running") {
            toolCalls += 1
            // 中断理由は最初の一因だけ記録する(cancel 後に流れた分で上書きしない)
            if (toolCalls > cfg.maxToolCalls && !aborted) {
              aborted = "doomloop-toolcalls"
              void run.cancel().catch(() => {})
            }
          } else if (message.status === "error") {
            toolErrors += 1
          }
        } else if (message.type === "usage") {
          // cacheRead は実コストが桁違いに安く、含めるとすぐ上限に達するので除外する。
          runTokens += message.usage.totalTokens - (message.usage.cacheReadTokens ?? 0)
          if (runTokens > cfg.runTokens && !aborted) {
            aborted = "budget-tokens"
            void run.cancel().catch(() => {})
          }
        }
        onMessage?.(message)
      }
    } finally {
      clearTimeout(durationGuard)
    }

    const result = await run.wait()
    const gitAfter = git(cwd, "rev-parse", "HEAD")
    // diff --stat は untracked(新規ファイルのみの run)を写さない。別欄で追記する。
    const trackedStat = gitBefore ? git(cwd, "diff", "--stat", gitBefore) : undefined
    const untrackedStat = (git(cwd, "ls-files", "--others", "--exclude-standard") ?? "")
      .split("\n")
      .filter((f) => f.trim() !== "")
      .map((f) => ` ${f} | (untracked)`)
      .join("\n")
    const diffStat =
      [trackedStat, untrackedStat].filter((s) => s !== undefined && s !== "").join("\n") || undefined

    return {
      status: result.status,
      ...(aborted ? { aborted } : {}),
      toolCalls,
      toolErrors,
      durationMs: result.durationMs ?? Date.now() - startedAt,
      ...(firstEventMs !== undefined ? { firstEventMs } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(gitBefore ? { gitBefore } : {}),
      ...(gitAfter ? { gitAfter } : {}),
      ...(diffStat ? { diffStat } : {}),
      ...(result.error ? { error: result.error.message } : {}),
    }
  } finally {
    agent.close()
  }
}
