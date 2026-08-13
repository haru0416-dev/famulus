/**
 * 自分のソースを、自分が動かせる場所に置く。
 *
 * コンテナに見えるのは作業場だけで、`/home/haru` は映らない(src/services/Sandbox.ts)。
 * この境界のせいで、**自走している側は自分のソースを読むことも直すこともできなかった**。
 * 実測で 2026-08-12 の tick が到達したのは「拾ってきた他人のリポジトリを動かす」ところまでで、
 * 自分の欠陥を見つけても書き換える手が無い。境界は緩めない — 代わりに**複製をこちら側から置く**。
 *
 * 置くのは clone。作業ツリーのコピーではなく履歴ごと渡すのは、直した結果を `git diff` で
 * 取り出せるようにするため。**本体への反映はここではやらない** — 反映は取り消しの効かない操作で、
 * コンテナの中で通ったゲートは「その複製で通った」という意味しか持たない。
 *
 * `keep` を立てて登録するので cleanup の日数では消えない(src/core/workspaces.ts)。
 */

import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { runDir, runInSandbox } from "../services/Sandbox.ts"
import { keepWorkspace } from "./workspaces.ts"

/** 作業場の名前。プロンプトにもこの名前で出る。 */
export const SELFDEV = "selfdev"

/** 作業場の中でのソースの位置。`npm` の置き土産(`.npm`)を clone の外に落とすために1段掘る。 */
const CLONE = "open-zero"

/** このファイルから見たリポジトリの根。**cwd に依らない** — CLI はどこから叩かれるか分からない。 */
export const repoRoot = (): string => fileURLToPath(new URL("../..", import.meta.url))

/**
 * 次の tick がこれを読んで「ここで何ができるか」を決める。**通し方を本文に書く。**
 * 一覧に出るのは名前とこの一行だけなので、ここに無い手順は次の回には存在しない。
 *
 * 中身は package.json の `gate` に置いてある。**定義を2か所に持たない** —
 * ここに並べ直すと、ホストで通しているものとコンテナで通しているものが黙って食い違う。
 * `corepack` を頭に付けるのは、コンテナの image に pnpm が入っていないから(corepack は入っている)。
 */
export const GATE = `cd ${CLONE} && corepack pnpm run gate`

export const SELFDEV_PURPOSE =
  `open-zero 自身のソース(${repoRoot()} の clone)。自分の欠陥はここで直す。` +
  `ゲートは \`${GATE}\`。**net を true にする** — 検査のうち数件が名前解決を要る。` +
  `直したものは \`git -C ${CLONE} diff\` で取り出してユーザーに渡す — ` +
  `**ここでの変更は動いている本体には入らない。**`

/** 依存の取得。`--frozen-lockfile` は lockfile と package.json のずれをその場で落とす。 */
const INSTALL = "corepack pnpm install --frozen-lockfile"

/** 依存の取得は分単位。tick の中では走らせないので、コンテナの既定(3分)より長く取る。 */
const INSTALL_MS = 10 * 60_000

const sh = (cmd: string, args: readonly string[], cwd?: string): string =>
  execFileSync(cmd, args as string[], { encoding: "utf8", ...(cwd ? { cwd } : {}) }).trim()

/**
 * 作業場を作って(あるいは作り直して)、中でゲートが通るところまで確かめる。
 *
 * `fresh` は clone ごと捨てて取り直す。**取り消せない**ので既定では取らない —
 * 中で直しかけていたものが消える。
 */
export const selfdev = (opts?: { fresh?: boolean; skipGate?: boolean }) =>
  Effect.gen(function* () {
    const root = repoRoot()
    const ws = runDir(SELFDEV)
    const clone = join(ws, CLONE)
    const lines: string[] = []

    if (opts?.fresh === true && existsSync(clone)) {
      rmSync(clone, { recursive: true, force: true })
      lines.push("clone を捨てた(--fresh)")
    }

    // ── ソースを置く。**--no-hardlinks**: 既定だと同じ FS の clone は object を共有する。
    // コンテナに渡す先が本体の `.git` と同じ inode を指す状態は、境界を引いた意味を薄める。
    if (existsSync(join(clone, ".git"))) {
      sh("git", ["-C", clone, "fetch", "origin", "--prune"])
      // `origin/HEAD` は clone のときに1度書かれるだけ。**張り直してから読む** —
      // 無い状態(古い git や壊れた clone)で rev-parse すると、ここで丸ごと落ちる。
      sh("git", ["-C", clone, "remote", "set-head", "origin", "-a"])
      const head = sh("git", ["-C", clone, "rev-parse", "--short", "origin/HEAD"])
      sh("git", ["-C", clone, "reset", "--hard", "origin/HEAD"])
      lines.push(`clone を ${head} に合わせた`)
    } else {
      sh("git", ["clone", "--no-hardlinks", root, clone])
      lines.push(`clone した: ${root} → ${clone}`)
    }
    // 手元の未コミットは clone に入らない。**入っていないことを書く** —
    // 「直したのに直っていない」の原因が、ここの取りこぼしだと分かるように。
    const dirty = sh("git", ["-C", root, "status", "--porcelain"])
    if (dirty) lines.push(`※ 本体の未コミット ${dirty.split("\n").length} ファイルは clone に入っていない`)

    yield* keepWorkspace(SELFDEV, SELFDEV_PURPOSE)
    lines.push(`作業場 ${SELFDEV} を登録した(cleanup の対象外)`)

    // ── 依存。ホスト側の node_modules は使えない(コンテナは bookworm、ホストは Ubuntu 26.04 で
    // libc が違う。tsc も biome も esbuild もプラットフォーム別のバイナリを持つ)。中で取る。
    if (!existsSync(join(clone, "node_modules"))) {
      const r = yield* Effect.promise(() =>
        runInSandbox(`cd ${CLONE} && ${INSTALL}`, { workDir: ws, net: true, timeoutMs: INSTALL_MS }),
      )
      lines.push(`依存の取得: 終了コード ${r.exitCode}(${Math.round(r.elapsedMs / 1000)}秒)`)
      if (r.exitCode !== 0) return [...lines, "", r.output].join("\n")
    } else {
      lines.push("node_modules は在るので依存の取得は飛ばした")
    }

    if (opts?.skipGate === true) return lines.join("\n")

    // ── **ここまでで止めない。** 置いただけでは「中でゲートが通る」ことの証拠にならない。
    //
    // `net` を開ける。検査は fetch を差し替えてあるので外へは出ないが、SSRF の防ぎは
    // 差し替えの手前で名前を引く(src/services/Web.ts の fetchFresh)。閉じたコンテナでは
    // そこが「名前が解決できない」で落ちるだけで、**検査が見ている条件とは関係が無い**。
    //
    // 出力を `| tail` で削らない。**パイプは終了コードを飲む** — 実際にここで
    // 「ゲート: 終了コード 0」と出しながら検査が 3 件落ちている状態を作った。
    // 長さは runInSandbox が末尾 12,000 字で切る。
    const gate = yield* Effect.promise(() =>
      runInSandbox(GATE, { workDir: ws, net: true, timeoutMs: INSTALL_MS }),
    )
    lines.push(`ゲート: 終了コード ${gate.exitCode}(${Math.round(gate.elapsedMs / 1000)}秒)`)
    return [...lines, "", gate.output].join("\n")
  })
