/** selfdev() 本体は repo の clone とコンテナ内の依存取得で分単位かかるので回さない。 */

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { configureApp, PROJECT_ROOT } from "../../src/core/config.ts"
import { GATE, repoRoot, SELFDEV, selfdev } from "../../src/core/selfdev.ts"
import { Proposals } from "../../src/services/Proposals.ts"
import { runDir } from "../../src/services/Sandbox.ts"
import { withHarness } from "../helpers.ts"

test("repoRoot はこのリポジトリの根を指す(cwd に依らない)", () => {
  assert.equal(resolve(repoRoot()), PROJECT_ROOT)
  assert.ok(existsSync(join(repoRoot(), "package.json")))
})

test("GATE の参照先 gate script が package.json に実在する", () => {
  // script 名が変わるとコンテナ側だけが黙って落ちる。
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
  }
  assert.ok(pkg.scripts?.gate, "package.json に gate script が無い")
  assert.match(GATE, /run gate$/)
})

test("コンテナの bun は動いているホストと同じ版を引く", () => {
  // 版を固定すると、mise で上げた後はコンテナで通ったゲートがホストでの通過を意味しない。
  assert.ok(GATE.includes(`bun@${Bun.version} `), GATE)
})

test("SELFDEV は runDir で名前が変わらない(DB の登録名とディレクトリ名が一致する)", () => {
  // 登録は SELFDEV の名前、一覧はディレクトリ名で突き合わせる。
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

test("selfdevは公開通信の承認前にcloneを変更せず、取得と検査を別々に申請する", async () => {
  const prev = process.env.FAMULUS_RUNS
  const root = mkdtempSync(join(tmpdir(), "fam-selfdev-approval-"))
  process.env.FAMULUS_RUNS = root
  try {
    configureApp()
    const clone = join(runDir(SELFDEV), "famulus")
    mkdirSync(clone)
    const marker = join(clone, "uncommitted")
    writeFileSync(marker, "keep")
    await withHarness(async (h) => {
      await h.run(selfdev({ fresh: true }))
      assert.equal(readFileSync(marker, "utf8"), "keep")
      const requests = await h.run(Effect.flatMap(Proposals, (p) => p.list()))
      assert.equal(requests.length, 2)
      assert.ok(requests.every((request) => request.status === "proposed"))
      assert.deepEqual(
        new Set(requests.map((request) => JSON.parse(request.payload).operation)),
        new Set(["selfdev-install", "selfdev-gate"]),
      )
    })
  } finally {
    if (prev === undefined) delete process.env.FAMULUS_RUNS
    else process.env.FAMULUS_RUNS = prev
    configureApp()
    rmSync(root, { recursive: true, force: true })
  }
})
