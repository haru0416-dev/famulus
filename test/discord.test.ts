/**
 * Discord の口の検査。**押されたことをどう見分けるか**を主に見る。
 *
 * 印は自分で先に付けるので、絵文字の数は最初から 1 ある。そこを引かずに数えると、
 * 誰も押していない通知が全部「押された」になり、心拍が勝手に進む。
 * 既読位置の扱いも見る — 初回に全部拾うと、DM に残っている過去の一言が今日の指示になる。
 */
import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { Effect } from "effect"
import { Discord, type Post } from "../src/services/Discord.ts"
import { withHarness } from "./helpers.ts"

const OWNER = "1211509900937793597"
const CH = "9001"

interface Hit {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown> | undefined
}

interface Msg {
  id: string
  content: string
  author: { id: string }
  reactions?: { emoji: { name: string }; count: number; me: boolean }[]
}

/**
 * Discord 役。DM を開く・出す・印を付ける・一覧を返す、の4つだけ答える。
 * 出したものは `msgs` に積むので、テスト側から押されたことにできる。
 */
const fakeDiscord = async (
  msgs: Msg[] = [],
): Promise<{ url: string; hits: Hit[]; msgs: Msg[]; close: () => Promise<void> }> => {
  const hits: Hit[] = []
  let next = 100
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = ""
    req.on("data", (c) => {
      raw += String(c)
    })
    req.on("end", () => {
      const path = req.url ?? ""
      const body = raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>)
      hits.push({ method: req.method ?? "", path, body })
      const json = (v: unknown) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v))

      if (path === "/users/@me/channels") return json({ id: CH })
      if (path === `/channels/${CH}/messages` && req.method === "POST") {
        const id = String(++next)
        msgs.unshift({ id, content: String(body?.content ?? ""), author: { id: "bot" } })
        return json({ id })
      }
      if (path.includes("/reactions/")) {
        // 自分で付けた印。押す側から見ると数は 1 から始まる。
        const [, id, emoji] = /\/messages\/(\d+)\/reactions\/([^/]+)\/@me/.exec(path) ?? []
        const name = decodeURIComponent(emoji ?? "")
        const m = msgs.find((x) => x.id === id)
        if (m && req.method === "DELETE") {
          m.reactions = (m.reactions ?? []).filter((r) => r.emoji.name !== name)
        } else if (m) {
          m.reactions ??= []
          m.reactions.push({ emoji: { name }, count: 1, me: true })
        }
        return res.writeHead(204).end()
      }
      if (path.startsWith(`/channels/${CH}/messages?`)) return json(msgs)
      return res.writeHead(404).end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    msgs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const post = (p: Post) =>
  Effect.gen(function* () {
    const d = yield* Discord
    return yield* d.post(p)
  })

const inbox = Effect.gen(function* () {
  const d = yield* Discord
  return yield* d.inbox()
})

const mark = (id: string, emoji: string, on: boolean) =>
  Effect.gen(function* () {
    const d = yield* Discord
    yield* d.mark(id, emoji, on)
  })

const configured = Effect.gen(function* () {
  const d = yield* Discord
  return d.configured()
})

/** 設定を立てる。値を消しっぱなしにすると、後続のテストが本物の Discord を叩きに行く。 */
const wire = (url: string | undefined) => {
  if (url === undefined) {
    process.env.OPEN_ZERO_DISCORD_TOKEN = ""
    delete process.env.OPEN_ZERO_DISCORD_TOKEN
    delete process.env.OPEN_ZERO_DISCORD_OWNER_ID
    delete process.env.OPEN_ZERO_DISCORD_API
    return
  }
  process.env.OPEN_ZERO_DISCORD_TOKEN = "test-token"
  process.env.OPEN_ZERO_DISCORD_OWNER_ID = OWNER
  process.env.OPEN_ZERO_DISCORD_API = url
}

