/**
 * DB には `purpose` と `keep` だけを持つ。大きさと更新時刻はコンテナが DB を経由せずに変えるので、列にせず毎回走査する。
 */

import { existsSync, lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Db } from "../services/Db.ts"
import { runsRoot } from "../services/Sandbox.ts"
import { nowIso } from "./time.ts"

export interface Workspace {
  readonly name: string
  readonly dir: string
  /** 説明が無いことも読ませるので、未登録でも行を落とさない。 */
  readonly purpose: string | undefined
  readonly keep: boolean
  readonly bytes: number
  readonly touchedMs: number
}

export interface TreeStat {
  readonly bytes: number
  readonly newestMs: number
}

/** 走行中に消えることがある。 */
const entriesOf = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 配下のファイルを書き換えても親ディレクトリの時刻は変わらないので、配下の最新時刻を採る。
 * `readdirSync(recursive: true)` は symlink を辿り、node_modules の構造で重複走査や ELOOP になるので使わない。
 * hard link は `dev:ino` で1回だけ数える。
 */
export const scanTree = (dir: string): TreeStat => {
  let bytes = 0
  let newestMs: number
  try {
    newestMs = lstatSync(dir).mtimeMs
  } catch {
    return { bytes: 0, newestMs: 0 }
  }
  const seen = new Set<string>()
  const stack = [dir]
  for (let d = stack.pop(); d !== undefined; d = stack.pop()) {
    for (const e of entriesOf(d)) {
      const p = join(d, e.name)
      let s: ReturnType<typeof lstatSync>
      try {
        s = lstatSync(p)
      } catch {
        continue
      }
      if (s.mtimeMs > newestMs) newestMs = s.mtimeMs
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.isFile()) {
        if (s.nlink > 1) {
          const key = `${s.dev}:${s.ino}`
          if (seen.has(key)) continue
          seen.add(key)
        }
        bytes += s.size
      }
    }
  }
  return { bytes, newestMs }
}

export const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)}MB`

export const sinceLabel = (touchedMs: number, nowMs: number): string => {
  const h = (nowMs - touchedMs) / 3_600_000
  if (h < 1) return "さっき"
  if (h < 48) return `${Math.round(h)} 時間前`
  return `${Math.round(h / 24)} 日前`
}

/** 実体のあるものだけ返す。消えた workspace の説明を返すと、選んだ先が空になる。 */
export const listWorkspaces = Effect.gen(function* () {
  const db = yield* Db
  const rows = yield* db.all("SELECT name, purpose, keep FROM workspaces")
  const reg = new Map(rows.map((r) => [r.name as string, r]))
  const root = runsRoot()
  if (!existsSync(root)) return []
  const out: Workspace[] = []
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dir = join(root, e.name)
    const r = reg.get(e.name)
    const t = scanTree(dir)
    out.push({
      name: e.name,
      dir,
      purpose: r === undefined ? undefined : (r.purpose as string),
      keep: r?.keep === 1,
      bytes: t.bytes,
      touchedMs: t.newestMs,
    })
  }
  return out.sort((a, b) => b.touchedMs - a.touchedMs)
})

export const renderWorkspaces = (list: readonly Workspace[], nowMs: number): string => {
  if (list.length === 0) return "(まだ1つも無い)"
  return list
    .map((w) => {
      const flags = w.keep ? " / 消さない" : ""
      const head = `- ${w.name}(${mb(w.bytes)} / 最後に触ったのは ${sinceLabel(w.touchedMs, nowMs)}${flags})`
      return `${head}\n  ${w.purpose ?? "説明なし — 何のための場所か分からない"}`
    })
    .join("\n")
}

export const purposeOf = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const r = yield* db.get("SELECT purpose FROM workspaces WHERE name = ?", name)
    return r === undefined ? undefined : (r.purpose as string)
  })

/** `keep` はモデルから変えさせない。ホスト側の管理経路(`keepWorkspace`)だけが立てる。 */
export const noteWorkspace = (name: string, purpose: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.run(
      `INSERT INTO workspaces (name, purpose, created_at, keep)VALUES (?, ?, ?, 0)
         ON CONFLICT(name)DO UPDATE SET purpose = excluded.purpose`,
      name,
      purpose,
      nowIso(),
    )
  })

export const keepWorkspace = (name: string, purpose: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.run(
      `INSERT INTO workspaces (name, purpose, created_at, keep)VALUES (?, ?, ?, 1)
         ON CONFLICT(name)DO UPDATE SET purpose = excluded.purpose, keep = 1`,
      name,
      purpose,
      nowIso(),
    )
  })

export const keptNames = Effect.gen(function* () {
  const db = yield* Db
  const rows = yield* db.all("SELECT name FROM workspaces WHERE keep = 1")
  return new Set(rows.map((r) => r.name as string))
})

export const forgetWorkspaces = (names: readonly string[]) =>
  Effect.gen(function* () {
    if (names.length === 0) return
    const db = yield* Db
    for (const n of names) yield* db.run("DELETE FROM workspaces WHERE name = ?", n)
  })
