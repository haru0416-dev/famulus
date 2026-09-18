import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  beginTaskBranch,
  branchDiffStat,
  branchExists,
  branchNameFor,
  discardTaskBranch,
  finishTaskBranch,
  mergeTaskBranch,
} from "../../src/core/gitops.ts"

const gitRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "famulus-gitops-"))
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"])
  writeFileSync(join(dir, "a.txt"), "hello\n")
  execFileSync("git", ["-C", dir, "add", "."])
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"])
  return dir
}

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()

describe("branchNameFor", () => {
  test("記号をハイフン化しprefixを付ける", () => {
    expect(branchNameFor("task-123 abc!")).toBe("famulus/task-123-abc-")
  })
})

describe("beginTaskBranch / finishTaskBranch", () => {
  test("クリーンなツリー: ブランチ作成→変更コミット→baseへ復帰(mainはクリーンのまま)", () => {
    const dir = gitRepo()
    const bb = beginTaskBranch(dir, "task-x")
    expect(bb.skipped).toBeUndefined()
    assert.ok(bb.branch)
    expect(git(dir, "branch", "--show-current")).toBe("famulus/task-x")
    writeFileSync(join(dir, "b.txt"), "agent output\n")
    const fin = finishTaskBranch(dir, bb.branch, "add b.txt")
    expect(fin.committed).toBe(true)
    expect(git(dir, "branch", "--show-current")).toBe("main")
    expect(git(dir, "status", "--porcelain")).toBe("")
    expect(git(dir, "log", "-1", "--format=%s", "famulus/task-x")).toContain("add b.txt")
  })

  test("無変更タスク: 空ブランチは削除してbaseへ復帰", () => {
    const dir = gitRepo()
    const bb = beginTaskBranch(dir, "noop")
    assert.ok(bb.branch)
    const fin = finishTaskBranch(dir, bb.branch, "no changes")
    expect(fin.committed).toBe(false)
    expect(git(dir, "branch", "--list", "famulus/noop")).toBe("")
    expect(git(dir, "branch", "--show-current")).toBe("main")
  })

  test("dirty tree: 混入防止のためskipして従来挙動(kill-probe対象の事故を防ぐ)", () => {
    const dir = gitRepo()
    writeFileSync(join(dir, "a.txt"), "uncommitted human work\n")
    const bb = beginTaskBranch(dir, "task-y")
    expect(bb.branch).toBeUndefined()
    expect(bb.skipped).toContain("混入防止")
    expect(git(dir, "branch", "--show-current")).toBe("main")
  })

  test("同名ブランチが既にあればskip(上書きしない)", () => {
    const dir = gitRepo()
    git(dir, "branch", "famulus/task-z")
    const bb = beginTaskBranch(dir, "task-z")
    expect(bb.branch).toBeUndefined()
    expect(bb.skipped).toBeDefined()
  })
})

function taskBranchWith(dir: string, label: string, file: string, content: string): string {
  const bb = beginTaskBranch(dir, label)
  assert.ok(bb.branch)
  writeFileSync(join(dir, file), content)
  finishTaskBranch(dir, bb.branch, `write ${file}`)
  return `famulus/${label}`
}

