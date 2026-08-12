/**
 * `.data/` を落とすほうの検査。**消しすぎないこと**を固定する。
 *
 * こちらはモデルを呼ばない代わりに、**取り消せない操作**をする。
 * 見るのは「残すべきものが残るか」で、消えるほうは1件ずつ数える。
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { Effect } from "effect"

// 回す時刻の判定はユーザーの時計で切る。TZ はモジュール読み込み時に確定するので、import より先に差す。
process.env.OPEN_ZERO_TZ = "Asia/Tokyo"
const { CLEANUP_DAILY, cleanup, cleanupDue } = await import("../src/core/cleanup.ts")
const { Db } = await import("../src/services/Db.ts")
const { keepWorkspace, noteWorkspace, purposeOf } = await import("../src/core/workspaces.ts")
const { withHarness } = await import("./helpers.ts")
type Harness = Awaited<ReturnType<typeof import("./helpers.ts").harness>>

const AT = "2026-08-13T00:00:00Z" // JST 9:00
const DAYS = 3 // 切り口は 2026-08-10

/** その木の中身を全部、指定の時刻に見せかける。親の刻は子を触っても変わらないので、両方に当てる。 */
const age = (path: string, daysAgo: number): void => {
  const t = new Date(Date.parse(AT) - daysAgo * 86_400_000)
  utimesSync(path, t, t)
}

const withTmp = async (fn: (dir: string, h: Harness) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "oz-cleanup-"))
  const runs = process.env.OPEN_ZERO_RUNS
  const flue = process.env.OPEN_ZERO_FLUE_DB
  process.env.OPEN_ZERO_RUNS = join(dir, "runs")
  process.env.OPEN_ZERO_FLUE_DB = join(dir, "flue.db")
  try {
    await withHarness((h) => Promise.resolve(fn(dir, h)))
  } finally {
    if (runs === undefined) delete process.env.OPEN_ZERO_RUNS
    else process.env.OPEN_ZERO_RUNS = runs
    if (flue === undefined) delete process.env.OPEN_ZERO_FLUE_DB
    else process.env.OPEN_ZERO_FLUE_DB = flue
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 作業場を1つ作る。`deep` を渡すと、下の階のファイルだけ新しくする。 */
const workspace = (dir: string, name: string, daysAgo: number, deepDaysAgo?: number): string => {
  const ws = join(dir, "runs", name)
  mkdirSync(join(ws, "src"), { recursive: true })
  const deep = join(ws, "src", "main.ts")
  writeFileSync(deep, "x".repeat(1024))
  age(deep, deepDaysAgo ?? daysAgo)
  age(join(ws, "src"), daysAgo)
  age(ws, daysAgo)
  return ws
}

test("しばらく触られていない作業場だけ落ちる", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "old", 10)
    workspace(dir, "fresh", 1)
    const line = await h.run(cleanup({ at: AT, days: DAYS }))
    assert.match(line, /作業場 1 件/)
    assert.equal(existsSync(join(dir, "runs", "old")), false)
    assert.equal(existsSync(join(dir, "runs", "fresh")), true)
  })
})

/**
 * **続きをやっている作業場を消さない。** 上の階の刻は中を書き換えても動かないので、
 * そこだけ見ると「10 日前から放置」に見える。木の中で一番新しい刻で判定する。
 */
test("下の階だけ書き換えた作業場は残る", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "working", 10, 1)
    const line = await h.run(cleanup({ at: AT, days: DAYS }))
    assert.match(line, /落とすものは無かった/)
    assert.equal(existsSync(join(dir, "runs", "working")), true)
  })
})

test("--dry は数えるだけで消さない", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "old", 10)
    const line = await h.run(cleanup({ at: AT, days: DAYS, dry: true }))
    assert.match(line, /数えただけ/)
    assert.match(line, /作業場 1 件/)
    assert.equal(existsSync(join(dir, "runs", "old")), true)
  })
})

test("作業場が1つも無くても落ちない", async () => {
  await withTmp(async (_dir, h) => {
    assert.match(await h.run(cleanup({ at: AT, days: DAYS })), /落とすものは無かった/)
  })
})

