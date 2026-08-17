/**
 * coder の検査。Cursor SDK(課金 run・ネットワーク)には触れない —
 * runCursorTask を差し替えて、coder が渡す引数と、run の前後の git 処理だけを見る。
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, vi } from "vitest"
import { ensureCoderScaffolding, runCodeTask, writeRepoMap } from "../../src/agent/coder.ts"
import { appConfig, PROJECT_ROOT } from "../../src/core/config.ts"

const cursor = vi.hoisted(() => {
  const summary = { status: "completed", toolCalls: 0, toolErrors: 0, durationMs: 5 }
  return {
    calls: [] as Record<string, unknown>[],
    summary,
    impl: (async () => summary) as (o: Record<string, unknown>) => Promise<unknown>,
  }
})

vi.mock("../../src/model/cursor.ts", () => ({
  runCursorTask: async (o: Record<string, unknown>) => {
    cursor.calls.push(o)
    return cursor.impl(o)
  },
}))

/** 差し替えた実装で1件走らせ、終わりに必ず既定へ戻す。 */
const withImpl = async <T>(
  impl: (o: Record<string, unknown>) => Promise<unknown>,
  fn: () => Promise<T>,
): Promise<T> => {
  cursor.impl = impl
  cursor.calls.length = 0
  try {
    return await fn()
  } finally {
    cursor.impl = async () => cursor.summary
  }
}

const gitRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "famulus-coder-"))
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"])
  writeFileSync(join(dir, "a.txt"), "hello\n")
  execFileSync("git", ["-C", dir, "add", "."])
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"])
  return dir
}

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()

test("scaffolding: guard.sh は実行可能で、4イベントとも同じ guard を指す", () => {
  const root = mkdtempSync(join(tmpdir(), "famulus-coder-"))
  ensureCoderScaffolding(root)
  const script = join(root, ".cursor", "hooks", "guard.sh")
  assert.ok(statSync(script).mode & 0o100, "実行ビットが無い")
  const body = readFileSync(script, "utf8")
  // hook は famulus 本体の CLI を絶対パスで呼ぶ。workspace からの相対では、cwd が違うと外れる。
  assert.ok(body.includes(join(PROJECT_ROOT, "src/cli.ts")))
  assert.ok(body.includes('cursor-hook "$FAMULUS_CODER_ROLE"'))
  const guard = [{ command: "./.cursor/hooks/guard.sh" }]
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".cursor", "hooks.json"), "utf8")), {
    version: 1,
    hooks: {
      beforeShellExecution: guard,
      preToolUse: guard,
      beforeReadFile: guard,
      beforeMCPExecution: guard,
    },
  })
})

test("scaffolding: 既存の hooks.json は上書きしない(冪等)", () => {
  const root = mkdtempSync(join(tmpdir(), "famulus-coder-"))
  ensureCoderScaffolding(root)
  const hooksJson = join(root, ".cursor", "hooks.json")
  writeFileSync(hooksJson, '{"version":1,"hooks":{}}')
  ensureCoderScaffolding(root)
  assert.equal(readFileSync(hooksJson, "utf8"), '{"version":1,"hooks":{}}')
})

test("repo-map: export シンボルの地図を .cursor/rules に置く", () => {
  const root = mkdtempSync(join(tmpdir(), "famulus-coder-"))
  writeFileSync(join(root, "a.ts"), "export function hello() {}\nexport const VALUE = 1\n")
  const body = writeRepoMap(root)
  assert.ok(body.includes("hello()"))
  assert.equal(readFileSync(join(root, ".cursor", "rules", "repo-map.md"), "utf8"), body)
})

test("plan: branch も snapshot も作らず、mode=plan と model を渡す", async () => {
  const root = mkdtempSync(join(tmpdir(), "famulus-coder-"))
  await withImpl(
    async () => cursor.summary,
    async () => {
      const out = await runCodeTask({ root, task: "調査だけ", plan: true, model: "claude-fable-5" })
      assert.equal(cursor.calls.length, 1)
      assert.equal(cursor.calls[0]?.mode, "plan")
      assert.equal(cursor.calls[0]?.cwd, root)
      assert.equal(cursor.calls[0]?.model, "claude-fable-5")
      assert.equal(out.branch, undefined)
      assert.equal(out.snapshotSha, undefined)
      assert.equal(out.model, "claude-fable-5")
      assert.ok(out.branchDetail.includes("plan"))
      // takeSnapshot が呼ばれていれば .agent/ が出来る。plan では出来ない。
      assert.ok(!existsSync(join(root, ".agent")))
    },
  )
})

