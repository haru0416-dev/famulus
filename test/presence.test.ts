/**
 * オンライン表示の検査。接続を落とさないことを固定する。
 *
 * ここで見るのは文面ではなく倒れる向き。表示に出す文は DB を読んで作るが、
 * 読めなかったときに接続まで落とすと、症状(ずっとオフライン)がそのまま戻る。
 * だから「DB が無い → 文は無い、けれど presence は組み立てられる」を検査に置く。
 */

import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { SCHEMA_SQL } from "../src/db/sqlite.ts"
import { presence, stateLine } from "../src/presence.ts"

/** 現行schemaのDBを1つ作る。shape境界も含めてpresenceと同じ条件で読む。 */
const withDb = (fn: (path: string, db: Database) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "oz-presence-"))
  const path = join(dir, "t.db")
  const db = new Database(path)
  try {
    db.exec(SCHEMA_SQL)
    db.run("INSERT INTO schema_meta VALUES ('version','4')")
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

/** 未読は `cycle:cursor` より後ろの owner 行。cursor を持たない状態は 0 として読む。 */
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

test("DB が読めなければ文は作らない", () => {
  assert.equal(stateLine(join(tmpdir(), "oz-presence-無い.db")), undefined)
})

test("旧versionのDBは部分的に表示しない", () => {
  withDb((path, db) => {
    db.run("UPDATE schema_meta SET value='2' WHERE key='version'")
    db.run(`INSERT INTO watchlist
      (id,subject,opened_at,last_activity_at,next_move_owner,status,cooldown_hours)
      VALUES ('a','a','2026-08-14T00:00:00Z','2026-08-14T00:00:00Z','human','open',24)`)
    assert.equal(stateLine(path), undefined)
  })
})

/**
 * 文が作れなくても presence は online。ここが `undefined` を返したり投げたりすると、
 * IDENTIFY に載せる中身が無くなって接続そのものが立たない。
 */
test("文が作れなくても online で組み立てる", () => {
  const p = presence(join(tmpdir(), "oz-presence-無い.db"))
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
    // type 4 は前置きの付かない表示。観測(別セッションの GUILD_CREATE)で state がそのまま返る。
    assert.deepEqual(p.activities, [{ type: 4, name: "Custom Status", state: "watch 1" }])
  })
})
