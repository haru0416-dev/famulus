/**
 * 拾ったものを**このホストで実際に動かす**ための1本道。
 *
 * 読むだけの記録は誰が書いても同じ文にしかならない。詰まった箇所・落ちた経路・要った時間は、
 * 自分で走らせないと出てこない。そのために任意のコマンドを動かす手段が要るが、
 * このホストにはユーザーの鍵も DB(`.data/*.db`)も置いてある。**境界を先に引かないと動かせない。**
 *
 * 境界に docker を選んだのは、srt(bubblewrap)と headless の `claude -p` を実測して落としたから。
 * 前者は AppArmor が入れ子の userns を塞いでいて動かず、後者は作業場の中にも書けない。
 * どちらの失敗も、越えるには sudo かサンドボックスの解除が要る。落とした経緯は docs/adr/0001。
 *
 * docker は sudo 無しで通り、「作業場には書ける / `/home/haru` は見えない /
 * `--network none` なら外に出られない」が同時に成り立つ。中に資格情報を持ち込まないので、
 * 万一持ち出されて困るのは**そのランで自分が置いたものだけ**になる。
 */
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

/**
 * 走らせるコンテナ。`node` と `git` と `python3` が最初から入っている必要がある(拾い物は大抵どれかで動く)。
 * 中身の実測は docs/adr/0001 — jq・cargo・go・uv は**入っていない**ので、要るなら中で取る。
 */
const DEFAULT_IMAGE = "node:24-bookworm"
/**
 * 1回の走行の上限。**依存の取得は分単位で掛かる**ので、web の 20 秒とは桁が違う。
 *
 * 上限を tick の持ち時間(`OPEN_ZERO_TICK_TIMEOUT_MS`、既定 300 秒)より**短く**取ってある。
 * 走行が tick を食い切ると、その回は丸ごと落ちて**走った記録が1行も残らない** —
 * コンテナの中で起きたことはコンテナを捨てた時点で消えるので、書き残せなかった走行は無かったのと同じになる。
 * 長い作業は1回で終わらせず、同じ作業場に置いて次の tick で続ける。
 */
const DEFAULT_TIMEOUT_MS = 3 * 60_000
/** モデルに渡す上限。ビルドログは平気で数MB出るが、読ませたいのは詰まった箇所だけ。 */
const MAX_OUTPUT_CHARS = 12_000
/** コンテナに許す上限。**このホストは 11GB / 6コアで、tick 自身もここで動いている。** 走行が全部食うと自分が死ぬ。 */
const MEMORY = "2g"
const CPUS = "2"
const PIDS = "512"

export interface RunOptions {
  /** ホスト側の作業場。**ここだけが書ける**。`runDir()` が返す絶対パスを渡す。 */
  readonly workDir: string
  /** 外に出るか。既定は出ない。依存の取得(clone・install)が要るときだけ true。 */
  readonly net?: boolean
  readonly timeoutMs?: number
  readonly image?: string
}

export interface RunResult {
  readonly exitCode: number
  /** stdout と stderr を**出た順のまま**混ぜたもの。上限で切る。 */
  readonly output: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly elapsedMs: number
}

/** 走行の置き場。`.data/` の下に置くので gitignore 済みで、DB と同じく外には出ない。 */
export const runsRoot = (): string => resolve(process.env.OPEN_ZERO_RUNS ?? ".data/runs")

/**
 * 名前から作業場を1つ作って絶対パスを返す。
 *
 * **名前はモデルが書く。**`../` や絶対パスをそのまま繋ぐと、書き込みを許す場所が
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
  if (!dir.startsWith(`${root}/`)) throw new Error(`作業場が置き場の外に出る: ${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** docker の引数を組む。**組み立てだけを切り出してある**(実際に走らせずに検査できるように)。 */
export function dockerArgs(command: string, opts: RunOptions & { name: string }): string[] {
  return [
    "run",
    "--rm",
    "--name",
    opts.name,
    // 外向きは既定で閉じる。docker には宛先の allowlist が無いので、開くか閉じるかの二択になる。
    "--network",
    opts.net ? "bridge" : "none",
    "--memory",
    MEMORY,
    "--cpus",
    CPUS,
    "--pids-limit",
    PIDS,
    // **ユーザーの uid で走らせる。** 既定の root で作ったファイルは、後で tick(haru)が読めも消せもしない。
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    // uid を指定するとコンテナの中に home が無くなる。npm も pip も HOME を要求するので作業場を充てる。
    "-e",
    "HOME=/work",
    "-v",
    `${opts.workDir}:/work`,
    "-w",
    "/work",
    opts.image ?? process.env.OPEN_ZERO_RUN_IMAGE ?? DEFAULT_IMAGE,
    "bash",
    "-lc",
    command,
  ]
}

/**
 * 1回走らせる。**返すのは結果であって判断ではない** — 失敗も失敗のまま返す。
 *
 * 出力は stdout と stderr を混ぜる。分けて返すと、ビルド系のように進捗を stderr へ流す道具で
 * 「どのコマンドがどこで落ちたか」の前後関係が消える。読む側が要るのはその順序のほう。
 */
export async function runInSandbox(command: string, opts: RunOptions): Promise<RunResult> {
  if (!isAbsolute(opts.workDir)) throw new Error(`作業場は絶対パスで渡す: ${opts.workDir}`)
  const startedAt = Date.now()
  // コンテナの名前。**時刻で作る**(同じ走行を続けて呼んでも衝突しない)。時間切れのとき外から消すのに要る。
  const name = `oz-run-${startedAt.toString(36)}-${process.pid}`
  const child = spawn("docker", dockerArgs(command, { ...opts, name }), {
    stdio: ["ignore", "pipe", "pipe"],
  })

  let out = ""
  let timedOut = false
  const take = (chunk: Buffer): void => {
    // 上限を超えた分は捨てる。全部溜めてから切ると、暴走した install でこちら側の記憶が先に尽きる。
    if (out.length < MAX_OUTPUT_CHARS * 2) out += chunk.toString("utf8")
  }
  child.stdout.on("data", take)
  child.stderr.on("data", take)

  const timer = setTimeout(() => {
    timedOut = true
    // **クライアントを殺してもコンテナは生き残る。** docker の子は daemon 側にいるので、
    // プロセス木を落としても中身は走り続ける。名前を指して外から消す。
    spawn("docker", ["rm", "-f", name], { stdio: "ignore" }).on("error", () => {})
    child.kill("SIGKILL")
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  const exitCode = await new Promise<number>((done) => {
    child.on("error", (e) => {
      // docker そのものが無い/動いていないとき。**理由を出力に混ぜて返す**(例外で落とすと、
      // 呼んだ側は「コマンドが失敗した」と「走らせる手段が無い」を区別できない)。
      out += `\n[走らせられなかった] ${e.message}`
      done(127)
    })
    child.on("close", (code) => done(code ?? -1))
  })
  clearTimeout(timer)

  const truncated = out.length > MAX_OUTPUT_CHARS
  return {
    exitCode,
    // 切るなら**末尾を残す**。落ちた理由は最後に出る(先頭は依存の取得ログで埋まる)。
    output: truncated
      ? `…(頭を ${out.length - MAX_OUTPUT_CHARS}字ぶん省いた)\n${out.slice(-MAX_OUTPUT_CHARS)}`
      : out,
    truncated,
    timedOut,
    elapsedMs: Date.now() - startedAt,
  }
}
