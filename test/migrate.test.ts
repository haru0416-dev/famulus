/**
 * マイグレーションの検査。**中身の入った DB で確かめる。**
 *
 * `schema.sql` は全部 `CREATE TABLE IF NOT EXISTS` なので、空の DB では新旧どちらの形も
 * 同じように「通ってしまう」。壊れるのは既に行がある DB のときだけで、しかも壊れ方は静かで、
 * 気付くのはユーザーが古い事実を喋られたときになる。だから旧い形を手で作ってから掛ける。
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { Effect } from "effect"
import { migrate } from "../src/db/migrate.ts"
import { openDb } from "../src/db/sqlite.ts"
import { RunnerStub } from "../src/model/Runner.ts"
import { makeRuntime } from "../src/runtime.ts"
import { Db, DbLive } from "../src/services/Db.ts"
import { Memory } from "../src/services/Memory.ts"

let ROOT = ""
before(() => {
  ROOT = mkdtempSync(join(tmpdir(), "oz-migrate-"))
})
after(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

/** v1 の形(slot が PRIMARY KEY、区間を持たない)を、行ごと手で作る。 */
function makeV1(path: string): void {
  const d = openDb(path)
  d.exec("PRAGMA foreign_keys = ON;")
  d.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
      taint INTEGER NOT NULL DEFAULT 0, exposure TEXT NOT NULL DEFAULT 'private',
      supersedes TEXT, provenance TEXT NOT NULL DEFAULT '[]', content TEXT
    );
    CREATE TABLE belief_slots (
      slot TEXT PRIMARY KEY,
      value TEXT,
      exposure TEXT NOT NULL,
      resolved_from TEXT NOT NULL REFERENCES events(id),
      updated_at TEXT NOT NULL
    );
    INSERT INTO events (id, at, kind, source, content)
      VALUES ('ev1', '2026-01-01T00:00:00Z', 'belief', 'system', '{"slot":"home.city"}');
    INSERT INTO belief_slots (slot, value, exposure, resolved_from, updated_at)
      VALUES ('home.city', '"札幌"', 'private', 'ev1', '2026-01-01T00:00:00Z');
  `)
  d.close()
}

test("旧い形の DB は開くだけで新しい形になる — 行は落ちない", async () => {
  const path = join(ROOT, "v1.db")
  makeV1(path)

  const rt = makeRuntime(DbLive(path), RunnerStub([{ text: "ok" }]).layer)
  try {
    const out = await rt.runPromise(
      Effect.gen(function* () {
        const mem = yield* Memory
        const cur = yield* mem.belief("home.city")
        // 区間を継げること = 新しい形として本当に動いていること。
        yield* mem.believe("home.city", "東京", { validFrom: "2026-06-01T00:00:00Z" })
        return { cur, after: yield* mem.belief("home.city"), hist: yield* mem.beliefHistory("home.city") }
      }),
    )
    assert.equal(out.cur?.value, "札幌", "既にあった行が消えていない")
    // **いつから真だったかは旧い形には無い。** 推測せず「DB が知った時刻」をそのまま置く。
    assert.equal(out.cur?.validFrom, "2026-01-01T00:00:00Z")
    assert.equal(out.cur?.validUntil, null)
    assert.equal(out.after?.value, "東京")
    assert.equal(out.hist.length, 2, "移行後の DB でも区間が継げる")
  } finally {
    await rt.dispose()
  }
})

test("掛かっている DB に二度掛けても何も起きない", () => {
  const path = join(ROOT, "twice.db")
  makeV1(path)
  const d = openDb(path)
  assert.deepEqual(migrate(d), ["belief_slots:bitemporal"], "1回目は掛かる")
  assert.deepEqual(migrate(d), [], "2回目は何もしない")
  const rows = d.prepare("SELECT slot, valid_from FROM belief_slots").all() as { slot: string }[]
  assert.equal(rows.length, 1, "二度掛けても行が増えない・消えない")
  d.close()
})

test("cache_write の無い ledger は列が足され、既存の行は残る", () => {
  const path = join(ROOT, "ledger-v1.db")
  const d = openDb(path)
  d.exec(`
    CREATE TABLE ledger (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, role TEXT, model TEXT,
      in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
      unpriced INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO ledger (id, at, kind, role, in_tok, out_tok)
      VALUES ('l1', '2026-08-01T00:00:00Z', 'run', 'dialogue', 2, 500);
  `)
  assert.deepEqual(migrate(d), ["ledger:cache_write"], "1回目は掛かる")
  assert.deepEqual(migrate(d), [], "2回目は何もしない")
  const row = d.prepare("SELECT in_tok, out_tok, cache_write FROM ledger").get() as Record<string, number>
  // **過去の行は復元できない。** 当時の cache_creation は残っていないので 0 のまま置く(推測で埋めない)。
  assert.deepEqual([row.in_tok, row.out_tok, row.cache_write], [2, 500, 0])
  d.close()
})

test("発火の記録を持たない watchlist は列が足され、既存の watch は「まだ回していない」になる", () => {
  const path = join(ROOT, "watchlist-v1.db")
  const d = openDb(path)
  d.exec(`
    CREATE TABLE watchlist (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, opened_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL, next_move_owner TEXT NOT NULL, status TEXT NOT NULL,
      source_ref TEXT
    );
    INSERT INTO watchlist (id, subject, opened_at, last_activity_at, next_move_owner, status)
      VALUES ('w1', 'AI追跡', '2026-08-01T00:00:00Z', '2026-08-05T00:00:00Z', 'famulus', 'open');
  `)
  assert.deepEqual(migrate(d), ["watchlist:firing", "watchlist:shown"], "1回目は掛かる")
  assert.deepEqual(migrate(d), [], "2回目は何もしない")
  const row = d
    .prepare("SELECT last_run_at, cooldown_hours, run_count, last_result, last_shown_at FROM watchlist")
    .get() as Record<string, unknown> | null
  assert.ok(row, "移行したはずの行が引けない")
  // **回した跡も載せた跡もどこにも残っていない。** `opened_at` で埋めると、
  // 回していないものを回したことにし、載せていないものを載せたことにする。
  assert.deepEqual(
    { ...row },
    { last_run_at: null, cooldown_hours: 24, run_count: 0, last_result: null, last_shown_at: null },
  )
  d.close()
})

test("結論の置き場を持たない proposals は列が足され、既存の提案は「まだ何も言っていない」になる", () => {
  const path = join(ROOT, "proposals-v1.db")
  const d = openDb(path)
  d.exec(`
    CREATE TABLE proposals (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL,
      summary TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    INSERT INTO proposals (id, kind, created_at, summary, status, expires_at)
      VALUES ('p1', 'plan', '2026-08-08T09:00:00Z', '歯医者に変更依頼', 'proposed', '2026-08-15T09:00:00Z');
  `)
  assert.deepEqual(migrate(d), ["proposals:settled"], "1回目は掛かる")
  assert.deepEqual(migrate(d), [], "2回目は何もしない")
  const row = d.prepare("SELECT settled_at, settled_note FROM proposals").get() as Record<string, unknown>
  // **言った跡はどこにも残っていない。** created_at で埋めると、言っていないものを言ったことにする。
  assert.deepEqual({ ...row }, { settled_at: null, settled_note: null })
  d.close()
})

test("外した経路の印は落ちる — 残すと「まだその経路がある」と読まれる", () => {
  const path = join(ROOT, "ntfy-cursor.db")
  const d = openDb(path)
  d.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value)VALUES ('ntfy:in_cursor', '5iTGgng7sRsd'), ('tick:last', '2026-08-13T04:39:35Z');
  `)
  assert.deepEqual(migrate(d), ["drop:ntfy_cursor"], "1回目は落ちる")
  assert.deepEqual(migrate(d), [], "2回目は何もしない")
  const rows = d.prepare("SELECT key FROM schema_meta ORDER BY key").all() as { key: string }[]
  // **他の印は巻き込まない。** tick の記録が消えると、動いていた事実が消える。
  assert.deepEqual(
    rows.map((r) => r.key),
    ["tick:last"],
  )
  d.close()
})

