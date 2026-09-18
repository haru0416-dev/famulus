/**
 * 任意コマンドは Docker 内だけで動かす。ホストへ書き出せるのは workspace と共有キャッシュだけ。
 * ホストの home・DB・資格情報は渡さない。
 */
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { appConfig } from "../core/config.ts"
import { timeZone } from "../core/time.ts"

/**
 * docker/run.Dockerfile から作る。全走行に影響するので小さく保ち、他に要るものは走行の中で取得する。
 * 版を上げても古いイメージは自動では消えない。
 */
const RUN_IMAGE = "famulus-run:1"
/** ビルド失敗時のフォールバック。pip も uv も jq も無い。 */
const BASE_IMAGE = "node:24-bookworm"
/** `FAMULUS_CYCLE_TIMEOUT_MS` より短くする。cycle が先に時間切れになると走行記録が残らない。 */
const DEFAULT_TIMEOUT_MS = 3 * 60_000
const MAX_OUTPUT_CHARS = 12_000
const MEMORY = "2g"
const CPUS = "2"
const PIDS = "512"
export const PUBLIC_NETWORK = "famulus-public"
export const PUBLIC_NETWORK_POLICY = "public-only-v1"
const PUBLIC_NETWORK_BRIDGE = "br-famulus"
const PUBLIC_NETWORK_READY = `/run/famulus-egress/${PUBLIC_NETWORK_POLICY}.ready`

/** モデルの入力には渡さない。 */
export interface NetworkApproval {
  readonly command: string
  readonly workDir: string
  readonly consume: () => Promise<void>
}

export interface RunOptions {
  /** `runDir()` が返す絶対パス。 */
  readonly workDir: string
  /** true にはコマンドと workspace に対する単回承認が要る。 */
  readonly net?: boolean
  readonly networkApproval?: NetworkApproval
  readonly timeoutMs?: number
  readonly image?: string
  readonly signal?: AbortSignal
}

export interface RunResult {
  readonly exitCode: number
  /** stdout と stderr を受け取った順に混ぜたもの。ストリーム間の発生順は保証しない。 */
  readonly output: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly elapsedMs: number
}

export const runsRoot = (): string => appConfig().paths.runs

// `runsRoot()` の下に置かない。`sweepRuns` が直下を全部 workspace として扱い、期限で消す。
export const cacheRoot = (): string => appConfig().paths.runCache

