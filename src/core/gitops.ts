/**
 * ブランチ毎タスク。エージェントの作業単位=ブランチ+コミット。
 * runが原子的になり、成果の分離・巻き戻し(branch -D)・mainのクリーン維持ができる。
 *
 * 設計:
 * - タスク開始時に base から `famulus/<label>` を作成(pushは決してしない)
 * - **dirty treeならブランチを切らない**(既存の変更とタスク成果が混ざる事故を防ぐ。
 *   skipして従来挙動=作業ツリーに残す。理由は呼び出し側が表示)
 * - 終了時: 変更があれば自動コミットして base へ戻る。無変更なら空ブランチを削除して戻る
 * - コミットはハーネスが行う(エージェントにgitを任せない)。メッセージにタスク要約を残す
 */
import { execFileSync } from "node:child_process"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

/**
 * dirty判定の対象パス(ハーネス自身が書くものを除外)。
 *
 * `.agent/`(snapshot store・run ログ)と `.cursor/`(guard hook の scaffolding)は
 * タスク実行の前にハーネスが必ず書く。除外しないと**clean な repo でも毎回 dirty 扱いになり、
 * ブランチが永久に切られない**(実測 2026-08-17)。gitignore 未設定の repo で顕在化する。
 */
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
  /** ブランチを切らなかった理由(dirty tree等)。undefinedなら切った。 */
  skipped?: string
}

/** ラベルをブランチ名に使える形へ正規化する。 */
export function branchNameFor(label: string): string {
  return `famulus/${label.replace(/[^\w.-]/g, "-").slice(0, 60)}`
}

/** タスクブランチを開始する。dirty tree・git不在・detached HEADではskipする。 */
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
  /** ブランチが残った場合はその名前(無変更で削除されたらundefined)。 */
  branch?: string
  detail: string
}

export interface BranchOpResult {
  ok: boolean
  detail: string
}

/** ブランチの存在確認。 */
export function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

/** merge-base基準のdiff統計(taskブランチの成果確認用。HEAD...branch)。 */
export function branchDiffStat(cwd: string, branch: string): string | undefined {
  try {
    return git(cwd, "diff", "--stat", `HEAD...${branch}`) || undefined
  } catch {
    return undefined
  }
}

/** famulus/ 配下のブランチだけを操作対象にする(mainや人間のブランチを守る)。 */
function ensureTaskBranch(branch: string): string | undefined {
  return branch.startsWith("famulus/") ? undefined : `famulus/ 配下のブランチのみ操作できます: ${branch}`
}

/**
 * taskブランチを現在ブランチへmergeし、成功時にブランチを削除する。
 * dirty treeは拒否(混入防止)、衝突時は自動abortしてクリーンな状態に戻す
 * (成果はブランチに残る — 手動mergeに委ねる)。
 */
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

/** taskブランチを破棄する(未マージでも-D)。チェックアウト中のブランチは拒否。 */
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

/** タスクブランチを終了する: 変更をコミットしてbaseへ戻る。無変更なら空ブランチを削除。 */
export function finishTaskBranch(cwd: string, tb: TaskBranch, taskSummary: string): FinishBranchResult {
  try {
    const dirty = dirtyPathsOutsideAgent(cwd).length > 0
    if (dirty) {
      // .agentはハーネス内部状態 — task branchに混入させない。
      // `:(exclude).agent` パススペックは使わない: .agentがgitignore済みのrepoでは
      // gitがexcludeパススペック内の.agentを「ignoredなパスのadd要求」と誤判定して
      // exit 1になる(dogfood実測 2026-07-09。gitignore無しrepoでの検証では出ない退行)。
      // add -A(ignoredは元々対象外)→ 非ignore repoで載った分だけ.agentをunstageする。
      git(cwd, "add", "-A")
      try {
        git(cwd, "reset", "-q", "--", ".agent", ".cursor")
      } catch {
        // HEAD無し等でresetできない場合: .agentがstageされていなければ実害なし
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
    // 失敗時はブランチに留まる(成果を失わない方向に倒す)
    return {
      committed: false,
      branch: tb.branch,
      detail: `ブランチ後処理に失敗(成果は ${tb.branch} に残っています): ${(e as Error).message.slice(0, 100)}`,
    }
  }
}
