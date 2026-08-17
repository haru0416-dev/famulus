/**
 * selfdev の検査。selfdev() 本体は回さない — repo 全体の clone と、コンテナ内での
 * 依存取得(分単位)を含むため。ここで固定するのは、次の cycle が読む一行と、
 * よそに置いた定義への参照が切れないこと。
 */

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { test } from "vitest"
import { configureApp, PROJECT_ROOT } from "../../src/core/config.ts"
import { GATE, repoRoot, SELFDEV, SELFDEV_PURPOSE } from "../../src/core/selfdev.ts"
import { runDir } from "../../src/services/Sandbox.ts"

test("repoRoot はこのリポジトリの根を指す(cwd に依らない)", () => {
  assert.equal(resolve(repoRoot()), PROJECT_ROOT)
  assert.ok(existsSync(join(repoRoot(), "package.json")))
})

test("GATE の参照先 gate script が package.json に実在する", () => {
  // ゲートの中身は package.json の `gate` に1か所だけ置く決め。script の名前が変わると
  // コンテナ側だけが黙って落ちるので、参照の実在をここで見る。
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
  }
  assert.ok(pkg.scripts?.gate, "package.json に gate script が無い")
  assert.match(GATE, /run gate$/)
})

test("コンテナの bun は動いているホストと同じ版を引く", () => {
  // 固定の版を書くと、mise が上げた日から「コンテナで通ったゲート」がホストの保証にならない。
  assert.ok(GATE.includes(`bun@${Bun.version} `), GATE)
})

test("SELFDEV は runDir で名前が変わらない(DB の登録名とディレクトリ名が一致する)", () => {
  // keepWorkspace は SELFDEV の名前で登録し、一覧はディレクトリ名で突き合わせる。
  // runDir の正規化で名前が変わると、登録と実体が別の行になる。
  const prev = process.env.FAMULUS_RUNS
  const root = mkdtempSync(join(tmpdir(), "fam-selfdev-"))
  process.env.FAMULUS_RUNS = root
  try {
    configureApp()
    assert.equal(basename(runDir(SELFDEV)), SELFDEV)
  } finally {
    if (prev === undefined) delete process.env.FAMULUS_RUNS
    else process.env.FAMULUS_RUNS = prev
    configureApp()
    rmSync(root, { recursive: true, force: true })
  }
})

test("次の cycle が読む一行に、ゲートの通し方と net の指定が入っている", () => {
  // 一覧に出るのは名前とこの一行だけ。ここに無い手順は次の回には存在しない。
  assert.ok(SELFDEV_PURPOSE.includes(GATE))
  assert.ok(SELFDEV_PURPOSE.includes("net"))
  assert.ok(SELFDEV_PURPOSE.includes(repoRoot()))
})
