/**
 * Discord の検査。押されたことをどう見分けるかを主に見る。
 *
 * リアクションは自分で先に付けるので、絵文字の数は最初から 1 ある。そこを引かずに数えると、
 * 誰も押していない通知が全部「押された」になり、cycle が勝手に進む。
 * 既読位置の扱いも見る — 初回に全部拾うと、DM に残っている過去の一言が今日の指示になる。
 */

import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { Db } from "../src/services/Db.ts"
import { Discord, type Enqueue } from "../src/services/Discord.ts"
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
 * Discord 役。DM を開く・出す・リアクションを付ける・一覧を返す、の4つだけ答える。
 * 出したものは `msgs` に積むので、テスト側から押されたことにできる。
 */
const fakeDiscord = async (
  seed: Msg[] = [],
  respond?: (hit: Hit, hits: readonly Hit[]) => { status: number; body?: unknown } | undefined,
): Promise<{
  url: string
  hits: Hit[]
  msgs: Msg[]
  at: (ch: string) => Msg[]
  close: () => Promise<void>
}> => {
  const hits: Hit[] = []
  let next = 100
  const rooms = new Map<string, Msg[]>([[CH, seed]])
  const at = (ch: string): Msg[] => {
    const got = rooms.get(ch) ?? []
    rooms.set(ch, got)
    return got
  }
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
      const override = respond?.(hits.at(-1) as Hit, hits)
      if (override)
        return res
          .writeHead(override.status, { "content-type": "application/json" })
          .end(JSON.stringify(override.body ?? {}))

      if (path === "/users/@me/channels") return json({ id: CH })
      const [, ch] = /^\/channels\/(\d+)\//.exec(path) ?? []
      if (path === `/channels/${ch}/messages` && req.method === "POST" && ch) {
        const id = String(++next)
        at(ch).unshift({ id, content: String(body?.content ?? ""), author: { id: "bot" } })
        return json({ id })
      }
      // スレッド。本物は起点の1通と同じ id を返す(スレッドそのものが場所になる)。
      const [, from] = /\/messages\/(\d+)\/threads$/.exec(path) ?? []
      if (from && req.method === "POST") {
        at(from)
        return json({ id: from, name: body?.name })
      }
      if (path.includes("/reactions/") && ch) {
        // 自分で付けたリアクション。押す側から見ると数は 1 から始まる。
        const [, id, emoji] = /\/messages\/(\d+)\/reactions\/([^/]+)\/@me/.exec(path) ?? []
        const name = decodeURIComponent(emoji ?? "")
        const m = at(ch).find((x) => x.id === id)
        if (m) {
          m.reactions ??= []
          m.reactions.push({ emoji: { name }, count: 1, me: true })
        }
        return res.writeHead(204).end()
      }
      if (ch && path.startsWith(`/channels/${ch}/messages?`)) return json(at(ch))
      return res.writeHead(404).end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    msgs: seed,
    at,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

let postSequence = 0
const post = (p: Omit<Enqueue, "purpose" | "dedupeKey">) =>
  Effect.gen(function* () {
    const d = yield* Discord
    const outbound = yield* d.enqueue({
      ...p,
      purpose: "discord-test",
      dedupeKey: String(++postSequence),
    })
    if (!outbound) return undefined
    yield* d.flushQueued()
    const done = yield* d.getOutbound(outbound.id)
    const messages = done?.actions.filter((a) => a.kind === "message" && a.state === "succeeded") ?? []
    const receipt = messages.at(-1)?.receipt as { messageId?: unknown } | undefined
    return typeof receipt?.messageId === "string" ? receipt.messageId : undefined
  })

const pollInbound = Effect.gen(function* () {
  const d = yield* Discord
  const batch = yield* d.pollInbound()
  yield* d.commitInboundBatch(batch)
  return batch.items
})

const peek = Effect.gen(function* () {
  const d = yield* Discord
  return yield* d.pollInbound()
})

const configured = Effect.gen(function* () {
  const d = yield* Discord
  return d.configured()
})

/** 値を残すと後続テストが実 Discord へ接続し得るため、解除もこの helper に集約する。 */
const wire = (url: string | undefined, ch?: { talk?: string; draft?: string; log?: string }) => {
  delete process.env.OPEN_ZERO_DISCORD_CH_TALK
  delete process.env.OPEN_ZERO_DISCORD_CH_DRAFT
  delete process.env.OPEN_ZERO_DISCORD_CH_LOG
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
  if (ch?.talk) process.env.OPEN_ZERO_DISCORD_CH_TALK = ch.talk
  if (ch?.draft) process.env.OPEN_ZERO_DISCORD_CH_DRAFT = ch.draft
  if (ch?.log) process.env.OPEN_ZERO_DISCORD_CH_LOG = ch.log
}

test("トークンが無ければ何もしない — 叩かないし落ちない", async () => {
  const dc = await fakeDiscord()
  wire(undefined)
  process.env.OPEN_ZERO_DISCORD_API = dc.url
  try {
    await withHarness(async (h) => {
      assert.equal(await h.run(configured), false)
      assert.equal(await h.run(post({ text: "本文" })), undefined)
      assert.deepEqual(await h.run(pollInbound), [])
      assert.equal(dc.hits.length, 0)
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("出したらリアクションも自分で付く — 押す側は絵文字を探さない", async () => {
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

test("2000 字を超えたら分ける — リアクションは最後の1通に付く", async () => {
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
      assert.deepEqual(await h.run(pollInbound), [])

      const m = dc.msgs.find((x) => x.id === id)
      const r = m?.reactions?.[0]
      if (r) r.count = 2
      assert.deepEqual(await h.run(pollInbound), [{ id: `${id}:🛑`, text: "やめて" }])
      // 二度は返らない。返ると同じ指示が cycle のたびに効き続ける。
      assert.deepEqual(await h.run(pollInbound), [])
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
      assert.deepEqual(await h.run(pollInbound), [])
      dc.msgs.unshift({ id: "52", content: "今日はこれをやって", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [{ id: "52", text: "今日はこれをやって" }])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("記録完了前に終了した回の項目は、次の回にもう一度取得する", async () => {
  const dc = await fakeDiscord([{ id: "70", content: "位置合わせ", author: { id: OWNER } }])
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      await h.run(pollInbound)
      dc.msgs.unshift({ id: "71", content: "歯医者を来週にずらして", author: { id: OWNER } })
      // 読んだが `seen` を呼ばずに終えた回。位置は進んでいない。
      const first = await h.run(peek)
      assert.deepEqual([...first.items], [{ id: "71", text: "歯医者を来週にずらして" }])
      // 二重記録は修復できるが、cursor 以前に取り残された項目は再取得できない。
      assert.deepEqual(await h.run(pollInbound), [{ id: "71", text: "歯医者を来週にずらして" }])
      assert.deepEqual(await h.run(pollInbound), [])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("押されたリアクションも、記録し終えるまでは消えない", async () => {
  const dc = await fakeDiscord()
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      const id = await h.run(post({ text: "出していいか", taps: [{ emoji: "✅", reply: "出していい" }] }))
      const r = dc.msgs.find((x) => x.id === id)?.reactions?.[0]
      assert.ok(r, "自分で付けたリアクションが見つからない")
      r.count = 2
      const first = await h.run(peek)
      assert.deepEqual([...first.items], [{ id: `${id}:✅`, text: "出していい" }])
      // 待ちリストから落ちるのも `seen` のとき。落ちる前に切られたら、次の回にもう一度返る。
      assert.deepEqual(await h.run(pollInbound), [{ id: `${id}:✅`, text: "出していい" }])
      assert.deepEqual(await h.run(pollInbound), [])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("自分の発言は拾わない — 出した文が次の cycle の入力に化けない", async () => {
  const dc = await fakeDiscord([{ id: "60", content: "位置合わせ", author: { id: OWNER } }])
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      await h.run(pollInbound)
      await h.run(post({ text: "こちらから出した文" }))
      assert.deepEqual(await h.run(pollInbound), [])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("Discord が落ちていても空を返す — cycle は返事が読めないだけで止まらない", async () => {
  // 1 番は特権ポートで、この環境では誰も listen していない(接続は即座に拒否される)。
  wire("http://127.0.0.1:1")
  try {
    await withHarness(async (h) => {
      assert.deepEqual(await h.run(pollInbound), [])
      assert.equal(await h.run(post({ text: "本文" })), undefined)
    })
  } finally {
    wire(undefined)
  }
})

const TALK = "7001"
const DRAFT = "7002"

/**
 * 分ける理由はミュートの単位。下書きと会話が同じ場所に出ると、
 * 「読まなくていいものをミュートする」と「返事が要るもの」も一緒に届かなくなる。
 */
test("下書きは下書きの場所へ、会話は会話の場所へ出る", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { talk: TALK, draft: DRAFT })
  try {
    await withHarness(async (h) => {
      await h.run(post({ text: "返事" }))
      await h.run(post({ text: "下書き本文", to: "draft" }))
      const sent = dc.hits.filter((x) => x.method === "POST" && x.path.endsWith("/messages"))
      assert.deepEqual(
        sent.map((x) => x.path),
        [`/channels/${TALK}/messages`, `/channels/${DRAFT}/messages`],
      )
      assert.equal(
        dc.hits.some((x) => x.path === "/users/@me/channels"),
        false,
      )
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("リアクションは出した場所に付く — 会話の場所に出した通知へ間違って付けない", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { talk: TALK, draft: DRAFT })
  try {
    await withHarness(async (h) => {
      const id = await h.run(
        post({ text: "出していいか", to: "draft", taps: [{ emoji: "✅", reply: "出す" }] }),
      )
      assert.equal(
        dc.hits.find((x) => x.method === "PUT")?.path.startsWith(`/channels/${DRAFT}/messages/${id}/`),
        true,
      )
      const r = dc.at(DRAFT).find((x) => x.id === id)?.reactions?.[0]
      if (r) r.count = 2
      assert.deepEqual(await h.run(pollInbound), [{ id: `${id}:✅`, text: "出す" }])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

/** 訊かれたチャンネルに返す。別のチャンネルに返すのは、書いた側からは返事が無いのと同じ。 */
test("返事は最後に話しかけられた場所に返る — DM に書かれたら DM に返す", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { talk: TALK, draft: DRAFT })
  try {
    await withHarness(async (h) => {
      dc.at(TALK).unshift({ id: "200", content: "位置合わせ", author: { id: OWNER } })
      dc.msgs.unshift({ id: "201", content: "位置合わせ", author: { id: OWNER } })
      await h.run(pollInbound)

      dc.msgs.unshift({ id: "300", content: "DM から訊く", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [{ id: "300", text: "DM から訊く" }])
      await h.run(post({ text: "DM への返事" }))
      assert.equal(dc.msgs[0]?.content, "DM への返事")

      dc.at(TALK).unshift({ id: "301", content: "やっぱりこっち", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [{ id: "301", text: "やっぱりこっち" }])
      await h.run(post({ text: "チャンネルへの返事" }))
      assert.equal(dc.at(TALK)[0]?.content, "チャンネルへの返事")
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

/**
 * 2つのチャンネルに同時に未読があるとき、どちらへ返すか。`listening()` は talk → DM の順で
 * 読むので、単に「最後に見たチャンネル」を覚えると常に DM になる。
 */
test("返事は、複数のチャンネルに未読があっても新しいほうへ返る", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { talk: TALK })
  try {
    await withHarness(async (h) => {
      dc.at(TALK).unshift({ id: "200", content: "位置合わせ", author: { id: OWNER } })
      dc.msgs.unshift({ id: "201", content: "位置合わせ", author: { id: OWNER } })
      await h.run(pollInbound)

      dc.msgs.unshift({ id: "300", content: "先に DM", author: { id: OWNER } })
      dc.at(TALK).unshift({ id: "301", content: "後から talk", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [
        { id: "300", text: "先に DM" },
        { id: "301", text: "後から talk" },
      ])
      await h.run(post({ text: "新しいほうへ" }))
      assert.equal(dc.at(TALK)[0]?.content, "新しいほうへ")

      dc.at(TALK).unshift({ id: "400", content: "先に talk", author: { id: OWNER } })
      dc.msgs.unshift({ id: "401", content: "後から DM", author: { id: OWNER } })
      await h.run(pollInbound)
      await h.run(post({ text: "DM へ" }))
      assert.equal(dc.msgs[0]?.content, "DM へ")
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("既読位置は場所ごとに持つ — 片方に書いても、もう片方の過去ログは指示にならない", async () => {
  const dc = await fakeDiscord([{ id: "50", content: "DM の去年の話", author: { id: OWNER } }])
  wire(dc.url, { talk: TALK })
  try {
    await withHarness(async (h) => {
      dc.at(TALK).unshift({ id: "51", content: "チャンネルの去年の話", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [])
      dc.at(TALK).unshift({ id: "52", content: "今日の指示", author: { id: OWNER } })
      // DM 側は位置が動いていないが、そこに残っている過去の一言は出てこない。
      assert.deepEqual(await h.run(pollInbound), [{ id: "52", text: "今日の指示" }])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("旧い全体 cursor は読まず、DM の位置をチャンネル単位で初期化する", async () => {
  const dc = await fakeDiscord([
    { id: "60", content: "去年の話", author: { id: OWNER } },
    { id: "61", content: "おととしの話", author: { id: OWNER } },
  ])
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          yield* db.setMeta("discord:last", "61")
        }),
      )
      assert.deepEqual(await h.run(pollInbound), [])
      dc.msgs.unshift({ id: "62", content: "今日の指示", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [{ id: "62", text: "今日の指示" }])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("呼びかけはチャンネルにだけ付く — DM では字が増えるだけ", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { draft: DRAFT })
  try {
    await withHarness(async (h) => {
      await h.run(post({ text: "下書き", to: "draft", ping: true }))
      assert.equal(dc.at(DRAFT)[0]?.content, `<@${OWNER}>\n下書き`)
      await h.run(post({ text: "返事", ping: true }))
      assert.equal(dc.msgs[0]?.content, "返事")
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

/**
 * リアクションは「どれに」までしか言えない。「直す」の中身は自由文でしか来ないが、
 * スレッド外に書かれた自由文はどの1件への返事か分からない。スレッドなら場所そのものが宛先になる。
 */
test("スレッドの名前を渡すと、出した1通からスレッドが立つ", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { draft: DRAFT })
  try {
    await withHarness(async (h) => {
      const id = await h.run(post({ text: "下書き本文", to: "draft", thread: "題名" }))
      const made = dc.hits.find((x) => x.method === "POST" && x.path.endsWith("/threads"))
      assert.equal(made?.path, `/channels/${DRAFT}/messages/${id}/threads`)
      assert.equal(made?.body?.name, "題名")
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

/** 生やした場所は位置を持たない。規則をそのまま当てると、最初の1通が黙って消える。 */
test("スレッドに書かれた1通目から拾う — 立てた時点で位置を置く", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { talk: TALK, draft: DRAFT })
  try {
    await withHarness(async (h) => {
      const id = await h.run(post({ text: "下書き本文", to: "draft", thread: "題名" }))
      dc.at(String(id)).unshift({ id: "900", content: "ここの数字を直して", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [{ id: "900", text: "ここの数字を直して" }])
      // 返事はスレッドの中に返る。スレッド外に返すと、どれへの返事か読む側が探すことになる。
      await h.run(post({ text: "直した" }))
      assert.equal(dc.at(String(id))[0]?.content, "直した")
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("聞き続けるスレッドには上限がある — 古いものから落ちる", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { draft: DRAFT })
  try {
    await withHarness(async (h) => {
      const ids: (string | undefined)[] = []
      for (const n of [1, 2, 3, 4]) {
        ids.push(await h.run(post({ text: `下書き${n}`, to: "draft", thread: `題名${n}` })))
      }
      const open = await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          return yield* db.meta("discord:threads")
        }),
      )
      assert.deepEqual(JSON.parse(open ?? "[]"), ids.slice(1))
      // 落ちたスレッドに書いても拾わない(接続していない)。
      dc.at(String(ids[0])).unshift({ id: "910", content: "古いスレッドへの返事", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

const LOG = "7003"

/**
 * 進み具合は1回動くたびに1行出る。落とす先を持たせると、会話か DM がそれで埋まる
 * — 埋まった場所は読み飛ばす場所になるので、指していない間は出さない。
 */
test("進み具合は指した場所にしか出ない — 指していなければ DM にも会話にも落ちない", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { talk: TALK })
  try {
    await withHarness(async (h) => {
      assert.equal(await h.run(post({ text: "3手 41秒", to: "log" })), undefined)
      assert.deepEqual(
        dc.hits.filter((x) => x.method === "POST" && x.path.endsWith("/messages")),
        [],
      )
      // 会話は指したままなので、そちらは出る(log を止めても他の経路は塞がない)。
      await h.run(post({ text: "返事" }))
      assert.equal(dc.at(TALK)[0]?.content, "返事")
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("進み具合の場所を指すとそこへ出る — 呼びかけは付けない", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { talk: TALK, log: LOG })
  try {
    await withHarness(async (h) => {
      await h.run(post({ text: "3手 41秒", to: "log" }))
      assert.equal(dc.at(LOG)[0]?.content, "3手 41秒")
      assert.deepEqual(dc.at(TALK), [])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

/** こちらから返事を求めない場所でも、ユーザーは書く。聞かない場所は黙って消える場所になる。 */
test("進み具合の場所に書かれたものも拾う", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { talk: TALK, log: LOG })
  try {
    await withHarness(async (h) => {
      dc.at(LOG).unshift({ id: "400", content: "位置合わせ", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [])
      dc.at(LOG).unshift({ id: "401", content: "この回のこれ何やってるの", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [{ id: "401", text: "この回のこれ何やってるの" }])
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("行数でも分ける — 2000 字に収まっていても縦に長いと畳まれる", async () => {
  const dc = await fakeDiscord()
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      await h.run(post({ text: Array.from({ length: 40 }, (_, i) => `行${i}`).join("\n") }))
      const sent = dc.hits.filter((x) => x.method === "POST" && x.path.endsWith("/messages"))
      assert.equal(sent.length, 3)
      const joined = sent.map((x) => String(x.body?.content ?? "")).join("\n")
      assert.equal(joined.split("\n").length, 40)
      assert.equal(joined.split("\n").at(-1), "行39")
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("enqueue は HTTP を使わず、同じ dedupe は同じ行、内容変更は Conflict", async () => {
  const dc = await fakeDiscord()
  wire(dc.url, { talk: TALK })
  try {
    await withHarness(async (h) => {
      const input = { purpose: "reply", dedupeKey: "event-1", text: "返事" } as const
      const first = await h.run(Effect.flatMap(Discord, (d) => d.enqueue(input)))
      const second = await h.run(Effect.flatMap(Discord, (d) => d.enqueue(input)))
      assert.equal(first?.id, second?.id)
      assert.equal(dc.hits.length, 0)
      const message = first?.actions.find((a) => a.kind === "message")
      assert.equal(message?.nonce?.length, 25)
      assert.deepEqual(message?.spec, {
        kind: "message",
        channelId: TALK,
        message: { content: "返事", enforce_nonce: true, nonce: message?.nonce },
      })

      const conflict = await h.fail(
        Effect.flatMap(Discord, (d) => d.enqueue({ ...input, text: "変えた返事" })),
      )
      assert.equal((conflict as { _tag?: unknown })._tag, "Conflict")
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("DM cache が無ければ open_dm を先に永続化し、flush が receipt と cache を残す", async () => {
  const dc = await fakeDiscord()
  wire(dc.url)
  try {
    await withHarness(async (h) => {
      const queued = await h.run(
        Effect.flatMap(Discord, (d) => d.enqueue({ purpose: "tell", dedupeKey: "dm-1", text: "本文" })),
      )
      assert.deepEqual(
        queued?.actions.map((a) => a.kind),
        ["open_dm", "message"],
      )
      assert.equal(dc.hits.length, 0)
      const [done] = await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(done?.state, "sent")
      assert.equal(await h.run(Effect.flatMap(Db, (db) => db.meta("discord:dm"))), CH)
      const body = dc.hits.find((hit) => hit.path.endsWith("/messages"))?.body
      assert.equal(body?.enforce_nonce, true)
      assert.equal(String(body?.nonce).length, 25)
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("2通目の 429 は partial で止まり、自動再送しない", async () => {
  let messages = 0
  const dc = await fakeDiscord([], (hit) => {
    if (hit.method === "POST" && hit.path.endsWith("/messages") && ++messages === 2) return { status: 429 }
    return undefined
  })
  wire(dc.url, { talk: TALK })
  try {
    await withHarness(async (h) => {
      const queued = await h.run(
        Effect.flatMap(Discord, (d) =>
          d.enqueue({
            purpose: "reply",
            dedupeKey: "partial",
            text: `${"あ".repeat(1500)}\n${"い".repeat(1500)}`,
          }),
        ),
      )
      const [done] = await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(done?.state, "partial")
      assert.deepEqual(
        done?.actions.map((a) => a.state),
        ["succeeded", "failed"],
      )
      await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(messages, 2)
      assert.equal(done?.id, queued?.id)
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})

test("5xx は unknown で止まり、自動再送しない", async () => {
  let messages = 0
  const dc = await fakeDiscord([], (hit) => {
    if (hit.method === "POST" && hit.path.endsWith("/messages")) {
      messages++
      return { status: 503 }
    }
    return undefined
  })
  wire(dc.url, { talk: TALK })
  try {
    await withHarness(async (h) => {
      await h.run(
        Effect.flatMap(Discord, (d) => d.enqueue({ purpose: "reply", dedupeKey: "unknown", text: "本文" })),
      )
      const [done] = await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(done?.state, "unknown")
      await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(messages, 1)
    })
  } finally {
    wire(undefined)
    await dc.close()
  }
})
