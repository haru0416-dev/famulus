#!/usr/bin/env bun
/**
 * 受信のポーリング。30秒ごとに systemd のタイマーから起動する。
 *
 *   1. 受信箱を1回読む。モデルは呼ばない。
 *   2. 何も来ていなければ終わる。大半の起動はここで終わる。
 *   3. 来ていたら DB に移して cycle の systemd unit を起動する。
 *
 * 受け取りを cycle(15分間隔)から分けてあるのは、返事の待ち時間を間隔から外すため。
 * websocket にしないのは再接続とセッション再開を自前で持たずに済ませるため。
 * オンライン表示だけは gateway が要るので別プロセス(src/presence.ts)。
 *
 * 続けて打たれた行は次のポーリングでまとめて読まれ、cycle の起動は1回だけ行う。
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as Effect from "effect/Effect"
import { configureApp } from "./core/config.ts"
import { loadEnv } from "./core/env.ts"
import { nowIso } from "./core/time.ts"
import { drainInbox } from "./inbox.ts"
import { run, runtime } from "./runtime.ts"
import { Db } from "./services/Db.ts"

loadEnv()
const CONFIG = configureApp()

const exec = promisify(execFile)

/**
 * 再起動を試すまでの最小間隔。クォータ枯渇や停止で cycle が即時終了したとき、未読は残るので
 * 毎回起動を試すことになる。30秒ごとにそれを行うと処理されない起動要求が積み上がる。
 * cycle が正常に終わった直後の未読には適用しない(下の `completed`)。
 */
const RETRY_MS = 180_000

/**
 * cycle の systemd unit を起動する。実行中の oneshot に `start` を重ねても待ち行列には積まれず、2回目は実行
 * されない。走行中に届いたぶんは DB に未読として残るので、次の起動で拾い直す。
 */
async function wake(): Promise<{ started: boolean; note: string }> {
  // 検査は unit を空にして、実際に systemd を呼ばない
  const unit = CONFIG.cycle.unit
  if (!unit) return { started: true, note: "起動しない(検査)" }
  // 実行中なら起動要求を送らない。
  // `is-active` は使えない。Type=oneshot は ExecStart の間ずっと `activating` で、
  // `is-active` はそれを終了コード 3 で返す。`show` なら状態がそのまま出て終了コードは 0。
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

async function poll(): Promise<string> {
  const state = await run(
    Effect.gen(function* () {
      const db = yield* Db
      const got = yield* drainInbox

      // 届いた件数ではなく DB の未読で決める。cycle 実行中に届いたぶんは追加の起動要求が併合されて
      // 落ちるので、消えるまで見る。消すのは cycle 側の completeCycle。
      const cursor = Number((yield* db.meta("cycle:cursor")) ?? 0)
      const row = yield* db.get("SELECT COUNT(*)n FROM events WHERE rowid > ?AND source = 'owner'", cursor)
      const unread = Number(row?.n ?? 0)
      yield* db.setMeta("health:inbound:last_success", nowIso())
      if (unread === 0) return { count: got, unread, wake: false }

      // 新しく届いたぶんは待たせない。
      const wokeRaw = yield* db.meta("cycle:woke")
      const since = Date.now() - (wokeRaw ? Date.parse(wokeRaw) : 0)

      // 起動した cycle が最後まで実行されたのに未読が残っている = その回と入れ違いに届いた。
      // cycle は見終えた行までしか cursor を進めない。`cycle:last` は completeCycle でしか進まないので、
      // クォータ枯渇や停止で処理されなかった回はここに入らず、RETRY_MS の側で間隔を空ける。
      const lastRaw = yield* db.meta("cycle:last")
      const completed = !!lastRaw && !!wokeRaw && Date.parse(lastRaw) >= Date.parse(wokeRaw)
      return { count: got, unread, wake: got > 0 || completed || since >= RETRY_MS }
    }),
  )

  if (state.unread === 0) return state.count > 0 ? `${state.count} 件(未読なし)` : "なし"
  const head = `届 ${state.count} / 未読 ${state.unread}`
  if (!state.wake) return `${head} — 起動しない(前回から間隔が短い)`

  const w = await wake()
  // 実際に起動できた回だけ記録する。実行中で拒否されたぶんを記録すると、RETRY_MS のあいだ
  // 未読が残ったまま再起動されない。
  if (w.started)
    await run(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.setMeta("cycle:woke", nowIso())
      }),
    )
  return `${head} — ${w.note}`
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

await main()
