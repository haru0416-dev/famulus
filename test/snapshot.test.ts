import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  ensureSnapshotStore,
  isSnapshotStoreReady,
  latestFlowSnapshot,
  listSnapshots,
  resolveSnapshot,
  restoreSnapshot,
  takeSnapshot,
} from "../src/core/snapshot.ts"

const gitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "villicus-snap-"))
  execFileSync("git", ["-C", dir, "init", "-q"])
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", dir, "config", "user.name", "t"])
  return dir
}
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8")

describe("snapshotストア(①スナップショット式undo)", () => {
  test("修正・削除・追加を1点へ巻き戻す(3ケース同時)", () => {
    const cwd = gitRepo()
    try {
      writeFileSync(join(cwd, "keep.txt"), "original\n")
      writeFileSync(join(cwd, "gone.txt"), "will be deleted\n")
      expect(ensureSnapshotStore(cwd)).toBe(true)
      const snap = takeSnapshot(cwd, { label: "pre", kind: "pre-step", flowId: "f-1", stepIndex: 0 })
      expect(snap).not.toBeNull()

      writeFileSync(join(cwd, "keep.txt"), "MODIFIED\n")
      rmSync(join(cwd, "gone.txt"))
      writeFileSync(join(cwd, "added.txt"), "new\n")

      const r = restoreSnapshot(cwd, snap!.sha)
      expect(r.ok).toBe(true)
      expect(read(cwd, "keep.txt")).toBe("original\n") // 修正が戻る
      expect(read(cwd, "gone.txt")).toBe("will be deleted\n") // 削除が復活
      expect(existsSync(join(cwd, "added.txt"))).toBe(false) // 追加が除去
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test(".agent と ignored(node_modules)は復元で触られない(保護)", () => {
    const cwd = gitRepo()
    try {
      writeFileSync(join(cwd, ".gitignore"), "node_modules/\n")
      mkdirSync(join(cwd, "node_modules"), { recursive: true })
      writeFileSync(join(cwd, "node_modules", "dep.js"), "dep\n")
      mkdirSync(join(cwd, ".agent"), { recursive: true })
      writeFileSync(join(cwd, ".agent", "internal.txt"), "internal\n")
      const snap = takeSnapshot(cwd, { label: "pre", kind: "pre-step" })

      // .agent と ignored を変異させてから復元
      writeFileSync(join(cwd, ".agent", "internal.txt"), "MUTATED internal\n")
      writeFileSync(join(cwd, "node_modules", "dep.js"), "MUTATED dep\n")
      const r = restoreSnapshot(cwd, snap!.sha)
      expect(r.ok).toBe(true)
      // どちらも復元されず変異のまま残る(= restoreの管理外 = 保護されている)
      expect(read(cwd, ".agent/internal.txt")).toContain("MUTATED")
      expect(read(cwd, "node_modules/dep.js")).toContain("MUTATED")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("ユーザの .git には触れない(snapshotのcommitはユーザ履歴に出ない)", () => {
    const cwd = gitRepo()
    try {
      writeFileSync(join(cwd, "a.txt"), "1\n")
      execFileSync("git", ["-C", cwd, "add", "-A"])
      execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "base"])
      takeSnapshot(cwd, { label: "s1", kind: "manual" })
      writeFileSync(join(cwd, "a.txt"), "2\n")
      takeSnapshot(cwd, { label: "s2", kind: "manual" })
      const log = execFileSync("git", ["-C", cwd, "log", "--oneline"], { encoding: "utf8" }).trim()
      expect(log.split("\n")).toHaveLength(1) // baseの1件のみ
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("復元は非破壊: 直前に安全スナップショット(pre-restore)を取り可逆", () => {
    const cwd = gitRepo()
    try {
      writeFileSync(join(cwd, "a.txt"), "v1\n")
      const s1 = takeSnapshot(cwd, { label: "v1", kind: "manual" })
      writeFileSync(join(cwd, "a.txt"), "v2\n")
      const r = restoreSnapshot(cwd, s1!.sha)
      expect(r.ok).toBe(true)
      expect(r.safety).toBeDefined()
      expect(read(cwd, "a.txt")).toBe("v1\n")
      // 安全スナップショットへ戻せば v2 が復活(復元の取り消し)
      const back = restoreSnapshot(cwd, r.safety!.sha)
      expect(back.ok).toBe(true)
      expect(read(cwd, "a.txt")).toBe("v2\n")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("非gitディレクトリでも動く(storeは独立)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "villicus-snap-nogit-"))
    try {
      writeFileSync(join(cwd, "x.txt"), "a\n")
      const s = takeSnapshot(cwd, { label: "s", kind: "manual" })
      expect(s).not.toBeNull()
      writeFileSync(join(cwd, "x.txt"), "b\n")
      expect(restoreSnapshot(cwd, s!.sha).ok).toBe(true)
      expect(read(cwd, "x.txt")).toBe("a\n")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("listSnapshotsは新しい順、resolveSnapshotは短縮SHA解決、latestFlowSnapshotは最新pre-step", () => {
    const cwd = gitRepo()
    try {
      writeFileSync(join(cwd, "a.txt"), "1\n")
      const s0 = takeSnapshot(cwd, { label: "step0", kind: "pre-step", flowId: "f-9", stepIndex: 0 })
      writeFileSync(join(cwd, "a.txt"), "2\n")
      const s1 = takeSnapshot(cwd, { label: "step1", kind: "pre-step", flowId: "f-9", stepIndex: 1 })

      const list = listSnapshots(cwd)
      expect(list[0]!.sha).toBe(s1!.sha) // 新しい順
      expect(resolveSnapshot(cwd, s0!.sha.slice(0, 8))!.sha).toBe(s0!.sha) // 短縮SHA
      expect(resolveSnapshot(cwd, "deadbeef")).toBeUndefined()
      expect(latestFlowSnapshot(cwd, "f-9")!.stepIndex).toBe(1) // 最新pre-step
      expect(latestFlowSnapshot(cwd, "nope")).toBeUndefined()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("存在しないSHAへのrestoreは失敗を返す(安全スナップは取る)", () => {
    const cwd = gitRepo()
    try {
      writeFileSync(join(cwd, "a.txt"), "1\n")
      takeSnapshot(cwd, { label: "s", kind: "manual" })
      const r = restoreSnapshot(cwd, "0000000000000000000000000000000000000000")
      expect(r.ok).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("store未初期化ならisSnapshotStoreReadyはfalse", () => {
    const cwd = mkdtempSync(join(tmpdir(), "villicus-snap-empty-"))
    try {
      expect(isSnapshotStoreReady(cwd)).toBe(false)
      expect(listSnapshots(cwd)).toEqual([])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