test("読み書きする側の無いテーブルは、空なら落ちる", () => {
  const path = join(ROOT, "unused.db")
  const d = openDb(path)
  d.exec("CREATE TABLE outbox (id TEXT PRIMARY KEY, destination_key TEXT);")
  d.exec("CREATE TABLE schedule (id TEXT PRIMARY KEY);")
  assert.deepEqual(migrate(d), ["drop:outbox", "drop:schedule"])
  assert.deepEqual(migrate(d), [], "落ちた後は何もしない")
  d.close()
})

test("行が入っているテーブルは落とさない — 想定と違うことが起きている兆候なので残す", () => {
  const path = join(ROOT, "unused-rows.db")
  const d = openDb(path)
  d.exec("CREATE TABLE outbox (id TEXT PRIMARY KEY);")
  d.exec("INSERT INTO outbox (id)VALUES ('o1')")
  assert.deepEqual(migrate(d), [], "行があるので触らない")
  const row = d.prepare("SELECT count(*)AS n FROM outbox").get() as { n: number }
  assert.equal(row.n, 1)
  d.close()
})

test("空の DB では移行するものが無い(新規は schema.sql がそのまま作る)", async () => {
  const rt = makeRuntime(DbLive(":memory:"), RunnerStub([{ text: "ok" }]).layer)
  try {
    const cols = await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* Db
        return yield* db.all("PRAGMA table_info(belief_slots)")
      }),
    )
    const names = cols.map((c) => String(c.name))
    assert.ok(names.includes("valid_from") && names.includes("valid_until"))
    assert.ok(names.includes("invalidated_by") && names.includes("invalidated_reason"))
  } finally {
    await rt.dispose()
  }
})
