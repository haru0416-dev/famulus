// 実 docker は使わない。docker の生死を持ち込むと、境界の破損とホストの事情が同じ失敗として出る。

import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { timeZone } from "../../src/core/time.ts"
import { Proposals } from "../../src/services/Proposals.ts"
import {
  cacheRoot,
  dockerArgs,
  orphanNames,
  PUBLIC_NETWORK,
  runDir,
  runInSandbox,
  runsRoot,
  sweepOrphans,
} from "../../src/services/Sandbox.ts"
import { prepareSandboxNetwork } from "../../src/services/SandboxNetwork.ts"
import { withHarness } from "../helpers.ts"

const withRoot = (fn: () => void): void => {
  const prev = process.env.FAMULUS_RUNS
  process.env.FAMULUS_RUNS = mkdtempSync(join(tmpdir(), "fam-runs-"))
  try {
    configureApp()
    fn()
  } finally {
    if (prev === undefined) delete process.env.FAMULUS_RUNS
    else process.env.FAMULUS_RUNS = prev
    configureApp()
  }
}

test("workspace の名前は置き場の外に出られない", () => {
  withRoot(() => {
    const root = runsRoot()
    for (const name of ["../../etc", "/etc/passwd", "a/../../b", "~/.ssh"]) {
      const dir = runDir(name)
      // 区切りを消してあるので `a-..-..-b` は1つのディレクトリ名で、親には上がらない。字面ではなく解決した先を見る。
      assert.equal(resolve(dir), dir, `${name} → ${dir} が正規化されていない`)
      assert.ok(dir.startsWith(`${root}/`), `${name} → ${dir} が置き場の下に無い`)
      assert.equal(relative(root, dir).split("/").length, 1, `${name} → ${dir} が置き場の直下に無い`)
    }
  })
})

test("名前が全部落ちるものは弾く(空の workspace を作らない)", () => {
  withRoot(() => {
    // 空を許すと置き場そのものが workspace になり、過去の走行と混ざる。
    assert.throws(() => runDir(".."), /走行名として使えない/)
    assert.throws(() => runDir("!!!"), /走行名として使えない/)
  })
})

test("既定では外に出られず、net は内部宛先を拒否する専用networkだけを使う", () => {
  const base = { workDir: "/tmp/w", name: "fam-run-test" }
  const closed = dockerArgs("echo hi", base)
  assert.deepEqual(
    closed.slice(closed.indexOf("--network"), closed.indexOf("--network") + 2),
    ["--network", "none"],
    "net を渡していないのに外へ出られる",
  )
  const open = dockerArgs("echo hi", { ...base, net: true })
  assert.equal(open[open.indexOf("--network") + 1], PUBLIC_NETWORK)
  assert.deepEqual(open.slice(open.indexOf("--cap-drop"), open.indexOf("--cap-drop") + 2), [
    "--cap-drop",
    "ALL",
  ])
  assert.ok(open.includes("no-new-privileges:true"))
})

test("ホストへマウントするのは workspace と共有キャッシュだけ。コンテナは毎回捨てる", () => {
  const args = dockerArgs("echo hi", { workDir: "/tmp/w", name: "fam-run-test" })
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
  // TZ を渡さないとコンテナは UTC で走り、失敗した検査がコードの不具合かタイムゾーン差か見分けられない。
  const args = dockerArgs("date", { workDir: "/tmp/w", name: "fam-run-test" })
  const env = args.filter((_, i) => args[i - 1] === "-e")
  assert.ok(env.includes(`TZ=${timeZone()}`), `帯が渡っていない: ${env.join(" ")}`)
})

test("パッケージキャッシュは workspace の外で共有する", () => {
  const args = dockerArgs("npm i", { workDir: "/tmp/w", name: "fam-run-test" })
  const env = args.filter((_, i) => args[i - 1] === "-e")
  for (const k of ["npm_config_cache=/cache/npm", "PIP_CACHE_DIR=/cache/pip", "UV_CACHE_DIR=/cache/uv"]) {
    assert.ok(env.includes(k), `${k} が渡っていない: ${env.join(" ")}`)
  }
  // 置き場が `.data/runs` の下にあると、cleanup が workspace として数えて削除する。
  assert.ok(!cacheRoot().startsWith(`${runsRoot()}/`), "キャッシュが workspace の置き場の中にある")
})

