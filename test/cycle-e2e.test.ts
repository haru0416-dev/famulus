import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { PROJECT_ROOT } from "../src/core/config.ts"
import { Attention } from "../src/services/Attention.ts"

const OWNER = "1211509900937793597"
const CHANNEL = "9001"

test("Discord受信からcycle返信と独立配送までを一筆書きで通す", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "famulus-cycle-e2e-"))
  const messages = [{ id: "100", content: "届いたら返して", author: { id: OWNER } }]
  const sent: string[] = []
  const reactions: { method: string; path: string }[] = []
  let nextId = 200
  let failDelivery = false
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => {
      raw += String(chunk)
    })
    req.on("end", () => {
      const path = req.url ?? ""
      if (path === "/users/@me/channels") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: CHANNEL }))
        return
      }
      if (req.method === "GET" && path.startsWith(`/channels/${CHANNEL}/messages?`)) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(messages))
        return
      }
      if (req.method === "POST" && path === `/channels/${CHANNEL}/messages`) {
        const body = JSON.parse(raw) as { content?: unknown }
        if (failDelivery) {
          res.writeHead(503, { "content-type": "application/json" }).end("{}")
          return
        }
        sent.push(String(body.content ?? ""))
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id: String(++nextId) }))
        return
      }
      if (path.includes("/reactions/")) {
        reactions.push({ method: req.method ?? "", path: decodeURIComponent(path) })
        res.writeHead(204).end()
        return
      }
      res.writeHead(404, { "content-type": "application/json" }).end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo

  process.env.FAMULUS_DATA = root
  process.env.FAMULUS_DB = join(root, "famulus.db")
  process.env.FAMULUS_DISCORD_API = `http://127.0.0.1:${address.port}`
  process.env.FAMULUS_DISCORD_TOKEN = "test-token"
  process.env.FAMULUS_DISCORD_OWNER_ID = OWNER
  process.env.FAMULUS_DISCORD_CH_TALK = CHANNEL
  process.env.FAMULUS_DISCORD_CH_DRAFT = ""
  process.env.FAMULUS_DISCORD_CH_LOG = ""
  process.env.FAMULUS_CYCLE_UNIT = ""
  process.env.FAMULUS_EMBEDDING = "stub"

  try {
    const { configureApp } = await import("../src/core/config.ts")
    configureApp()
    const { runCycle } = await import("../src/cycle.ts")
    const deliver = async () => {
      const worker = Bun.spawn([process.execPath, join(PROJECT_ROOT, "src/deliver.ts")], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const error = await new Response(worker.stderr).text()
      assert.equal(await worker.exited, 0, error)
    }
    const { run } = await import("../src/runtime.ts")
    const { Db } = await import("../src/services/Db.ts")

    await run(Effect.flatMap(Db, (db) => db.setMeta(`discord:last:${CHANNEL}`, "99")))
    let evidence: readonly { readonly id: string; readonly text: string }[] = []
    const result = await runCycle({
      createAssistant: (opts) => {
        evidence = opts.ownerEvidence ?? []
        return {
          respond: async () => ({ text: "端から端まで返った", steps: 1, tools: [] }),
        }
      },
      keep: async () => "keeper: 保存対象は無かった",
      wakePendingDelivery: async () => false,
    })

    assert.match(result, /動いた: 端から端まで返った/)
    assert.deepEqual(
      evidence.map((item) => item.text),
      ["届いたら返して"],
    )
    assert.deepEqual(sent, ["端から端まで返った"])
    assert.ok(reactions.some((reaction) => reaction.method === "PUT" && reaction.path.includes("/👀/@me")))

    const queued = await run(
      Effect.flatMap(Db, (db) => db.get("SELECT COUNT(*) n FROM discord_outbound WHERE state='queued'")),
    )
    assert.equal(Number(queued?.n), 1, "cycle完了リアクションは独立配送workerへ残る")
    await deliver()
    assert.ok(reactions.some((reaction) => reaction.method === "PUT" && reaction.path.includes("/✅/@me")))
    assert.ok(reactions.some((reaction) => reaction.method === "DELETE" && reaction.path.includes("/👀/@me")))

    const respond = (text: string) =>
      runCycle({
        createAssistant: () => ({ respond: async () => ({ text, steps: 1, tools: [] }) }),
        keep: async () => "keeper: 保存対象は無かった",
        wakePendingDelivery: async () => false,
      })
    const sql = (statement: string) => run(Effect.flatMap(Db, (db) => db.run(statement)))
    const cycleState = () =>
      run(
        Effect.flatMap(Db, (db) =>
          db.all(
            "SELECT key,value FROM schema_meta WHERE key IN ('cycle:cursor','cycle:last','cycle:last_active','cycle:reason_key','cycle:repeat') ORDER BY key",
          ),
        ),
      )

    // queue が無いのに入力だけ完了扱いにしない。
    messages.push({ id: "101", content: "保存失敗から再試行", author: { id: OWNER } })
    const beforeQueueFailure = await cycleState()
    await sql(`CREATE TRIGGER fail_cycle_reply BEFORE INSERT ON discord_outbound
      WHEN NEW.purpose='cycle-reply' BEGIN SELECT RAISE(ABORT,'reply enqueue failure'); END`)
    await assert.rejects(respond("保存できなかった返信"))
    assert.deepEqual(await cycleState(), beforeQueueFailure)
    const unread = await run(Effect.flatMap(Attention, (att) => att.planCycle()))
    assert.deepEqual(
      unread.newEvents.map((event) => event.origin_id),
      ["101"],
    )
    assert.deepEqual(sent, ["端から端まで返った"])
    await sql("DROP TRIGGER fail_cycle_reply")
    await respond("保存失敗の次は届いた")
    assert.deepEqual(sent, ["端から端まで返った", "保存失敗の次は届いた"])

    // 配送後に締めが失敗したら、再生成した別本文ではなく保存済み返信を使う。
    messages.push({ id: "102", content: "締め失敗から再試行", author: { id: OWNER } })
    const beforeCompletionFailure = await cycleState()
    await sql(`CREATE TRIGGER fail_cycle_last BEFORE INSERT ON schema_meta
      WHEN NEW.key='cycle:last' BEGIN SELECT RAISE(ABORT,'cycle last failure'); END`)
    await assert.rejects(respond("先に保存した返信"))
    assert.deepEqual(await cycleState(), beforeCompletionFailure)
    assert.equal(sent.at(-1), "先に保存した返信")
    await sql("DROP TRIGGER fail_cycle_last")
    assert.match(await respond("再生成で変わった返信"), /先に保存した返信/)
    assert.deepEqual(sent, ["端から端まで返った", "保存失敗の次は届いた", "先に保存した返信"])
    assert.equal((await run(Effect.flatMap(Attention, (att) => att.planCycle()))).newEvents.length, 0)

    // HTTP 結果が不明でも、本文と配送状態を残して入力の処理は完了できる。
    messages.push({ id: "103", content: "配送だけ失敗する", author: { id: OWNER } })
    failDelivery = true
    assert.match(await respond("配送結果を追える返信"), /動いた/)
    const failedReply = await run(
      Effect.flatMap(Db, (db) =>
        db.get(`SELECT o.state,a.spec FROM discord_outbound o
        JOIN discord_outbound_actions a ON a.outbound_id=o.id
        WHERE o.purpose='cycle-reply' AND json_extract(a.spec,'$.message.content')='配送結果を追える返信'`),
      ),
    )
    assert.equal(failedReply?.state, "unknown", "曖昧なHTTP結果を自動再送で二重投稿しない")
    assert.equal(JSON.parse(String(failedReply?.spec)).message.content, "配送結果を追える返信")
    assert.equal((await run(Effect.flatMap(Attention, (att) => att.planCycle()))).newEvents.length, 0)

    // flush 自体が落ちても、保存済み返信は worker へ引き継げる。
    messages.push({ id: "104", content: "flush失敗から独立配送", author: { id: OWNER } })
    failDelivery = false
    await sql(`CREATE TRIGGER fail_reply_flush BEFORE UPDATE ON discord_outbound
      WHEN NEW.purpose='cycle-reply' AND NEW.state='sending'
      BEGIN SELECT RAISE(ABORT,'reply flush failure'); END`)
    assert.match(await respond("workerで届く返信"), /動いた/)
    const queuedReply = await run(
      Effect.flatMap(Db, (db) =>
        db.get(`SELECT o.state FROM discord_outbound o
        JOIN discord_outbound_actions a ON a.outbound_id=o.id
        WHERE o.purpose='cycle-reply' AND json_extract(a.spec,'$.message.content')='workerで届く返信'`),
      ),
    )
    assert.equal(queuedReply?.state, "queued")
    assert.equal((await run(Effect.flatMap(Attention, (att) => att.planCycle()))).newEvents.length, 0)
    await sql("DROP TRIGGER fail_reply_flush")
    await deliver()
    assert.equal(sent.at(-1), "workerで届く返信")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
    for (const key of [
      "FAMULUS_DATA",
      "FAMULUS_DB",
      "FAMULUS_DISCORD_API",
      "FAMULUS_DISCORD_TOKEN",
      "FAMULUS_DISCORD_OWNER_ID",
      "FAMULUS_DISCORD_CH_TALK",
      "FAMULUS_DISCORD_CH_DRAFT",
      "FAMULUS_DISCORD_CH_LOG",
      "FAMULUS_CYCLE_UNIT",
      "FAMULUS_EMBEDDING",
    ])
      delete process.env[key]
  }
})
