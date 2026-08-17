/**
 * スナップショット式undo。
 *
 * ユーザの `.git` を汚さない**隠しgit-dir**(`.agent/snapshots/git`、work-tree=repo)に
 * タスク開始ごとに commit してツリー状態を残し、任意地点へ巻き戻す(`fam restore`)。
 *
 * 安全設計:
 * - ユーザの `.git` には一切触れない(別git-dirを --git-dir/--work-tree で明示指定)。
 * - `.agent/` と `.git/` は store の info/exclude で保護 — add にも clean にも掛からない
 *   (snapshotが自分自身 `.agent/snapshots` を巻き込む再帰と、内部状態の巻き戻しを防ぐ)。
 * - restore は read-tree(index=snapshot)→ checkout-index(修正/削除を復元)→ clean -fd
 *   (追加ファイルを除去、ignore/excludeは尊重=node_modules等は残す)。ブランチrefは
 *   動かさないので履歴・他snapshotは失われない。
 * - restore の前に安全スナップショットを1枚取る(restore自体を可逆にする — 非破壊原則)。
 *
 * 見送り(記録): objects共有(alternates)で巨大repoを軽くする最適化は、ユーザ側 git gc
 * による借用オブジェクト刈り取りのfootgunがあるため既定では使わない(自己完結オブジェクト)。
 * snapshotは retryFresh フロー(opt-in、既定off)でのみ刻まれ、commitのblobは内容ハッシュで
 * dedupされるため増加は緩やか。明示的な prune / gc は未実装(将来の運用課題として docs に記録)。
 */
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** manifest 1行 = スナップショット1枚のメタ。 */
export interface SnapshotEntry {
  /** commit SHA(復元の参照キー)。 */
  sha: string
  ts: string
  /** 人間可読ラベル(フロー・ステップ・pre-restore等)。 */
  label: string
  flowId?: string
  stepIndex?: number
  /** pre-step / pre-restore / manual の別(用途フィルタ用)。 */
  kind: "pre-step" | "pre-restore" | "manual"
}

export interface RestoreResult {
  ok: boolean
  detail: string
  /** 復元直前に取った安全スナップショット(復元を巻き戻すためのundo点)。 */
  safety?: SnapshotEntry
}

const GIT_STDIO = ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"]

const snapshotsPath = (cwd: string): string => join(cwd, ".agent", "snapshots")
const storePath = (cwd: string): string => join(snapshotsPath(cwd), "git")
const manifestPath = (cwd: string): string => join(snapshotsPath(cwd), "manifest.jsonl")

/** store の git-dir/work-tree を明示した git 実行(ユーザの .git には絶対触れない)。 */
function storeGit(cwd: string, ...args: string[]): string {
  const snapshotStoreDir = storePath(cwd)
  return execFileSync(
    "git",
    [`--git-dir=${snapshotStoreDir}`, `--work-tree=${cwd}`, "-c", "core.quotepath=false", ...args],
    { encoding: "utf8", stdio: GIT_STDIO, maxBuffer: 64 * 1024 * 1024 },
  ).trim()
}

/** git 本体が使えるか(不在環境ではsnapshotは無効=nullを返して素通り)。 */
export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] })
    return true
  } catch {
    return false
  }
}

/** store が初期化済みか。 */
export function isSnapshotStoreReady(cwd: string): boolean {
  return existsSync(storePath(cwd))
}

/**
 * store を初期化する(冪等)。detached-work-tree の定石: `git init --bare` で
 * git-dir をそこに直接置き(ユーザの .git を巻き込まない)、core.bare=false にして
 * 以降は毎コマンド `--work-tree` を明示する。info/exclude で .agent/.git を保護、
 * commit用のローカルidentityとgpgsign無効を設定する。git不在なら false。
 */
