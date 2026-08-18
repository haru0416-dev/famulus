import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { test } from "vitest"

const OWNER = "1211509900937793597"
const CHANNEL = "9001"

test("Discord受信からcycle返信と独立配送までを一筆書きで通す", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "famulus-cycle-e2e-"))
  const messages = [{ id: "100", content: "届いたら返して", author: { id: OWNER } }]
  const sent: string[] = []
  const reactions: { method: string; path: string }[] = []
  let nextId = 200
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
    const { deliver } = await import("../src/deliver.ts")
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
    assert.equal(await deliver(), 1)
    assert.ok(reactions.some((reaction) => reaction.method === "PUT" && reaction.path.includes("/✅/@me")))
    assert.ok(reactions.some((reaction) => reaction.method === "DELETE" && reaction.path.includes("/👀/@me")))
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
