import { describe, expect, test } from "vitest"
import { evaluateHookInput } from "../../src/core/guard-hook.ts"

describe("evaluateHookInput — hook_event_nameディスパッチ", () => {
  test("beforeShellExecution: commandをtokenize評価器へ", () => {
    const d = evaluateHookInput({ hook_event_name: "beforeShellExecution", command: "rm -rf /tmp/x" })
    expect(d.verdict.permission).toBe("deny")
    expect(d.verdict.reason).toBe("rm-recursive-force")
    expect(d.descriptor).toBe("rm -rf /tmp/x")
  })

  test("hook_event_name欠落は旧hooks.json互換でshell評価", () => {
    const d = evaluateHookInput({ command: "git status" })
    expect(d.verdict.permission).toBe("allow")
  })

  test("preToolUse: reviewerのWriteをdeny、descriptorにツール名", () => {
    const d = evaluateHookInput({ hook_event_name: "preToolUse", tool_name: "Write" }, "reviewer")
    expect(d.verdict.permission).toBe("deny")
    expect(d.verdict.reason).toBe("reviewer-write-tool")
    expect(d.descriptor).toBe("[preToolUse] Write")
  })

  test("preToolUse: executorのWriteは許可", () => {
    const d = evaluateHookInput({ hook_event_name: "preToolUse", tool_name: "Write" })
    expect(d.verdict.permission).toBe("allow")
  })

  test("beforeReadFile: 秘密ファイルはロール不問でdeny", () => {
    const d = evaluateHookInput({ hook_event_name: "beforeReadFile", file_path: "/repo/.env" })
    expect(d.verdict.permission).toBe("deny")
    expect(d.verdict.reason).toBe("secret-file-read")
    expect(d.descriptor).toBe("[beforeReadFile] /repo/.env")
  })

  test("beforeReadFile: 通常ファイルは許可", () => {
    const d = evaluateHookInput({ hook_event_name: "beforeReadFile", file_path: "/repo/src/cli.ts" })
    expect(d.verdict.permission).toBe("allow")
  })

  test("beforeMCPExecution: reviewerの外部サーバーをdeny", () => {
    const d = evaluateHookInput(
      { hook_event_name: "beforeMCPExecution", mcp_server_name: "evil-mcp", tool_name: "do_thing" },
      "reviewer",
    )
    expect(d.verdict.permission).toBe("deny")
    expect(d.verdict.reason).toBe("reviewer-mcp")
    expect(d.descriptor).toBe("[beforeMCPExecution] evil-mcp:do_thing")
  })

  test("beforeMCPExecution: reviewerのcustom-user-tools(submit_review)は許可", () => {
    const d = evaluateHookInput(
      {
        hook_event_name: "beforeMCPExecution",
        mcp_server_name: "custom-user-tools",
        tool_name: "submit_review",
      },
      "reviewer",
    )
    expect(d.verdict.permission).toBe("allow")
  })

  test("beforeMCPExecution: executorのallowlist外サーバーはdeny", () => {
    const d = evaluateHookInput(
      { hook_event_name: "beforeMCPExecution", mcp_server_name: "evil-mcp", tool_name: "x" },
      undefined,
      { mcpAllowlist: ["playwright"] },
    )
    expect(d.verdict.permission).toBe("deny")
    expect(d.verdict.reason).toBe("mcp-not-allowlisted")
  })

  test("beforeMCPExecution: executorのallowlist内サーバーは許可", () => {
    const d = evaluateHookInput(
      { hook_event_name: "beforeMCPExecution", mcp_server_name: "playwright", tool_name: "navigate" },
      undefined,
      { mcpAllowlist: ["playwright"] },
    )
    expect(d.verdict.permission).toBe("allow")
  })

  test("未知イベント(観測系フック等)はallow", () => {
    const d = evaluateHookInput({ hook_event_name: "afterFileEdit" })
    expect(d.verdict.permission).toBe("allow")
  })

  test("入力欠落(tool_name無しpreToolUse)はallowに倒れる", () => {
    const d = evaluateHookInput({ hook_event_name: "preToolUse" }, "reviewer")
    expect(d.verdict.permission).toBe("allow")
  })
})
