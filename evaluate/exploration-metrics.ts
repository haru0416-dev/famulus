#!/usr/bin/env bun
/**
 * 探索の計器。実DB(読み取り専用)から、探索がどれだけ・どこまで届いているかを数える。
 * モデルは呼ばない。`bun run eval:exploration` で実行。
 *
 * 出す数字:
 *   1. dossier の数と [explore] 比率(fan-out が実際に使われているか)
 *   2. 問いの重複率(同じ問いを繰り返しているか)
 *   3. 出典ドメインの新規到達率 — dossier を時系列に並べ、各回の出典のうち過去に
 *      一度も出ていないドメインの割合。低いほど同じ先を回っている。
 *   4. 空振り・圏外の記録数
 */
import { Database } from "bun:sqlite"
import { configureApp } from "../src/core/config.ts"
import { loadEnv } from "../src/core/env.ts"

loadEnv()
const config = configureApp()
const db = new Database(config.paths.db, { readonly: true })

interface DossierRow {
  id: string
  question: string
  created_at: string
}

const dossiers = db
  .query("SELECT id, question, created_at FROM research_dossiers ORDER BY created_at")
  .all() as DossierRow[]

const exploreCount = dossiers.filter((d) => d.question.startsWith("[explore]")).length

// ── 問いの重複。語の集合の Jaccard 係数 0.6 以上を「同じ問い」と数える。
// 日本語は助詞で切れず1連なりになるので、長い連なりは2文字ずつに割る。
const tokens = (s: string): Set<string> => {
  const out = new Set<string>()
  for (const run of s
    .toLowerCase()
    .replace(/\[explore\]/g, "")
    .split(/[^a-z0-9ぁ-んァ-ヶ一-龠ー]+/)) {
    if (run.length < 2) continue
    if (/^[a-z0-9]+$/.test(run) || run.length <= 4) out.add(run)
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return out
}
const jaccard = (a: Set<string>, b: Set<string>): number => {
  const shared = [...a].filter((x) => b.has(x)).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : shared / union
}
let duplicatePairs = 0
for (let i = 0; i < dossiers.length; i++) {
  for (let j = i + 1; j < dossiers.length; j++) {
    const a = dossiers[i]
    const b = dossiers[j]
    if (a && b && jaccard(tokens(a.question), tokens(b.question)) >= 0.6) duplicatePairs++
  }
}

// ── 出典ドメインの新規到達率。source_ref(取得元 URL)のホスト名で数える。
const artifactRows = db
  .query(
    `SELECT a.dossier_id, a.source_ref FROM research_artifacts a
      WHERE a.source_ref IS NOT NULL ORDER BY a.created_at`,
  )
  .all() as { dossier_id: string; source_ref: string }[]
const domainsOf = new Map<string, Set<string>>()
for (const row of artifactRows) {
  let host: string
  try {
    host = new URL(row.source_ref).hostname.replace(/^www\./, "")
  } catch {
    continue
  }
  const got = domainsOf.get(row.dossier_id) ?? new Set()
  got.add(host)
  domainsOf.set(row.dossier_id, got)
}
const seen = new Set<string>()
const series: string[] = []
let newTotal = 0
let domainTotal = 0
for (const d of dossiers) {
  const domains = domainsOf.get(d.id)
  if (!domains || domains.size === 0) continue
  const fresh = [...domains].filter((x) => !seen.has(x))
  newTotal += fresh.length
  domainTotal += domains.size
  series.push(
    `  ${d.created_at.slice(0, 10)} 既知${String(seen.size).padStart(3)} 出典${domains.size} 新規${fresh.length} ${d.question.slice(0, 40)}`,
  )
  for (const x of domains) seen.add(x)
}

const missNotes = db
  .query(
    `SELECT COUNT(*) n FROM research_claims WHERE statement LIKE '[explore:空振り]%' OR statement LIKE '[explore:圏外]%'`,
  )
  .get() as { n: number }

const pct = (a: number, b: number): string => (b === 0 ? "-" : `${Math.round((a / b) * 100)}%`)
console.log(`dossier: ${dossiers.length} 件(うち explore 経由 ${exploreCount})`)
console.log(`問いの重複対(Jaccard≥0.6): ${duplicatePairs}`)
console.log(`出典ドメイン: 累計 ${seen.size} 種 / 新規到達率 ${pct(newTotal, domainTotal)}(新規 ${newTotal} / 延べ ${domainTotal})`)
console.log(`空振り・圏外の記録: ${missNotes.n} 件`)
console.log("時系列(既知=それまでに見たドメイン数):")
for (const line of series) console.log(line)
db.close()
