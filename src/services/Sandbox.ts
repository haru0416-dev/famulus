/**
 * 取得したコードや手順をこのホストで実行検証するための経路。
 *
 * 任意コマンドは Docker 内だけで動かす。ホストへ書き出せるのは指定 workspace と共有キャッシュだけで、
 * コンテナ内のそれ以外の書き込みは `--rm` とともに捨てる。ホストの home・DB・資格情報は渡さず、
 * ネットワークも必要な実行だけ開く。
 */
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { appConfig } from "../core/config.ts"
import { timeZone } from "../core/time.ts"

/**
 * 走らせるコンテナ。docker/run.Dockerfile で組む(素の `node:24-bookworm` に
 * pip・venv・uv・jq・ripgrep を足したもの)。無ければ最初の走行が組む — `ensureImage`。
 *
 * 全走行へ影響するためイメージは小さく保つ。ここに無い実体が要る走行は、
 * その走行の中で取る(`fam selfdev` が bun を npx で引くのがそれ — src/core/selfdev.ts)。
 *
 * **RUN_IMAGE の版を上げたら、走っているホストでは古いイメージが残る。**`ensureImage` は名前で存在を見るので、
 * 上げた回だけ組み直しが1回入る。古いほうは自動では消えない。
 */
const RUN_IMAGE = "famulus-run:1"
/** ビルド失敗時のフォールバックイメージ。ここでも実行できるが、pip も uv も jq も無い。 */
const BASE_IMAGE = "node:24-bookworm"
/**
 * 1回の走行の上限。依存の取得は分単位で掛かるので、web の 20 秒とは桁が違う。
 *
 * 上限は cycle の持ち時間(`FAMULUS_CYCLE_TIMEOUT_MS`、既定 420 秒)より短く取ってある。
 * 走行が cycle の制限時間を使い切ると、その回は終了して走行記録が1行も残らない —
 * コンテナの中で起きたことはコンテナを捨てた時点で消えるので、書き残せなかった走行は無かったのと同じになる。
 * 長い作業は1回で終わらせず、同じ workspace に置いて次の cycle で続ける。
 */
const DEFAULT_TIMEOUT_MS = 3 * 60_000
/** モデルに渡す上限。ビルドログは平気で数MB出るが、読ませたいのは詰まった箇所だけ。 */
const MAX_OUTPUT_CHARS = 12_000
/** ホスト側の処理を止めないため、1走行が使える資源を制限する。 */
const MEMORY = "2g"
const CPUS = "2"
const PIDS = "512"
export const PUBLIC_NETWORK = "famulus-public"
export const PUBLIC_NETWORK_POLICY = "public-only-v1"
const PUBLIC_NETWORK_BRIDGE = "br-famulus"
const PUBLIC_NETWORK_READY = `/run/famulus-egress/${PUBLIC_NETWORK_POLICY}.ready`

/** モデルの入力には渡さない。承認済みのDB記録を起動直前に一度だけ消費する。 */
export interface NetworkApproval {
  readonly command: string
  readonly workDir: string
  readonly consume: () => Promise<void>
}

export interface RunOptions {
  /** ホストへ書き出す workspace。`runDir()` が返す絶対パスを渡す。 */
  readonly workDir: string
  /** 公開通信にはコマンド・workspaceを固定した単回承認が別途必要。 */
  readonly net?: boolean
  readonly networkApproval?: NetworkApproval
  readonly timeoutMs?: number
  readonly image?: string
  readonly signal?: AbortSignal
}

export interface RunResult {
  readonly exitCode: number
  /** stdout と stderr を親プロセスが受け取った順に混ぜたもの。別ストリーム間の発生順は保証しない。 */
  readonly output: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly elapsedMs: number
}

/** 走行の置き場(config の runs、既定 `~/.famulus/runs`)。repo の外 — git には載らない。 */
export const runsRoot = (): string => appConfig().paths.runs

/**
 * 取得したパッケージの共有キャッシュ。workspace の外に置く。
 *
 * `HOME=/work` のため、既定のキャッシュは workspace ごとに重複する。
 * `runsRoot()` の下に置いてはいけない。`sweepRuns` は runsRoot() の直下を全部
 * workspace として数えるので、キャッシュが workspace の一覧に出て、14日で消される側に回る。
 */
