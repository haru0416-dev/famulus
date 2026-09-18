/**
 * コーディングを Cursor SDK へ委譲する。ledger への記帳は CLI が行い、merge/push は人間が行う。
 * cycle からは呼ばない(入口は `fam code` だけ)。従量課金のコスト上限が governance に入るまで変えない。
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appConfig, PROJECT_ROOT } from "../core/config.ts"
import { beginTaskBranch, branchDiffStat, finishTaskBranch } from "../core/gitops.ts"
import { collectMap, renderMap } from "../core/repomap.ts"
import { takeSnapshot } from "../core/snapshot.ts"
import { type CursorRunSummary, runCursorTask } from "../model/cursor.ts"
import { estimateRunCostUSD } from "../model/cursor-pricing.ts"

/** 冪等。settingSources:["project"] 経由で Cursor に読まれる。 */
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

/** 探索のツールコールを減らすため、シンボル地図を .cursor/rules に置く。 */
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
  /** branch/snapshot/commit を行わない。 */
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

/** 失敗してもブランチと snapshot は残す。 */
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
  // 記号の連続を1つのハイフンにまとめる。1文字ずつ置き換えるとハイフンだらけで読めない。
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