test("トークンが無ければ何もしない — 叩かないし落ちない", async () => {
  const dc = await fakeDiscord()
  wire(undefined)
  process.env.OPEN_ZERO_DISCORD_API = dc.url
  try {
    await withHarness(async (h) => {
      assert.equal(await h.run(configured), false)
      assert.equal(await h.run(post({ text: "本文" })), undefined)
      assert.deepEqual(await h.run(inbox), [])
      assert.equal(dc.hits.length, 0)
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("出したら印も自分で付く — 押す側は絵文字を探さない", async () => {
  const dc = await fakeDiscord()
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      const id = await h.run(
        post({
          text: "下書きが1本できた",
          taps: [
            { emoji: "✅", reply: "出していい" },
            { emoji: "🛑", reply: "やめて" },
          ],
        }),
      )
      assert.equal(typeof id, "string")
      assert.deepEqual(
        dc.hits.filter((x) => x.method === "PUT").map((x) => decodeURIComponent(x.path).split("/")[6]),
        ["✅", "🛑"],
      )
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("2000 字を超えたら分ける — 印は最後の1通に付く", async () => {
  const dc = await fakeDiscord()
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      const text = `${"あ".repeat(1500)}\n${"い".repeat(1500)}`
      const id = await h.run(post({ text, taps: [{ emoji: "✅", reply: "了解" }] }))
      const sent = dc.hits.filter((x) => x.method === "POST" && x.path.endsWith("/messages"))
      assert.equal(sent.length, 2)
      assert.equal(String(sent[0]?.body?.content), "あ".repeat(1500))
      assert.equal(String(sent[1]?.body?.content), "い".repeat(1500))
      assert.equal(dc.hits.find((x) => x.method === "PUT")?.path.includes(`/messages/${id}/`), true)
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("押されるまでは空。押されたら割り当てた文が返る", async () => {
  const dc = await fakeDiscord()
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      const id = await h.run(post({ text: "出していいか", taps: [{ emoji: "🛑", reply: "やめて" }] }))
      // 自分で付けたぶんだけ。ここで拾うと、誰も押していない通知が承認になる。
      assert.deepEqual(await h.run(inbox), [])

      const m = dc.msgs.find((x) => x.id === id)
      const r = m?.reactions?.[0]
      if (r) r.count = 2
      assert.deepEqual(await h.run(inbox), [{ id: `${id}:🛑`, text: "やめて", msgId: id }])
      // 二度は返らない。返ると同じ指示が心拍のたびに効き続ける。
      assert.deepEqual(await h.run(inbox), [])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("初回は自由文を取り込まない — DM に残っている過去の一言は指示ではない", async () => {
  const dc = await fakeDiscord([
    { id: "50", content: "去年の話", author: { id: OWNER } },
    { id: "51", content: "おはよう", author: { id: OWNER } },
  ])
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      assert.deepEqual(await h.run(inbox), [])
      dc.msgs.unshift({ id: "52", content: "今日はこれをやって", author: { id: OWNER } })
      assert.deepEqual(await h.run(inbox), [{ id: "52", text: "今日はこれをやって", msgId: "52" }])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("自分の発言は拾わない — 出した文が次の心拍の入力に化けない", async () => {
  const dc = await fakeDiscord([{ id: "60", content: "位置合わせ", author: { id: OWNER } }])
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      await h.run(inbox)
      await h.run(post({ text: "こちらから出した文" }))
      assert.deepEqual(await h.run(inbox), [])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("Discord が落ちていても空を返す — 心拍は返事が読めないだけで止まらない", async () => {
  // 1 番は特権ポートで、この環境では誰も listen していない(接続は即座に拒否される)。
  wire("http://127.0.0.1:1")
  try {
    await withHarness(async (h) => {
      assert.deepEqual(await h.run(inbox), [])
      assert.equal(await h.run(post({ text: "本文" })), undefined)
    })
  } finally {
    wire(undefined)
  }
})

test("行数でも分ける — 2000 字に収まっていても縦に長いと畳まれる", async () => {
  const dc = await fakeDiscord()
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      // 40 行 / 320 字。字数だけで見れば 1 通に収まる。
      await h.run(post({ text: Array.from({ length: 40 }, (_, i) => `行${i}`).join("\n") }))
      const sent = dc.hits.filter((x) => x.method === "POST" && x.path.endsWith("/messages"))
      assert.equal(sent.length, 3)
      // 分けた先で行が消えていない。切れ目の改行だけが落ちる。
      const joined = sent.map((x) => String(x.body?.content ?? "")).join("\n")
      assert.equal(joined.split("\n").length, 40)
      assert.equal(joined.split("\n").at(-1), "行39")
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("受け取った印は付けて外せる — 返し終わったことを鳴らさずに知らせる", async () => {
  const dc = await fakeDiscord([{ id: "70", content: "やっといて", author: { id: OWNER } }])
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      await h.run(mark("70", "👀", true))
      assert.deepEqual(
        dc.msgs.find((m) => m.id === "70")?.reactions?.map((r) => r.emoji.name),
        ["👀"],
      )
      await h.run(mark("70", "👀", false))
      assert.deepEqual(dc.msgs.find((m) => m.id === "70")?.reactions, [])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("印を付ける先は自由文だけ — 押して返ってきたぶんには付けない", async () => {
  const dc = await fakeDiscord()
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      const id = await h.run(post({ text: "下書き", taps: [{ emoji: "🛑", reply: "やめて" }] }))
      await h.run(inbox)
      const m = dc.msgs.find((x) => x.id === id)
      if (m?.reactions?.[0]) m.reactions[0].count = 2
      dc.msgs.unshift({ id: "9999", content: "こっちが自由文", author: { id: OWNER } })
      const got = await h.run(inbox)
      // 印を押したぶんと自由文の両方が返る。ackId に選ぶのは後者だけ。
      assert.equal(got.length, 2)
      assert.deepEqual(
        got.filter((x) => x.id === x.msgId).map((x) => x.msgId),
        ["9999"],
      )
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})
