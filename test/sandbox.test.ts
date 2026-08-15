/**
 * 走らせる手段の検査。通ることではなく、境界が外れないことを見る。
 *
 * 実際にコンテナが動くかどうかは docker を立てて確かめた(そちらはここでは回さない —
 * 検査に docker の生死を持ち込むと、境界の壊れとホストの都合が同じ赤で出る)。
 * ここに残すのは、モデルが書いた文字列がそのまま境界を広げうる2か所:
 * workspace の名前と、docker に渡す引数。
 */

import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { test } from "vitest"
import { TZ } from "../src/core/time.ts"
import {
  cacheRoot,
  dockerArgs,
  orphanNames,
  runDir,
  runInSandbox,
  runsRoot,
} from "../src/services/Sandbox.ts"

const withRoot = (fn: () => void): void => {
  const prev = process.env.OPEN_ZERO_RUNS
  process.env.OPEN_ZERO_RUNS = mkdtempSync(join(tmpdir(), "oz-runs-"))
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.OPEN_ZERO_RUNS
    else process.env.OPEN_ZERO_RUNS = prev
  }
}

test("workspace の名前は置き場の外に出られない", () => {
  withRoot(() => {
    const root = runsRoot()
    for (const name of ["../../etc", "/etc/passwd", "a/../../b", "~/.ssh"]) {
      const dir = runDir(name)
      // `..` が字として残っていても構わない — 区切りを消してあるので `a-..-..-b` は
      // 1つのディレクトリ名で、親には上がらない。見るべきは字面ではなく解決した先。
      assert.equal(resolve(dir), dir, `${name} → ${dir} が正規化されていない`)
      assert.ok(dir.startsWith(`${root}/`), `${name} → ${dir} が置き場の下に無い`)
      assert.equal(relative(root, dir).split("/").length, 1, `${name} → ${dir} が置き場の直下に無い`)
    }
  })
})

test("名前が全部落ちるものは弾く(空の workspace を作らない)", () => {
  withRoot(() => {
    // 全部が使えない字なら、削った結果は空になる。空を許すと置き場そのものが workspace になり、
    // 過去の走行が全部書ける場所に混ざる。
    assert.throws(() => runDir(".."), /走行名として使えない/)
    assert.throws(() => runDir("!!!"), /走行名として使えない/)
  })
})

test("既定では外に出られない。net を渡したときだけ開く", () => {
  const base = { workDir: "/tmp/w", name: "oz-run-test" }
  const closed = dockerArgs("echo hi", base)
  assert.deepEqual(
    closed.slice(closed.indexOf("--network"), closed.indexOf("--network") + 2),
    ["--network", "none"],
    "net を渡していないのに外へ出られる",
  )
  const open = dockerArgs("echo hi", { ...base, net: true })
  assert.equal(open[open.indexOf("--network") + 1], "bridge")
})

test("ホストへマウントするのは workspace と共有キャッシュだけ。コンテナは毎回捨てる", () => {
  const args = dockerArgs("echo hi", { workDir: "/tmp/w", name: "oz-run-test" })
  const mounts = args.filter((_, i) => args[i - 1] === "-v")
  assert.deepEqual(
    mounts,
    ["/tmp/w:/work", `${cacheRoot()}:/cache`],
    "workspace とキャッシュ以外が繋がっている",
  )
  assert.ok(args.includes("--rm"), "コンテナが残ると走行のたびに溜まる")
  // ユーザーの uid で走らせる。root のままだと、コンテナが作ったファイルを cycle が消せない。
  assert.equal(args[args.indexOf("--user") + 1], `${process.getuid?.()}:${process.getgid?.()}`)
})

test("中の時計の帯はホストと同じ", () => {
  // 帯を渡さないとコンテナは UTC で走る。同じコマンドが違う日付を出す環境になり、
  // コンテナ内で失敗した検査を読む側が、コードの不具合とタイムゾーン差を見分けられない。
  const args = dockerArgs("date", { workDir: "/tmp/w", name: "oz-run-test" })
  const env = args.filter((_, i) => args[i - 1] === "-e")
  assert.ok(env.includes(`TZ=${TZ}`), `帯が渡っていない: ${env.join(" ")}`)
})

test("パッケージキャッシュは workspace の外で共有する", () => {
  const args = dockerArgs("npm i", { workDir: "/tmp/w", name: "oz-run-test" })
  const env = args.filter((_, i) => args[i - 1] === "-e")
  for (const k of ["npm_config_cache=/cache/npm", "PIP_CACHE_DIR=/cache/pip", "UV_CACHE_DIR=/cache/uv"]) {
    assert.ok(env.includes(k), `${k} が渡っていない: ${env.join(" ")}`)
  }
  // 置き場が `.data/runs` の下にあると、cleanup が workspace として数えて 14 日で削除する。
  assert.ok(!cacheRoot().startsWith(`${runsRoot()}/`), "キャッシュが workspace の置き場の中にある")
})

/**
 * 時間切れ時の削除が実行されなかった回を後から処理する。名前の末尾の pid だけで決める。
 * 起動元プロセスが存在するものを消すと、実行中の走行が理由不明で停止する。
 */
test("起動元のホストPIDが存在しないコンテナだけ消す", () => {
  const mine = process.pid
  const out = orphanNames(
    [`oz-run-abc-${mine}`, "oz-run-abc-999999", "oz-run-abc-notapid", "oz-run-abc-0"],
    (pid) => pid === mine,
  )
  assert.deepEqual(out.removed, ["oz-run-abc-999999"])
  // pid が読めない名前(手で立てたもの・名前の付け方を変える前のもの)は残す側に倒す。
  assert.deepEqual(out.kept, [`oz-run-abc-${mine}`, "oz-run-abc-notapid", "oz-run-abc-0"])
})

test("コマンドは最後の1要素として渡す(語に割らない)", () => {
  // 空白で割って渡すと `bash -lc` は最初の語しか実行しない。パイプもリダイレクトも消える。
  const cmd = "npm install && node index.js | head -5"
  const args = dockerArgs(cmd, { workDir: "/tmp/w", name: "oz-run-test" })
  assert.deepEqual(args.slice(-3), ["bash", "-lc", cmd])
})

test("開始前にabortされていればdockerを起動しない", async () => {
  const controller = new AbortController()
  controller.abort(new Error("lease lost"))
  await assert.rejects(
    () => runInSandbox("echo should-not-run", { workDir: tmpdir(), signal: controller.signal }),
    /lease lost/,
  )
})