/** Flue の表を最小限だけ起こす。ここに無い列は cleanup が触らない。 */
const flue = (dir: string, paths: readonly string[]): string => {
  const file = join(dir, "flue.db")
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE flue_conversation_streams (path TEXT PRIMARY KEY, identity_json TEXT NOT NULL);
    CREATE TABLE flue_conversation_stream_batches (path TEXT NOT NULL, seq INTEGER NOT NULL);
    CREATE TABLE flue_conversation_stream_batch_chunks (path TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT);
    CREATE TABLE flue_conversation_fold_checkpoints (path TEXT PRIMARY KEY, head_offset TEXT NOT NULL);
    CREATE TABLE flue_conversation_fold_checkpoint_chunks (path TEXT NOT NULL, chunk_index INTEGER NOT NULL);
    CREATE TABLE flue_attachments (stream_path TEXT NOT NULL, attachment_id TEXT NOT NULL);
    CREATE TABLE flue_attachment_chunks (stream_path TEXT NOT NULL, attachment_id TEXT NOT NULL);
    CREATE TABLE flue_agent_submissions (submission_id TEXT NOT NULL UNIQUE, session_key TEXT NOT NULL);
    CREATE TABLE flue_submission_chunks (submission_id TEXT NOT NULL, item_id TEXT NOT NULL);
  `)
  for (const p of paths) {
    const conv = p.slice(p.lastIndexOf("/") + 1)
    db.prepare("INSERT INTO flue_conversation_streams VALUES (?, '{}')").run(p)
    db.prepare("INSERT INTO flue_conversation_stream_batches VALUES (?, 1)").run(p)
    db.prepare("INSERT INTO flue_conversation_stream_batch_chunks VALUES (?, 1, ?)").run(p, "x".repeat(4096))
    db.prepare("INSERT INTO flue_conversation_fold_checkpoints VALUES (?, '0')").run(p)
    db.prepare("INSERT INTO flue_conversation_fold_checkpoint_chunks VALUES (?, 0)").run(p)
    db.prepare("INSERT INTO flue_attachments VALUES (?, ?)").run(p, `att-${conv}`)
    db.prepare("INSERT INTO flue_attachment_chunks VALUES (?, ?)").run(p, `att-${conv}`)
    db.prepare("INSERT INTO flue_agent_submissions VALUES (?, ?)").run(
      `sub-${conv}`,
      `agent-session:["Assistant","${conv}","default","default"]`,
    )
    db.prepare("INSERT INTO flue_submission_chunks VALUES (?, 'item')").run(`sub-${conv}`)
  }
  db.close()
  return file
}

const rows = (file: string, sql: string): number => {
  const db = new DatabaseSync(file)
  try {
    return (db.prepare(sql).get() as { n: number }).n
  } finally {
    db.close()
  }
}

test("過ぎた日の会話だけ落ちる(その日ぶんと未来は残る)", async () => {
  await withTmp(async (dir, h) => {
    const file = flue(dir, [
      "agents/Assistant/tick-2026-08-07",
      "agents/Assistant/tick-2026-08-08",
      "agents/Assistant/tick-2026-08-12",
      "agents/Assistant/tick-2026-08-13",
    ])
    const line = await h.run(cleanup({ at: AT, days: DAYS }))
    assert.match(line, /会話 2 本/)
    assert.deepEqual(
      new DatabaseSync(file)
        .prepare("SELECT path FROM flue_conversation_streams ORDER BY path")
        .all()
        .map((r) => (r as { path: string }).path),
      ["agents/Assistant/tick-2026-08-12", "agents/Assistant/tick-2026-08-13"],
    )
  })
})

/**
 * **形が読めない path には触らない。** Flue 側の持ち物なので、
 * `tick-<日付>` 以外は日付が読めず、いつ読まれるかも分からない。
 */
test("tick-<日付> の形でない会話は日付が読めないので触らない", async () => {
  await withTmp(async (dir, h) => {
    const file = flue(dir, ["agents/Assistant/default", "agents/Assistant/tick-2026-08-07"])
    await h.run(cleanup({ at: AT, days: DAYS }))
    assert.deepEqual(
      new DatabaseSync(file)
        .prepare("SELECT path FROM flue_conversation_streams")
        .all()
        .map((r) => (r as { path: string }).path),
      ["agents/Assistant/default"],
    )
  })
})

test("会話を落とすと、その会話に紐づく表も全部落ちる", async () => {
  await withTmp(async (dir, h) => {
    const file = flue(dir, ["agents/Assistant/tick-2026-08-07", "agents/Assistant/tick-2026-08-12"])
    await h.run(cleanup({ at: AT, days: DAYS }))
    for (const [table, col] of [
      ["flue_conversation_stream_batches", "path"],
      ["flue_conversation_stream_batch_chunks", "path"],
      ["flue_conversation_fold_checkpoints", "path"],
      ["flue_conversation_fold_checkpoint_chunks", "path"],
      ["flue_attachments", "stream_path"],
      ["flue_attachment_chunks", "stream_path"],
    ] as const) {
      assert.equal(rows(file, `SELECT count(*) AS n FROM ${table}`), 1, `${table} が1本ぶん残る`)
      assert.equal(
        rows(file, `SELECT count(*) AS n FROM ${table} WHERE ${col} LIKE '%08-07'`),
        0,
        `${table} から落ちている`,
      )
    }
    // 投入の記録は path を持たず、session_key の中にしか会話 id が無い。
    assert.equal(rows(file, "SELECT count(*) AS n FROM flue_agent_submissions"), 1)
    assert.equal(rows(file, "SELECT count(*) AS n FROM flue_submission_chunks"), 1)
    assert.equal(
      rows(file, "SELECT count(*) AS n FROM flue_submission_chunks WHERE submission_id LIKE '%08-07'"),
      0,
    )
  })
})

test("--dry は会話も消さない", async () => {
  await withTmp(async (dir, h) => {
    const file = flue(dir, ["agents/Assistant/tick-2026-08-07"])
    const line = await h.run(cleanup({ at: AT, days: DAYS, dry: true }))
    assert.match(line, /会話 1 本/)
    assert.equal(rows(file, "SELECT count(*) AS n FROM flue_conversation_streams"), 1)
  })
})

/** 版が上がって表の名前が変わっても、掃除ごと落ちない(消せるものだけ消す)。 */
test("Flue の表が無くても落ちない", async () => {
  await withTmp(async (dir, h) => {
    new DatabaseSync(join(dir, "flue.db")).close()
    assert.match(await h.run(cleanup({ at: AT, days: DAYS })), /落とすものは無かった/)
  })
})

/** 1日1回。印を付けるのは呼び出し側(src/tick.ts)なので、ここは判定だけを見る。 */
test("その日ぶんが済んでいれば回さない", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const db = yield* Db
        const before = yield* cleanupDue(AT)
        yield* db.setMeta(CLEANUP_DAILY, "2026-08-13")
        return { before, after: yield* cleanupDue(AT) }
      }),
    )
    assert.equal(out.before, true)
    assert.equal(out.after, false)
  })
})

test("ユーザーの時計で早すぎる時刻には回さない", async () => {
  await withHarness(async (h) => {
    // 2026-08-12T18:30:00Z = JST 翌 3:30。日付は変わっているが既定の 4 時より前。
    assert.equal(await h.run(cleanupDue("2026-08-12T18:30:00Z")), false)
  })
})

/**
 * **時刻では決まらない作業場がある。** 自分のソース(`selfdev`)は何日か触らなくても
 * 在り続けなければならない。触っていないことを理由に消すと、直したい日に限って無い。
 */
test("keep を立てた作業場は古くても残る", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "selfdev", 30)
    workspace(dir, "old", 30)
    const line = await h.run(
      Effect.gen(function* () {
        yield* keepWorkspace("selfdev", "自分のソース")
        return yield* cleanup({ at: AT, days: DAYS })
      }),
    )
    assert.match(line, /作業場 1 件/)
    assert.equal(existsSync(join(dir, "runs", "selfdev")), true)
    assert.equal(existsSync(join(dir, "runs", "old")), false)
  })
})

/** 実体を消したら説明も落とす。残すと、実体の無い説明だけが溜まっていく。 */
test("落とした作業場の登録も消える(--dry では消えない)", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "old", 30)
    const after = await h.run(
      Effect.gen(function* () {
        yield* noteWorkspace("old", "もう使っていない調べ物")
        yield* cleanup({ at: AT, days: DAYS, dry: true })
        const kept = yield* purposeOf("old")
        yield* cleanup({ at: AT, days: DAYS })
        return { kept, gone: yield* purposeOf("old") }
      }),
    )
    assert.equal(after.kept, "もう使っていない調べ物")
    assert.equal(after.gone, undefined)
    assert.equal(existsSync(join(dir, "runs", "old")), false)
  })
})
