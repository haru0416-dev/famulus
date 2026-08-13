/**
 * `.data/` を落とすほうの検査。消しすぎないことを固定する。
 *
 * こちらはモデルを呼ばない代わりに、取り消せない操作をする。
 * 見るのは「残すべきものが残るか」で、消えるほうは1件ずつ数える。
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as Effect from "effect/Effect"

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

/** コンテナを数える手の差し替え。検査からホストの docker には触らない。 */
const noOrphans = async (): Promise<{ removed: string[]; kept: string[] }> => ({ removed: [], kept: [] })

const withTmp = async (fn: (dir: string, h: Harness) => Promise<void> | void): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "oz-cleanup-"))
  const runs = process.env.OPEN_ZERO_RUNS
  const cache = process.env.OPEN_ZERO_RUN_CACHE
  process.env.OPEN_ZERO_RUNS = join(dir, "runs")
  // 既定のままだと本物の `.data/run-cache` を見に行く。上限を超えていたら検査が消してしまう。
  process.env.OPEN_ZERO_RUN_CACHE = join(dir, "cache")
  try {
    await withHarness((h) => Promise.resolve(fn(dir, h)))
  } finally {
    if (runs === undefined) delete process.env.OPEN_ZERO_RUNS
    else process.env.OPEN_ZERO_RUNS = runs
    if (cache === undefined) delete process.env.OPEN_ZERO_RUN_CACHE
    else process.env.OPEN_ZERO_RUN_CACHE = cache
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
    const line = await h.run(cleanup({ at: AT, days: DAYS, orphans: noOrphans }))
    assert.match(line, /作業場 1 件/)
    assert.equal(existsSync(join(dir, "runs", "old")), false)
    assert.equal(existsSync(join(dir, "runs", "fresh")), true)
  })
})

/**
 * 続きをやっている作業場を消さない。上の階の刻は中を書き換えても動かないので、
 * そこだけ見ると「10 日前から放置」に見える。木の中で一番新しい刻で判定する。
 */
test("下の階だけ書き換えた作業場は残る", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "working", 10, 1)
    const line = await h.run(cleanup({ at: AT, days: DAYS, orphans: noOrphans }))
    assert.match(line, /落とすものは無かった/)
    assert.equal(existsSync(join(dir, "runs", "working")), true)
  })
})

test("--dry は数えるだけで消さない", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "old", 10)
    const line = await h.run(cleanup({ at: AT, days: DAYS, dry: true, orphans: noOrphans }))
    assert.match(line, /数えただけ/)
    assert.match(line, /作業場 1 件/)
    assert.equal(existsSync(join(dir, "runs", "old")), true)
  })
})

test("作業場が1つも無くても落ちない", async () => {
  await withTmp(async (_dir, h) => {
    assert.match(await h.run(cleanup({ at: AT, days: DAYS, orphans: noOrphans })), /落とすものは無かった/)
  })
})

/**
 * 共有キャッシュは古さで切らない。使い回すために置いてあるので、
 * 触られていないことは消してよい理由にならない。切るのは上限だけ。
 */
test("共有キャッシュは上限を超えたときだけ落ちる", async () => {
  await withTmp(async (dir, h) => {
    const cache = join(dir, "cache", "uv")
    mkdirSync(cache, { recursive: true })
    const blob = join(cache, "big")
    writeFileSync(blob, "x".repeat(64 * 1024))
    age(blob, 90) // 90 日前。作業場ならとうに落ちている年
    const kept = await h.run(cleanup({ at: AT, days: DAYS, orphans: noOrphans }))
    assert.match(kept, /落とすものは無かった/)
    assert.equal(existsSync(blob), true, "上限内のキャッシュが古さで落ちた")

    // 上限を跨いだときだけ落ちる。古さでは動かないことを、同じ木で続けて見る。
    const line = await h.run(cleanup({ at: AT, days: DAYS, cacheMaxMb: 0, orphans: noOrphans }))
    assert.match(line, /共有キャッシュ/)
    assert.equal(existsSync(blob), false)
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
 * 時刻では決まらない作業場がある。自分のソース(`selfdev`)は何日か触らなくても
 * 在り続けなければならない。触っていないことを理由に消すと、直したい日に限って無い。
 */
test("keep を立てた作業場は古くても残る", async () => {
  await withTmp(async (dir, h) => {
    workspace(dir, "selfdev", 30)
    workspace(dir, "old", 30)
    const line = await h.run(
      Effect.gen(function* () {
        yield* keepWorkspace("selfdev", "自分のソース")
        return yield* cleanup({ at: AT, days: DAYS, orphans: noOrphans })
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
