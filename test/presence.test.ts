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
import { test } from "node:test"
import { presence, stateLine } from "../src/presence.ts"

/** 表示に要る列だけの DB を1つ作る。本物の migrations は通さない — 読む側の形しか要らない。 */
const withDb = (fn: (path: string, db: Database) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "oz-presence-"))
  const path = join(dir, "t.db")
  const db = new Database(path)
  try {
    db.run("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)")
    db.run("CREATE TABLE events (id INTEGER PRIMARY KEY, source TEXT)")
    db.run("CREATE TABLE watchlist (id TEXT PRIMARY KEY, status TEXT)")
    fn(path, db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test("未読が無ければ watch の数だけ出す", () => {
  withDb((path, db) => {
    db.run("INSERT INTO watchlist VALUES ('a','open'),('b','open'),('c','done')")
    assert.equal(stateLine(path), "watch 2")
  })
})

/** 未読は `tick:cursor` より後ろの owner 行。cursor を持たない状態は 0 として読む。 */
test("未読があれば件数を前に出す", () => {
  withDb((path, db) => {
    db.run("INSERT INTO events VALUES (1,'owner'),(2,'system'),(3,'owner')")
    db.run("INSERT INTO watchlist VALUES ('a','open')")
    assert.equal(stateLine(path), "未読 2 / watch 1")
    db.run("INSERT INTO schema_meta VALUES ('tick:cursor','2')")
    assert.equal(stateLine(path), "未読 1 / watch 1")
  })
})

test("DB が読めなければ文は作らない", () => {
  assert.equal(stateLine(join(tmpdir(), "oz-presence-無い.db")), undefined)
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
    db.run("INSERT INTO watchlist VALUES ('a','open')")
    const p = presence(path)
    assert.equal(p.status, "online")
    // type 4 は前置きの付かない表示。観測(別セッションの GUILD_CREATE)で state がそのまま返る。
    assert.deepEqual(p.activities, [{ type: 4, name: "Custom Status", state: "watch 1" }])
  })
})
