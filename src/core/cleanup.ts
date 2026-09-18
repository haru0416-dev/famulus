/**
 * `~/.famulus/runs` の workspace は最後に触った時刻で、`run-cache` は容量上限で、1日1回削除する。
 * `events` は append-only なので対象外。
 */

import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Db } from "../services/Db.ts"
import { cacheRoot, runsRoot, sweepOrphans } from "../services/Sandbox.ts"
import { appConfig } from "./config.ts"
import { localDayRange, localHour, nowIso } from "./time.ts"
import { forgetWorkspaces, keptNames, mb, scanTree } from "./workspaces.ts"

export const CLEANUP_DAILY = "daily:cleanup"

/** 済みの印を付けるのは呼び出し側(src/cycle.ts)。 */
export const cleanupDue = (atIso: string) =>
  Effect.gen(function* () {
    if (localHour(atIso) < appConfig().schedule.cleanupHour) return false
    const db = yield* Db
    return (yield* db.meta(CLEANUP_DAILY)) !== localDayRange(atIso).key
  })

/** `kept`(`selfdev` など)は何日触られなくても残す必要があるので時刻を見ない。 */
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

/** 共有キャッシュは使い回すために置くので古さでは切らない。消えても次の走行が取得し直す。 */
const sweepCache = (dry: boolean, maxMb: number): number => {
  const root = cacheRoot()
  if (!existsSync(root)) return 0
  const t = scanTree(root)
  if (t.bytes <= maxMb * 1024 * 1024) return 0
  if (!dry) rmSync(root, { recursive: true, force: true })
  return t.bytes
}

export const cleanup = (opts?: {
  at?: string
  days?: number
  dry?: boolean
  cacheMaxMb?: number
  orphans?: (dry: boolean) => Promise<{ removed: string[]; kept: string[] }>
}) =>
  Effect.gen(function* () {
    const at = opts?.at ?? nowIso()
    const days = opts?.days ?? appConfig().cleanup.days
    const cutoffMs = Date.parse(at) - days * 86_400_000
    const dry = opts?.dry === true
    const maxMb = opts?.cacheMaxMb ?? appConfig().cleanup.cacheMaxMb

    const runs = sweepRuns(cutoffMs, dry, yield* keptNames)
    // 実体より先に記録を消すと、rmSync が失敗した回に keep 指定だけが消えて次回本体が消される。
    if (!dry) yield* forgetWorkspaces(runs.names)

    const cacheBytes = sweepCache(dry, maxMb)
    // docker が止まっていても他の掃除は失敗させない。
    const sweep = opts?.orphans ?? sweepOrphans
    const orphans = yield* Effect.promise(() => sweep(dry).catch(() => ({ removed: [], kept: [] })))

    // 削除条件は場所ごとに異なる(古さ / 上限 / 起動元プロセスの有無)ので、理由も場所ごとに書く。
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