test("plan: model 未指定なら config の cursor.model で数える", async () => {
  const root = mkdtempSync(join(tmpdir(), "famulus-coder-"))
  const out = await runCodeTask({ root, task: "t", plan: true })
  assert.equal(out.model, appConfig().cursor.model)
  // usage の無い run は costUsd を出さない(0 ではなく不明)。
  assert.equal(out.costUsd, undefined)
})

test("cost: usage があれば単価表で概算 USD を載せる", async () => {
  const root = mkdtempSync(join(tmpdir(), "famulus-coder-"))
  await withImpl(
    async () => ({
      ...cursor.summary,
      usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
    }),
    async () => {
      // composer-2.5: input 0.5 USD/M・output 2.5 USD/M(fast=false 側)→ 2*0.5 + 1*2.5
      const out = await runCodeTask({ root, task: "t", plan: true, model: "composer-2.5" })
      assert.ok(out.costUsd !== undefined)
      assert.ok(Math.abs(out.costUsd - 3.5) < 1e-9)
    },
  )
})

test("task: 成果をブランチにコミットして base へ復帰する", async () => {
  const dir = gitRepo()
  await withImpl(
    async (o) => {
      writeFileSync(join(String(o.cwd), "b.txt"), "agent output\n")
      return { ...cursor.summary, toolCalls: 2 }
    },
    async () => {
      const out = await runCodeTask({ root: dir, task: "add feature X" })
      assert.equal(cursor.calls[0]?.task, "add feature X")
      assert.match(out.branch ?? "", /^famulus\/\d{4}-\d{2}-\d{2}-add-feature-X$/)
      assert.match(out.snapshotSha ?? "", /^[0-9a-f]{40}$/)
      assert.equal(git(dir, "branch", "--show-current"), "main")
      assert.ok(out.branch !== undefined)
      assert.ok(git(dir, "ls-tree", "-r", "--name-only", out.branch).includes("b.txt"))
      // ハーネス内部状態(.agent / .cursor)以外は clean で戻る。
      const noise = git(dir, "status", "--porcelain")
        .split("\n")
        .filter((l) => l !== "" && !l.includes(".agent") && !l.includes(".cursor"))
      assert.deepEqual(noise, [])
    },
  )
})

test("task: 記号だけの依頼でもブランチ名が立つ。model 指定と usage も通る", async () => {
  const dir = gitRepo()
  await withImpl(
    async (o) => {
      writeFileSync(join(String(o.cwd), "b.txt"), "x\n")
      return { ...cursor.summary, usage: { inputTokens: 1_000_000, outputTokens: 0 } }
    },
    async () => {
      const out = await runCodeTask({ root: dir, task: "!!!", model: "composer-2.5" })
      assert.match(out.branch ?? "", /^famulus\/\d{4}-\d{2}-\d{2}-task$/)
      assert.equal(cursor.calls[0]?.model, "composer-2.5")
      assert.ok(out.costUsd !== undefined)
      assert.ok(Math.abs(out.costUsd - 0.5) < 1e-9)
    },
  )
})

test("task: dirty tree ではブランチを切らず、run は走らせる", async () => {
  const dir = gitRepo()
  writeFileSync(join(dir, "a.txt"), "uncommitted human work\n")
  await withImpl(
    async () => cursor.summary,
    async () => {
      const out = await runCodeTask({ root: dir, task: "t" })
      assert.equal(cursor.calls.length, 1)
      assert.equal(out.branch, undefined)
      assert.ok(out.branchDetail.includes("混入防止"))
      // 人間の未コミットはそのまま(何も変えない)。
      assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "uncommitted human work\n")
    },
  )
})
