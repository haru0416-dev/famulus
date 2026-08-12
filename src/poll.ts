#!/usr/bin/env node
/**
 * 口。**返事の待ち時間を心拍の間隔から切り離すためだけに在る。**
 *
 * 心拍は15分ごとで、それは自分の都合で動くぶんには十分な間隔だが、話しかけられたときの
 * 待ち時間としては長すぎる。かといって心拍を30秒にすると、理由の判定(SQL)と Flue の起動が
 * 30秒ごとに走る。**そこで受け取るところだけを分けた。**
 *
 *   1. 受信箱を1回読む(REST 1本 + ntfy 1本)。**モデルは呼ばない。**
 *   2. 何も来ていなければ黙って終わる。大半の起動はここで終わる。
 *   3. 来ていたら台帳に移して心拍を起こす。
 *
 * **常駐にしない。** websocket を張れば待ち時間は0になるが、落ちたら黙って死ぬ常駐が1本増え、
 * 再接続とセッション再開を自分で持つことになる。30秒間隔なら、その全部が systemd の
 * タイマー再実行に置き換わる。待ち時間 30秒 と 0秒 の差は、持ち主が別のことをしている
 * 前提では意味を持たない。
 *
 * **まとめて渡るのは間隔のおかげ。** 続けて3行打たれても、次の起動で3件同時に読まれて
 * 心拍は1回しか起きない。打っている途中で走り出さないための待ちを別に持たなくてよい。
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect } from "effect"
import { loadEnv } from "./core/env.ts"
import { nowIso } from "./core/time.ts"
import { drainInbox } from "./inbox.ts"
import { run, runtime } from "./runtime.ts"
import { Db } from "./services/Db.ts"

loadEnv()

const exec = promisify(execFile)

/** 起こす先。検査のときだけ空にして、実際に systemd を叩かせない。 */
const tickUnit = (): string => process.env.OPEN_ZERO_TICK_UNIT ?? "open-zero-tick.service"

/**
 * 起こし直すまでの下限。**心拍が読めずに終わったときだけ効く。**
 * 枠切れや停止で心拍が即返した場合、未読は残ったままなので毎回起こしに行くことになる。
 * 30秒ごとにそれをやると読まれない起動を積むだけなので、間隔を空ける。
 *
 * 走行中に届いたぶんには効かせない(下の `ran` を見る)。そちらは心拍が正常に終わっていて、
 * 単に間に合わなかっただけなので、待たせる理由が無い。
 */
const RETRY_MS = 180_000

/**
 * 心拍を起こす。
 *
 * **走っている最中に投げると systemd は併合する。** 走行中の oneshot に `start` を重ねても
 * 待ち行列には積まれず、2回目は実行されない(docs/adr/0003)。つまり「心拍が走っている間に
 * 話しかけられた」ぶんは、この1回では読まれない。そこを塞ぐのが下の未読の見直しで、
 * 台帳に未読が残っている限り次の起動でもう一度起こす。
 */
async function wake(): Promise<{ started: boolean; note: string }> {
  const unit = tickUnit()
  if (!unit) return { started: true, note: "起こさない(検査)" }
  // 走行中なら投げない。投げても併合されて消えるだけで、投げた側からは成功に見える。
  //
  // **`is-active` では見えない。** Type=oneshot は ExecStart の間ずっと
  // `activating` で、`is-active` はその文字列を終了コード 3 で返す — 走っている最中こそ
  // 「失敗」に見える。`show` なら状態がそのまま出て、終了コードは常に 0。
  const state = await exec("systemctl", ["--user", "show", unit, "-p", "ActiveState", "--value"])
    .then((r) => r.stdout.trim())
    .catch(() => "")
  if (state !== "" && state !== "inactive" && state !== "failed")
    return { started: false, note: `走行中(${state}) — 次の起動で見直す` }
  try {
    await exec("systemctl", ["--user", "start", "--no-block", unit])
    return { started: true, note: `起こした: ${unit}` }
  } catch (e) {
    return { started: false, note: `起こせなかった: ${String(e)}` }
  }
}

async function poll(): Promise<string> {
  const state = await run(
    Effect.gen(function* () {
      const db = yield* Db
      const got = yield* drainInbox

      // **届いた件数ではなく、台帳の未読で決める。** 心拍が走っている最中に届いたぶんは
      // 起こし直しが併合されて落ちるので、消えるまで見る。消すのは心拍側の commit。
      const cursor = Number((yield* db.meta("tick:cursor")) ?? 0)
      const row = yield* db.get("SELECT COUNT(*) n FROM events WHERE rowid > ? AND source = 'owner'", cursor)
      const unread = Number(row?.n ?? 0)
      if (unread === 0) return { count: got, unread, wake: false }

      // 新しく届いたぶんは待たせない。
      const wokeRaw = yield* db.meta("tick:woke")
      const since = Date.now() - (wokeRaw ? Date.parse(wokeRaw) : 0)

      // **起こした心拍が最後まで走ったのに未読が残っている = その回と入れ違いに届いた。**
      // 心拍は見終えた行までしか cursor を進めないので、残っているぶんは読まれていない。
      // 待たせる理由が無いので即もう一度起こす。`tick:last` は commit でしか進まないため、
      // 枠切れや停止で見送られた回はここに入らず、下の RETRY_MS の側で間が空く。
      const lastRaw = yield* db.meta("tick:last")
      const ran = !!lastRaw && !!wokeRaw && Date.parse(lastRaw) >= Date.parse(wokeRaw)
      return { count: got, unread, wake: got > 0 || ran || since >= RETRY_MS }
    }),
  )

  if (state.unread === 0) return state.count > 0 ? `${state.count} 件(未読なし)` : "なし"
  const head = `届 ${state.count} / 未読 ${state.unread}`
  if (!state.wake) return `${head} — 起こさない(前回から間が無い)`

  const w = await wake()
  // **実際に起動できた回だけ数える。** 走行中で弾かれたぶんを数えると、その3分は未読が
  // 残ったまま誰も起こしに行かない — 塞ごうとした穴がそのまま残る。
  if (w.started)
    await run(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.setMeta("tick:woke", nowIso())
      }),
    )
  return `${head} — ${w.note}`
}

const main = async (): Promise<void> => {
  const rt = runtime()
  try {
    console.log(await poll())
  } catch (e) {
    console.log(`落ちた: ${String(e)}`)
    process.exitCode = 1
  } finally {
    await rt.dispose()
  }
}

await main()
