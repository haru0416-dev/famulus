/**
 * workspace の一覧。`.data/runs/<名前>` に何が置いてあるかを、次の tick が読める形にする。
 *
 * `shell` は前から同じ名前を渡せば続きから走る作りになっていたが、どんな名前が在るかを
 * 知る手段が無かった。名前は毎回モデルが思い付きで書くので、実測では同じ調べ物に
 * `hn` と `ossrun` と `boundary-probe` が別々に立ち、どれが何のためのものかは
 * ディレクトリ名からしか読めない状態になっていた。続きから走らせるための仕組みが、
 * 続きの在り処を渡していない。
 *
 * ここに置くのはファイルシステムが知らないことだけ。
 *
 * - `purpose` … 何のための場所か。ディレクトリを見ても出てこない。
 * - `keep` … 触られなくても消してはいけない場所か。時刻からは決まらない(src/core/cleanup.ts)。
 *
 * 大きさと最後に触った時刻は木を走査すれば分かるので列にしない。持つと必ずずれる —
 * コンテナが書き込むのはホスト側のファイルなので、DB を経由せずに中身が変わる。
 */

import { existsSync, lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Db } from "../services/Db.ts"
import { runsRoot } from "../services/Sandbox.ts"
import { nowIso } from "./time.ts"

export interface Workspace {
  readonly name: string
  /** ホスト側の絶対パス。 */
  readonly dir: string
  /** 登録が無ければ undefined。「説明が無い」ことも読ませるので、行ごと落とさない。 */
  readonly purpose: string | undefined
  readonly keep: boolean
  readonly bytes: number
  /** ディレクトリ配下で最も新しい更新時刻(ミリ秒)。 */
  readonly touchedMs: number
}

export interface TreeStat {
  readonly bytes: number
  readonly newestMs: number
}

/** 読めないディレクトリは空として扱う。走行中に消えることがある。 */
const entriesOf = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * ディレクトリを1回だけ再帰走査し、合計サイズと最新更新時刻を同時に取得する。
 *
 * ルートディレクトリの時刻だけを見ると、配下のファイルを書き換えても親ディレクトリの時刻が変わらないため、
 * 使用中の workspace が「古い」と表示される。配下を走査して最も新しい更新時刻を採る。
 *
 * ## 同じ実体を2回数えない
 * workspace の内容はほとんどが `node_modules` で、bun の isolated と pnpm はそこを
 * symlink と hard link で構成する(bun は `node_modules/.bun/` へ、pnpm は `.pnpm/` へ張る)。
 *
 * - `readdirSync(recursive: true)` は symlink の参照先を走査する(Bun / Node どちらも)。
 *   この構造では同じディレクトリを繰り返し走査し、走査件数もサイズも数倍になる。
 *   symlink の循環があれば `ELOOP` を投げ、一覧取得全体が失敗する。
 * - hard link では同じ inode が複数のパスに現れる。パスごとに加算すると、
 *   消しても空かない分を数えることになる。
 *
 * 明示的に再帰走査して `lstat` で確認する。symlink は辿らず、容量にも含めない。
 * regular file の hard link は `dev:ino` で1回だけ数え、同じ実体の重複加算を避ける。
 * この方針はリンク構造で走査量と容量が膨らむのを防ぐためのもの。
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
        continue // 走査との競合で消えた項目。1件の競合で一覧全体を失敗させない。
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

/** 「3 時間前」「5 日前」。刻そのものより、放置の長さのほうが選ぶときに要る。 */
export const sinceLabel = (touchedMs: number, nowMs: number): string => {
  const h = (nowMs - touchedMs) / 3_600_000
  if (h < 1) return "さっき"
  if (h < 48) return `${Math.round(h)} 時間前`
  return `${Math.round(h / 24)} 日前`
}

/**
 * 登録と実体を突き合わせる。実体のあるものだけ返す — 消えた workspace の説明だけ残しても、
 * 一覧から選んだ先が空になる。並びは最後に触った順(続きをやる相手が上に来る)。
 */
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

/** プロンプトにも `oz ws` にも同じ形で出す。説明の無いものは無いと書く。 */
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

/**
 * 説明を書く/上書きする。`keep` はここからは動かせない —
 * 消えないようにする指定は取り消せない側(残り続ける)なので、ホスト側の管理経路からだけ変更する。
 */
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

/** 触られなくても消さない場所として登録する。`oz selfdev` のようなホスト側の管理経路から呼ぶ。 */
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

/** 消さない指定のある名前。cleanup がこれを避ける。 */
export const keptNames = Effect.gen(function* () {
  const db = yield* Db
  const rows = yield* db.all("SELECT name FROM workspaces WHERE keep = 1")
  return new Set(rows.map((r) => r.name as string))
})

/** 実体を消したあとに登録も削除する。残すと、実体の無い説明が一覧に出ない代わりに溜まる。 */
export const forgetWorkspaces = (names: readonly string[]) =>
  Effect.gen(function* () {
    if (names.length === 0) return
    const db = yield* Db
    for (const n of names) yield* db.run("DELETE FROM workspaces WHERE name = ?", n)
  })