// 起動元プロセスが生きているものを消すと、実行中の走行が止まる。名前の末尾の pid だけで決める。
test("起動元のホストPIDが存在しないコンテナだけ消す", () => {
  const mine = process.pid
  const out = orphanNames(
    [`fam-run-abc-${mine}`, "fam-run-abc-999999", "fam-run-abc-notapid", "fam-run-abc-0"],
    (pid) => pid === mine,
  )
  assert.deepEqual(out.removed, ["fam-run-abc-999999"])
  // pid が読めない名前(手で立てたもの・古い命名のもの)は残す。
  assert.deepEqual(out.kept, [`fam-run-abc-${mine}`, "fam-run-abc-notapid", "fam-run-abc-0"])
})

test("コマンドは最後の1要素として渡す(語に割らない)", () => {
  // 空白で割って渡すと `bash -lc` は最初の語しか実行しない。パイプもリダイレクトも消える。
  const cmd = "npm install && node index.js | head -5"
  const args = dockerArgs(cmd, { workDir: "/tmp/w", name: "fam-run-test" })
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

test("相対の workDir は走らせる前に弾く", async () => {
  await assert.rejects(() => runInSandbox("echo x", { workDir: "rel/path" }), /絶対パス/)
})

test("承認なし・操作変更は拒否し、policy不備では承認を消費しない", async () => {
  await withFakeDocker(async ({ log, workDir }) => {
    await withHarness(async (h) => {
      await assert.rejects(
        () => runInSandbox("echo x", { workDir, image: FAKE_IMAGE, net: true }),
        /単回承認/,
      )
      const request = await h.run(prepareSandboxNetwork("echo x", workDir))
      if (request.approved) throw new Error("unexpected approval")
      await h.run(Effect.flatMap(Proposals, (p) => p.approve(request.id)))
      const permission = await h.run(prepareSandboxNetwork("echo x", workDir))
      if (!permission.approved) throw new Error("missing approval")
      const opts = { workDir, image: FAKE_IMAGE, net: true, networkApproval: permission.approval }
      await assert.rejects(() => runInSandbox("echo changed", opts), /単回承認/)
      await assert.rejects(() => runInSandbox("echo x", { ...opts, workDir: `${workDir}/other` }), /単回承認/)
      await assert.rejects(
        () =>
          runInSandbox("echo x", opts, async () => {
            throw new Error("policy missing")
          }),
        /policy missing/,
      )
      assert.equal(readFileSync(log, "utf8"), "")
      const result = await runInSandbox("echo x", opts, async () => {})
      assert.equal(result.exitCode, 0)
      assert.match(result.output, /FAKE-OK/)
      await assert.rejects(() => runInSandbox("echo x", opts, async () => {}))
    })
  })
})

test("ネット走行が失敗しても同じ承認を再利用できない", async () => {
  await withFakeDocker(async ({ workDir }) => {
    await withHarness(async (h) => {
      const request = await h.run(prepareSandboxNetwork("exit 3", workDir))
      if (request.approved) throw new Error("unexpected approval")
      await h.run(Effect.flatMap(Proposals, (p) => p.approve(request.id)))
      const permission = await h.run(prepareSandboxNetwork("exit 3", workDir))
      if (!permission.approved) throw new Error("missing approval")
      const opts = { workDir, image: FAKE_IMAGE, net: true, networkApproval: permission.approval }
      process.env.FAKE_RUN_MODE = "fail"
      assert.equal((await runInSandbox("exit 3", opts, async () => {})).exitCode, 3)
      await assert.rejects(() => runInSandbox("exit 3", opts, async () => {}))
    })
  })
})

test("コンテナ内の home は workspace(uid 指定で home が無くなるため)", () => {
  const args = dockerArgs("x", { workDir: "/tmp/w", name: "fam-run-test" })
  const env = args.filter((_, i) => args[i - 1] === "-e")
  assert.ok(env.includes("HOME=/work"), `HOME が渡っていない: ${env.join(" ")}`)
  assert.equal(args[args.indexOf("-w") + 1], "/work")
})

test("イメージは opts → config → 既定の順で決める", () => {
  const base = { workDir: "/tmp/w", name: "fam-run-test" }
  const prev = process.env.FAMULUS_RUN_IMAGE
  try {
    process.env.FAMULUS_RUN_IMAGE = "my-image:9"
    configureApp()
    assert.ok(dockerArgs("x", base).includes("my-image:9"))
    assert.ok(dockerArgs("x", { ...base, image: "explicit:1" }).includes("explicit:1"))
    delete process.env.FAMULUS_RUN_IMAGE
    configureApp()
    assert.ok(dockerArgs("x", base).includes("famulus-run:1"))
  } finally {
    if (prev === undefined) delete process.env.FAMULUS_RUN_IMAGE
    else process.env.FAMULUS_RUN_IMAGE = prev
    configureApp()
  }
})

// 以下は docker を PATH 上の代替スクリプトに差し替える。イメージ名を不正な参照にしてあるので、差し替えが外れて実 docker へ届いてもコンテナは立たない。

const FAKE_IMAGE = "fam-test-invalid::"

const fakeDockerScript = [
  "#!/usr/bin/env bash",
  'case "$1" in',
  '  rm) printf "rm %s\\n" "$*" >> "$FAKE_DOCKER_LOG"; exit 0 ;;',
  // FAKE_PS_NAMES は意図して語分割させる(1語 = 1コンテナ名 = 1行)。
  '  ps) printf "%s\\n" $FAKE_PS_NAMES; exit 0 ;;',
  "  image|build) exit 1 ;;",
  "  run)",
  '    case "$FAKE_RUN_MODE" in',
  // 30,000 字は MAX_OUTPUT_CHARS の2倍を超える長さ。超えないと末尾を捨てる実装でも TAIL-END が残る。
  '      big) for _ in $(seq 300); do printf "%0100d" 0; done; printf "\\nTAIL-END\\n"; exit 0 ;;',
  // sleep の stdio を pipe から外す。繋いだままだと SIGKILL 後も孫の sleep が pipe を開いたままで、close が遅れる。
  "      slow) sleep 3 >/dev/null 2>&1; exit 0 ;;",
  '      fail) printf "boom\\n"; exit 3 ;;',
  '      *) printf "FAKE-OK\\n"; exit 0 ;;',
  "    esac ;;",
  "esac",
  "exit 0",
  "",
].join("\n")

const withFakeDocker = async (
  fn: (ctx: { log: string; workDir: string }) => Promise<void>,
  opts?: { noDocker?: boolean },
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "fam-fake-docker-"))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  if (opts?.noDocker !== true) {
    writeFileSync(join(bin, "docker"), fakeDockerScript)
    chmodSync(join(bin, "docker"), 0o755)
  }
  const log = join(dir, "docker.log")
  writeFileSync(log, "")
  const workDir = join(dir, "work")
  mkdirSync(workDir)
  const prev = {
    path: process.env.PATH,
    runs: process.env.FAMULUS_RUNS,
    cache: process.env.FAMULUS_RUN_CACHE,
    image: process.env.FAMULUS_RUN_IMAGE,
  }
  // noDocker では PATH を空の bin だけにする。代替を置くときは先頭に足す(代替スクリプトが bash や seq を使う)。
  process.env.PATH = opts?.noDocker === true ? bin : `${bin}:${prev.path ?? ""}`
  process.env.FAMULUS_RUNS = join(dir, "runs")
  process.env.FAMULUS_RUN_CACHE = join(dir, "cache")
  delete process.env.FAMULUS_RUN_IMAGE
  process.env.FAKE_DOCKER_LOG = log
  try {
    configureApp()
    await fn({ log, workDir })
  } finally {
    process.env.PATH = prev.path
    if (prev.runs === undefined) delete process.env.FAMULUS_RUNS
    else process.env.FAMULUS_RUNS = prev.runs
    if (prev.cache === undefined) delete process.env.FAMULUS_RUN_CACHE
    else process.env.FAMULUS_RUN_CACHE = prev.cache
    if (prev.image !== undefined) process.env.FAMULUS_RUN_IMAGE = prev.image
    delete process.env.FAKE_DOCKER_LOG
    delete process.env.FAKE_RUN_MODE
    delete process.env.FAKE_PS_NAMES
    configureApp()
    rmSync(dir, { recursive: true, force: true })
  }
}

