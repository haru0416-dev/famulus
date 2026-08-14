/**
 * `.data/` の下で放っておくと増え続けるものを、1日1回だけ削除する。
 *
 * 対象ごとに増え方と寿命が異なる。
 *
 * - `events`(`open-zero.db`)は append-only で、増えるのが正しい。ここは触らない。
 *   トリガが DELETE を拒否するので、間違って書いても通らない。
 * - `.data/runs/<名前>` はコンテナの workspace。中身は依存の取得物とビルドの残骸で、
 *   測定した workspace では 9.8MB のうち 8.7MB が npm のキャッシュだった。結果は DB に書く規律なので、
 *   ここに残っているものは次回再開用の作業データでしかない。ただし
 *   「長い作業は同じ workspace に置いて次回続ける」(src/services/Sandbox.ts)ので、
 *   触られたばかりのものは消せない。最後に触った時刻で切る。
 *   ただし時刻では決まらないものが1つある — 自分のソースのように、何日か触らなくても
 *   在り続けなければならない場所。そこは `keep` で外す(src/core/workspaces.ts)。
 * - `.data/run-cache` は workspace をまたいで共有するパッケージの置き場。古さでは切らない —
 *   使い回すために置いてあるので、触られていないことは消してよい理由にならない。上限で切る。
 *   消えても次の走行が取得し直すだけなので、部分的に選ばずまるごと削除する。
 *
 * 増えるものはもう1つあって、こちらは `.data/` の外にいる。対応するホストプロセスが存在しないコンテナ
 * (`oz-run-*`)は cycle 自身が停止した回に残る。`sweepOrphans` が pid で判定して削除する。
 *
 * 3つ目だった `flue-tick.db` の掃除は廃止した。tick の会話を日ごとに溜めていたのは
 * Flue ランタイム側で、道具ループを AI SDK に載せ替えたときに書き手がいなくなった。
 * 書かれない DB を削除する処理だけが残っていても、次に誰かが読むときに「まだ使っている」と読める。
 * 残っているファイルそのもの(`.data/flue-tick.db`)は消していない — 中身は過去の会話で、
 * 消すかどうかはユーザーが決める。
 *
 * モデルは呼ばない。DB、ファイルの時刻・容量、Docker コンテナの主プロセス生存判定だけで決める。
 */

import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Db } from "../services/Db.ts"
import { cacheRoot, runsRoot, sweepOrphans } from "../services/Sandbox.ts"
import { localDayRange, localHour, nowIso } from "./time.ts"
import { forgetWorkspaces, keptNames, mb, scanTree } from "./workspaces.ts"

/**
 * これより古いものを削除する。続きをやる workspace を消さない期間を取る。
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
 * 共有キャッシュの上限(MB)。超えたらまるごと削除する。
 *
 * 2GB にしたのは、走行 30回ぶんの workspace が合計 1.4GB で、その中で重複していたのが
 * 184MB だったから。同じ調子で溜まっても月単位で届かない幅。
 */
export const CACHE_MAX_MB = Number(process.env.OPEN_ZERO_CACHE_MAX_MB ?? 2048)

/** この cycle で回すかどうか。1日1回。印を付けるのは呼び出し側(src/cycle.ts)。 */
export const cleanupDue = (atIso: string) =>
  Effect.gen(function* () {
    if (localHour(atIso) < CLEANUP_HOUR) return false
    const db = yield* Db
    return (yield* db.meta(CLEANUP_DAILY)) !== localDayRange(atIso).key
  })

/**
 * workspace のうち、しばらく触られていないものを削除する。
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
 * 共有キャッシュが上限を超えていたら削除する。古さは見ない(使い回すために置いてある)。
 * 返すのは削除した量で、超えていなければ 0。
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
  /** コンテナ列挙処理。ここだけホストの docker に触るので、検査では差し替える。 */
  orphans?: (dry: boolean) => Promise<{ removed: string[]; kept: string[] }>
}) =>
  Effect.gen(function* () {
    const at = opts?.at ?? nowIso()
    const days = opts?.days ?? CLEANUP_DAYS
    const cutoffMs = Date.parse(at) - days * 86_400_000
    const dry = opts?.dry === true
    const maxMb = opts?.cacheMaxMb ?? CACHE_MAX_MB

    const runs = sweepRuns(cutoffMs, dry, yield* keptNames)
    // 実体を消したら説明も削除する。順はこちらが後 — 先に消すと、rmSync が失敗した回に
    // 「消さない指定」だけが消えて、次の掃除で本体が持っていかれる。
    if (!dry) yield* forgetWorkspaces(runs.names)

    const cacheBytes = sweepCache(dry, maxMb)
    // docker が動いていない回もここへ来る。コンテナ掃除の失敗で他の掃除まで失敗させない。
    const sweep = opts?.orphans ?? sweepOrphans
    const orphans = yield* Effect.promise(() => sweep(dry).catch(() => ({ removed: [], kept: [] })))

    // 削除理由を場所ごとに書く。3つとも条件が異なる(古さ / 上限 / 起動元プロセスの有無)ので、
    // 「14 日より古いもの」を全体に掛けると、キャッシュとコンテナの削除条件を読み違える。
    const parts: string[] = []
    if (runs.names.length > 0)
      parts.push(`workspace ${runs.names.length} 件(${mb(runs.bytes)}、${days} 日より古い)`)
    if (cacheBytes > 0) parts.push(`共有キャッシュ(${mb(cacheBytes)}、上限 ${maxMb}MB 超え)`)
    if (orphans.removed.length > 0)
      parts.push(`起動元プロセスが存在しないコンテナ ${orphans.removed.length} 件`)
    const head = dry ? "cleanup(数えただけ)" : "cleanup"
    if (parts.length === 0)
      return `${head}: 削除対象は無かった(workspace は ${days} 日、キャッシュは ${maxMb}MB で判定)`
    return dry ? `${head}: ${parts.join(" / ")} が削除対象` : `${head}: ${parts.join(" / ")} を削除した`
  })
