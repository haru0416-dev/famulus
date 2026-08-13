/**
 * 走らせる手段の検査。**通ることではなく、境界が外れないことを見る。**
 *
 * 実際にコンテナが動くかどうかは docker を立てて確かめた(そちらはここでは回さない —
 * 検査に docker の生死を持ち込むと、境界の壊れとホストの都合が同じ赤で出る)。
 * ここに残すのは、モデルが書いた文字列がそのまま境界を広げうる2か所:
 * 作業場の名前と、docker に渡す引数。
 */
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { test } from "node:test"
import { TZ } from "../src/core/time.ts"
import { cacheRoot, dockerArgs, orphanNames, runDir, runsRoot } from "../src/services/Sandbox.ts"

/** 置き場を一時ディレクトリに向ける。`.data/runs` を検査で汚さない。 */
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

test("作業場の名前は置き場の外に出られない", () => {
  withRoot(() => {
    const root = runsRoot()
    for (const name of ["../../etc", "/etc/passwd", "a/../../b", "~/.ssh"]) {
      const dir = runDir(name)
      // **`..` が字として残っていても構わない** — 区切りを消してあるので `a-..-..-b` は
      // 1つのディレクトリ名で、親には上がらない。見るべきは字面ではなく**解決した先**。
      assert.equal(resolve(dir), dir, `${name} → ${dir} が正規化されていない`)
      assert.ok(dir.startsWith(`${root}/`), `${name} → ${dir} が置き場の下に無い`)
      assert.equal(relative(root, dir).split("/").length, 1, `${name} → ${dir} が置き場の直下に無い`)
    }
  })
})

test("名前が全部落ちるものは弾く(空の作業場を作らない)", () => {
  withRoot(() => {
    // 全部が使えない字なら、削った結果は空になる。**空を許すと置き場そのものが作業場になり、
    // 過去の走行が全部書ける場所に混ざる。**
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

test("書けるのは作業場と共有キャッシュだけ。コンテナは毎回捨てる", () => {
  const args = dockerArgs("echo hi", { workDir: "/tmp/w", name: "oz-run-test" })
  const mounts = args.filter((_, i) => args[i - 1] === "-v")
  assert.deepEqual(mounts, ["/tmp/w:/work", `${cacheRoot()}:/cache`], "作業場とキャッシュ以外が繋がっている")
  assert.ok(args.includes("--rm"), "コンテナが残ると走行のたびに溜まる")
  // **ユーザーの uid で走らせる。** root のままだと、コンテナが作ったファイルを tick が消せない。
  assert.equal(args[args.indexOf("--user") + 1], `${process.getuid?.()}:${process.getgid?.()}`)
})

test("中の時計の帯はホストと同じ", () => {
  // 帯を渡さないとコンテナは UTC で走る。**同じコマンドが違う日付を出す環境**になり、
  // 中で落ちた検査を読む側が「自分の欠陥」と「帯の差」を見分けられない。
  const args = dockerArgs("date", { workDir: "/tmp/w", name: "oz-run-test" })
  const env = args.filter((_, i) => args[i - 1] === "-e")
  assert.ok(env.includes(`TZ=${TZ}`), `帯が渡っていない: ${env.join(" ")}`)
})

/**
 * **キャッシュを作業場の外へ出す。** `HOME=/work` のままだと npm も pip も uv も
 * 作業場ごとに同じものを落とす(実測: 別の作業場で uv が 2041ms → 3274ms、57MB を二重に持つ)。
 */
test("落としたものは作業場の外に置く", () => {
  const args = dockerArgs("npm i", { workDir: "/tmp/w", name: "oz-run-test" })
  const env = args.filter((_, i) => args[i - 1] === "-e")
  for (const k of ["npm_config_cache=/cache/npm", "PIP_CACHE_DIR=/cache/pip", "UV_CACHE_DIR=/cache/uv"]) {
    assert.ok(env.includes(k), `${k} が渡っていない: ${env.join(" ")}`)
  }
  // 置き場が `.data/runs` の下にあると、cleanup が作業場として数えて 14 日で落とす。
  assert.ok(!cacheRoot().startsWith(`${runsRoot()}/`), "キャッシュが作業場の置き場の中にある")
})

/**
 * **時間切れの片付けが飛ばなかった回**を後から拾う。名前の末尾の pid だけで決める。
 * 生きているものを消すと、走っている最中の走行が理由不明で落ちる。
 */
test("主のいないコンテナだけ消す", () => {
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
