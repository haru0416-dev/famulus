/**
 * 受信ポーリングの検査。systemd も Discord もモデルも呼ばない。
 *
 * poll.ts は import した瞬間に設定を固める(loadEnv → configureApp)ので、
 * 環境を先に置いてから動的 import で読む。ここで置く3つが境界になる:
 * - FAMULUS_DB=:memory: … 既定 runtime に実 DB を開かせない
 * - FAMULUS_DISCORD_TOKEN 空 … token が無いと読む先が無く、pollInbound は外へ出ない
 * - FAMULUS_CYCLE_UNIT 空 … wake が systemctl を呼ばない
 * 万一どれかが外れて外へ出たら、下の fetch 差し替えが先に落とす。
 */

import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test, vi } from "vitest"

process.env.FAMULUS_DB = ":memory:"
process.env.FAMULUS_DISCORD_TOKEN = ""
process.env.FAMULUS_DISCORD_OWNER_ID = ""
process.env.FAMULUS_CYCLE_UNIT = ""

const realFetch = globalThis.fetch
globalThis.fetch = (() => {
  throw new Error("検査中にネットワークへ出た")
}) as unknown as typeof fetch

const { poll, wake } = await import("../src/poll.ts")
const { run, runtime } = await import("../src/runtime.ts")
const { Db } = await import("../src/services/Db.ts")
const Effect = await import("effect/Effect")
const { nowIso } = await import("../src/core/time.ts")
const { PROJECT_ROOT } = await import("../src/core/config.ts")

afterAll(async () => {
  globalThis.fetch = realFetch
  await runtime().dispose()
})

const meta = (key: string) => run(Effect.flatMap(Db, (db) => db.meta(key)))
const setMeta = (key: string, value: string) => run(Effect.flatMap(Db, (db) => db.setMeta(key, value)))
const insertOwnerEvent = (id: string, originKind?: string) =>
  run(
    Effect.flatMap(Db, (db) =>
      db.run(
        // content は json_valid 制約があるので JSON 文字列で入れる。
        `INSERT INTO events (id,at,kind,source,taint,exposure,provenance,content,origin_kind,origin_id)
         VALUES (?,?,'observe','owner',0,'private','[]','"こんにちは"',?,?)`,
        id,
        nowIso(),
        originKind ?? null,
        originKind ? id : null,
      ),
    ),
  )

test("wake: unit が空なら systemd を呼ばずに起動扱い", async () => {
  assert.deepEqual(await wake(), { started: true, note: "起動しない(検査)" })
})

test("未読が無ければ起動せず、受信の生存時刻だけ進める", async () => {
  assert.equal(await poll(), "なし")
  assert.ok(await meta("health:inbound:last_success"))
})

test("対話REPLで処理済みのowner入力は未読に数えない", async () => {
  await insertOwnerEvent("poll-chat", "chat")
  assert.equal(await poll(), "なし")
})

test("未読があれば起動を試み、cycle:woke を記録する", async () => {
  await insertOwnerEvent("poll-e1")
  assert.equal(await poll(), "届 0 / 未読 1 — 起動しない(検査)")
  assert.ok(await meta("cycle:woke"))
})

test("起動直後の未読では再起動しない(間隔を空ける)", async () => {
  // cycle:woke は直前の検査で入ったばかり。完走の記録(cycle:last)は無い。
  assert.equal(await poll(), "届 0 / 未読 1 — 起動しない(前回から間隔が短い)")
})

test("cycle が完走していれば間隔を待たずに起動する(入れ違いの届き)", async () => {
  await setMeta("cycle:last", nowIso())
  assert.equal(await poll(), "届 0 / 未読 1 — 起動しない(検査)")
})

test("完走していなくても RETRY_MS を過ぎたら起動を試す", async () => {
  await setMeta("cycle:woke", "2026-01-01T00:00:00Z")
  await setMeta("cycle:last", "2025-12-31T00:00:00Z")
  assert.equal(await poll(), "届 0 / 未読 1 — 起動しない(検査)")
})

test("cursor が進めば未読は消える", async () => {
  const row = await run(Effect.flatMap(Db, (db) => db.get("SELECT MAX(rowid)n FROM events")))
  await setMeta("cycle:cursor", String(row?.n ?? 0))
  assert.equal(await poll(), "なし")
})

test("wake: unit があれば systemd の状態を見てから起動する", async () => {
  // CONFIG は import 時に固まるので、unit と偽の systemctl を置いてから読み直す。
  // systemctl は PATH 上の代替スクリプト — 実 systemd には触れない。
  const dir = mkdtempSync(join(tmpdir(), "fam-poll-systemctl-"))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(
    join(bin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      '[ "$2" = show ] && { printf "%s\\n" "$FAKE_STATE"; exit 0; }',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash の既定値展開で、JS の埋め込みではない
      '[ "$2" = start ] && exit "${FAKE_START_CODE:-0}"',
      "exit 0",
      "",
    ].join("\n"),
  )
  chmodSync(join(bin, "systemctl"), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${bin}:${prevPath ?? ""}`
  process.env.FAMULUS_CYCLE_UNIT = "famulus-cycle-test.service"
  try {
    vi.resetModules()
    const fresh = await import("../src/poll.ts")
    // oneshot は ExecStart の間ずっと activating。重ねて起動しない。
    process.env.FAKE_STATE = "activating"
    assert.deepEqual(await fresh.wake(), {
      started: false,
      note: "実行中(activating) — 次のポーリングで再確認する",
    })
    process.env.FAKE_STATE = "inactive"
    assert.deepEqual(await fresh.wake(), { started: true, note: "起動した: famulus-cycle-test.service" })
    process.env.FAKE_START_CODE = "1"
    const failed = await fresh.wake()
    assert.equal(failed.started, false)
    assert.ok(failed.note.startsWith("起動できなかった"), failed.note)
  } finally {
    process.env.PATH = prevPath
    process.env.FAMULUS_CYCLE_UNIT = ""
    delete process.env.FAKE_STATE
    delete process.env.FAKE_START_CODE
    rmSync(dir, { recursive: true, force: true })
  }
})

const spawnPoll = async (env: Record<string, string>) => {
  const child = Bun.spawn([process.execPath, "src/poll.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...Bun.env,
      FAMULUS_DB: ":memory:",
      FAMULUS_DISCORD_TOKEN: "",
      FAMULUS_DISCORD_OWNER_ID: "",
      FAMULUS_CYCLE_UNIT: "",
      FAMULUS_TZ: "Asia/Tokyo",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return { exitCode, stdout }
}

test("直接実行では main が走り、結果を1行出す(import.meta.main の回帰)", async () => {
  const out = await spawnPoll({})
  assert.equal(out.exitCode, 0)
  assert.equal(out.stdout.trim(), "なし")
})

test("DB が開けない回は失敗を書いて終了コード1", async () => {
  // /dev/null の下は mkdir できないので、DB を開く段で必ず落ちる。
  const out = await spawnPoll({ FAMULUS_DB: "/dev/null/famulus.db" })
  assert.equal(out.exitCode, 1)
  assert.ok(out.stdout.startsWith("失敗: "), out.stdout)
})
