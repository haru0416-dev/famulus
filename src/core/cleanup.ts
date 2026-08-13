/**
 * `.data/` の下で放っておくと増え続けるものを、1日1回だけ落とす。
 *
 * 増えるものは2つあって、性質が違う。
 *
 * - `events`(`open-zero.db`)は append-only で、増えるのが正しい。ここは触らない。
 *   トリガが DELETE を塞いでいるので、間違って書いても通らない。
 * - `.data/runs/<名前>` はコンテナの作業場。中身は依存の取得物とビルドの残骸で、
 *   実測では 9.8MB のうち 8.7MB が npm のキャッシュだった。結果は DB に書く規律なので、
 *   ここに残っているものは次の回のための足場でしかない。ただし
 *   「長い作業は同じ作業場に置いて次の tick で続ける」(src/services/Sandbox.ts)ので、
 *   触られたばかりのものは消せない。最後に触った時刻で切る。
 *   ただし時刻では決まらないものが1つある — 自分のソースのように、何日か触らなくても
 *   在り続けなければならない場所。そこは `keep` で外す(src/core/workspaces.ts)。
 * - `.data/run-cache` は作業場をまたいで共有するパッケージの置き場。古さでは切らない —
 *   使い回すために置いてあるので、触られていないことは消してよい理由にならない。上限で切る。
 *   消えても次の走行が落とし直すだけなので、部分的に選ばずまるごと落とす。
 *
 * 増えるものはもう1つあって、こちらは `.data/` の外にいる。主のいないコンテナ
 * (`oz-run-*`)は tick 自身が落ちた回に残る。`sweepOrphans` が pid で見て消す。
 *
 * 3つ目だった `flue-tick.db` の掃除は落とした。tick の会話を日ごとに溜めていたのは
 * 枠(Flue)側で、道具ループを AI SDK に載せ替えたときに書き手がいなくなった。
 * 書かれない DB を刈る道具だけが残っていても、次に誰かが読むときに「まだ使っている」と読める。
 * 残っているファイルそのもの(`.data/flue-tick.db`)は消していない — 中身は過去の会話で、
 * 消すかどうかはユーザーが決める。
 *
 * モデルは呼ばない。全部 SQL とファイルの時刻で決まるので、枠を1回も使わずに毎日通せる。
 */

import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Db } from "../services/Db.ts"
import { cacheRoot, runsRoot, sweepOrphans } from "../services/Sandbox.ts"
import { dayRange, localHour, nowIso } from "./time.ts"
import { forgetWorkspaces, keptNames, mb, scanTree } from "./workspaces.ts"

/**
 * これより古いものを落とす。続きをやる作業場を消さない幅を取る。
 *
 * 環境変数で縮められるようにしてあるのは、端から端まで通して確かめるため —
 * 既定の 14 日だと、確かめたい日に落ちるものが無い。
 */
export const CLEANUP_DAYS = Number(process.env.OPEN_ZERO_CLEANUP_DAYS ?? 14)

/** その日ぶんを済ませたかどうかを置く場所。 */
export const CLEANUP_DAILY = "daily:cleanup"

/** ユーザーの時計でこの時刻を過ぎてから回す。見直し(dream)と同じ時間帯。 */
export const CLEANUP_HOUR = Number(process.env.OPEN_ZERO_CLEANUP_HOUR ?? 4)

/**
 * 共有キャッシュの上限(MB)。超えたらまるごと落とす。
 *
 * 2GB にしたのは、走行 30回ぶんの作業場が合計 1.4GB で、その中で重複していたのが
 * 184MB だったから(2026-08-13 の実測)。同じ調子で溜まっても月単位で届かない幅。
 */
export const CACHE_MAX_MB = Number(process.env.OPEN_ZERO_CACHE_MAX_MB ?? 2048)

/** この tick で回すかどうか。1日1回。印を付けるのは呼び出し側(src/tick.ts)。 */
export const cleanupDue = (atIso: string) =>
  Effect.gen(function* () {
    if (localHour(atIso) < CLEANUP_HOUR) return false
    const db = yield* Db
    return (yield* db.meta(CLEANUP_DAILY)) !== dayRange(atIso).key
  })

