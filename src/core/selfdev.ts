/**
 * コンテナから `/home/haru` は見えないので、famulus の clone を workspace に置く。履歴ごと渡すのは
 * 直した結果を `git diff` で取り出すため。コンテナで通ったゲートは複製での結果なので、本体へは反映しない。
 */

import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import { runDir, runInSandbox } from "../services/Sandbox.ts"
import { prepareSandboxNetwork } from "../services/SandboxNetwork.ts"
import { keepWorkspace } from "./workspaces.ts"

/** プロンプトにもこの名前で出る。 */
export const SELFDEV = "selfdev"

/** npm が作る `.npm` を clone の外に置くため1段下げる。 */
const CLONE = "famulus"

/** CLI の cwd は決まらないので import.meta.url から求める。 */
export const repoRoot = (): string => fileURLToPath(new URL("../..", import.meta.url))

/**
 * bun が要るのはこの workspace だけなのでイメージには入れない。版を固定すると mise が上げた日から
 * コンテナとホストのゲート結果が一致しなくなるので、ホストの版に合わせる。
 */
const BUN = `npx -y bun@${Bun.version}`

/** 中身は package.json の `gate` だけに置く。ここに並べ直すとホストとコンテナで黙って食い違う。 */
export const GATE = `cd ${CLONE} && ${BUN} run gate`

export const SELFDEV_PURPOSE =
  `famulus のソース(${repoRoot()} の clone)。famulus の不具合はここで修正する。` +
  `ゲートは \`${GATE}\`。net=true はコマンドとworkspaceごとの単回承認が必要。` +
  `直したものは \`git -C ${CLONE} diff\` で取り出してユーザーに渡す — ` +
  `**ここでの変更は動いている本体には入らない。**`

const INSTALL = `${BUN} install --frozen-lockfile`

/** cycle の中では走らせないので、コンテナの既定より長く取る。 */
const INSTALL_MS = 10 * 60_000

const sh = (cmd: string, args: readonly string[], cwd?: string): string =>
  execFileSync(cmd, args as string[], { encoding: "utf8", ...(cwd ? { cwd } : {}) }).trim()

/** `fresh` は直しかけの変更ごと clone を捨てるので既定では使わない。 */
export const selfdev = (opts?: { fresh?: boolean; skipGate?: boolean }) =>
  Effect.gen(function* () {
    const root = repoRoot()
    const ws = runDir(SELFDEV)
    const clone = join(ws, CLONE)
    const lines: string[] = []
    const installCommand = `cd ${CLONE} && ${INSTALL}`
    const installPermission = yield* prepareSandboxNetwork(installCommand, ws, "selfdev-install")
    const gatePermission = opts?.skipGate ? undefined : yield* prepareSandboxNetwork(GATE, ws, "selfdev-gate")
    if (!installPermission.approved || (gatePermission && !gatePermission.approved)) {
      return [installPermission, gatePermission]
        .flatMap((permission) => (permission && !permission.approved ? [permission.message] : []))
        .join("\n")
    }

    if (opts?.fresh === true && existsSync(clone)) {
      rmSync(clone, { recursive: true, force: true })
      lines.push("clone を捨てた(--fresh)")
    }

    // `--no-hardlinks`: 既定では同じ FS の clone が本体の `.git` と object の inode を共有する。
    if (existsSync(join(clone, ".git"))) {
      sh("git", ["-C", clone, "fetch", "origin", "--prune"])
      // `origin/HEAD` は clone 時に1度書かれるだけで、無いと rev-parse が失敗する。
      sh("git", ["-C", clone, "remote", "set-head", "origin", "-a"])
      const head = sh("git", ["-C", clone, "rev-parse", "--short", "origin/HEAD"])
      sh("git", ["-C", clone, "reset", "--hard", "origin/HEAD"])
      lines.push(`clone を ${head} に合わせた`)
    } else {
      sh("git", ["clone", "--no-hardlinks", root, clone])
      lines.push(`clone した: ${root} → ${clone}`)
    }
    // 未コミットの変更は clone に入らないので、入っていないことを出力に書く。
    const dirty = sh("git", ["-C", root, "status", "--porcelain"])
    if (dirty) lines.push(`※ 本体の未コミット ${dirty.split("\n").length} ファイルは clone に入っていない`)

    yield* keepWorkspace(SELFDEV, SELFDEV_PURPOSE)
    lines.push(`workspace ${SELFDEV} を登録した(cleanup の対象外)`)

    // ホストとコンテナで libc が異なり node_modules を共有できないので、コンテナ内で取得する。
    // reset で bun.lock が変わり得るので node_modules があっても毎回同期する。
    const install = yield* Effect.promise(() =>
      runInSandbox(installCommand, {
        workDir: ws,
        net: true,
        networkApproval: installPermission.approval,
        timeoutMs: INSTALL_MS,
      }),
    )
    lines.push(`依存の取得: 終了コード ${install.exitCode}(${Math.round(install.elapsedMs / 1000)}秒)`)
    if (install.exitCode !== 0) return [...lines, "", install.output].join("\n")

    if (opts?.skipGate === true) return lines.join("\n")

    // net を開けるのは、Web.ts の SSRF 対策が fetch 差し替えの手前で名前解決するため。閉じると検査と無関係に落ちる。
    // `| tail` を付けると終了コードが失われる。
    const gate = yield* Effect.promise(() =>
      runInSandbox(GATE, {
        workDir: ws,
        net: true,
        ...(gatePermission?.approved ? { networkApproval: gatePermission.approval } : {}),
        timeoutMs: INSTALL_MS,
      }),
    )
    lines.push(`ゲート: 終了コード ${gate.exitCode}(${Math.round(gate.elapsedMs / 1000)}秒)`)
    return [...lines, "", gate.output].join("\n")
  })
