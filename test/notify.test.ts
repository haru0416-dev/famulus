/**
 * 通知の口の検査。**押せなかったときに黙って false を返すか**を主に見る。
 *
 * ここが例外を投げると、通知先を書いていないだけで心拍が落ちる。届かないことより、
 * 届かないせいで本体が止まることのほうが困る。だから「未設定」「繋がらない」を固定する。
 * 本文の形も見る — ntfy は JSON の発行口とヘッダの発行口で解釈が違い、
 * 日本語の見出しはヘッダに載せられない。
 */
import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { Effect } from "effect"
import { Notify, type Push } from "../src/services/Notify.ts"
import { withHarness } from "./helpers.ts"

interface Received {
  readonly body: Record<string, unknown>
}

/** 受け取った本文を溜めるだけの ntfy 役。`status` を変えると送信失敗を作れる。 */
const fakeNtfy = async (
  status = 200,
): Promise<{ url: string; got: Received[]; close: () => Promise<void> }> => {
  const got: Received[] = []
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = ""
    req.on("data", (c) => {
      raw += String(c)
    })
    req.on("end", () => {
      got.push({ body: JSON.parse(raw) as Record<string, unknown> })
      res.writeHead(status).end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    got,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const push = (p: Push) =>
  Effect.gen(function* () {
    const notify = yield* Notify
    return yield* notify.push(p)
  })

const configured = Effect.gen(function* () {
  const notify = yield* Notify
  return notify.configured()
})

test("トピックが無ければ何もしない — 押さないし落ちない", async () => {
  const ntfy = await fakeNtfy()
  process.env.OPEN_ZERO_NTFY_URL = ntfy.url
  process.env.OPEN_ZERO_NTFY_TOPIC = ""
  try {
    await withHarness(async (h) => {
      assert.equal(await h.run(configured), false)
      assert.equal(await h.run(push({ title: "見出し", body: "本文" })), false)
      assert.equal(ntfy.got.length, 0)
    })
  } finally {
    await ntfy.close()
  }
})

test("押した本文の形 — 日本語の見出しは JSON に載る", async () => {
  const ntfy = await fakeNtfy()
  process.env.OPEN_ZERO_NTFY_URL = ntfy.url
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  try {
    await withHarness(async (h) => {
      assert.equal(await h.run(configured), true)
      const ok = await h.run(
        push({
          title: "副業が1件まとまった",
          body: "週2〜3・フルリモート",
          priority: 4,
          click: "https://e.example",
        }),
      )
      assert.equal(ok, true)
      assert.deepEqual(ntfy.got[0]?.body, {
        topic: "oz-test",
        title: "副業が1件まとまった",
        message: "週2〜3・フルリモート",
        priority: 4,
        click: "https://e.example",
      })
    })
  } finally {
    await ntfy.close()
  }
})

test("急ぎでない通知に priority と click は付かない", async () => {
  const ntfy = await fakeNtfy()
  process.env.OPEN_ZERO_NTFY_URL = ntfy.url
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  try {
    await withHarness(async (h) => {
      await h.run(push({ title: "見出し", body: "本文" }))
      assert.deepEqual(Object.keys(ntfy.got[0]?.body ?? {}).sort(), ["message", "title", "topic"])
    })
  } finally {
    await ntfy.close()
  }
})

test("ntfy が断ったら false — 例外にはしない", async () => {
  const ntfy = await fakeNtfy(500)
  process.env.OPEN_ZERO_NTFY_URL = ntfy.url
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  try {
    await withHarness(async (h) => {
      assert.equal(await h.run(push({ title: "見出し", body: "本文" })), false)
    })
  } finally {
    await ntfy.close()
  }
})

test("繋がらなくても落ちない — 心拍は通知の失敗で止まらない", async () => {
  // 1 番は特権ポートで、この環境では誰も listen していない(接続は即座に拒否される)。
  process.env.OPEN_ZERO_NTFY_URL = "http://127.0.0.1:1"
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  await withHarness(async (h) => {
    assert.equal(await h.run(push({ title: "見出し", body: "本文" })), false)
  })
})