/**
 * 作業場のうち、しばらく触られていないものを落とす。
 *
 * `kept` は時刻を見ずに残す名前(src/core/workspaces.ts の `keep`)。自分のソースを置いた
 * `selfdev` のように、何日か触らなくても在り続けなければならない場所がある。
 * 時刻だけで切ると、直したい日に限って消えている。
 */
const sweepRuns = (
  cutoffMs: number,
  dry: boolean,
  kept: ReadonlySet<string>,
): { names: string[]; bytes: number } => {
  const root = runsRoot()
  if (!existsSync(root)) return { names: [], bytes: 0 }
  const names: string[] = []
  let bytes = 0
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || kept.has(e.name)) continue
    const dir = join(root, e.name)
    const t = scanTree(dir)
    if (t.newestMs >= cutoffMs) continue
    names.push(e.name)
    bytes += t.bytes
    if (!dry) rmSync(dir, { recursive: true, force: true })
  }
  return { names, bytes }
}

/**
 * 共有キャッシュが上限を超えていたら落とす。古さは見ない(使い回すために置いてある)。
 * 返すのは落とした量で、超えていなければ 0。
 */
const sweepCache = (dry: boolean, maxMb: number): number => {
  const root = cacheRoot()
  if (!existsSync(root)) return 0
  const t = scanTree(root)
  if (t.bytes <= maxMb * 1024 * 1024) return 0
  if (!dry) rmSync(root, { recursive: true, force: true })
  return t.bytes
}

/**
 * 1回通す。戻り値は DB に残す1行。
 *
 * `dry` は数えるだけで消さない。消すほうは取り消せないので、既定の確認手段はこちら。
 */
export const cleanup = (opts?: {
  at?: string
  days?: number
  dry?: boolean
  /** 共有キャッシュの上限(MB)。既定は CACHE_MAX_MB。 */
  cacheMaxMb?: number
  /** コンテナを数える手。ここだけホストの docker に触るので、検査では差し替える。 */
  orphans?: (dry: boolean) => Promise<{ removed: string[]; kept: string[] }>
}) =>
  Effect.gen(function* () {
    const at = opts?.at ?? nowIso()
    const days = opts?.days ?? CLEANUP_DAYS
    const cutoffMs = Date.parse(at) - days * 86_400_000
    const dry = opts?.dry === true
    const maxMb = opts?.cacheMaxMb ?? CACHE_MAX_MB

    const runs = sweepRuns(cutoffMs, dry, yield* keptNames)
    // 実体を消したら説明も落とす。順はこちらが後 — 先に消すと、rmSync が落ちた回に
    // 「消さない指定」だけが消えて、次の掃除で本体が持っていかれる。
    if (!dry) yield* forgetWorkspaces(runs.names)

    const cacheBytes = sweepCache(dry, maxMb)
    // docker が動いていない回もここへ来る。掃除の失敗で掃除そのものを落とさない。
    const sweep = opts?.orphans ?? sweepOrphans
    const orphans = yield* Effect.promise(() => sweep(dry).catch(() => ({ removed: [], kept: [] })))

    // 切り口を場所ごとに書く。3つとも別の理由で落ちる(古さ / 上限 / 主の生死)ので、
    // 「14 日より古いもの」を全体に掛けると、キャッシュとコンテナの落ち方を読み違える。
    const parts: string[] = []
    if (runs.names.length > 0)
      parts.push(`作業場 ${runs.names.length} 件(${mb(runs.bytes)}、${days} 日より古い)`)
    if (cacheBytes > 0) parts.push(`共有キャッシュ(${mb(cacheBytes)}、上限 ${maxMb}MB 超え)`)
    if (orphans.removed.length > 0) parts.push(`主のいないコンテナ ${orphans.removed.length} 件`)
    const head = dry ? "cleanup(数えただけ)" : "cleanup"
    if (parts.length === 0)
      return `${head}: 落とすものは無かった(作業場は ${days} 日、キャッシュは ${maxMb}MB で切る)`
    return `${head}: ${parts.join(" / ")} を落とした`
  })
