/**
 * `.data/` の下で**放っておくと増え続けるもの**を、1日1回だけ落とす。
 *
 * 増えるものは2つあって、性質が違う。
 *
 * - `events`(`open-zero.db`)は append-only で、**増えるのが正しい**。ここは触らない。
 *   トリガが DELETE を塞いでいるので、間違って書いても通らない。
 * - `.data/runs/<名前>` はコンテナの作業場。中身は依存の取得物とビルドの残骸で、
 *   実測では 9.8MB のうち 8.7MB が npm のキャッシュだった。**結果は DB に書く規律**なので、
 *   ここに残っているものは次の回のための足場でしかない。ただし
 *   「長い作業は同じ作業場に置いて次の tick で続ける」(src/services/Sandbox.ts)ので、
 *   触られたばかりのものは消せない。**最後に触った時刻**で切る。
 *   ただし時刻では決まらないものが1つある — 自分のソースのように、何日か触らなくても
 *   在り続けなければならない場所。そこは `keep` で外す(src/core/workspaces.ts)。
 *
 * **3つ目だった `flue-tick.db` の掃除は落とした。** tick の会話を日ごとに溜めていたのは
 * 枠(Flue)側で、道具ループを AI SDK に載せ替えたときに書き手がいなくなった。
 * 書かれない DB を刈る道具だけが残っていても、次に誰かが読むときに「まだ使っている」と読める。
 * 残っているファイルそのもの(`.data/flue-tick.db`)は消していない — 中身は過去の会話で、
 * 消すかどうかはユーザーが決める。
 *
 * モデルは呼ばない。全部 SQL とファイルの時刻で決まるので、枠を1回も使わずに毎日通せる。
 */

import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { Db } from "../services/Db.ts"
import { runsRoot } from "../services/Sandbox.ts"
import { dayRange, localHour, nowIso } from "./time.ts"
import { forgetWorkspaces, keptNames, mb, scanTree } from "./workspaces.ts"

/**
 * これより古いものを落とす。**続きをやる作業場を消さない**幅を取る。
 *
 * 環境変数で縮められるようにしてあるのは、端から端まで通して確かめるため —
 * 既定の 14 日だと、確かめたい日に落ちるものが無い。
 */
export const CLEANUP_DAYS = Number(process.env.OPEN_ZERO_CLEANUP_DAYS ?? 14)

/** その日ぶんを済ませたかどうかを置く場所。 */
export const CLEANUP_DAILY = "daily:cleanup"

/** ユーザーの時計でこの時刻を過ぎてから回す。見直し(dream)と同じ時間帯。 */
export const CLEANUP_HOUR = Number(process.env.OPEN_ZERO_CLEANUP_HOUR ?? 4)

/** この tick で回すかどうか。**1日1回**。印を付けるのは呼び出し側(src/tick.ts)。 */
export const cleanupDue = (atIso: string) =>
  Effect.gen(function* () {
    if (localHour(atIso) < CLEANUP_HOUR) return false
    const db = yield* Db
    return (yield* db.meta(CLEANUP_DAILY)) !== dayRange(atIso).key
  })

/**
 * 作業場のうち、しばらく触られていないものを落とす。
 *
 * `kept` は**時刻を見ずに残す**名前(src/core/workspaces.ts の `keep`)。自分のソースを置いた
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
 * 1回通す。戻り値は DB に残す1行。
 *
 * `dry` は数えるだけで消さない。**消すほうは取り消せない**ので、既定の確認手段はこちら。
 */
export const cleanup = (opts?: { at?: string; days?: number; dry?: boolean }) =>
  Effect.gen(function* () {
    const at = opts?.at ?? nowIso()
    const days = opts?.days ?? CLEANUP_DAYS
    const cutoffMs = Date.parse(at) - days * 86_400_000
    const dry = opts?.dry === true

    const runs = sweepRuns(cutoffMs, dry, yield* keptNames)
    // 実体を消したら説明も落とす。**順はこちらが後** — 先に消すと、rmSync が落ちた回に
    // 「消さない指定」だけが消えて、次の掃除で本体が持っていかれる。
    if (!dry) yield* forgetWorkspaces(runs.names)

    const parts: string[] = []
    if (runs.names.length > 0) parts.push(`作業場 ${runs.names.length} 件(${mb(runs.bytes)})`)
    const head = dry ? "cleanup(数えただけ)" : "cleanup"
    if (parts.length === 0) return `${head}: 落とすものは無かった(${days} 日より古いもの)`
    return `${head}: ${parts.join(" / ")} を落とした(${days} 日より古いもの)`
  })