export function ensureSnapshotStore(cwd: string): boolean {
  if (!gitAvailable()) return false
  const snapshotStoreDir = storePath(cwd)
  if (isSnapshotStoreReady(cwd)) return true
  mkdirSync(snapshotsPath(cwd), { recursive: true })
  // --bare で git-dir を snapshotStoreDir 直下に作る(nested .git を生まない)。
  execFileSync("git", ["init", "-q", "--bare", snapshotStoreDir], { stdio: ["ignore", "ignore", "pipe"] })
  // 作業ツリー操作(add/commit/checkout-index/clean)を許すため bare を解除する。
  // work-tree は毎コマンド --work-tree で明示するので config には残さない。
  storeGit(cwd, "config", "core.bare", "false")
  // info/exclude: .agent と .git を add にも clean にも掛けない(work-tree root基準)。
  writeFileSync(`${snapshotStoreDir}/info/exclude`, "/.agent/\n/.git/\n")
  storeGit(cwd, "config", "user.name", "famulus")
  storeGit(cwd, "config", "user.email", "famulus@local")
  storeGit(cwd, "config", "commit.gpgsign", "false")
  // 借用(alternates)は使わない(自己完結) — gc autoは既定のまま(短命前提)。
  return true
}

function appendManifest(cwd: string, entry: SnapshotEntry): void {
  mkdirSync(snapshotsPath(cwd), { recursive: true })
  appendFileSync(manifestPath(cwd), `${JSON.stringify(entry)}\n`)
}

/**
 * 現在の作業ツリーをスナップショットする。store未初期化なら初期化する。
 * git不在・失敗時は null(=snapshot無効。呼び出し側は素通りする)。
 */
export function takeSnapshot(
  cwd: string,
  opts: { label: string; kind?: SnapshotEntry["kind"]; flowId?: string; stepIndex?: number },
): SnapshotEntry | null {
  try {
    if (!ensureSnapshotStore(cwd)) return null
    storeGit(cwd, "add", "-A")
    // 空コミットも許可(2連続snapshotで無変更でも刻めるように)。identityは設定済み。
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

/** manifest からスナップショット一覧(新しい順)。 */
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

/** SHA(短縮可)から manifest エントリを解決する。曖昧・不明なら undefined。 */
export function resolveSnapshot(cwd: string, ref: string): SnapshotEntry | undefined {
  const all = listSnapshots(cwd)
  const exact = all.find((e) => e.sha === ref)
  if (exact) return exact
  const prefixed = all.filter((e) => e.sha.startsWith(ref))
  return prefixed.length === 1 ? prefixed[0] : undefined
}

/** そのフローの pre-step スナップショットのうち最新のもの(失敗後の巻き戻し先)。 */
export function latestFlowSnapshot(cwd: string, flowId: string): SnapshotEntry | undefined {
  return listSnapshots(cwd).find((e) => e.flowId === flowId && e.kind === "pre-step")
}

/**
 * 指定スナップショットへ作業ツリーを復元する。復元前に安全スナップショット(pre-restore)を
 * 1枚取り、それを RestoreResult.safety で返す(復元を巻き戻せる=非破壊)。
 * read-tree(index←snapshot)→ checkout-index -fa(修正/削除を復元)→ clean -fd
 * (追加ファイル除去、ignore/exclude尊重)。ブランチrefは動かさない。
 */
export function restoreSnapshot(cwd: string, sha: string): RestoreResult {
  if (!gitAvailable()) return { ok: false, detail: "gitが使えない環境です(snapshotは無効)" }
  if (!isSnapshotStoreReady(cwd)) return { ok: false, detail: "スナップショットがまだありません" }
  // 参照の存在確認(storeにcommitが在るか)
  try {
    storeGit(cwd, "cat-file", "-e", `${sha}^{commit}`)
  } catch {
    return { ok: false, detail: `スナップショットが見つかりません: ${sha}` }
  }
  // 復元を可逆にする安全スナップショット(これ自体は復元対象を上書きする前に取る)
  const safety = takeSnapshot(cwd, { label: `pre-restore ${sha.slice(0, 10)}`, kind: "pre-restore" })
  try {
    storeGit(cwd, "read-tree", sha)
    storeGit(cwd, "checkout-index", "-f", "-a")
    storeGit(cwd, "clean", "-f", "-d")
    // index を整合させておく(次回 add -A/commit の基準を明確化)
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
