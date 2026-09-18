#!/usr/bin/env bun
/**
 * Discord の Gateway に接続を張り続け、オンライン表示を出す。REST だけでは表示はオフラインのまま。
 * 受け取りは poll(REST)に残す。この接続が止まっても失うのが表示だけになるように。
 * intents は 0。RESUME は実装する(再接続のたびに IDENTIFY すると日次の上限に当たる)。
 * DB が読めなくても接続は落とさない。
 */
import { Database } from "bun:sqlite"
import { appConfig, configureApp } from "./core/config.ts"
import { loadEnv } from "./core/env.ts"
import { nowIso } from "./core/time.ts"

/** READY が `resume_gateway_url` を返したら、次はそちらへ繋ぐ。 */
const ENTRY = "wss://gateway.discord.gg/?v=10&encoding=json"

/** Gateway の presence 更新は 20秒に5回まで。 */
const REFRESH_MS = 60_000

/** IDENTIFY は日に 1000 回まで。120秒で頭打ちなら、繋がらない状態が1日続いても 720 回で収まる。 */
const BACKOFF_MAX_MS = 120_000

/** トークンか intents が違う。待っても直らない。 */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014])

/** RESUME しても op 9 が返るだけなので、セッションを作り直す。 */
const STALE = new Set([4007, 4009])

const log = (m: string): void => console.log(`${nowIso()} ${m}`)

/**
 * 読み取り専用で開く(書き込みの錠を持つと cycle が待たされる)。
 * 掃除の最中や DB が無いときは `undefined`。
 */
export function stateLine(path: string = appConfig().paths.db): string | undefined {
  try {
    const db = new Database(path, { readonly: true })
    try {
      // 最初に置く。先に読むと、他が WAL を開き直している間は locked で表示が消える。
      db.exec("PRAGMA busy_timeout = 2000;")
      const cursor = Number(
        (db.query("SELECT value v FROM schema_meta WHERE key='cycle:cursor'").get() as { v?: string } | null)
          ?.v ?? 0,
      )
      const unread = Number(
        (
          db
            .query(
              "SELECT COUNT(*) n FROM events WHERE rowid > ? AND source = 'owner' AND COALESCE(origin_kind,'') != 'chat'",
            )
            .get(cursor) as { n: number }
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

export const presence = (path?: string) => {
  const line = stateLine(path)
  return {
    since: 0,
    // type 4 は前置きの付かない表示。
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
 * セッションを捨てた回は seq も捨てる。持ち越すと新しいセッションに無い番号で heartbeat を送り、
 * 同じところで切られ続ける。
 */
export function carryOver(
  code: number,
  session: Session | undefined,
  seq: number | null,
): { session: Session | undefined; seq: number | null } {
  const keep = STALE.has(code) ? undefined : session
  return { session: keep, seq: keep ? seq : null }
}

/** 切れるのは異常ではない(Discord から定期的に再接続を求められる)ので、閉じた理由を例外にせず返す。 */
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
    /** READY か RESUMED まで行っていない回だけ待つ。回線が落ちている間に毎秒再接続しない。 */
    let connected = false

    const stop = () => {
      clearInterval(beat)
      clearInterval(refresh)
    }
    /** 4000 番台で閉じると Discord はセッションを残す。1000 で閉じると消える。 */
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
        // 最初の1回だけずらす。全接続が同時に送ると heartbeat が集中する。
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify({ op: 1, d: seq }))
          acked = false
          beat = setInterval(() => {
            // ACK が返らないまま次の番が来たら届いていない。再接続する。
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
                properties: { os: "linux", browser: "famulus", device: "famulus" },
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
      // セッションは残っているので RESUME で戻る。
      if (m.op === 7) return again()
      // `d` が false ならセッションを作り直す。
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
      // 4000 は自分で閉じた回。それ以外は理由を残す(通知なしの停止を診断する唯一の記録)。
      if (e.code !== 4000) log(`切れた: ${e.code} ${e.reason || ""}`)
      done({ ...carryOver(e.code, session, seq), connected, ...(fatal === undefined ? {} : { fatal }) })
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
    // 設定が無いのは異常ではない(Discord と同じ契約)。
    log("FAMULUS_DISCORD_TOKEN が無い — 接続しない")
    return
  }
  // トークンが無効だと 4004 で再接続し続けるので、先に1回確かめる。
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
    // 一度でも繋がった回は待たない。繋がった回で待つと、Discord から再接続を求められるたびに表示が消える。
    if (r.connected) {
      wait = 1_000
      await Bun.sleep(1_000)
      continue
    }
    await Bun.sleep(wait)
    wait = Math.min(wait * 2, BACKOFF_MAX_MS)
  }
}

// systemd から止められたら正常終了する(異常終了だと Restart が数える)。
// 検査から import したときは接続しない。
if (import.meta.main) {
  loadEnv()
  configureApp()
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0))
  await main()
}