describe("mergeTaskBranch / discardTaskBranch(成果消費)", () => {
  test("merge: 成果を取り込みブランチを削除、mainはクリーン", () => {
    const dir = gitRepo()
    const branch = taskBranchWith(dir, "task-m", "b.txt", "agent output\n")
    expect(branchDiffStat(dir, branch)).toContain("b.txt")
    const op = mergeTaskBranch(dir, branch)
    expect(op.ok).toBe(true)
    expect(git(dir, "log", "-1", "--format=%s")).toContain("b.txt")
    expect(branchExists(dir, branch)).toBe(false)
    expect(git(dir, "status", "--porcelain")).toBe("")
  })

  test("merge: dirty treeは拒否(混入防止)", () => {
    const dir = gitRepo()
    const branch = taskBranchWith(dir, "task-d", "b.txt", "x\n")
    writeFileSync(join(dir, "a.txt"), "uncommitted\n")
    const op = mergeTaskBranch(dir, branch)
    expect(op.ok).toBe(false)
    expect(op.detail).toContain("混入防止")
    expect(branchExists(dir, branch)).toBe(true)
  })

  test("merge: 衝突は自動abortしてクリーンに戻し、ブランチを残す", () => {
    const dir = gitRepo()
    const branch = taskBranchWith(dir, "task-c", "a.txt", "agent version\n")
    writeFileSync(join(dir, "a.txt"), "human version\n")
    git(dir, "add", "-A")
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "human edit")
    const op = mergeTaskBranch(dir, branch)
    expect(op.ok).toBe(false)
    expect(op.detail).toContain("abort")
    expect(git(dir, "status", "--porcelain")).toBe("")
    expect(branchExists(dir, branch)).toBe(true)
  })

  test("famulus/配下以外のブランチは操作拒否(main保護)", () => {
    const dir = gitRepo()
    expect(mergeTaskBranch(dir, "main").ok).toBe(false)
    expect(discardTaskBranch(dir, "main").ok).toBe(false)
  })

  test("discard: 未マージの成果ブランチを破棄する", () => {
    const dir = gitRepo()
    const branch = taskBranchWith(dir, "task-x", "b.txt", "x\n")
    const op = discardTaskBranch(dir, branch)
    expect(op.ok).toBe(true)
    expect(branchExists(dir, branch)).toBe(false)
  })

  test("discard: 存在しないブランチはok:false", () => {
    const dir = gitRepo()
    expect(discardTaskBranch(dir, "famulus/nope").ok).toBe(false)
  })

  test(".agent/はdirty判定から除外(gitignore無しrepoでの恒久skip・merge誤拒否を防ぐ)", () => {
    const dir = gitRepo()
    mkdirSync(join(dir, ".agent", "log"), { recursive: true })
    writeFileSync(join(dir, ".agent", "log", "lineage.jsonl"), "{}\n")
    const bb = beginTaskBranch(dir, "task-agent-noise")
    expect(bb.skipped).toBeUndefined()
    assert.ok(bb.branch)
    writeFileSync(join(dir, "b.txt"), "work\n")
    writeFileSync(join(dir, ".agent", "log", "lineage.jsonl"), '{"more":1}\n')
    const fin = finishTaskBranch(dir, bb.branch, "work")
    expect(fin.committed).toBe(true)
    const committed = git(dir, "ls-tree", "-r", "--name-only", "famulus/task-agent-noise")
    expect(committed).toContain("b.txt")
    expect(committed).not.toContain(".agent/log/lineage.jsonl")
    const op = mergeTaskBranch(dir, "famulus/task-agent-noise")
    expect(op.ok).toBe(true)
  })

  test(".agentがgitignore済みのrepoでもfinishがコミットできる(excludeパススペック退行の回帰)", () => {
    // `add -A -- ':(exclude).agent'` は .agent が gitignore 済みだと exit 1 になり、
    // コミットも base への復帰も失敗する。
    const dir = gitRepo()
    writeFileSync(join(dir, ".gitignore"), ".agent\n")
    git(dir, "add", ".gitignore")
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore .agent")
    mkdirSync(join(dir, ".agent", "log"), { recursive: true })
    writeFileSync(join(dir, ".agent", "log", "lineage.jsonl"), "{}\n")
    const bb = beginTaskBranch(dir, "task-ignored-agent")
    expect(bb.skipped).toBeUndefined()
    assert.ok(bb.branch)
    writeFileSync(join(dir, "b.txt"), "work\n")
    const fin = finishTaskBranch(dir, bb.branch, "work")
    expect(fin.committed).toBe(true)
    expect(git(dir, "branch", "--show-current")).toBe("main")
    const committed = git(dir, "ls-tree", "-r", "--name-only", "famulus/task-ignored-agent")
    expect(committed).toContain("b.txt")
    expect(committed).not.toContain(".agent/log/lineage.jsonl")
  })
})

test("ハーネス自身が書く .agent/.cursor は dirty 扱いにしない(clean な repo でブランチが切れる)", () => {
  const dir = gitRepo()
  mkdirSync(join(dir, ".cursor", "hooks"), { recursive: true })
  writeFileSync(join(dir, ".cursor", "hooks.json"), "{}")
  writeFileSync(join(dir, ".cursor", "hooks", "guard.sh"), "#!/usr/bin/env bash\n")
  mkdirSync(join(dir, ".agent", "store"), { recursive: true })
  writeFileSync(join(dir, ".agent", "store", "runs.ndjson"), "{}\n")

  const begun = beginTaskBranch(dir, "task")
  expect(begun.skipped).toBeUndefined()
  expect(begun.branch?.branch).toBe("famulus/task")
})
