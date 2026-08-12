/**
 * `.data/` の下で**放っておくと増え続けるもの**を、1日1回だけ落とす。
 *
 * 増えるものは3つあって、性質が違う。
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
 * - `flue-tick.db` は tick の会話の保存先。会話 id は `tick-<その日>` で日ごとに変わり、
 *   **過ぎた日の会話は二度と開かれない**。読まれないまま残る。
 *
 * モデルは呼ばない。全部 SQL とファイルの時刻で決まるので、枠を1回も使わずに毎日通せる。
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
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

const flueDb = (): string => process.env.OPEN_ZERO_FLUE_DB ?? ".data/flue-tick.db"

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

/** 会話 id から日付を取る。`tick-YYYY-MM-DD` の形だけを対象にする。 */
const dayOfPath = (path: string): string | undefined => /(?:^|\/)tick-(\d{4}-\d{2}-\d{2})$/.exec(path)?.[1]

/**
 * 読まれない会話を落とす。**形が分かるものだけ**を対象にし、
 * それ以外の path には触らない — Flue 側の持ち物なので、読めない形を推測で消さない。
 */
const sweepConversations = (
  file: string,
  cutoffDay: string,
  dry: boolean,
): { paths: string[]; before: number; after: number } => {
  if (!existsSync(file)) return { paths: [], before: 0, after: 0 }
  const before = statSync(file).size
  const db = new DatabaseSync(file)
  try {
    // 表の一覧を先に取る。**Flue 側の schema は向こうの持ち物**で、版が上がれば表も変わる。
    // 無い表に DELETE を撃つと落ちるので、有るものだけを対象にする。
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (t) => t.name,
      ),
    )
    if (!tables.has("flue_conversation_streams")) return { paths: [], before, after: before }
    const rows = db.prepare("SELECT path FROM flue_conversation_streams").all() as { path: string }[]
    const stale = rows.filter((r) => {
      const day = dayOfPath(r.path)
      return day !== undefined && day < cutoffDay
    })
    if (stale.length === 0 || dry) return { paths: stale.map((s) => s.path), before, after: before }

    // 会話1本ぶんを全部の表から落とす。**順は子から**(外部キーが張ってある表がある)。
    const byPath = (
      [
        ["flue_conversation_stream_batch_chunks", "path"],
        ["flue_conversation_stream_batches", "path"],
        ["flue_conversation_fold_checkpoint_chunks", "path"],
        ["flue_conversation_fold_checkpoints", "path"],
        ["flue_attachment_chunks", "stream_path"],
        ["flue_attachments", "stream_path"],
        ["flue_conversation_streams", "path"],
      ] as const
    )
      .filter(([t]) => tables.has(t))
      .map(([t, col]) => `DELETE FROM ${t} WHERE ${col} = ?`)
    db.exec("BEGIN")
    try {
      for (const p of stale.map((s) => s.path)) {
        // 投入の記録は session_key(JSON 文字列)側にしか会話 id を持っていない。
        const conv = p.slice(p.lastIndexOf("/") + 1)
        if (tables.has("flue_agent_submissions")) {
          const subs = db
            .prepare("SELECT submission_id FROM flue_agent_submissions WHERE session_key LIKE ?")
            .all(`%"${conv}"%`) as { submission_id: string }[]
          if (tables.has("flue_submission_chunks")) {
            const delChunk = db.prepare("DELETE FROM flue_submission_chunks WHERE submission_id = ?")
            for (const s of subs) delChunk.run(s.submission_id)
          }
          db.prepare("DELETE FROM flue_agent_submissions WHERE session_key LIKE ?").run(`%"${conv}"%`)
        }
        for (const sql of byPath) db.prepare(sql).run(p)
      }
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
    // **消しただけではファイルは縮まない。** 空いた頁を返させる。
    db.exec("VACUUM")
    return { paths: stale.map((s) => s.path), before, after: statSync(file).size }
  } finally {
    db.close()
  }
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
    const cutoffDay = dayRange(new Date(cutoffMs).toISOString()).key
    const dry = opts?.dry === true

    const runs = sweepRuns(cutoffMs, dry, yield* keptNames)
    // 実体を消したら説明も落とす。**順はこちらが後** — 先に消すと、rmSync が落ちた回に
    // 「消さない指定」だけが消えて、次の掃除で本体が持っていかれる。
    if (!dry) yield* forgetWorkspaces(runs.names)
    const conv = sweepConversations(flueDb(), cutoffDay, dry)

    const parts: string[] = []
    if (runs.names.length > 0) parts.push(`作業場 ${runs.names.length} 件(${mb(runs.bytes)})`)
    if (conv.paths.length > 0) {
      const shrunk = conv.before - conv.after
      parts.push(`会話 ${conv.paths.length} 本(${shrunk > 0 ? mb(shrunk) : "縮まらず"})`)
    }
    const head = dry ? "cleanup(数えただけ)" : "cleanup"
    if (parts.length === 0) return `${head}: 落とすものは無かった(${days} 日より古いもの)`
    return `${head}: ${parts.join(" / ")} を落とした(${days} 日より古いもの)`
  })
