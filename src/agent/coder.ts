/**
 * coder — コーディングを Cursor SDK へ委譲する実行の1本。
 *
 * 順路: scaffolding(guard hook)→ snapshot → task ブランチ → runCursorTask →
 * commit して base へ復帰 → 概算コストを添えて返す。記帳(ledger)は CLI 側が行う。
 *
 * 自走(cycle)へは渡さない — 入口は `fam code` だけ。従量課金のコスト上限が
 * governance に入るまでこの境界は動かさない。merge/push はここには無い(人間が行う)。
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appConfig, PROJECT_ROOT } from "../core/config.ts"
import { beginTaskBranch, branchDiffStat, finishTaskBranch } from "../core/gitops.ts"
import { collectMap, renderMap } from "../core/repomap.ts"
import { takeSnapshot } from "../core/snapshot.ts"
import { type CursorRunSummary, runCursorTask } from "../model/cursor.ts"
import { estimateRunCostUSD } from "../model/cursor-pricing.ts"

/**
 * workspace に guard hook の scaffolding を置く(冪等)。
 * settingSources:["project"] 経由でロードされ、4イベントとも同じ guard.sh が
 * `fam cursor-hook` を呼ぶ。role は guard.sh が env から argv へ展開する。
 */
export function ensureCoderScaffolding(root: string): void {
  const hooksDir = join(root, ".cursor", "hooks")
  mkdirSync(hooksDir, { recursive: true })
  const script = join(hooksDir, "guard.sh")
  writeFileSync(
    script,
    `#!/usr/bin/env bash\n# famulus guard: 破壊的 shell・秘密ファイル読取・reviewer の書き込みを実行前に遮断。\nexec bun ${JSON.stringify(join(PROJECT_ROOT, "src/cli.ts"))} cursor-hook "$FAMULUS_CODER_ROLE"\n`,
  )
  chmodSync(script, 0o755)
  const hooksJson = join(root, ".cursor", "hooks.json")
  if (!existsSync(hooksJson)) {
    const guard = [{ command: "./.cursor/hooks/guard.sh" }]
    writeFileSync(
      hooksJson,
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            beforeShellExecution: guard,
            preToolUse: guard,
            beforeReadFile: guard,
            beforeMCPExecution: guard,
          },
        },
        null,
        2,
      )}\n`,
    )
  }
}

/** repo のシンボル地図を .cursor/rules に置く(探索ツールコールの削減)。 */
export function writeRepoMap(root: string): string {
  const rulesDir = join(root, ".cursor", "rules")
  mkdirSync(rulesDir, { recursive: true })
  const body = renderMap(collectMap(root))
  writeFileSync(join(rulesDir, "repo-map.md"), body)
  return body
}

export interface CodeTaskOptions {
  readonly root: string
  readonly task: string
  readonly model?: string
  /** 読み取り志向の計画モード。branch/snapshot/commit を行わない。 */
  readonly plan?: boolean
}

export interface CodeOutcome {
  readonly run: CursorRunSummary
  /** 成果の残ったブランチ(無変更・plan・skip 時は undefined)。 */
  readonly branch?: string
  readonly branchDetail: string
  readonly snapshotSha?: string
  readonly costUsd?: number
  readonly model: string
}

/** 1タスクを workspace 上で実行する。失敗しても成果(ブランチ・snapshot)を失わない方向に倒す。 */
export async function runCodeTask(opts: CodeTaskOptions): Promise<CodeOutcome> {
  const { root, task, plan } = opts
  ensureCoderScaffolding(root)

  if (plan) {
    const run = await runCursorTask({
      cwd: root,
      task,
      mode: "plan",
      ...(opts.model ? { model: opts.model } : {}),
    })
    const cost = costOf(run, opts)
    return {
      run,
      branchDetail: "planモード(ブランチ・snapshotなし)",
      ...(cost !== undefined ? { costUsd: cost } : {}),
      model: modelOf(run, opts),
    }
  }

  const snapshot = takeSnapshot(root, { label: `pre-task ${task.slice(0, 80)}` })
  // ブランチ名は日付+タスク先頭を語単位で。記号をそのまま詰めるとハイフンだらけで読めない。
  const slug =
    task
      .slice(0, 60)
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "task"
  const label = `${new Date().toISOString().slice(0, 10)}-${slug}`
  const begun = beginTaskBranch(root, label)
  const run = await runCursorTask({ cwd: root, task, ...(opts.model ? { model: opts.model } : {}) })

  let branch: string | undefined
  let branchDetail: string
  if (begun.branch) {
    const finished = finishTaskBranch(root, begun.branch, task)
    branch = finished.branch
    branchDetail = finished.detail
  } else {
    branchDetail = begun.skipped ?? "ブランチなし"
  }

  const cost = costOf(run, opts)
  return {
    run,
    ...(branch ? { branch } : {}),
    branchDetail,
    ...(snapshot ? { snapshotSha: snapshot.sha } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    model: modelOf(run, opts),
  }
}

const modelOf = (_run: CursorRunSummary, opts: CodeTaskOptions): string =>
  opts.model ?? appConfig().cursor.model

const costOf = (run: CursorRunSummary, opts: CodeTaskOptions): number | undefined =>
  run.usage ? estimateRunCostUSD({ model: modelOf(run, opts), fast: false, usage: run.usage }) : undefined

export { branchDiffStat }