test("出力と終了コードをそのまま返す(失敗も失敗のまま)", async () => {
  await withFakeDocker(async ({ workDir }) => {
    const ok = await runInSandbox("echo hi", { workDir, image: FAKE_IMAGE })
    assert.equal(ok.exitCode, 0)
    assert.ok(ok.output.includes("FAKE-OK"))
    assert.equal(ok.truncated, false)
    assert.equal(ok.timedOut, false)
    process.env.FAKE_RUN_MODE = "fail"
    const bad = await runInSandbox("echo hi", { workDir, image: FAKE_IMAGE })
    assert.equal(bad.exitCode, 3)
    assert.ok(bad.output.includes("boom"))
  })
})

test("長い出力は頭を省いて末尾を残す", async () => {
  await withFakeDocker(async ({ workDir }) => {
    process.env.FAKE_RUN_MODE = "big"
    const r = await runInSandbox("build", { workDir, image: FAKE_IMAGE })
    assert.equal(r.truncated, true)
    assert.ok(r.output.startsWith("…(頭を"), r.output.slice(0, 40))
    assert.ok(r.output.includes("TAIL-END"))
  })
})

test("時間切れはコンテナを名前で外から消し、timedOut を立てる", async () => {
  await withFakeDocker(async ({ workDir, log }) => {
    process.env.FAKE_RUN_MODE = "slow"
    const r = await runInSandbox("sleep", { workDir, image: FAKE_IMAGE, timeoutMs: 300 })
    assert.equal(r.timedOut, true)
    assert.ok(r.elapsedMs < 2_500, `切られていない: ${r.elapsedMs}ms`)
    // rm は完了を待たずに返るので、ログに書かれるまで待つ。
    const deadline = Date.now() + 3_000
    let seen = ""
    while (Date.now() < deadline) {
      seen = readFileSync(log, "utf8")
      if (seen.includes("rm -f fam-run-")) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(seen.includes("rm -f fam-run-"), `rm が飛んでいない: ${seen}`)
  })
  // 既定の 5 秒だと退行時に vitest が打ち切り、PATH の復元が次の検査に漏れる。
}, 10_000)

test("走行中の abort は止めて例外で返す", async () => {
  await withFakeDocker(async ({ workDir }) => {
    process.env.FAKE_RUN_MODE = "slow"
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("lease lost")), 100)
    await assert.rejects(
      () => runInSandbox("sleep", { workDir, image: FAKE_IMAGE, signal: controller.signal }),
      /lease lost/,
    )
  })
}, 10_000)