export const cacheRoot = (): string => appConfig().paths.runCache

/**
 * 名前から workspace を1つ作って絶対パスを返す。
 *
 * 名前はモデルが書く。`../` や絶対パスをそのまま繋ぐと、書き込みを許す場所が
 * `.data/runs` の外へ伸びる — 境界を docker に引いておきながら、渡す先で外してしまう。
 * 使える字を絞ってから繋ぎ、それでも根の下に入らなければ弾く(二重に見る)。
 */
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

/** docker の引数を組む。組み立てだけを切り出してある(実際に走らせずに検査できるように)。 */
export function dockerArgs(command: string, opts: RunOptions & { name: string }): string[] {
  return [
    "run",
    "--rm",
    "--name",
    opts.name,
    // 外向きは既定で閉じる。docker には宛先の allowlist が無いので、開くか閉じるかの二択になる。
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
    // ホストプロセスと同じ uid で走らせ、生成物をホスト側から読んで消せるようにする。
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    // uid を指定するとコンテナの中に home が無くなる。npm も pip も HOME を要求するので workspace を充てる。
    "-e",
    "HOME=/work",
    // 設定タイムゾーンを渡し、ホスト側の検証と日付境界を揃える。
    "-e",
    `TZ=${timeZone()}`,
    // 取得キャッシュは workspace をまたいで使い回す。置き場は workspace の外(cacheRoot)。
    // イメージ側にも同じ値を設定してあるが、ここでも渡す — フォールバック先の素のイメージには入っていないので、
    // 組めなかった回だけキャッシュを使わない、という差ができる。
    "-e",
    "npm_config_cache=/cache/npm",
    "-e",
    "PIP_CACHE_DIR=/cache/pip",
    "-e",
    "UV_CACHE_DIR=/cache/uv",
    "-e",
    "XDG_CACHE_HOME=/cache/xdg",
    // uv は既定でキャッシュから hardlink する。/cache と /work は別のマウントなので張れず、
    // 走行のたびに警告を出して copy に切り替わる。最初から copy と指定する。
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

/** docker を1回呼んで終了コードと出力を取る。走行そのものではなく、周りの世話(組む・数える・消す)用。 */
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

/** root側のpacket filterと専用networkが揃っている場合だけ外向き走行を許す。 */
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

/** 一度組んだら二度と確認しない(`docker image inspect` でも 30ms 掛かるので、走行ごとには払わない)。 */
let imagePromise: Promise<string> | undefined

/**
 * 走行用のイメージを、無ければ組む。返すのは実際に使えるイメージ名。
 *
 * 組むのは初回だけで、このホストでは 15.6 秒 / 素のイメージ +110MB だった。
 * 走行の持ち時間から引かれるので、`ensureImage` は cycle の締切より前に呼ぶ側で吸収する
 * — いまは `runInSandbox` の中で待つ。1回きりなので、二度目からは 0 秒。
 *
 * ビルドできなければ素のイメージへフォールバックする。ここで例外を投げると、Dockerfile の誤り1つで
 * 走行経路がすべて使えなくなる。フォールバックしたことは走行出力の先頭に書いて、読む側に見せる。
 */
export function ensureImage(): Promise<string> {
  imagePromise ??= (async () => {
    const has = await docker(["image", "inspect", RUN_IMAGE], 30_000)
    if (has.code === 0) return RUN_IMAGE
    const file = join(dirname(fileURLToPath(import.meta.url)), "../../docker/run.Dockerfile")
    // 文脈は Dockerfile の在るディレクトリだけ渡す。リポジトリの根を渡すと `.data/` ごと
    // daemon へ送ることになる(実測で 1.4GB あった)。
    const built = await docker(["build", "-q", "-f", file, "-t", RUN_IMAGE, dirname(file)])
    return built.code === 0 ? RUN_IMAGE : BASE_IMAGE
  })()
  return imagePromise
}

/**
 * 対応するホストプロセスが存在しないコンテナを消す。名前に起動元の pid が入っていることだけを頼りにする
 * (`fam-run-<時刻36進>-<pid>`)。時間切れの片付けは `docker rm -f` を投げた時点で終わりだが、
 * cycle 自身やホストが停止した回は削除処理が実行されず、`--rm` の付いたコンテナが残る。
 *
 * 存在する pid のものは触らない。pid は使い回されるので、対応プロセスの同一性までは判定できず、
 * 別のプロセスが同じ番号を使っていれば削除対象から漏れる。誤削除しない側に倒す。
 */
export function orphanNames(
  names: readonly string[],
  isAlive: (pid: number) => boolean,
): { removed: string[]; kept: string[] } {
  const removed: string[] = []
  const kept: string[] = []
  for (const name of names) {
    const pid = Number(name.split("-").at(-1))
    // pid が読めない名前は残す。ここへ来るのは手で立てたコンテナか、名前の付け方を変えた後の残り。
    ;(!Number.isInteger(pid) || pid <= 0 || isAlive(pid) ? kept : removed).push(name)
  }
  return { removed, kept }
}

/** 上の判定を docker に繋いだもの。`dry` なら数えるだけ。 */
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

/**
 * 1回走らせる。返すのは結果であって判断ではない — 失敗も失敗のまま返す。
 *
 * 出力は stdout と stderr を混ぜる。分けて返すと、ビルド系のように進捗を stderr へ流す道具で
 * 「どのコマンドがどこで失敗したか」の前後関係が消える。読む側が要るのはその順序のほう。
 */
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
  // image が明示されている場合は、自動ビルドせず指定されたイメージを使う。
  const configuredImage = appConfig().runImage
  const image = opts.image ?? configuredImage ?? (await ensureImage())
  opts.signal?.throwIfAborted()
  // 起動前に使用済みを確定する。起動失敗・応答不明でも同じ承認で再送しない。
  if (opts.net && opts.networkApproval) await opts.networkApproval.consume()
  opts.signal?.throwIfAborted()
  const fellBack = image === BASE_IMAGE && opts.image === undefined && configuredImage === undefined
  const startedAt = Date.now()
  // コンテナの名前は時刻で作る(同じ走行を続けて呼んでも衝突しない)。時間切れのとき外から消すのに要る。
  const name = `fam-run-${startedAt.toString(36)}-${process.pid}`
  const child = spawn("docker", dockerArgs(command, { ...opts, image, name }), {
    stdio: ["ignore", "pipe", "pipe"],
  })

  // 走行の道具立てが違うことは、走る前に伝える。落ちたことを黙っていると、
  // 読む側は `uv: command not found` から「この環境には uv が無い」と学んでしまう。
  let out = fellBack ? `[走行用イメージを組めなかった — pip / uv / jq は無い]\n` : ""
  let timedOut = false
  let dropped = 0
  const take = (chunk: Buffer): void => {
    // 超過分は頭から捨てて末尾を保つ(落ちた理由は最後に出る)。全部溜めてから切ると、
    // 暴走した install でこちら側の記憶が先に尽きる。
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
    // クライアントを殺してもコンテナは生き残る。docker の子は daemon 側にいるので、
    // プロセス木を落としても中身は走り続ける。名前を指して外から消す。
    spawn("docker", ["rm", "-f", name], { stdio: "ignore" }).on("error", () => {})
    child.kill("SIGKILL")
  }
  const timer = setTimeout(stop, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  opts.signal?.addEventListener("abort", stop, { once: true })

  const exitCode = await new Promise<number>((done) => {
    child.on("error", (e) => {
      // docker そのものが無い/動いていないとき。理由を出力に混ぜて返す(例外で落とすと、
      // 呼んだ側は「コマンドが失敗した」と「走らせる手段が無い」を区別できない)。
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
    // 切るなら末尾を残す。落ちた理由は最後に出る(先頭は依存の取得ログで埋まる)。
    output: truncated
      ? `…(頭を ${dropped + Math.max(0, out.length - MAX_OUTPUT_CHARS)}字ぶん省いた)\n${out.slice(-MAX_OUTPUT_CHARS)}`
      : out,
    truncated,
    timedOut,
    elapsedMs: Date.now() - startedAt,
  }
}