// 名前はモデルが書くので、字を絞ったうえで runsRoot() の下に入るかも確かめる。
export function runDir(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
  if (!safe) throw new Error(`走行名として使えない: ${name}`)
  const root = runsRoot()
  const dir = join(root, safe)
  if (!dir.startsWith(`${root}/`)) throw new Error(`workspace が置き場の外に出る: ${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function dockerArgs(command: string, opts: RunOptions & { name: string }): string[] {
  return [
    "run",
    "--rm",
    "--name",
    opts.name,
    "--network",
    opts.net ? PUBLIC_NETWORK : "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--memory",
    MEMORY,
    "--cpus",
    CPUS,
    "--pids-limit",
    PIDS,
    // 生成物をホスト側から消せるように同じ uid で走らせる。
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    // uid を指定すると home が無くなるが、npm も pip も HOME を要求する。
    "-e",
    "HOME=/work",
    "-e",
    `TZ=${timeZone()}`,
    // イメージ側にも同じ値があるが、フォールバック先の BASE_IMAGE には無いのでここでも渡す。
    "-e",
    "npm_config_cache=/cache/npm",
    "-e",
    "PIP_CACHE_DIR=/cache/pip",
    "-e",
    "UV_CACHE_DIR=/cache/uv",
    "-e",
    "XDG_CACHE_HOME=/cache/xdg",
    // /cache と /work は別マウントで hardlink できず、既定だと毎回警告が出る。
    "-e",
    "UV_LINK_MODE=copy",
    "-v",
    `${opts.workDir}:/work`,
    "-v",
    `${cacheRoot()}:/cache`,
    "-w",
    "/work",
    opts.image ?? appConfig().runImage ?? RUN_IMAGE,
    "bash",
    "-lc",
    command,
  ]
}

function execute(
  file: string,
  args: readonly string[],
  timeoutMs = 5 * 60_000,
): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(file, args as string[], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    const take = (c: Buffer): void => {
      if (out.length < 8_000) out += c.toString("utf8")
    }
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      done({ code: 127, out: e.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      done({ code: code ?? -1, out })
    })
  })
}

const docker = (args: readonly string[], timeoutMs?: number) => execute("docker", args, timeoutMs)

export async function verifyPublicNetworkPolicy(readyPath: string = PUBLIC_NETWORK_READY): Promise<void> {
  let ready: string
  try {
    const stat = statSync(readyPath)
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      throw new Error("ready file is not root-owned and read-only")
    ready = readFileSync(readyPath, "utf8").trim()
  } catch (error) {
    throw new Error(`public network policy unavailable: ${String(error)}`)
  }
  if (ready !== PUBLIC_NETWORK_POLICY)
    throw new Error(`public network policy version mismatch: ${ready || "empty"}`)

  const policy = await execute("sudo", ["-n", "/usr/local/libexec/famulus-egress-check"], 30_000)
  if (policy.code !== 0) throw new Error(`public network packet filter unavailable: ${policy.out.trim()}`)

  const inspected = await docker(["network", "inspect", PUBLIC_NETWORK], 30_000)
  if (inspected.code !== 0) throw new Error(`public network unavailable: ${inspected.out.trim()}`)
  let network: Record<string, unknown>
  try {
    const decoded = JSON.parse(inspected.out) as unknown
    if (!Array.isArray(decoded) || typeof decoded[0] !== "object" || decoded[0] === null)
      throw new Error("shape")
    network = decoded[0] as Record<string, unknown>
  } catch {
    throw new Error("public network inspect returned invalid JSON")
  }
  const options = network.Options as Record<string, unknown> | undefined
  const labels = network.Labels as Record<string, unknown> | undefined
  if (
    network.Name !== PUBLIC_NETWORK ||
    network.Driver !== "bridge" ||
    network.Internal !== false ||
    network.EnableIPv6 !== false ||
    options?.["com.docker.network.bridge.name"] !== PUBLIC_NETWORK_BRIDGE ||
    options?.["com.docker.network.bridge.enable_icc"] !== "false" ||
    labels?.["io.famulus.egress"] !== PUBLIC_NETWORK_POLICY
  )
    throw new Error("public network attributes do not match policy")
}

let imagePromise: Promise<string> | undefined

// ビルド失敗で例外にしない。Dockerfile の誤り1つで走行がすべて止まるので BASE_IMAGE に切り替える。
export function ensureImage(): Promise<string> {
  imagePromise ??= (async () => {
    const has = await docker(["image", "inspect", RUN_IMAGE], 30_000)
    if (has.code === 0) return RUN_IMAGE
    const file = join(dirname(fileURLToPath(import.meta.url)), "../../docker/run.Dockerfile")
    // context を repo ルートにすると `.data/` ごと daemon へ送られる。
    const built = await docker(["build", "-q", "-f", file, "-t", RUN_IMAGE, dirname(file)])
    return built.code === 0 ? RUN_IMAGE : BASE_IMAGE
  })()
  return imagePromise
}

/**
 * 名前末尾の起動元 pid だけで判定する。pid は再利用されるので、生きている pid のものは
 * 別プロセスでも残す(誤削除より取りこぼしを選ぶ)。
 */
export function orphanNames(
  names: readonly string[],
  isAlive: (pid: number) => boolean,
): { removed: string[]; kept: string[] } {
  const removed: string[] = []
  const kept: string[] = []
  for (const name of names) {
    const pid = Number(name.split("-").at(-1))
    // pid が読めない名前は手動で作ったコンテナとみなして残す。
    ;(!Number.isInteger(pid) || pid <= 0 || isAlive(pid) ? kept : removed).push(name)
  }
  return { removed, kept }
}

export async function sweepOrphans(dry = false): Promise<{ removed: string[]; kept: string[] }> {
  const ls = await docker(["ps", "-a", "--filter", "name=^fam-run-", "--format", "{{.Names}}"], 30_000)
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const out = orphanNames(
    ls.out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    alive,
  )
  if (!dry) for (const name of out.removed) await docker(["rm", "-f", name], 30_000)
  return out
}

// stdout と stderr を分けると、進捗を stderr に出す道具でどこで失敗したかの前後関係が消える。
export async function runInSandbox(
  command: string,
  opts: RunOptions,
  verifyNetwork: () => Promise<void> = verifyPublicNetworkPolicy,
): Promise<RunResult> {
  opts.signal?.throwIfAborted()
  if (!isAbsolute(opts.workDir)) throw new Error(`workspace は絶対パスで渡す: ${opts.workDir}`)
  if (
    opts.net &&
    (!opts.networkApproval ||
      opts.networkApproval.command !== command ||
      opts.networkApproval.workDir !== opts.workDir)
  ) {
    throw new Error("公開通信には、このコマンドとworkspaceに対する単回承認が必要")
  }
  if (opts.net) await verifyNetwork()
  mkdirSync(cacheRoot(), { recursive: true })
  const configuredImage = appConfig().runImage
  const image = opts.image ?? configuredImage ?? (await ensureImage())
  opts.signal?.throwIfAborted()
  // 起動前に使用済みを確定する。起動失敗・応答不明でも同じ承認で再送しない。
  if (opts.net && opts.networkApproval) await opts.networkApproval.consume()
  opts.signal?.throwIfAborted()
  const fellBack = image === BASE_IMAGE && opts.image === undefined && configuredImage === undefined
  const startedAt = Date.now()
  // 時間切れのとき名前で外から消す。末尾の pid は orphanNames が使う。
  const name = `fam-run-${startedAt.toString(36)}-${process.pid}`
  const child = spawn("docker", dockerArgs(command, { ...opts, image, name }), {
    stdio: ["ignore", "pipe", "pipe"],
  })

  // フォールバックを先頭に書かないと、モデルが `uv: command not found` を環境の性質と誤解する。
  let out = fellBack ? `[走行用イメージを組めなかった — pip / uv / jq は無い]\n` : ""
  let timedOut = false
  let dropped = 0
  const take = (chunk: Buffer): void => {
    // 全部溜めてから切ると、出力が止まらない install でメモリが尽きる。
    out += chunk.toString("utf8")
    if (out.length > MAX_OUTPUT_CHARS * 2) {
      dropped += out.length - MAX_OUTPUT_CHARS
      out = out.slice(-MAX_OUTPUT_CHARS)
    }
  }
  child.stdout.on("data", take)
  child.stderr.on("data", take)

  const stop = () => {
    timedOut = true
    // docker クライアントを殺してもコンテナは daemon 側で走り続ける。
    spawn("docker", ["rm", "-f", name], { stdio: "ignore" }).on("error", () => {})
    child.kill("SIGKILL")
  }
  const timer = setTimeout(stop, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  opts.signal?.addEventListener("abort", stop, { once: true })

  const exitCode = await new Promise<number>((done) => {
    child.on("error", (e) => {
      // docker が無い・動いていない。例外にせず出力に書く。
      out += `\n[走らせられなかった] ${e.message}`
      done(127)
    })
    child.on("close", (code) => done(code ?? -1))
  })
  clearTimeout(timer)
  opts.signal?.removeEventListener("abort", stop)
  opts.signal?.throwIfAborted()

  const truncated = dropped > 0 || out.length > MAX_OUTPUT_CHARS
  return {
    exitCode,
    // 失敗の理由は末尾に出るので末尾を残す。
    output: truncated
      ? `…(頭を ${dropped + Math.max(0, out.length - MAX_OUTPUT_CHARS)}字ぶん省いた)\n${out.slice(-MAX_OUTPUT_CHARS)}`
      : out,
    truncated,
    timedOut,
    elapsedMs: Date.now() - startedAt,
  }
}
