/**
 * タスクごとに `famulus/<label>` ブランチを切り、コミットはエージェントではなくハーネスが行う。push はしない。
 * dirty tree では既存の変更と混ざるのでブランチを切らない。
 */
import { execFileSync } from "node:child_process"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

/** `.agent/` と `.cursor/` はタスク前にハーネスが必ず書くので、除外しないと gitignore の無い repo で毎回 dirty になる。 */
function dirtyPathsOutsideAgent(cwd: string): string[] {
  return git(cwd, "status", "--porcelain")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .filter((l) => {
      const path = l.slice(3).replace(/^"|"$/g, "")
      const own = (dir: string): boolean => path === dir || path.startsWith(`${dir}/`)
      return !own(".agent") && !own(".cursor")
    })
}

export interface TaskBranch {
  branch: string
  baseBranch: string
}

export interface BeginBranchResult {
  branch?: TaskBranch
  skipped?: string
}

export function branchNameFor(label: string): string {
  return `famulus/${label.replace(/[^\w.-]/g, "-").slice(0, 60)}`
}

export function beginTaskBranch(cwd: string, label: string): BeginBranchResult {
  try {
    if (dirtyPathsOutsideAgent(cwd).length > 0) {
      return { skipped: "作業ツリーに未コミットの変更があるためブランチを切らずに実行します(混入防止)" }
    }
    const baseBranch = git(cwd, "branch", "--show-current")
    if (baseBranch === "") return { skipped: "detached HEADのためブランチを切らずに実行します" }
    const branch = branchNameFor(label)
    git(cwd, "switch", "-c", branch)
    return { branch: { branch, baseBranch } }
  } catch (e) {
    return {
      skipped: `gitブランチ作成に失敗したため従来挙動で実行します: ${(e as Error).message.slice(0, 100)}`,
    }
  }
}

export interface FinishBranchResult {
  committed: boolean
  branch?: string
  detail: string
}

export interface BranchOpResult {
  ok: boolean
  detail: string
}

export function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

export function branchDiffStat(cwd: string, branch: string): string | undefined {
  try {
    return git(cwd, "diff", "--stat", `HEAD...${branch}`) || undefined
  } catch {
    return undefined
  }
}

/** main や人間のブランチを操作しない。 */
function ensureTaskBranch(branch: string): string | undefined {
  return branch.startsWith("famulus/") ? undefined : `famulus/ 配下のブランチのみ操作できます: ${branch}`
}

export function mergeTaskBranch(cwd: string, branch: string): BranchOpResult {
  const guard = ensureTaskBranch(branch)
  if (guard) return { ok: false, detail: guard }
  try {
    if (dirtyPathsOutsideAgent(cwd).length > 0) {
      return { ok: false, detail: "作業ツリーに未コミットの変更があるためmergeを中止します(混入防止)" }
    }
    if (!branchExists(cwd, branch)) return { ok: false, detail: `ブランチがありません: ${branch}` }
    const current = git(cwd, "branch", "--show-current")
    if (current === branch)
      return { ok: false, detail: `チェックアウト中のブランチ自身はmergeできません: ${branch}` }
  } catch (e) {
    return { ok: false, detail: `git状態の確認に失敗: ${(e as Error).message.slice(0, 120)}` }
  }
  try {
    git(cwd, "merge", "--no-edit", branch)
    git(cwd, "branch", "-d", branch)
    return { ok: true, detail: `${branch} をmergeしブランチを削除しました` }
  } catch (e) {
    try {
      git(cwd, "merge", "--abort")
      return {
        ok: false,
        detail: `merge衝突のためabortしました(成果は ${branch} に残っています。手動mergeへ)`,
      }
    } catch {
      return { ok: false, detail: `merge失敗: ${(e as Error).message.slice(0, 150)}` }
    }
  }
}

export function discardTaskBranch(cwd: string, branch: string): BranchOpResult {
  const guard = ensureTaskBranch(branch)
  if (guard) return { ok: false, detail: guard }
  try {
    if (!branchExists(cwd, branch)) return { ok: false, detail: `ブランチがありません: ${branch}` }
    if (git(cwd, "branch", "--show-current") === branch) {
      return { ok: false, detail: `チェックアウト中のブランチは破棄できません: ${branch}` }
    }
    git(cwd, "branch", "-D", branch)
    return { ok: true, detail: `${branch} を破棄しました` }
  } catch (e) {
    return { ok: false, detail: `破棄失敗: ${(e as Error).message.slice(0, 150)}` }
  }
}

export function finishTaskBranch(cwd: string, tb: TaskBranch, taskSummary: string): FinishBranchResult {
  try {
    const dirty = dirtyPathsOutsideAgent(cwd).length > 0
    if (dirty) {
      // `:(exclude).agent` は使わない。.agent が gitignore 済みの repo では ignored パスの add として exit 1 になる。
      git(cwd, "add", "-A")
      try {
        git(cwd, "reset", "-q", "--", ".agent", ".cursor")
      } catch {
        // HEAD 無しで reset できなくても、.agent が stage されていなければ害は無い
      }
      git(
        cwd,
        "-c",
        "user.name=famulus",
        "-c",
        "user.email=famulus@local",
        "commit",
        "-q",
        "-m",
        `famulus: ${taskSummary.slice(0, 100)}`,
      )
    }
    git(cwd, "switch", tb.baseBranch)
    if (!dirty) {
      git(cwd, "branch", "-d", tb.branch)
      return { committed: false, detail: `無変更のため ${tb.branch} を削除して ${tb.baseBranch} に復帰` }
    }
    return {
      committed: true,
      branch: tb.branch,
      detail: `${tb.branch} にコミットして ${tb.baseBranch} に復帰(取り込みは merge/cherry-pick、破棄は branch -D)`,
    }
  } catch (e) {
    // 成果を失わないようブランチに留まる
    return {
      committed: false,
      branch: tb.branch,
      detail: `ブランチ後処理に失敗(成果は ${tb.branch} に残っています): ${(e as Error).message.slice(0, 100)}`,
    }
  }
}