test("docker が無ければ 127 と理由を返す(例外にしない)", async () => {
  await withFakeDocker(
    async ({ workDir }) => {
      const r = await runInSandbox("echo hi", { workDir, image: FAKE_IMAGE })
      assert.equal(r.exitCode, 127)
      assert.ok(r.output.includes("走らせられなかった"), r.output)
    },
    { noDocker: true },
  )
})

test("イメージを組めなければ素のイメージへ落とし、そのことを先頭に書く", async () => {
  // ensureImage は結果をプロセス内で使い回す。他の検査は image を明示しているので影響しない。
  await withFakeDocker(async ({ workDir }) => {
    const r = await runInSandbox("echo hi", { workDir })
    assert.equal(r.exitCode, 0)
    assert.ok(r.output.startsWith("[走行用イメージを組めなかった"), r.output.slice(0, 60))
    assert.ok(r.output.includes("FAKE-OK"))
  })
})

test("sweepOrphans: 起動元 pid の無いコンテナだけ rm する。dry は数えるだけ", async () => {
  await withFakeDocker(async ({ log }) => {
    const dead = 1_073_741_824 // pid_max より大きく、存在し得ない pid
    process.env.FAKE_PS_NAMES = `fam-run-a-${dead} fam-run-b-${process.pid} fam-run-c-notapid`
    const dry = await sweepOrphans(true)
    assert.deepEqual(dry.removed, [`fam-run-a-${dead}`])
    assert.deepEqual(dry.kept, [`fam-run-b-${process.pid}`, "fam-run-c-notapid"])
    assert.ok(!readFileSync(log, "utf8").includes("rm"), "dry なのに消しに行った")
    const wet = await sweepOrphans()
    assert.deepEqual(wet.removed, [`fam-run-a-${dead}`])
    assert.ok(readFileSync(log, "utf8").includes(`rm -f fam-run-a-${dead}`))
  })
})
