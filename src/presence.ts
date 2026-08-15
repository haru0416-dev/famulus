#!/usr/bin/env bun
/**
 * Discord の Gateway に接続を張り続ける。オンライン表示を出すためだけに在る。
 *
 * ボットが「オンライン」と出るかどうかは、Gateway の WebSocket セッションを持っているか
 * だけで決まる。REST でメッセージを出しても表示は動かない — だから `src/poll.ts` が
 * 30秒ごとに `pollInbound()` を呼んでいる間も、ユーザーの画面ではずっとオフラインだった。
 *
 * メッセージの経路はここに移さない。受け取りは今まで通り poll(REST)が持つ。
 * 分ける理由は障害時の影響が違うこと — この接続が切れても届いたものは30秒後に読まれるが、
 * 受け取りを常駐に寄せると、常駐プロセスが通知なしに停止した間は誰も読まない。
 * このプロセスが停止して失われるのは表示だけ。
 *
 * intents は 0 で、何も受け取らない。特権 intent が要らず、guild が増えても
 * 流れてくる量が変わらない。受け取らないので replay も要らないが、RESUME は実装する —
 * 再接続のたびに IDENTIFY を消費すると、回線が揺れた日に日次の上限に当たる。
 *
 * 状態(未読と watch の数)を出すのは、緑の丸だけでは「繋がっている」以上のことを言えないから。
 * DB が読めなくても接続は落とさない。表示のために接続を切らない。
 */
import { Database } from "bun:sqlite"
import { appConfig } from "./core/config.ts"
import { loadEnv } from "./core/env.ts"
import { nowIso } from "./core/time.ts"
import { SCHEMA_VERSION, schemaVersion } from "./db/sqlite.ts"

loadEnv()

/** 既定の入口。READY が `resume_gateway_url` を寄越したら、次はそちらへ繋ぐ。 */
const ENTRY = "wss://gateway.discord.gg/?v=10&encoding=json"

/** 表示を書き換える間隔。Gateway の presence 更新は 20秒に5回まで — 60秒なら当たらない。 */
const REFRESH_MS = 60_000

/**
 * 再接続の待ちの上限。IDENTIFY は日に 1000 回まで。
 * 120秒で頭打ちにすると、繋がらない状態が丸1日続いても 720 回で収まる。
 */
const BACKOFF_MAX_MS = 120_000

/** 戻ってこられない終わり方。トークンか intents が違うので、待っても直らない。 */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014])

/** セッションごと捨てる終わり方。RESUME を投げても 9 が返るだけなので、作り直す。 */
const STALE = new Set([4007, 4009])

const log = (m: string): void => console.log(`${nowIso()} ${m}`)

/**
 * 表示に出す文。読み取り専用で開く — 常駐が書き込みの錠を持つと、cycle が待たされる。
 * 読めなければ `undefined`(掃除の最中や、まだ DB が無い状態は普通にある)。
 */
