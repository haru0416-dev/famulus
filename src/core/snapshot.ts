/**
 * ユーザの `.git` に触れない別 git-dir(`.agent/snapshots/git`)に作業ツリーを commit し、`fam restore` で戻す。
 * alternates は使わない。ユーザ側の git gc が借りた object を消すことがある。
 */
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface SnapshotEntry {
  sha: string
  ts: string
  label: string
  flowId?: string
  stepIndex?: number
  kind: "pre-step" | "pre-restore" | "manual"
}

export interface RestoreResult {
  ok: boolean
  detail: string
  /** 復元そのものを取り消すために復元直前に取る。 */
  safety?: SnapshotEntry
}

const GIT_STDIO = ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"]

const snapshotsPath = (cwd: string): string => join(cwd, ".agent", "snapshots")
const storePath = (cwd: string): string => join(snapshotsPath(cwd), "git")
const manifestPath = (cwd: string): string => join(snapshotsPath(cwd), "manifest.jsonl")

function storeGit(cwd: string, ...args: string[]): string {
  const snapshotStoreDir = storePath(cwd)
  return execFileSync(
    "git",
    [`--git-dir=${snapshotStoreDir}`, `--work-tree=${cwd}`, "-c", "core.quotepath=false", ...args],
    { encoding: "utf8", stdio: GIT_STDIO, maxBuffer: 64 * 1024 * 1024 },
  ).trim()
}

export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] })
    return true
  } catch {
    return false
  }
}

export function isSnapshotStoreReady(cwd: string): boolean {
  return existsSync(storePath(cwd))
}

export function ensureSnapshotStore(cwd: string): boolean {
  if (!gitAvailable()) return false
  const snapshotStoreDir = storePath(cwd)
  if (isSnapshotStoreReady(cwd)) return true
  mkdirSync(snapshotsPath(cwd), { recursive: true })
  // --bare は nested .git を作らないため。work-tree は config に残さず毎コマンド明示する。
  execFileSync("git", ["init", "-q", "--bare", snapshotStoreDir], { stdio: ["ignore", "ignore", "pipe"] })
  storeGit(cwd, "config", "core.bare", "false")
  // .agent を含めると snapshot が自身を取り込み、restore が内部状態を巻き戻す。
  writeFileSync(`${snapshotStoreDir}/info/exclude`, "/.agent/\n/.git/\n")
  storeGit(cwd, "config", "user.name", "famulus")
  storeGit(cwd, "config", "user.email", "famulus@local")
  storeGit(cwd, "config", "commit.gpgsign", "false")
  return true
}

function appendManifest(cwd: string, entry: SnapshotEntry): void {
  mkdirSync(snapshotsPath(cwd), { recursive: true })
  appendFileSync(manifestPath(cwd), `${JSON.stringify(entry)}\n`)
}

/** git 不在・失敗時は null を返し、呼び出し側は snapshot なしで進む。 */
export function takeSnapshot(
  cwd: string,
  opts: { label: string; kind?: SnapshotEntry["kind"]; flowId?: string; stepIndex?: number },
): SnapshotEntry | null {
  try {
    if (!ensureSnapshotStore(cwd)) return null
    storeGit(cwd, "add", "-A")
    storeGit(cwd, "commit", "-q", "--allow-empty", "-m", opts.label.slice(0, 200))
    const sha = storeGit(cwd, "rev-parse", "HEAD")
    const entry: SnapshotEntry = {
      sha,
      ts: new Date().toISOString(),
      label: opts.label,
      kind: opts.kind ?? "manual",
      ...(opts.flowId ? { flowId: opts.flowId } : {}),
      ...(opts.stepIndex !== undefined ? { stepIndex: opts.stepIndex } : {}),
    }
    appendManifest(cwd, entry)
    return entry
  } catch {
    return null
  }
}

export function listSnapshots(cwd: string): SnapshotEntry[] {
  const snapshotManifest = manifestPath(cwd)
  if (!existsSync(snapshotManifest)) return []
  const out: SnapshotEntry[] = []
  for (const line of readFileSync(snapshotManifest, "utf8").split("\n")) {
    if (line.trim() === "") continue
    try {
      out.push(JSON.parse(line) as SnapshotEntry)
    } catch {
      // 破損行は読み飛ばす
    }
  }
  return out.reverse()
}

export function resolveSnapshot(cwd: string, ref: string): SnapshotEntry | undefined {
  const all = listSnapshots(cwd)
  const exact = all.find((e) => e.sha === ref)
  if (exact) return exact
  const prefixed = all.filter((e) => e.sha.startsWith(ref))
  return prefixed.length === 1 ? prefixed[0] : undefined
}

export function latestFlowSnapshot(cwd: string, flowId: string): SnapshotEntry | undefined {
  return listSnapshots(cwd).find((e) => e.flowId === flowId && e.kind === "pre-step")
}

/** ブランチ ref は動かさないので、履歴と他の snapshot は残る。clean は ignore を尊重する。 */
export function restoreSnapshot(cwd: string, sha: string): RestoreResult {
  if (!gitAvailable()) return { ok: false, detail: "gitが使えない環境です(snapshotは無効)" }
  if (!isSnapshotStoreReady(cwd)) return { ok: false, detail: "スナップショットがまだありません" }
  try {
    storeGit(cwd, "cat-file", "-e", `${sha}^{commit}`)
  } catch {
    return { ok: false, detail: `スナップショットが見つかりません: ${sha}` }
  }
  const safety = takeSnapshot(cwd, { label: `pre-restore ${sha.slice(0, 10)}`, kind: "pre-restore" })
  try {
    storeGit(cwd, "read-tree", sha)
    storeGit(cwd, "checkout-index", "-f", "-a")
    storeGit(cwd, "clean", "-f", "-d")
    storeGit(cwd, "reset", "-q", "--mixed", "HEAD")
    return {
      ok: true,
      detail: `作業ツリーを ${sha.slice(0, 10)} の状態へ復元しました`,
      ...(safety ? { safety } : {}),
    }
  } catch (e) {
    return {
      ok: false,
      detail: `復元に失敗しました: ${(e as Error).message.slice(0, 160)}`,
      ...(safety ? { safety } : {}),
    }
  }
}
