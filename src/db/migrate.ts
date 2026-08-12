/**
 * 既に中身のある DB を新しいスキーマに合わせる。
 *
 * `schema.sql` は全部 `CREATE TABLE IF NOT EXISTS` なので、**既存のテーブルには一切効かない**。
 * 形を変えたければここで明示的に作り直すしかない。schema.sql を適用する**前**に呼ぶ:
 * 先に旧い形を新しい形へ寄せておけば、あとは `IF NOT EXISTS` が素通りするだけで済む。
 *
 * どれも冪等。掛かっていなければ掛け、掛かっていれば何もしない。
 * **正本(`events`)には触らない。** ここで作り直すのは projection だけで、
 * 万一壊しても events から引き直せる、という前提を崩さない。
 */
import type { DatabaseSync } from "node:sqlite"

const columns = (d: DatabaseSync, table: string): string[] => {
  try {
    return (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  } catch {
    return []
  }
}

/**
 * belief_slots を bitemporal にする(slot ごと1行 → slot ごとに区間の並び)。
 *
 * 旧い行は「いつから真だったか」を持っていない。**そこを推測で埋めない。**
 * 台帳が知った時刻(`updated_at`)をそのまま `valid_from` に置く — これは
 * 「いつからかは分からないが、遅くともこの時点では真だった」という、記録として正しい読み。
 */
function bitemporalBeliefSlots(d: DatabaseSync): boolean {
  const cols = columns(d, "belief_slots")
  if (cols.length === 0 || cols.includes("valid_from")) return false

  d.exec("ALTER TABLE belief_slots RENAME TO belief_slots_v1")
  d.exec(`
    CREATE TABLE belief_slots (
      slot         TEXT NOT NULL,
      value        TEXT CHECK (value IS NULL OR json_valid(value)),
      exposure     TEXT NOT NULL CHECK (exposure IN ('private','public')),
      resolved_from TEXT NOT NULL REFERENCES events(id),
      updated_at   TEXT NOT NULL,
      valid_from   TEXT NOT NULL,
      valid_until  TEXT,
      invalidated_by     TEXT REFERENCES events(id),
      invalidated_reason TEXT,
      PRIMARY KEY (slot, valid_from)
    )`)
  d.exec(`
    INSERT INTO belief_slots (slot, value, exposure, resolved_from, updated_at, valid_from)
    SELECT slot, value, exposure, resolved_from, updated_at, updated_at FROM belief_slots_v1`)
  d.exec("DROP TABLE belief_slots_v1")
  return true
}

/**
 * ledger に cache_write を足す。
 *
 * 入力トークンは3つに割れて返るのに、台帳は2つしか持っていなかった。落ちていたのは
 * `cache_creation_input_tokens` で、ここが素の `input_tokens` を桁で上回る。
 * これが無いと `in_tok` を「入力」として読んだ人が実際よりはるかに小さい値を見る。
 * 既存行は当時の値が復元できないので 0 のまま置く(**推測で埋めない**)。
 * 0 と「本当に 0 だった」の区別が要るなら at で切る。
 */
function ledgerCacheWrite(d: DatabaseSync): boolean {
  const cols = columns(d, "ledger")
  if (cols.length === 0 || cols.includes("cache_write")) return false
  d.exec("ALTER TABLE ledger ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0")
  return true
}

/**
 * watchlist に発火の記録を足す(docs/adr/0013)。
 *
 * 既存行の `last_run_at` は NULL のまま置く。**「まだ一度も回していない」と読むのが記録として正しい**
 * — 回した跡はどこにも残っていないので、`opened_at` や `last_activity_at` で埋めると
 * 回していないものを回したことにする。NULL は最初の心拍で1回だけ机に載り、そこから冷却が始まる。
 */
function watchlistFiring(d: DatabaseSync): boolean {
  const cols = columns(d, "watchlist")
  if (cols.length === 0 || cols.includes("last_run_at")) return false
  d.exec("ALTER TABLE watchlist ADD COLUMN last_run_at TEXT")
  d.exec("ALTER TABLE watchlist ADD COLUMN cooldown_hours REAL NOT NULL DEFAULT 24")
  d.exec("ALTER TABLE watchlist ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0")
  d.exec("ALTER TABLE watchlist ADD COLUMN last_result TEXT")
  return true
}

/**
 * 読み書きする側の無い卓を落とす(docs/adr/0007)。
 *
 * `schema.sql` から消しても `IF NOT EXISTS` は既存の DB に効かないので、卓は残り続ける。
 * 残ると `.schema` を読んだ側が「その仕組みが在る」と読む — 消したい理由がそれなので、実物も落とす。
 *
 * **空のときだけ落とす。** 行があるなら、それは想定と違うことが起きている印で、
 * ここで消してよいものではない。名前を返さないので、残ったことは表に出ない。
 */
const DROPPED = [
  "execution_attempts",
  "outbox",
  "schedule",
  "thread_map",
  "feedback_weights",
  "owner_allowlist",
]

function dropUnusedTables(d: DatabaseSync): string[] {
  const gone: string[] = []
  for (const t of DROPPED) {
    if (columns(d, t).length === 0) continue
    const row = d.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number } | undefined
    if ((row?.n ?? 0) > 0) continue
    d.exec(`DROP TABLE ${t}`)
    gone.push(t)
  }
  return gone
}

/** 適用したものの名前を返す。何も要らなければ空。 */
export function migrate(d: DatabaseSync): string[] {
  const applied: string[] = []
  if (bitemporalBeliefSlots(d)) applied.push("belief_slots:bitemporal")
  if (ledgerCacheWrite(d)) applied.push("ledger:cache_write")
  if (watchlistFiring(d)) applied.push("watchlist:firing")
  for (const t of dropUnusedTables(d)) applied.push(`drop:${t}`)
  return applied
}
