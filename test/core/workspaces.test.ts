/**
 * コンテナは DB を通さずにファイルを書き換え、掃除は登録を残すことがあるので、
 * 実体と登録がずれたら実体を正とする。
 */

import assert from "node:assert/strict"
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import {
  keepWorkspace,
  listWorkspaces,
  noteWorkspace,
  purposeOf,
  renderWorkspaces,
  scanTree,
  sinceLabel,
} from "../../src/core/workspaces.ts"
import { type Harness, withHarness } from "../helpers.ts"

const withRuns = async (fn: (root: string, h: Harness) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "fam-ws-"))
  const prev = process.env.FAMULUS_RUNS
  process.env.FAMULUS_RUNS = join(dir, "runs")
  try {
    await withHarness(async (h) => {
      await fn(join(dir, "runs"), h)
    })
  } finally {
    if (prev === undefined) delete process.env.FAMULUS_RUNS
    else process.env.FAMULUS_RUNS = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

const put = (root: string, name: string, bytes: number, hoursAgo = 0): void => {
  const dir = join(root, name, "sub")
  mkdirSync(dir, { recursive: true })
  const f = join(dir, "f.bin")
  writeFileSync(f, "x".repeat(bytes))
  const t = new Date(Date.now() - hoursAgo * 3_600_000)
  utimesSync(f, t, t)
  utimesSync(dir, t, t)
  utimesSync(join(root, name), t, t)
}

test("一覧は実体のあるものだけ、最後に触った順に返る", async () => {
  await withRuns(async (root, h) => {
    put(root, "hn", 2048, 50)
    put(root, "selfdev", 1024, 1)
    const list = await h.run(
      Effect.gen(function* () {
        yield* noteWorkspace("hn", "Show HN の追跡")
        yield* noteWorkspace("消えた", "掃除で落ちたはず")
        return yield* listWorkspaces
      }),
    )
    assert.deepEqual(
      list.map((w) => w.name),
      ["selfdev", "hn"],
    )
    assert.equal(list[0]?.purpose, undefined)
    assert.equal(list[1]?.purpose, "Show HN の追跡")
    assert.equal(list[1]?.bytes, 2048)
  })
})

test("説明を書き直すと上書きされる(区間は持たない)", async () => {
  await withRuns(async (root, h) => {
    put(root, "hn", 16)
    const out = await h.run(
      Effect.gen(function* () {
        yield* noteWorkspace("hn", "最初の説明")
        yield* noteWorkspace("hn", "あとの説明")
        return yield* purposeOf("hn")
      }),
    )
    assert.equal(out, "あとの説明")
  })
})

test("noteWorkspace は keep を変更しない", async () => {
  await withRuns(async (root, h) => {
    put(root, "selfdev", 16)
    const list = await h.run(
      Effect.gen(function* () {
        yield* keepWorkspace("selfdev", "自分のソース")
        yield* noteWorkspace("selfdev", "説明だけ書き換えた")
        return yield* listWorkspaces
      }),
    )
    assert.equal(list[0]?.keep, true)
    assert.equal(list[0]?.purpose, "説明だけ書き換えた")
  })
})

/** ルートの mtime だけだと使用中の workspace が古く見え、cleanup が消す。 */
test("scanTree は子孫を含む最大 mtime と合計サイズを返す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fam-scan-"))
  try {
    mkdirSync(join(dir, "a", "b"), { recursive: true })
    writeFileSync(join(dir, "a", "b", "new.txt"), "x".repeat(100))
    writeFileSync(join(dir, "old.txt"), "x".repeat(50))
    const old = new Date(Date.now() - 30 * 86_400_000)
    utimesSync(join(dir, "old.txt"), old, old)
    utimesSync(join(dir, "a"), old, old)
    utimesSync(dir, old, old)
    const t = scanTree(dir)
    assert.equal(t.bytes, 150)
    assert.ok(Date.now() - t.newestMs < 60_000, "子孫ファイルの mtime を取得する")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** bun の isolated は `node_modules` を symlink と hard link で組むので、数え直すと大きさが数倍に出る。 */
test("scanTree は symlink の先へ降りない", () => {
  const dir = mkdtempSync(join(tmpdir(), "fam-scan-sym-"))
  try {
    mkdirSync(join(dir, "real"))
    writeFileSync(join(dir, "real", "f.bin"), "x".repeat(100))
    symlinkSync(join(dir, "real"), join(dir, "link"), "dir")
    assert.equal(scanTree(dir).bytes, 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scanTree は hard link を1回だけ数える", () => {
  const dir = mkdtempSync(join(tmpdir(), "fam-scan-hard-"))
  try {
    writeFileSync(join(dir, "f.bin"), "x".repeat(100))
    linkSync(join(dir, "f.bin"), join(dir, "g.bin"))
    assert.equal(scanTree(dir).bytes, 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** ここで例外になると一覧が出ず、cycle のプロンプトも作れない。 */
test("scanTree は symlink の輪で落ちない", () => {
  const dir = mkdtempSync(join(tmpdir(), "fam-scan-loop-"))
  try {
    mkdirSync(join(dir, "a"))
    writeFileSync(join(dir, "a", "f.bin"), "x".repeat(100))
    symlinkSync(dir, join(dir, "a", "up"), "dir")
    assert.equal(scanTree(dir).bytes, 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("一覧の文は、説明の無い workspace をそう書く", async () => {
  const now = Date.parse("2026-08-13T12:00:00Z")
  const line = renderWorkspaces(
    [
      {
        name: "selfdev",
        dir: "/x/selfdev",
        purpose: "自分のソース",
        keep: true,
        bytes: 1_048_576,
        touchedMs: now - 3_600_000,
      },
      {
        name: "hn",
        dir: "/x/hn",
        purpose: undefined,
        keep: false,
        bytes: 0,
        touchedMs: now - 5 * 86_400_000,
      },
    ],
    now,
  )
  assert.match(line, /selfdev\(1\.0MB \/ 最後に触ったのは 1 時間前 \/ 消さない\)/)
  assert.match(line, /自分のソース/)
  assert.match(line, /説明が無い|説明なし/)
  assert.match(line, /5 日前/)
})

test("1つも無ければ、無いと書く", () => {
  assert.equal(renderWorkspaces([], Date.now()), "(まだ1つも無い)")
})

test("放置の長さは時間か日で出す", () => {
  const now = Date.parse("2026-08-13T12:00:00Z")
  assert.equal(sinceLabel(now - 60_000, now), "さっき")
  assert.equal(sinceLabel(now - 5 * 3_600_000, now), "5 時間前")
  assert.equal(sinceLabel(now - 5 * 86_400_000, now), "5 日前")
})
