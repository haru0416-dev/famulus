#!/usr/bin/env bun
/**
 * 受信のポーリング。30秒ごとに systemd のタイマーから起動し、モデルは呼ばない。
 * cycle(15分間隔)から分けるのは返事の待ち時間を間隔から外すため。websocket にしないのは
 * 再接続とセッション再開を自前で持たないため(オンライン表示は src/presence.ts)。
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as Effect from "effect/Effect"
import { configureApp } from "./core/config.ts"
import { loadEnv } from "./core/env.ts"
import { nowIso } from "./core/time.ts"
import { wakePendingDelivery } from "./deliver.ts"
import { drainInbox } from "./inbox.ts"
import { run, runtime } from "./runtime.ts"
import { Db } from "./services/Db.ts"

loadEnv()
const CONFIG = configureApp()

const exec = promisify(execFile)

/**
 * 再起動を試す最小間隔。枯渇や停止で cycle が即時終了すると未読が残り、30秒ごとの起動要求が積み上がる。
 * cycle が正常終了した直後の未読には適用しない(`completed`)。
 */
const RETRY_MS = 180_000

/**
 * 実行中の oneshot への `start` は待ち行列に積まれない。走行中に届いたぶんは DB に未読として残り、
 * 次の起動で拾う。
 */
export async function wake(): Promise<{ started: boolean; note: string }> {
  // 検査は unit を空にして、実際に systemd を呼ばない
  const unit = CONFIG.cycle.unit
  if (!unit) return { started: true, note: "起動しない(検査)" }
  // `is-active` は使えない。Type=oneshot は ExecStart の間 `activating` で、終了コード 3 を返す。
  const state = await exec("systemctl", ["--user", "show", unit, "-p", "ActiveState", "--value"])
    .then((r) => r.stdout.trim())
    .catch(() => "")
  if (state !== "" && state !== "inactive" && state !== "failed")
    return { started: false, note: `実行中(${state}) — 次のポーリングで再確認する` }
  try {
    await exec("systemctl", ["--user", "start", "--no-block", unit])
    return { started: true, note: `起動した: ${unit}` }
  } catch (e) {
    return { started: false, note: `起動できなかった: ${String(e)}` }
  }
}

export async function poll(): Promise<string> {
  try {
    const state = await run(
      Effect.gen(function* () {
        const db = yield* Db
        const got = yield* drainInbox

        // 届いた件数ではなく DB の未読で決める。cycle 実行中の起動要求は併合されて落ちる。
        // 未読を消すのは completeCycle。
        const cursor = Number((yield* db.meta("cycle:cursor")) ?? 0)
        const row = yield* db.get(
          "SELECT COUNT(*)n FROM events WHERE rowid > ?AND source = 'owner' AND COALESCE(origin_kind,'') != 'chat'",
          cursor,
        )
        const unread = Number(row?.n ?? 0)
        yield* db.setMeta("health:inbound:last_success", nowIso())
        if (unread === 0) return { count: got, unread, wake: false }

        const wokeRaw = yield* db.meta("cycle:woke")
        const since = Date.now() - (wokeRaw ? Date.parse(wokeRaw) : 0)

        // cycle が最後まで実行されたのに未読が残る = その回と入れ違いに届いた。`cycle:last` は completeCycle
        // でしか進まないので、枯渇や停止で処理されなかった回はここに入らず RETRY_MS で間隔を空ける。
        const lastRaw = yield* db.meta("cycle:last")
        const completed = !!lastRaw && !!wokeRaw && Date.parse(lastRaw) >= Date.parse(wokeRaw)
        return { count: got, unread, wake: got > 0 || completed || since >= RETRY_MS }
      }),
    )

    if (state.unread === 0) return state.count > 0 ? `${state.count} 件(未読なし)` : "なし"
    const head = `届 ${state.count} / 未読 ${state.unread}`
    if (!state.wake) return `${head} — 起動しない(前回から間隔が短い)`

    const w = await wake()
    // 起動できた回だけ記録する。実行中で拒否された回を記録すると、RETRY_MS のあいだ再起動されない。
    if (w.started)
      await run(
        Effect.gen(function* () {
          const db = yield* Db
          yield* db.setMeta("cycle:woke", nowIso())
        }),
      )
    return `${head} — ${w.note}`
  } finally {
    // 受信の記録と cycle 起動を配送より先に終える。配送は poll の60秒 cgroup から分離する。
    await wakePendingDelivery(CONFIG.discord.token !== undefined)
  }
}

const main = async (): Promise<void> => {
  const rt = runtime()
  try {
    console.log(await poll())
  } catch (e) {
    await run(
      Effect.flatMap(Db, (db) =>
        db.setMeta(
          "health:inbound:last_failure",
          JSON.stringify({ at: nowIso(), stage: "poll-inbox", error: String(e) }),
        ),
      ),
      rt,
    ).catch(() => {})
    console.log(`失敗: ${String(e)}`)
    process.exitCode = 1
  } finally {
    await rt.dispose()
  }
}

// 検査から import したときに受信処理を走らせない。
if (import.meta.main) await main()
