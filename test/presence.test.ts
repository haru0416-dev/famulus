/** 表示の文は DB から作るが、DB が読めなくても接続は落とさない(落とすとずっとオフラインになる)。 */

import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { SCHEMA_SQL } from "../src/db/sqlite.ts"
import { carryOver, presence, stateLine } from "../src/presence.ts"

const withDb = (fn: (path: string, db: Database) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "fam-presence-"))
  const path = join(dir, "t.db")
  const db = new Database(path)
  try {
    db.exec(SCHEMA_SQL)
    fn(path, db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test("未読が無ければ watch の数だけ出す", () => {
  withDb((path, db) => {
    db.run(`INSERT INTO watchlist
      (id,subject,opened_at,last_activity_at,next_move_owner,status,cooldown_hours)
      VALUES ('a','a','2026-08-14T00:00:00Z','2026-08-14T00:00:00Z','human','open',24),
             ('b','b','2026-08-14T00:00:00Z','2026-08-14T00:00:00Z','human','open',24),
             ('c','c','2026-08-14T00:00:00Z','2026-08-14T00:00:00Z','human','closed',24)`)
    assert.equal(stateLine(path), "watch 2")
  })
})

/** 未読は `cycle:cursor` より後ろの owner 行。cursor が無ければ 0。 */
test("未読があれば件数を前に出す", () => {
  withDb((path, db) => {
    db.run(`INSERT INTO events
      (id,at,kind,source,taint,exposure,provenance,content)
      VALUES ('1','2026-08-14T00:00:00Z','observe','owner',0,'private','[]','1'),
             ('2','2026-08-14T00:00:00Z','observe','system',0,'private','[]','2'),
             ('3','2026-08-14T00:00:00Z','observe','owner',0,'private','[]','3')`)
    db.run(`INSERT INTO watchlist
      (id,subject,opened_at,last_activity_at,next_move_owner,status,cooldown_hours)
      VALUES ('a','a','2026-08-14T00:00:00Z','2026-08-14T00:00:00Z','human','open',24)`)
    assert.equal(stateLine(path), "未読 2 / watch 1")
    db.run("INSERT INTO schema_meta VALUES ('cycle:cursor','2')")
    assert.equal(stateLine(path), "未読 1 / watch 1")
  })
})

test("対話REPLで処理済みのowner入力は未読表示に数えない", () => {
  withDb((path, db) => {
    db.run(`INSERT INTO events
      (id,at,kind,source,taint,exposure,provenance,content,origin_kind,origin_id)
      VALUES ('chat-1','2026-08-14T00:00:00Z','observe','owner',0,'private','[]','1','chat','chat-1')`)
    assert.equal(stateLine(path), "watch 0")
  })
})

test("DB が読めなければ文は作らない", () => {
  assert.equal(stateLine(join(tmpdir(), "fam-presence-無い.db")), undefined)
})

/** ここが `undefined` や例外になると IDENTIFY に載せる中身が無く、接続できない。 */
test("文が作れなくても online で組み立てる", () => {
  const p = presence(join(tmpdir(), "fam-presence-無い.db"))
  assert.equal(p.status, "online")
  assert.deepEqual(p.activities, [])
})

test("文が作れたら活動として載る", () => {
  withDb((path, db) => {
    db.run(`INSERT INTO watchlist
      (id,subject,opened_at,last_activity_at,next_move_owner,status,cooldown_hours)
      VALUES ('a','a','2026-08-14T00:00:00Z','2026-08-14T00:00:00Z','human','open',24)`)
    const p = presence(path)
    assert.equal(p.status, "online")
    // type 4 は前置きの付かない表示で、state がそのまま出る。
    assert.deepEqual(p.activities, [{ type: 4, name: "Custom Status", state: "watch 1" }])
  })
})

/** 捨てたセッションの seq を持ち越すと、新しいセッションが同じところで切られ続ける。 */
test("セッションごと捨てる終わり方では番号も捨てる", () => {
  const s = { id: "s1", url: "wss://x" }
  assert.deepEqual(carryOver(4007, s, 42), { session: undefined, seq: null })
  assert.deepEqual(carryOver(4009, s, 42), { session: undefined, seq: null })
})

test("セッションが残る終わり方では番号を持ち越す", () => {
  const s = { id: "s1", url: "wss://x" }
  assert.deepEqual(carryOver(4000, s, 42), { session: s, seq: 42 })
})

test("op 9 で先にセッションを捨てた回も番号は残さない", () => {
  assert.deepEqual(carryOver(4000, undefined, 42), { session: undefined, seq: null })
})
