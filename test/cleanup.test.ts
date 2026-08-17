/**
 * `.data/` を削除する処理の検査。消しすぎないことを固定する。
 *
 * こちらはモデルを呼ばない代わりに、取り消せない操作をする。
 * 見るのは「残すべきものが残るか」で、消えるほうは1件ずつ数える。
 */

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { test } from "vitest"

// 回す時刻の判定はユーザーの時計で切る。TZ はモジュール読み込み時に確定するので、import より先に差す。
process.env.FAMULUS_TZ = "Asia/Tokyo"
const { CLEANUP_DAILY, cleanup, cleanupDue } = await import("../src/core/cleanup.ts")
const { Db } = await import("../src/services/Db.ts")
const { keepWorkspace, noteWorkspace, purposeOf } = await import("../src/core/workspaces.ts")
const { withHarness } = await import("./helpers.ts")
type Harness = Awaited<ReturnType<typeof import("./helpers.ts").harness>>

const AT = "2026-08-13T00:00:00Z"
const DAYS = 3

const age = (path: string, daysAgo: number): void => {
  const t = new Date(Date.parse(AT) - daysAgo * 86_400_000)
  utimesSync(path, t, t)
}

/** コンテナ列挙処理の差し替え。検査からホストの docker には触らない。 */
const noOrphans = async (): Promise<{ removed: string[]; kept: string[] }> => ({ removed: [], kept: [] })

const withTmp = async (fn: (dir: string, h: Harness) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "fam-cleanup-"))
  const runs = process.env.FAMULUS_RUNS
  const cache = process.env.FAMULUS_RUN_CACHE
  process.env.FAMULUS_RUNS = join(dir, "runs")
  // 既定のままだと本物の `.data/run-cache` を読む。上限を超えていたら検査が消してしまう。
  process.env.FAMULUS_RUN_CACHE = join(dir, "cache")
  try {
    await withHarness((h) => Promise.resolve(fn(dir, h)))
  } finally {
    if (runs === undefined) delete process.env.FAMULUS_RUNS
    else process.env.FAMULUS_RUNS = runs
    if (cache === undefined) delete process.env.FAMULUS_RUN_CACHE
    else process.env.FAMULUS_RUN_CACHE = cache
    rmSync(dir, { recursive: true, force: true })
  }
}

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

test("しばらく触られていない workspace だけ削除される", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "old", 10)
    workspace(dir, "fresh", 1)
    const line = await h.run(cleanup({ at: AT, days: DAYS, orphans: noOrphans }))
    assert.match(line, /workspace 1 件/)
    assert.equal(existsSync(join(dir, "runs", "old")), false)
    assert.equal(existsSync(join(dir, "runs", "fresh")), true)
  })
})

/**
 * 続きをやっている workspace を消さない。ルートディレクトリの mtime は子孫を書き換えても動かないので、
 * そこだけ見ると「10 日前から放置」に見える。全子孫の最大 mtime で判定する。
 */
test("子孫ファイルが更新された workspace は残る", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "working", 10, 1)
    const line = await h.run(cleanup({ at: AT, days: DAYS, orphans: noOrphans }))
    assert.match(line, /削除対象は無かった/)
    assert.equal(existsSync(join(dir, "runs", "working")), true)
  })
})

test("--dry は数えるだけで消さない", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "old", 10)
    const line = await h.run(cleanup({ at: AT, days: DAYS, dry: true, orphans: noOrphans }))
    assert.match(line, /数えただけ/)
    assert.match(line, /workspace 1 件/)
    assert.match(line, /削除対象$/)
    assert.doesNotMatch(line, /削除した/)
    assert.equal(existsSync(join(dir, "runs", "old")), true)
  })
})

test("workspace が1つも無くても落ちない", async () => {
  await withTmp(async (_dir, h) => {
    assert.match(await h.run(cleanup({ at: AT, days: DAYS, orphans: noOrphans })), /削除対象は無かった/)
  })
})

/**
 * 共有キャッシュは古さで切らない。使い回すために置いてあるので、
 * 触られていないことは消してよい理由にならない。切るのは上限だけ。
 */
test("共有キャッシュは上限を超えたときだけ削除される", async () => {
  await withTmp(async (dir, h) => {
    const cache = join(dir, "cache", "uv")
    mkdirSync(cache, { recursive: true })
    const blob = join(cache, "big")
    writeFileSync(blob, "x".repeat(64 * 1024))
    age(blob, 90)
    const kept = await h.run(cleanup({ at: AT, days: DAYS, orphans: noOrphans }))
    assert.match(kept, /削除対象は無かった/)
    assert.equal(existsSync(blob), true, "上限内のキャッシュが古さで削除された")

    const line = await h.run(cleanup({ at: AT, days: DAYS, cacheMaxMb: 0, orphans: noOrphans }))
    assert.match(line, /共有キャッシュ/)
    assert.equal(existsSync(blob), false)
  })
})

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
 * 時刻では決まらない workspace がある。自分のソース(`selfdev`)は何日か触らなくても
 * 在り続けなければならない。触っていないことを理由に消すと、直したい日に限って無い。
 */
test("keep を立てた workspace は古くても残る", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "selfdev", 30)
    workspace(dir, "old", 30)
    const line = await h.run(
      Effect.gen(function* () {
        yield* keepWorkspace("selfdev", "自分のソース")
        return yield* cleanup({ at: AT, days: DAYS, orphans: noOrphans })
      }),
    )
    assert.match(line, /workspace 1 件/)
    assert.equal(existsSync(join(dir, "runs", "selfdev")), true)
    assert.equal(existsSync(join(dir, "runs", "old")), false)
  })
})

/** 実体を消したら説明も削除する。残すと、実体の無い説明だけが溜まっていく。 */
test("削除した workspace の登録も消える(--dry では消えない)", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "old", 30)
    const after = await h.run(
      Effect.gen(function* () {
        yield* noteWorkspace("old", "もう使っていない調べ物")
        yield* cleanup({ at: AT, days: DAYS, dry: true, orphans: noOrphans })
        const kept = yield* purposeOf("old")
        yield* cleanup({ at: AT, days: DAYS, orphans: noOrphans })
        return { kept, gone: yield* purposeOf("old") }
      }),
    )
    assert.equal(after.kept, "もう使っていない調べ物")
    assert.equal(after.gone, undefined)
    assert.equal(existsSync(join(dir, "runs", "old")), false)
  })
})
