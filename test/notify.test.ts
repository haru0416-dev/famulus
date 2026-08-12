/**
 * 通知の経路の検査。**押せなかったときに黙って false を返すか**を主に見る。
 *
 * ここが例外を投げると、通知先を書いていないだけで tick が落ちる。届かないことより、
 * 届かないせいで本体が止まることのほうが困る。だから「未設定」「繋がらない」を固定する。
 * 本文の形も見る — ntfy は JSON の発行形式とヘッダの発行形式で解釈が違い、
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

const inbox = (since: string) =>
  Effect.gen(function* () {
    const notify = yield* Notify
    return yield* notify.inbox(since)
  })

/** 押し戻しの設定は個別に立てる。立てっぱなしにすると、前のテストのボタンが次の本文に混ざる。 */
const noReply = () => {
  process.env.OPEN_ZERO_NTFY_TOPIC_IN = ""
  process.env.OPEN_ZERO_NTFY_PUBLIC_URL = ""
}

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

test("繋がらなくても落ちない — tick は通知の失敗で止まらない", async () => {
  // 1 番は特権ポートで、この環境では誰も listen していない(接続は即座に拒否される)。
  process.env.OPEN_ZERO_NTFY_URL = "http://127.0.0.1:1"
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  await withHarness(async (h) => {
    assert.equal(await h.run(push({ title: "見出し", body: "本文" })), false)
  })
})

test("ボタンは受信箱へ発行する http action になる", async () => {
  const ntfy = await fakeNtfy()
  process.env.OPEN_ZERO_NTFY_URL = ntfy.url
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  process.env.OPEN_ZERO_NTFY_TOPIC_IN = "oz-test-in"
  process.env.OPEN_ZERO_NTFY_PUBLIC_URL = "https://vps.example:8443"
  try {
    await withHarness(async (h) => {
      await h.run(
        push({ title: "見出し", body: "本文", actions: [{ label: "止める", reply: "止めて: 見出し" }] }),
      )
      assert.deepEqual(ntfy.got[0]?.body.actions, [
        {
          action: "http",
          label: "止める",
          // 端末が踏む URL。127.0.0.1 のままだとスマホは自分自身を叩く。
          url: "https://vps.example:8443",
          method: "POST",
          body: JSON.stringify({ topic: "oz-test-in", message: "止めて: 見出し" }),
          clear: true,
        },
      ])
    })
  } finally {
    noReply()
    await ntfy.close()
  }
})

test("受信トピックが無ければボタンごと落とす — 押しても何も起きないボタンは出さない", async () => {
  const ntfy = await fakeNtfy()
  process.env.OPEN_ZERO_NTFY_URL = ntfy.url
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  noReply()
  try {
    await withHarness(async (h) => {
      await h.run(push({ title: "見出し", body: "本文", actions: [{ label: "止める", reply: "止めて" }] }))
      assert.equal(ntfy.got[0]?.body.actions, undefined)
    })
  } finally {
    await ntfy.close()
  }
})

test("受信箱は message の行だけ拾う", async () => {
  const lines = [
    '{"id":"a1","event":"open","topic":"oz-test-in"}',
    '{"id":"a2","event":"message","topic":"oz-test-in","message":"止めて: e8370fe2"}',
    '{"id":"a3","event":"keepalive","topic":"oz-test-in"}',
    '{"id":"a4","event":"message","topic":"oz-test-in","message":"来週にして"}',
    "",
  ].join("\n")
  const server = createServer((_req, res) => res.writeHead(200).end(lines))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  process.env.OPEN_ZERO_NTFY_URL = `http://127.0.0.1:${port}`
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  process.env.OPEN_ZERO_NTFY_TOPIC_IN = "oz-test-in"
  try {
    await withHarness(async (h) => {
      assert.deepEqual(await h.run(inbox("all")), [
        { id: "a2", text: "止めて: e8370fe2" },
        { id: "a4", text: "来週にして" },
      ])
    })
  } finally {
    noReply()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("受信トピックが無ければ受信箱は空", async () => {
  const ntfy = await fakeNtfy()
  process.env.OPEN_ZERO_NTFY_URL = ntfy.url
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  noReply()
  try {
    await withHarness(async (h) => {
      assert.deepEqual(await h.run(inbox("all")), [])
      assert.equal(ntfy.got.length, 0)
    })
  } finally {
    await ntfy.close()
  }
})

test("受信箱が読めなくても空を返す — tick は返事が読めないだけで止まらない", async () => {
  process.env.OPEN_ZERO_NTFY_URL = "http://127.0.0.1:1"
  process.env.OPEN_ZERO_NTFY_TOPIC = "oz-test"
  process.env.OPEN_ZERO_NTFY_TOPIC_IN = "oz-test-in"
  try {
    await withHarness(async (h) => {
      assert.deepEqual(await h.run(inbox("all")), [])
    })
  } finally {
    noReply()
  }
})
