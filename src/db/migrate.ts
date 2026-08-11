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
 * 入力トークンは3つに割れて返るのに、台帳は2つしか持っていなかった。**落ちていたのが一番大きい列**で、
 * 実測では `input_tokens: 2` / `cache_creation_input_tokens: 904` — 台帳の in_tok=2 は嘘ではないが、
 * これを「入力」として読むと実際の 1/450 になる。既存行は当時の値が復元できないので 0 のまま置く
 * (**推測で埋めない**)。0 と「本当に 0 だった」の区別が要るなら at で切る。
 */
function ledgerCacheWrite(d: DatabaseSync): boolean {
  const cols = columns(d, "ledger")
  if (cols.length === 0 || cols.includes("cache_write")) return false
  d.exec("ALTER TABLE ledger ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0")
  return true
}

/** 適用したものの名前を返す。何も要らなければ空。 */
export function migrate(d: DatabaseSync): string[] {
  const applied: string[] = []
  if (bitemporalBeliefSlots(d)) applied.push("belief_slots:bitemporal")
  if (ledgerCacheWrite(d)) applied.push("ledger:cache_write")
  return applied
}