export function stateLine(path: string = appConfig().paths.db): string | undefined {
  try {
    const db = new Database(path, { readonly: true })
    try {
      // 最初に置く。これより前に読むと、他が WAL を開き直している間は locked で表示が消える。
      db.exec("PRAGMA busy_timeout = 2000;")
      if (schemaVersion(db) !== SCHEMA_VERSION) return undefined
      const cursor = Number(
        (db.query("SELECT value v FROM schema_meta WHERE key='cycle:cursor'").get() as { v?: string } | null)
          ?.v ?? 0,
      )
      const unread = Number(
        (
          db.query("SELECT COUNT(*) n FROM events WHERE rowid > ? AND source = 'owner'").get(cursor) as {
            n: number
          }
        ).n,
      )
      const watches = Number(
        (db.query("SELECT COUNT(*) n FROM watchlist WHERE status = 'open'").get() as { n: number }).n,
      )
      return unread > 0 ? `未読 ${unread} / watch ${watches}` : `watch ${watches}`
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/** presence の中身。`op 2` の中でも `op 3` 単体でも同じ形で渡す。 */
export const presence = (path?: string) => {
  const line = stateLine(path)
  return {
    since: 0,
    // type 4 は前置きの付かない表示。文が出せないときは活動を空にする(緑の丸だけになる)。
    activities: line ? [{ type: 4, name: "Custom Status", state: line }] : [],
    status: "online",
    afk: false,
  }
}

interface Session {
  id: string
  url: string
}

/**
 * 1回ぶんの接続。閉じた理由を返す — 呼ぶ側が次に RESUME するか IDENTIFY するかを決める。
 * 例外にしないのは、切れることが異常ではないから(Discord 側から定期的に張り直させられる)。
 */
function once(
  prev: Session | undefined,
  seqIn: number | null,
  token: string,
): Promise<{ session: Session | undefined; seq: number | null; fatal?: number; connected: boolean }> {
  return new Promise((done) => {
    const ws = new WebSocket(prev ? `${prev.url}/?v=10&encoding=json` : ENTRY)
    let seq = seqIn
    let session = prev
    let beat: ReturnType<typeof setInterval> | undefined
    let refresh: ReturnType<typeof setInterval> | undefined
    let acked = true
    let fatal: number | undefined
    let settled = false
    /** READY か RESUMED まで行ったか。行っていない回だけ待つ — 回線が落ちている間に毎秒叩かない。 */
    let connected = false

    const stop = () => {
      clearInterval(beat)
      clearInterval(refresh)
    }
    /** 張り直させる。4000 番台で閉じると Discord はセッションを残す — 1000 で閉じると消える。 */
    const again = () => {
      stop()
      try {
        ws.close(4000, "reconnect")
      } catch {
        /* 既に閉じている。 */
      }
    }

    ws.onmessage = (e) => {
      let m: { op: number; d?: unknown; s?: number | null; t?: string | null }
      try {
        m = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (typeof m.s === "number") seq = m.s

      if (m.op === 10) {
        const ms = (m.d as { heartbeat_interval: number }).heartbeat_interval
        // 最初の1回だけずらす。全接続が同時に送ると、Discord 側へ heartbeat が集中する。
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify({ op: 1, d: seq }))
          acked = false
          beat = setInterval(() => {
            // ACK が返らないまま次の番が来たら、繋がって見えて届いていない。張り直す。
            if (!acked) return again()
            ws.send(JSON.stringify({ op: 1, d: seq }))
            acked = false
          }, ms)
        }, ms * Math.random())

        if (session) ws.send(JSON.stringify({ op: 6, d: { token, session_id: session.id, seq } }))
        else
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token,
                intents: 0,
                properties: { os: "linux", browser: "open-zero", device: "open-zero" },
                presence: presence(),
              },
            }),
          )
        return
      }

      if (m.op === 11) {
        acked = true
        return
      }
      // 張り直せと言われた。セッションは残っているので RESUME で戻る。
      if (m.op === 7) return again()
      // セッションが無効。`d` が false なら作り直し。
      if (m.op === 9) {
        if (m.d === false) session = undefined
        return again()
      }

      if (m.t === "READY" || m.t === "RESUMED") {
        connected = true
        if (m.t === "READY") {
          const d = m.d as { session_id: string; resume_gateway_url: string }
          session = { id: d.session_id, url: d.resume_gateway_url }
        }
        log(`${m.t} — 接続中(${stateLine() ?? "状態は読めていない"})`)
        // 表示だけを更新する。切らずに書き換えられる。
        refresh = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 3, d: presence() }))
        }, REFRESH_MS)
      }
    }

    ws.onclose = (e) => {
      stop()
      if (settled) return
      settled = true
      if (FATAL.has(e.code)) fatal = e.code
      if (STALE.has(e.code)) session = undefined
      // 4000 は自分で閉じた回。それ以外は理由を残す — 通知なしの停止を診断するための唯一の記録。
      if (e.code !== 4000) log(`切れた: ${e.code} ${e.reason || ""}`)
      done({ session, seq, connected, ...(fatal === undefined ? {} : { fatal }) })
    }
    ws.onerror = () => {
      /* onclose が続けて来る。ここで done すると二重になる。 */
    }
  })
}

async function main(): Promise<void> {
  const config = appConfig()
  const token = config.discord.token
  if (!token) {
    // 設定が無いのは異常ではない(Discord と同じ契約)。走り続ける理由も無い。
    log("OPEN_ZERO_DISCORD_TOKEN が無い — 接続しない")
    return
  }
  // 出せる先が実在するかを1回だけ確かめる。トークンが無効だと 4004 で無限に張り直すことになる。
  const me = await fetch(`${config.discord.api}/users/@me`, { headers: { authorization: `Bot ${token}` } })
  if (!me.ok) {
    log(`トークンが通らない: ${me.status} — 接続しない`)
    process.exitCode = 1
    return
  }
  const who = (await me.json()) as { username?: string }
  log(`${who.username ?? "(名前が取れない)"} として接続する`)

  let session: Session | undefined
  let seq: number | null = null
  let wait = 1_000
  for (;;) {
    const r = await once(session, seq, token)
    if (r.fatal !== undefined) {
      log(`直らない終わり方: ${r.fatal} — 止まる`)
      process.exitCode = 1
      return
    }
    session = r.session
    seq = r.seq
    // 一度でも繋がった回は待たない。待つのは繋がらなかった回だけ — そちらは相手か回線の側で、
    // 間を詰めても直らない。繋がった回で待つと、Discord から張り直させられるたびに表示が消える。
    if (r.connected) {
      wait = 1_000
      await Bun.sleep(1_000)
      continue
    }
    await Bun.sleep(wait)
    wait = Math.min(wait * 2, BACKOFF_MAX_MS)
  }
}

// systemd から止められたら黙って降りる。落ちたことにすると Restart が数える。
// 入口として走ったときだけ。検査から import したときに接続を張らせない。
if (import.meta.main) {
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0))
  await main()
}
