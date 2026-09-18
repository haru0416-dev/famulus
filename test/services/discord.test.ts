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
import { type ProposalCard, proposalCard } from "../../src/agent/assistant.ts"
import { drainInbox } from "../../src/inbox.ts"
import { Attention } from "../../src/services/Attention.ts"
import { Db } from "../../src/services/Db.ts"
import { Discord, type Enqueue } from "../../src/services/Discord.ts"
import { Drafts, deliveryKey } from "../../src/services/Drafts.ts"
import { Memory } from "../../src/services/Memory.ts"
import { Proposals, REACTION_DENY_REASON } from "../../src/services/Proposals.ts"
import { Research } from "../../src/services/Research.ts"
import { withHarness } from "../helpers.ts"

const OWNER = "1211509900937793597"
const CH = "9001"
const terminalDossier = (question: string) =>
  Effect.flatMap(Research, (research) =>
    research.recordWebDossier({
      question,
      limitations: "test fixture",
      snapshots: [],
      claims: [],
    }),
  )

interface Hit {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown> | undefined
}

interface Msg {
  id: string
  content: string
  author: { id: string }
  reactions?: { emoji: { name: string | null }; count: number; me: boolean }[]
  reactors?: Record<string, string[]>
  attachments?: { url: string; filename?: string; content_type?: string; size?: number }[]
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
      // multipart(添付)の本文は JSON ではない。読めない本文は undefined として扱う。
      let body: Record<string, unknown> | undefined
      try {
        body = raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>)
      } catch {
        body = undefined
      }
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
        const [, reactionId, reactionEmoji] =
          /\/messages\/(\d+)\/reactions\/([^/?]+)(?:\?|$)/.exec(path) ?? []
        if (req.method === "GET" && reactionId) {
          const name = decodeURIComponent(reactionEmoji ?? "")
          const message = at(ch).find((x) => x.id === reactionId)
          const users =
            message?.reactors?.[name] ??
            ((message?.reactions?.find((reaction) => reaction.emoji.name === name)?.count ?? 0) > 1
              ? [OWNER]
              : [])
          return json(users.map((id) => ({ id })))
        }
        // 自分で付けたリアクション。押す側から見ると数は 1 から始まる。
        const [, id, emoji] = /\/messages\/(\d+)\/reactions\/([^/]+)\/@me/.exec(path) ?? []
        const name = decodeURIComponent(emoji ?? "")
        const m = at(ch).find((x) => x.id === id)
        if (m) {
          m.reactions ??= []
          if (req.method === "DELETE") {
            m.reactions = m.reactions.filter((r) => !(r.me && r.emoji.name === name))
            return res.writeHead(204).end()
          }
          m.reactions.push({ emoji: { name }, count: 1, me: true })
          return res.writeHead(204).end()
        }
        return res.writeHead(404).end("{}")
      }
      if (/^\/channels\/\d+\/typing$/.test(path) && req.method === "POST") return res.writeHead(204).end()
      if (path.startsWith("/cdn/")) {
        res.writeHead(200, { "content-type": "image/png" })
        return res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]))
      }
      const [, messageChannel, messageId] = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path) ?? []
      if (messageChannel && messageId && req.method === "GET") {
        const message = at(messageChannel).find((candidate) => candidate.id === messageId)
        return message ? json(message) : res.writeHead(404).end("{}")
      }
      if (messageChannel && messageId && req.method === "PATCH") {
        const message = at(messageChannel).find((candidate) => candidate.id === messageId)
        if (!message) return res.writeHead(404).end("{}")
        message.content = String(body?.content ?? "")
        return json({ id: messageId })
      }
      if (messageChannel && messageId && req.method === "DELETE") {
        const room = at(messageChannel)
        const found = room.findIndex((candidate) => candidate.id === messageId)
        if (found < 0) return res.writeHead(404).end("{}")
        room.splice(found, 1)
        return res.writeHead(204).end()
      }
      if (ch && path.startsWith(`/channels/${ch}/messages?`)) {
        const query = new URL(path, "http://discord.test")
        const before = query.searchParams.get("before")
        const after = query.searchParams.get("after")
        const limit = Number(query.searchParams.get("limit") ?? "50")
        const listed = [...at(ch)]
          .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
          .filter((message) => before === null || BigInt(message.id) < BigInt(before))
          .filter((message) => after === null || BigInt(message.id) > BigInt(after))
          .slice(0, limit)
        return json(listed)
      }
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
  delete process.env.FAMULUS_DISCORD_CH_TALK
  delete process.env.FAMULUS_DISCORD_CH_DRAFT
  delete process.env.FAMULUS_DISCORD_CH_LOG
  if (url === undefined) {
    process.env.FAMULUS_DISCORD_TOKEN = ""
    delete process.env.FAMULUS_DISCORD_TOKEN
    delete process.env.FAMULUS_DISCORD_OWNER_ID
    delete process.env.FAMULUS_DISCORD_API
    return
  }
  process.env.FAMULUS_DISCORD_TOKEN = "test-token"
  process.env.FAMULUS_DISCORD_OWNER_ID = OWNER
  process.env.FAMULUS_DISCORD_API = url
  if (ch?.talk) process.env.FAMULUS_DISCORD_CH_TALK = ch.talk
  if (ch?.draft) process.env.FAMULUS_DISCORD_CH_DRAFT = ch.draft
  if (ch?.log) process.env.FAMULUS_DISCORD_CH_LOG = ch.log
}

/** wire を張って本文を回し、終わりに必ず外して fake を閉じる。 */
const wired = async (
  dc: Awaited<ReturnType<typeof fakeDiscord>>,
  ch: Parameters<typeof wire>[1],
  fn: () => Promise<void>,
): Promise<void> => {
  wire(dc.url, ch)
  try {
    await fn()
  } finally {
    wire(undefined)
    await dc.close()
  }
}

test("トークンが無ければ何もしない — 叩かないし落ちない", async () => {
  const dc = await fakeDiscord()
  wire(undefined)
  process.env.FAMULUS_DISCORD_API = dc.url
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
  await wired(dc, undefined, async () => {
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
  })
})

test("2000 字を超えたら分ける — リアクションは最後の1通に付く", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      const text = `${"あ".repeat(1500)}\n${"い".repeat(1500)}`
      const id = await h.run(post({ text, taps: [{ emoji: "✅", reply: "了解" }] }))
      const sent = dc.hits.filter((x) => x.method === "POST" && x.path.endsWith("/messages"))
      assert.equal(sent.length, 2)
      assert.equal(String(sent[0]?.body?.content), "あ".repeat(1500))
      assert.equal(String(sent[1]?.body?.content), "い".repeat(1500))
      assert.equal(dc.hits.find((x) => x.method === "PUT")?.path.includes(`/messages/${id}/`), true)
    })
  })
})

test("押されるまでは空。押されたら割り当てた文が返る", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
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
  })
})

test("owner以外のリアクションは判断として受け取らない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      const id = await h.run(post({ text: "出していいか", taps: [{ emoji: "✅", reply: "出していい" }] }))
      const message = dc.msgs.find((item) => item.id === id)
      const reaction = message?.reactions?.[0]
      assert.ok(message)
      assert.ok(reaction)
      reaction.count = 2
      message.reactors = { "✅": ["999999999999999999"] }

      assert.deepEqual(await h.run(pollInbound), [])
      assert.ok(
        dc.hits.some(
          (hit) => hit.method === "GET" && decodeURIComponent(hit.path).includes(`/reactions/✅?limit=100`),
        ),
      )

      message.reactors = { "✅": [OWNER] }
      assert.deepEqual(await h.run(pollInbound), [{ id: `${id}:✅`, text: "出していい" }])
    })
  })
})

test("リアクション利用者の取得失敗は通常のowner入力を止めない", async () => {
  const dc = await fakeDiscord([{ id: "500", content: "通常入力", author: { id: OWNER } }], (hit) =>
    hit.method === "GET" && hit.path.includes("/reactions/") ? { status: 503 } : undefined,
  )
  await wired(dc, { talk: CH }, async () => {
    await withHarness(async (h) => {
      await h.run(Effect.flatMap(Db, (db) => db.setMeta(`discord:last:${CH}`, "499")))
      const id = await h.run(post({ text: "出していいか", taps: [{ emoji: "✅", reply: "出していい" }] }))
      const reaction = dc.msgs.find((item) => item.id === id)?.reactions?.[0]
      assert.ok(reaction)
      reaction.count = 2

      assert.deepEqual(await h.run(pollInbound), [{ id: "500", text: "通常入力" }])
      assert.ok(dc.hits.some((hit) => hit.method === "GET" && hit.path.includes("/reactions/")))
    })
  })
})

test("下書きのリアクションは対象draftへ一度だけ適用する", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      const { draftId, messageId, outboundState, actionStates, health } = await h.run(
        Effect.gen(function* () {
          const drafts = yield* Drafts
          const discord = yield* Discord
          const db = yield* Db
          const dossier = yield* terminalDossier("draft reaction")
          const draft = yield* drafts.materialize({ title: "題", body: "本文", dossierId: dossier.id })
          const outbound = yield* discord.enqueue({
            purpose: "assistant-draft",
            dedupeKey: deliveryKey(draft.id, draft.content_hash),
            text: "本文",
            taps: [{ emoji: "✏️", reply: "直す", draft: { id: draft.id, decision: "revise" } }],
          })
          assert.ok(outbound)
          yield* discord.flushQueued()
          const done = yield* discord.getOutbound(outbound.id)
          const receipt = done?.actions.find((a) => a.kind === "message")?.receipt as
            | { messageId?: unknown }
            | undefined
          return {
            draftId: draft.id,
            messageId: String(receipt?.messageId),
            outboundState: done?.state,
            actionStates: done?.actions.map((action) => action.state),
            health: yield* db.meta("health:draft:last_success"),
          }
        }),
      )
      assert.ok(health)

      assert.deepEqual(
        { outboundState, actionStates },
        { outboundState: "sent", actionStates: ["succeeded", "succeeded", "succeeded"] },
      )
      const reaction = dc.msgs.find((x) => x.id === messageId)?.reactions?.[0]
      assert.ok(reaction)
      const pendingTaps = await h.run(Effect.flatMap(Db, (db) => db.meta("discord:taps")))
      assert.notEqual(pendingTaps, undefined, `reaction待ちが未登録: ${pendingTaps}`)
      reaction.count = 2
      assert.equal(await h.run(drainInbox), 1)
      assert.equal(await h.run(drainInbox), 0)
      const stored = await h.run(Effect.flatMap(Drafts, (drafts) => drafts.forDay()))
      assert.equal(stored?.id, draftId)
      // ✏️ は終点ではなく差し戻し — 配送前の状態へ戻り、改稿ループに入る
      assert.equal(stored?.state, "revision_needed")
      assert.equal(stored?.delivered_at, null)
      assert.match(String(stored?.review_feedback), /直す/)
      assert.equal(stored?.decision_origin_id, `${messageId}:✏️`)
    })
  })
})

test("済んだ合図は見た合図を外す — ✅ を付けてから 👀 を消す", async () => {
  const dc = await fakeDiscord([{ id: "50", content: "たのむ", author: { id: OWNER } }])
  // 宛先をチャンネルにする — DM 宛だと open_dm のアクションが先頭に足されて、ack だけを数えられない。
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const reactions = () => dc.msgs.find((m) => m.id === "50")?.reactions?.map((r) => r.emoji.name)
      const ackOnce = (purpose: string, emoji: string, clear?: string) =>
        h.run(
          Effect.gen(function* () {
            const discord = yield* Discord
            const o = yield* discord.enqueue({
              purpose,
              dedupeKey: "50",
              text: "",
              ack: { channelId: CH, messageId: "50", emoji, ...(clear ? { clear } : {}) },
            })
            assert.ok(o)
            yield* discord.flushQueued()
            return yield* discord.getOutbound(o.id)
          }),
        )

      // 受け取り時: 👀 だけ付く。PUT は 204 で本文が無いが、受領証は status で成立する
      const seen = await ackOnce("cycle-ack", "👀")
      assert.equal(seen?.state, "sent")
      assert.deepEqual(
        seen?.actions.map((a) => a.state),
        ["succeeded"],
      )
      assert.deepEqual(reactions(), ["👀"])

      // 済んだ合図: ✅ を付けてから 👀 を外す。残るのは ✅ だけ
      const done = await ackOnce("cycle-done", "✅", "👀")
      assert.equal(done?.state, "sent")
      assert.deepEqual(
        done?.actions.map((a) => a.state),
        ["succeeded", "succeeded"],
      )
      assert.deepEqual(reactions(), ["✅"])
    })
  })
})

test("進行表示は台帳を通さない直接送信 — typing / post / edit / delete", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const { id, afterEdit, outbound } = await h.run(
        Effect.gen(function* () {
          const discord = yield* Discord
          const db = yield* Db
          yield* discord.typing(CH)
          const id = yield* discord.statusPost(CH, "🛠 recall(病院)×2")
          assert.ok(id)
          yield* discord.statusEdit(CH, id, "🛠 recall(病院)×2 · digger")
          const afterEdit = dc.msgs.find((m) => m.id === id)?.content
          yield* discord.statusDelete(CH, id)
          return { id, afterEdit, outbound: yield* db.all("SELECT id FROM discord_outbound") }
        }),
      )
      assert.ok(dc.hits.some((x) => x.method === "POST" && x.path === `/channels/${CH}/typing`))
      assert.equal(afterEdit, "🛠 recall(病院)×2 · digger")
      assert.equal(
        dc.msgs.find((m) => m.id === id),
        undefined,
      )
      // 台帳に行が増えていない — 進行表示は配送記録ではない
      assert.deepEqual(outbound, [])

      // 失敗は握りつぶして処理を止めない(実在しない message の edit / delete)
      await h.run(
        Effect.flatMap(Discord, (discord) =>
          Effect.gen(function* () {
            yield* discord.statusEdit(CH, "9999", "x")
            yield* discord.statusDelete(CH, "9999")
          }),
        ),
      )
    })
  })
})

test("進行表示は相手が落ちていても失敗しない — 表示が出ないだけ", async () => {
  const dc = await fakeDiscord()
  const dead = dc.url
  await dc.close()
  wire(dead, { talk: TALK })
  try {
    await withHarness(async (h) => {
      await h.run(
        Effect.flatMap(Discord, (discord) =>
          Effect.gen(function* () {
            yield* discord.typing(CH)
            assert.equal(yield* discord.statusPost(CH, "x"), undefined)
            yield* discord.statusEdit(CH, "1", "x")
            yield* discord.statusDelete(CH, "1")
          }),
        ),
      )
    })
  } finally {
    wire(undefined)
  }
})

test("progressFor は変化があるときだけ送り、post 失敗は次の tick で再試行する", async () => {
  let failNextPost = true
  const dc = await fakeDiscord([], (hit) => {
    if (failNextPost && hit.method === "POST" && hit.path === `/channels/${CH}/messages`) {
      failNextPost = false
      return { status: 500 }
    }
    return undefined
  })
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const posts = () =>
        dc.hits.filter((x) => x.method === "POST" && x.path === `/channels/${CH}/messages`).length
      const display = await h.run(Effect.map(Discord, (d) => d.progressFor(CH)))

      // 1通も出していないうちの stop は何もしない
      await h.run(display.stop())
      assert.equal(dc.hits.length, 0)

      // 内容が無いうちは typing だけ
      await h.run(display.tick())
      assert.equal(posts(), 0)
      assert.ok(dc.hits.some((x) => x.path === `/channels/${CH}/typing`))

      // post が失敗した tick は次の tick で同じ内容を再試行する
      display.want("🛠 recall(病院)×2")
      await h.run(display.tick())
      assert.equal(dc.msgs.length, 0)
      await h.run(display.tick())
      assert.equal(posts(), 2)
      assert.equal(dc.msgs[0]?.content, "🛠 recall(病院)×2")

      // 同じ内容では送らない。変わったら同じ1通を edit
      await h.run(display.tick())
      assert.equal(posts(), 2)
      display.want("🛠 recall(病院)×2 · digger")
      await h.run(display.tick())
      assert.equal(posts(), 2)
      assert.equal(dc.msgs.length, 1)
      assert.equal(dc.msgs[0]?.content, "🛠 recall(病院)×2 · digger")

      // stop は作った1通だけを消す
      await h.run(display.stop())
      assert.equal(dc.msgs.length, 0)
    })
  })
})

test("初回は自由文を取り込まない — DM に残っている過去の一言は指示ではない", async () => {
  const dc = await fakeDiscord([
    { id: "50", content: "去年の話", author: { id: OWNER } },
    { id: "51", content: "おはよう", author: { id: OWNER } },
  ])
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      assert.deepEqual(await h.run(pollInbound), [])
      dc.msgs.unshift({ id: "52", content: "今日はこれをやって", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [{ id: "52", text: "今日はこれをやって" }])
    })
  })
})

test("owner自由文のeventには返信先channelをprovenanceとして残す", async () => {
  const dc = await fakeDiscord([{ id: "80", content: "位置合わせ", author: { id: OWNER } }])
  await wired(dc, { talk: CH }, async () => {
    await withHarness(async (h) => {
      await h.run(pollInbound)
      dc.at(CH).unshift({ id: "81", content: "ここで続けて", author: { id: OWNER } })
      assert.equal(await h.run(drainInbox), 1)
      const event = await h.run(
        Effect.flatMap(Db, (db) =>
          db.get("SELECT provenance FROM events WHERE origin_kind='discord' AND origin_id='81'"),
        ),
      )
      assert.deepEqual(JSON.parse(String(event?.provenance)), [{ kind: "discord", ref: CH }])
    })
  })
})

test("記録完了前に終了した回の項目は、次の回にもう一度取得する", async () => {
  const dc = await fakeDiscord([{ id: "70", content: "位置合わせ", author: { id: OWNER } }])
  await wired(dc, undefined, async () => {
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
  })
})

test("未読が100件を超えても全件を古い順に取得してからcursorを進める", async () => {
  const dc = await fakeDiscord([{ id: "1000", content: "位置合わせ", author: { id: OWNER } }])
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      await h.run(pollInbound)
      for (let id = 1001; id <= 1125; id++) {
        dc.msgs.unshift({ id: String(id), content: `指示${id}`, author: { id: OWNER } })
      }

      const items = await h.run(pollInbound)
      assert.equal(items.length, 125)
      assert.deepEqual(items.at(0), { id: "1001", text: "指示1001" })
      assert.deepEqual(items.at(-1), { id: "1125", text: "指示1125" })
      assert.equal(
        dc.hits.filter((hit) => hit.method === "GET" && hit.path.includes("/messages?")).length,
        3,
        "初回の位置合わせ1回と、未読を回収する2ページ",
      )
      assert.deepEqual(await h.run(pollInbound), [])
    })
  })
})

test("後続ページの取得失敗では取得済みページより先へcursorを進めない", async () => {
  let failSecondPage = false
  let page = 0
  const dc = await fakeDiscord([{ id: "2000", content: "位置合わせ", author: { id: OWNER } }], (hit) => {
    if (!failSecondPage || hit.method !== "GET" || !hit.path.includes("/messages?")) return undefined
    page++
    return page === 2 ? { status: 503 } : undefined
  })
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      await h.run(pollInbound)
      for (let id = 2001; id <= 2125; id++) {
        dc.msgs.unshift({ id: String(id), content: `指示${id}`, author: { id: OWNER } })
      }

      failSecondPage = true
      const failed = await h.run(Effect.result(peek))
      assert.equal(failed._tag, "Failure")
      assert.equal(await h.run(Effect.flatMap(Db, (db) => db.meta(`discord:last:${CH}`))), "2000")

      failSecondPage = false
      const recovered = await h.run(pollInbound)
      assert.equal(recovered.length, 125)
      assert.equal(recovered[0]?.id, "2001")
      assert.equal(recovered.at(-1)?.id, "2125")
    })
  })
})

test("cursorより古いリアクション待ちはmessage IDで直接確認する", async () => {
  const dc = await fakeDiscord(
    Array.from({ length: 201 }, (_, index) => {
      const id = String(300 - index)
      return {
        id,
        content: `投稿${id}`,
        author: { id: "bot" },
        ...(id === "100" ? { reactions: [{ emoji: { name: "✅" }, count: 2, me: true }] } : {}),
      }
    }),
  )
  await wired(dc, { talk: CH }, async () => {
    await withHarness(async (h) => {
      await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          yield* db.setMeta(`discord:last:${CH}`, "300")
          yield* db.setMeta("discord:taps", JSON.stringify({ "100": { "✅": "古い投稿への返事" } }))
        }),
      )
      assert.deepEqual(await h.run(pollInbound), [{ id: "100:✅", text: "古い投稿への返事" }])
      assert.equal(
        dc.hits.some((hit) => hit.method === "GET" && hit.path === `/channels/${CH}/messages/100`),
        true,
      )
    })
  })
})

test("権限を失った過去channelのtapは破棄して現在channelの受信を続ける", async () => {
  const oldChannel = "7999"
  const dc = await fakeDiscord([], (hit) =>
    hit.method === "GET" && hit.path === `/channels/${oldChannel}/messages/100` ? { status: 403 } : undefined,
  )
  dc.at(CH).unshift(
    { id: "301", content: "現在の指示", author: { id: OWNER } },
    { id: "300", content: "位置合わせ", author: { id: OWNER } },
  )
  await wired(dc, { talk: CH }, async () => {
    await withHarness(async (h) => {
      await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          yield* db.setMeta(`discord:last:${CH}`, "300")
          yield* db.setMeta(
            "discord:taps",
            JSON.stringify({ "100": { "✅": { reply: "旧tap", channelId: oldChannel } } }),
          )
        }),
      )
      assert.deepEqual(await h.run(pollInbound), [{ id: "301", text: "現在の指示" }])
      assert.equal(await h.run(Effect.flatMap(Db, (db) => db.meta("discord:taps"))), "{}")
    })
  })
})

test("古いbatchを後からcommitしてもcursorと返信先を巻き戻さない", async () => {
  wire(undefined)
  await withHarness(async (h) => {
    const result = await h.run(
      Effect.gen(function* () {
        const discord = yield* Discord
        const db = yield* Db
        const memory = yield* Memory
        yield* db.setMeta(`discord:last:${TALK}`, "500")
        yield* db.setMeta("discord:heard_in", TALK)
        yield* db.setMeta("discord:heard_at", "100")
        yield* memory.remember({
          source: "owner",
          content: "最後のowner発言",
          at: "2026-08-16T00:00:00Z",
          origin: { kind: "discord", id: "600" },
          provenance: [{ kind: "discord", ref: CH }],
        })
        yield* memory.remember({
          source: "owner",
          content: "遅れて保存された古い発言",
          at: "2026-08-16T00:01:00Z",
          origin: { kind: "discord", id: "500" },
          provenance: [{ kind: "discord", ref: TALK }],
        })
        yield* discord.commitInboundBatch({
          items: [],
          marks: { [TALK]: "700", [CH]: "200" },
          consumedTapIds: [],
          heard: CH,
          heardAt: "200",
        })
        const afterOld = {
          heard: yield* db.meta("discord:heard_in"),
          heardAt: yield* db.meta("discord:heard_at"),
        }
        yield* discord.commitInboundBatch({
          items: [],
          marks: { [CH]: "600" },
          consumedTapIds: [],
          heard: CH,
          heardAt: "600",
        })
        yield* discord.commitInboundBatch({
          items: [],
          marks: { [TALK]: "500" },
          consumedTapIds: [],
          heard: TALK,
          heardAt: "500",
        })
        return {
          afterOld,
          talkCursor: yield* db.meta(`discord:last:${TALK}`),
          dmCursor: yield* db.meta(`discord:last:${CH}`),
          heard: yield* db.meta("discord:heard_in"),
          heardAt: yield* db.meta("discord:heard_at"),
        }
      }),
    )
    assert.deepEqual(result, {
      afterOld: { heard: CH, heardAt: "600" },
      talkCursor: "700",
      dmCursor: "600",
      heard: CH,
      heardAt: "600",
    })
  })
})

test("押されたリアクションも、記録し終えるまでは消えない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      const id = await h.run(post({ text: "出していいか", taps: [{ emoji: "✅", reply: "出していい" }] }))
      const r = dc.msgs.find((x) => x.id === id)?.reactions?.[0]
      assert.ok(r, "自分で付けたリアクションが見つからない")
      r.count = 2
      const first = await h.run(peek)
      assert.deepEqual([...first.items], [{ id: `${id}:✅`, text: "出していい" }])
      // 待ちリストから落ちるのも `seen` のとき。落ちる前に切られたら、次の回にもう一度返る。
      const second = await h.run(peek)
      assert.deepEqual([...second.items], [{ id: `${id}:✅`, text: "出していい" }])
      await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          const current = JSON.parse((yield* db.meta("discord:taps")) ?? "{}") as Record<string, unknown>
          yield* db.setMeta(
            "discord:taps",
            JSON.stringify({ ...current, "999": { "✅": { reply: "新着" } } }),
          )
          const discord = yield* Discord
          yield* discord.commitInboundBatch(second)
        }),
      )
      const left = JSON.parse(
        (await h.run(Effect.flatMap(Db, (db) => db.meta("discord:taps")))) ?? "{}",
      ) as Record<string, unknown>
      assert.equal(id === undefined ? undefined : left[id], undefined)
      assert.deepEqual(left["999"], { "✅": { reply: "新着" } }, "poll中に追加されたtap対応表は消さない")
      assert.deepEqual(await h.run(pollInbound), [])
    })
  })
})

test("自分の発言は拾わない — 出した文が次の cycle の入力に化けない", async () => {
  const dc = await fakeDiscord([{ id: "60", content: "位置合わせ", author: { id: OWNER } }])
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      await h.run(pollInbound)
      await h.run(post({ text: "こちらから出した文" }))
      assert.deepEqual(await h.run(pollInbound), [])
    })
  })
})

test("DM専用構成でDiscordが落ちたら空受信ではなく失敗する", async () => {
  // 1 番は特権ポートで、この環境では誰も listen していない(接続は即座に拒否される)。
  wire("http://127.0.0.1:1")
  try {
    await withHarness(async (h) => {
      const result = await h.run(Effect.result(peek))
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") assert.equal(result.failure._tag, "ConnectorFailed")
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
  await wired(dc, { talk: TALK, draft: DRAFT }, async () => {
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
  })
})

test("リアクションは出した場所に付く — 会話の場所に出した通知へ間違って付けない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK, draft: DRAFT }, async () => {
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
  })
})

/** 訊かれたチャンネルに返す。別のチャンネルに返すのは、書いた側からは返事が無いのと同じ。 */
test("返事は最後に話しかけられた場所に返る — DM に書かれたら DM に返す", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK, draft: DRAFT }, async () => {
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
  })
})

/**
 * 2つのチャンネルに同時に未読があるとき、どちらへ返すか。`listening()` は talk → DM の順で
 * 読むので、単に「最後に見たチャンネル」を覚えると常に DM になる。
 */
test("返事は、複数のチャンネルに未読があっても新しいほうへ返る", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
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
  })
})

test("既読位置は場所ごとに持つ — 片方に書いても、もう片方の過去ログは指示にならない", async () => {
  const dc = await fakeDiscord([{ id: "50", content: "DM の去年の話", author: { id: OWNER } }])
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      dc.at(TALK).unshift({ id: "51", content: "チャンネルの去年の話", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [])
      dc.at(TALK).unshift({ id: "52", content: "今日の指示", author: { id: OWNER } })
      // DM 側は位置が動いていないが、そこに残っている過去の一言は出てこない。
      assert.deepEqual(await h.run(pollInbound), [{ id: "52", text: "今日の指示" }])
    })
  })
})

test("旧い全体 cursor は読まず、DM の位置をチャンネル単位で初期化する", async () => {
  const dc = await fakeDiscord([
    { id: "60", content: "去年の話", author: { id: OWNER } },
    { id: "61", content: "おととしの話", author: { id: OWNER } },
  ])
  await wired(dc, undefined, async () => {
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
  })
})

test("呼びかけはチャンネルにだけ付く — DM では字が増えるだけ", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { draft: DRAFT }, async () => {
    await withHarness(async (h) => {
      await h.run(post({ text: "下書き", to: "draft", ping: true }))
      assert.equal(dc.at(DRAFT)[0]?.content, `<@${OWNER}>\n下書き`)
      await h.run(post({ text: "返事", ping: true }))
      assert.equal(dc.msgs[0]?.content, "返事")
    })
  })
})

/**
 * リアクションは「どれに」までしか言えない。「直す」の中身は自由文でしか来ないが、
 * スレッド外に書かれた自由文はどの1件への返事か分からない。スレッドなら場所そのものが宛先になる。
 */
test("スレッドの名前を渡すと、出した1通からスレッドが立つ", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { draft: DRAFT }, async () => {
    await withHarness(async (h) => {
      const id = await h.run(post({ text: "下書き本文", to: "draft", thread: "題名" }))
      const made = dc.hits.find((x) => x.method === "POST" && x.path.endsWith("/threads"))
      assert.equal(made?.path, `/channels/${DRAFT}/messages/${id}/threads`)
      assert.equal(made?.body?.name, "題名")
    })
  })
})

/** チャンネル側を短く保ちつつ全文を届ける置き場。長文はスレッドの中に入る。 */
test("threadNotes は立てたスレッドの中へ1要素1通で入る", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { draft: DRAFT }, async () => {
    await withHarness(async (h) => {
      await h.run(
        post({
          text: "題と件数だけ",
          to: "draft",
          thread: "題名",
          threadNotes: ["全文そのもの", "根拠 dossier: d-1"],
        }),
      )
      // スレッド(fake では起点メッセージと同じ id が場所になる)へ、順番どおり2通
      const made = dc.hits.find((x) => x.method === "POST" && x.path.endsWith("/threads"))
      const origin = /\/messages\/(\d+)\/threads$/.exec(made?.path ?? "")?.[1]
      assert.ok(origin)
      // fake は新しい順に積む
      assert.deepEqual(
        dc.at(origin).map((m) => m.content),
        ["根拠 dossier: d-1", "全文そのもの"],
      )
      // チャンネル側には短い1通だけ
      assert.equal(dc.at(DRAFT).filter((m) => m.author.id === "bot").length, 1)
    })
  })
})

/** 生やした場所は位置を持たない。規則をそのまま当てると、最初の1通が黙って消える。 */
test("スレッドに書かれた1通目から拾う — 立てた時点で位置を置く", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK, draft: DRAFT }, async () => {
    await withHarness(async (h) => {
      const id = await h.run(post({ text: "下書き本文", to: "draft", thread: "題名" }))
      dc.at(String(id)).unshift({ id: "900", content: "ここの数字を直して", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [{ id: "900", text: "ここの数字を直して" }])
      // 返事はスレッドの中に返る。スレッド外に返すと、どれへの返事か読む側が探すことになる。
      await h.run(post({ text: "直した" }))
      assert.equal(dc.at(String(id))[0]?.content, "直した")
    })
  })
})

test("聞き続けるスレッドには上限がある — 古いものから落ちる", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { draft: DRAFT }, async () => {
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
  })
})

const LOG = "7003"

/**
 * 進み具合は1回動くたびに1行出る。落とす先を持たせると、会話か DM がそれで埋まる
 * — 埋まった場所は読み飛ばす場所になるので、指していない間は出さない。
 */
test("進み具合は指した場所にしか出ない — 指していなければ DM にも会話にも落ちない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
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
  })
})

test("進み具合の場所を指すとそこへ出る — 呼びかけは付けない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK, log: LOG }, async () => {
    await withHarness(async (h) => {
      await h.run(post({ text: "3手 41秒", to: "log" }))
      assert.equal(dc.at(LOG)[0]?.content, "3手 41秒")
      assert.deepEqual(dc.at(TALK), [])
    })
  })
})

/** こちらから返事を求めない場所でも、ユーザーは書く。聞かない場所は黙って消える場所になる。 */
test("進み具合の場所に書かれたものも拾う", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK, log: LOG }, async () => {
    await withHarness(async (h) => {
      dc.at(LOG).unshift({ id: "400", content: "位置合わせ", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [])
      dc.at(LOG).unshift({ id: "401", content: "この回のこれ何やってるの", author: { id: OWNER } })
      assert.deepEqual(await h.run(pollInbound), [{ id: "401", text: "この回のこれ何やってるの" }])
    })
  })
})

test("行数でも分ける — 2000 字に収まっていても縦に長いと畳まれる", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      await h.run(post({ text: Array.from({ length: 40 }, (_, i) => `行${i}`).join("\n") }))
      const sent = dc.hits.filter((x) => x.method === "POST" && x.path.endsWith("/messages"))
      assert.equal(sent.length, 3)
      const joined = sent.map((x) => String(x.body?.content ?? "")).join("\n")
      assert.equal(joined.split("\n").length, 40)
      assert.equal(joined.split("\n").at(-1), "行39")
    })
  })
})

test("enqueue は HTTP を使わず、同じ dedupe は同じ行、内容変更は Conflict", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const input = { purpose: "reply", dedupeKey: "event-1", text: "返事" } as const
      const first = await h.run(Effect.flatMap(Discord, (d) => d.enqueue(input)))
      const second = await h.run(Effect.flatMap(Discord, (d) => d.enqueue(input)))
      assert.equal(first?.id, second?.id)
      assert.equal(dc.hits.length, 0)
      assert.equal(await h.run(Effect.flatMap(Discord, (d) => d.needsFlush())), true)
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
      await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(await h.run(Effect.flatMap(Discord, (d) => d.needsFlush())), false)
    })
  })
})

test("DM cache が無ければ open_dm を先に永続化し、flush が receipt と cache を残す", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
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
  })
})

test("2通目の 429 は partial で止まり、自動再送しない", async () => {
  let messages = 0
  const dc = await fakeDiscord([], (hit) => {
    if (hit.method === "POST" && hit.path.endsWith("/messages") && ++messages === 2) return { status: 429 }
    return undefined
  })
  await wired(dc, { talk: TALK }, async () => {
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
  })
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
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const draft = await h.run(
        Effect.gen(function* () {
          const drafts = yield* Drafts
          const dossier = yield* terminalDossier("failed delivery")
          return yield* drafts.materialize({ title: "題", body: "本文", dossierId: dossier.id })
        }),
      )
      const outbound = await h.run(
        Effect.flatMap(Discord, (d) =>
          d.enqueue({ purpose: "assistant-draft", dedupeKey: draft.id, text: "本文" }),
        ),
      )
      assert.ok(outbound)
      const [done] = await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(done?.state, "unknown")
      const failedDraft = await h.run(Effect.flatMap(Drafts, (drafts) => drafts.forDay()))
      assert.equal(failedDraft?.state, "delivery_failed")
      assert.equal(failedDraft?.outbound_id, outbound.id, "attach前の終端もdedupe keyから紐付ける")
      const plan = await h.run(Effect.flatMap(Attention, (attention) => attention.planCycle()))
      assert.equal(plan.draftDue, false, "配送失敗はhealthに残し、同じ日次処理を自動再送しない")
      const health = await h.run(Effect.flatMap(Db, (db) => db.meta("health:draft:last_failure")))
      assert.match(health ?? "", /"stage":"delivery"/)
      await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(messages, 1)
    })
  })
})

test("配送先が無ければdraftを失敗で終端化してhealthへ残す", async () => {
  wire(undefined)
  await withHarness(async (h) => {
    const failed = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const dossier = yield* terminalDossier("missing destination")
        const draft = yield* drafts.materialize({ title: "題", body: "本文", dossierId: dossier.id })
        return yield* drafts.failDelivery(draft.id, "Discord destination is not configured")
      }),
    )
    assert.equal(failed.state, "delivery_failed")
    const plan = await h.run(Effect.flatMap(Attention, (attention) => attention.planCycle()))
    assert.equal(plan.draftDue, false)
    const health = await h.run(Effect.flatMap(Db, (db) => db.meta("health:draft:last_failure")))
    assert.match(health ?? "", /Discord destination is not configured/)
  })
})

test("修正待ちへ変わったdraftを配送失敗で上書きしない", async () => {
  wire(undefined)
  await withHarness(async (h) => {
    const result = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const dossier = yield* terminalDossier("concurrent revision")
        const draft = yield* drafts.materialize({ title: "題", body: "本文", dossierId: dossier.id })
        yield* drafts.requestRevision(draft.id, "直す")
        return yield* Effect.result(drafts.failDelivery(draft.id, "destination missing"))
      }),
    )
    assert.equal(result._tag, "Failure")
    const health = await h.run(Effect.flatMap(Db, (db) => db.meta("health:draft:last_failure")))
    assert.equal(health, undefined)
  })
})

test("受信GETの5xxを空受信にせず失敗として返す", async () => {
  const dc = await fakeDiscord([], (hit) =>
    hit.method === "GET" && hit.path.includes("/messages?") ? { status: 503 } : undefined,
  )
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const result = await h.run(Effect.result(Effect.flatMap(Discord, (d) => d.pollInbound())))
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") assert.equal(result.failure._tag, "ConnectorFailed")
    })
  })
})

test("受信GETの不正な200応答を空受信にせず失敗として返す", async () => {
  const dc = await fakeDiscord([], (hit) =>
    hit.method === "GET" && hit.path.includes("/messages?")
      ? { status: 200, body: { message: "upstream error" } }
      : undefined,
  )
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const result = await h.run(Effect.result(Effect.flatMap(Discord, (d) => d.pollInbound())))
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") assert.equal(result.failure._tag, "ConnectorFailed")
    })
  })
})

test("一般配送のバックログは受信GETより前に送らない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const outbound = await h.run(
        Effect.flatMap(Discord, (discord) =>
          discord.enqueue({ purpose: "reply", dedupeKey: "inbound-before-backlog", text: "待機中" }),
        ),
      )
      assert.ok(outbound)
      await h.run(peek)

      const inboundAt = dc.hits.findIndex((hit) => hit.method === "GET" && hit.path.includes("/messages?"))
      const deliveryAt = dc.hits.findIndex((hit) => hit.method === "POST" && hit.path.endsWith("/messages"))
      assert.ok(inboundAt >= 0)
      assert.equal(deliveryAt, -1, "pollInbound が一般配送まで待っている")
      assert.equal(
        (await h.run(Effect.flatMap(Discord, (discord) => discord.getOutbound(outbound.id))))?.state,
        "queued",
      )

      await h.run(Effect.flatMap(Discord, (discord) => discord.flushQueued()))
      assert.equal(
        (await h.run(Effect.flatMap(Discord, (discord) => discord.getOutbound(outbound.id))))?.state,
        "sent",
      )
    })
  })
})

test("ID指定の即時配送は既存バックログを巻き込まない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const [backlog, immediate] = await h.run(
        Effect.gen(function* () {
          const discord = yield* Discord
          return [
            yield* discord.enqueue({ purpose: "reply", dedupeKey: "older-backlog", text: "古い待機" }),
            yield* discord.enqueue({ purpose: "cycle-ack", dedupeKey: "immediate-only", text: "今の応答" }),
          ] as const
        }),
      )
      assert.ok(backlog)
      assert.ok(immediate)

      await h.run(Effect.flatMap(Discord, (discord) => discord.flushOutbound(immediate.id)))
      assert.equal(
        (await h.run(Effect.flatMap(Discord, (discord) => discord.getOutbound(backlog.id))))?.state,
        "queued",
      )
      assert.equal(
        (await h.run(Effect.flatMap(Discord, (discord) => discord.getOutbound(immediate.id))))?.state,
        "sent",
      )
      assert.deepEqual(
        dc.at(TALK).map((message) => message.content),
        ["今の応答"],
      )
    })
  })
})

test("DM未初期化時はDM cacheだけを先行し、一般配送は受信後まで残す", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      const outbound = await h.run(
        Effect.flatMap(Discord, (discord) =>
          discord.enqueue({ purpose: "reply", dedupeKey: "cold-dm-backlog", text: "待機中" }),
        ),
      )
      assert.ok(outbound)
      await h.run(peek)

      assert.equal(dc.hits.filter((hit) => hit.path === "/users/@me/channels").length, 1)
      assert.ok(dc.hits.some((hit) => hit.method === "GET" && hit.path.includes(`/channels/${CH}/messages?`)))
      assert.equal(dc.hits.filter((hit) => hit.method === "POST" && hit.path.endsWith("/messages")).length, 0)
      assert.equal(await h.run(Effect.flatMap(Db, (db) => db.meta("discord:dm"))), CH)
      assert.equal(
        (await h.run(Effect.flatMap(Discord, (discord) => discord.getOutbound(outbound.id))))?.state,
        "queued",
      )
    })
  })
})

test("削除済みcustom emojiのname=nullは受信障害にしない", async () => {
  const dc = await fakeDiscord([
    {
      id: "90",
      content: "old",
      author: { id: "bot" },
      reactions: [{ emoji: { name: null }, count: 1, me: false }],
    },
  ])
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const result = await h.run(Effect.result(peek))
      assert.equal(result._tag, "Success")
    })
  })
})

test("別workerが送信中のactionをreceiptなしでsentにしない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const outbound = await h.run(
        Effect.flatMap(Discord, (d) =>
          d.enqueue({ purpose: "reply", dedupeKey: "concurrent-sending", text: "本文" }),
        ),
      )
      assert.ok(outbound)
      await h.run(
        Effect.flatMap(Db, (db) =>
          db.withImmediateTransaction("simulate concurrent sender", (tx) => {
            tx.run(
              "UPDATE discord_outbound SET state='sending',updated_at='2099-01-01T00:00:00Z' WHERE id=?",
              outbound.id,
            )
            tx.run(
              "UPDATE discord_outbound_actions SET state='sending',updated_at='2099-01-01T00:00:00Z' WHERE outbound_id=?",
              outbound.id,
            )
          }),
        ),
      )
      await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      const stillSending = await h.run(Effect.flatMap(Discord, (d) => d.getOutbound(outbound.id)))
      assert.equal(stillSending?.state, "sending")
      assert.equal(stillSending?.actions[0]?.state, "sending")
      assert.equal(dc.hits.length, 0)
    })
  })
})

test("添付HTTPの上限内にある送信中actionを中断扱いにしない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const outbound = await h.run(
        Effect.flatMap(Discord, (discord) =>
          discord.enqueue({ purpose: "reply", dedupeKey: "active-upload", text: "本文" }),
        ),
      )
      assert.ok(outbound)
      const activeAt = new Date(Date.now() - 75_000).toISOString()
      await h.run(
        Effect.flatMap(Db, (db) =>
          db.withImmediateTransaction("simulate active upload", (tx) => {
            tx.run(
              "UPDATE discord_outbound SET state='sending',updated_at=? WHERE id=?",
              activeAt,
              outbound.id,
            )
            tx.run(
              "UPDATE discord_outbound_actions SET state='sending',updated_at=? WHERE outbound_id=?",
              activeAt,
              outbound.id,
            )
          }),
        ),
      )

      await h.run(Effect.flatMap(Discord, (discord) => discord.flushQueued()))
      const active = await h.run(Effect.flatMap(Discord, (discord) => discord.getOutbound(outbound.id)))
      assert.equal(active?.state, "sending")
      assert.equal(active?.actions[0]?.state, "sending")
      assert.equal(await h.run(Effect.flatMap(Discord, (discord) => discord.needsFlush())), true)
    })
  })
})

test("receipt永続化後に停止したoutboundは残りのactionから再開する", async () => {
  const dc = await fakeDiscord()
  dc.at(TALK).unshift({ id: "4242", content: "本文", author: { id: "bot" } })
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const outbound = await h.run(
        Effect.flatMap(Discord, (d) =>
          d.enqueue({
            purpose: "reply",
            dedupeKey: "resume-after-receipt",
            text: "本文",
            taps: [{ emoji: "✅", reply: "了解" }],
          }),
        ),
      )
      assert.ok(outbound)
      await h.run(
        Effect.flatMap(Db, (db) =>
          db.withImmediateTransaction("simulate restart after receipt", (tx) => {
            tx.run(
              "UPDATE discord_outbound SET state='sending',updated_at='2000-01-01T00:00:00Z' WHERE id=?",
              outbound.id,
            )
            tx.run(
              `UPDATE discord_outbound_actions
                  SET state='succeeded',receipt=?,updated_at='2000-01-01T00:00:00Z'
                WHERE outbound_id=? AND ordinal=0`,
              JSON.stringify({ channelId: TALK, messageId: "4242" }),
              outbound.id,
            )
          }),
        ),
      )

      const [done] = await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(done?.state, "sent")
      assert.deepEqual(
        done?.actions.map((action) => action.state),
        ["succeeded", "succeeded"],
      )
      assert.equal(dc.hits.length, 1)
      assert.equal(
        decodeURIComponent(dc.hits[0]?.path ?? ""),
        `/channels/${TALK}/messages/4242/reactions/✅/@me`,
      )
      const pending = JSON.parse(
        (await h.run(Effect.flatMap(Db, (db) => db.meta("discord:taps")))) ?? "{}",
      ) as Record<string, unknown>
      assert.deepEqual(pending["4242"], {
        "✅": { reply: "了解", outboundId: outbound.id, channelId: TALK },
      })
    })
  })
})

test("旧版が安全な中間状態をunknownにしたoutboundもaction状態から再開する", async () => {
  const dc = await fakeDiscord()
  dc.at(TALK).unshift({ id: "4343", content: "本文", author: { id: "bot" } })
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const outbound = await h.run(
        Effect.flatMap(Discord, (d) =>
          d.enqueue({
            purpose: "reply",
            dedupeKey: "recover-legacy-unknown",
            text: "本文",
            taps: [{ emoji: "✅", reply: "了解" }],
          }),
        ),
      )
      assert.ok(outbound)
      await h.run(
        Effect.flatMap(Db, (db) =>
          db.withImmediateTransaction("simulate legacy broad unknown", (tx) => {
            tx.run(
              `UPDATE discord_outbound
                  SET state='unknown',error='interrupted during HTTP',updated_at='2000-01-01T00:00:00Z'
                WHERE id=?`,
              outbound.id,
            )
            tx.run(
              `UPDATE discord_outbound_actions
                  SET state='succeeded',receipt=?,updated_at='2000-01-01T00:00:00Z'
                WHERE outbound_id=? AND ordinal=0`,
              JSON.stringify({ channelId: TALK, messageId: "4343" }),
              outbound.id,
            )
          }),
        ),
      )

      const [done] = await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      assert.equal(done?.state, "sent")
      assert.deepEqual(
        done?.actions.map((action) => action.state),
        ["succeeded", "succeeded"],
      )
      assert.equal(
        decodeURIComponent(dc.hits[0]?.path ?? ""),
        `/channels/${TALK}/messages/4343/reactions/✅/@me`,
      )
    })
  })
})

test("旧版で全receipt後に停止したoutboundはtap metadataを補修してsentになる", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const outbound = await h.run(
        Effect.flatMap(Discord, (d) =>
          d.enqueue({
            purpose: "reply",
            dedupeKey: "recover-completed-tap",
            text: "本文",
            taps: [{ emoji: "✅", reply: "了解" }],
          }),
        ),
      )
      assert.ok(outbound)
      await h.run(
        Effect.flatMap(Db, (db) =>
          db.withImmediateTransaction("simulate legacy completed actions", (tx) => {
            tx.run(
              "UPDATE discord_outbound SET state='sending',updated_at='2000-01-01T00:00:00Z' WHERE id=?",
              outbound.id,
            )
            tx.run(
              `UPDATE discord_outbound_actions
                  SET state='succeeded',receipt=?,updated_at='2000-01-01T00:00:00Z'
                WHERE outbound_id=? AND ordinal=0`,
              JSON.stringify({ channelId: TALK, messageId: "5252" }),
              outbound.id,
            )
            tx.run(
              `UPDATE discord_outbound_actions
                  SET state='succeeded',receipt=?,updated_at='2000-01-01T00:00:00Z'
                WHERE outbound_id=? AND ordinal=1`,
              JSON.stringify({ status: 204 }),
              outbound.id,
            )
          }),
        ),
      )

      assert.deepEqual(await h.run(Effect.flatMap(Discord, (d) => d.flushQueued())), [])
      const done = await h.run(Effect.flatMap(Discord, (d) => d.getOutbound(outbound.id)))
      assert.equal(done?.state, "sent")
      const pending = JSON.parse(
        (await h.run(Effect.flatMap(Db, (db) => db.meta("discord:taps")))) ?? "{}",
      ) as Record<string, unknown>
      assert.deepEqual(pending["5252"], {
        "✅": { reply: "了解", outboundId: outbound.id, channelId: TALK },
      })
      assert.equal(dc.hits.length, 0)
    })
  })
})

test("一部のtap配送に失敗したoutboundでは成功済みtapも入力にしない", async () => {
  let reactions = 0
  const dc = await fakeDiscord([], (hit) => {
    if (hit.method === "PUT" && ++reactions === 2) return { status: 429 }
    return undefined
  })
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const retained = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [
          String(9_000_000_000_000_000_000n + BigInt(index)),
          { "✅": { reply: `既存${index}` } },
        ]),
      )
      await h.run(Effect.flatMap(Db, (db) => db.setMeta("discord:taps", JSON.stringify(retained))))
      const messageId = await h.run(
        post({
          text: "選んで",
          taps: [
            { emoji: "✅", reply: "了解" },
            { emoji: "🛑", reply: "停止" },
          ],
        }),
      )
      assert.ok(messageId)
      const outbound = await h.run(
        Effect.flatMap(Db, (db) =>
          db.get(
            "SELECT state FROM discord_outbound WHERE purpose='discord-test' ORDER BY created_at DESC LIMIT 1",
          ),
        ),
      )
      assert.equal(outbound?.state, "partial")
      const pending = JSON.parse(
        (await h.run(Effect.flatMap(Db, (db) => db.meta("discord:taps")))) ?? "{}",
      ) as Record<string, unknown>
      assert.deepEqual(pending, retained, "失敗したoutboundが既存の有効tapを追い出さない")
      const reaction = dc.at(TALK).find((message) => message.id === messageId)?.reactions?.[0]
      assert.ok(reaction)
      reaction.count = 2
      await h.run(
        Effect.flatMap(Db, (db) =>
          db.setMeta("discord:taps", JSON.stringify({ ...retained, [messageId]: { "✅": "了解" } })),
        ),
      )
      assert.deepEqual(await h.run(pollInbound), [])
    })
  })
})

test("別outboundの完了時も送信中tapは有効tap20件の枠を奪わない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const retained = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [
          String(8_000_000_000_000_000_000n + BigInt(index)),
          { "✅": { reply: `既存${index}` } },
        ]),
      )
      const interrupted = await h.run(
        Effect.gen(function* () {
          const discord = yield* Discord
          const db = yield* Db
          const outbound = yield* discord.enqueue({
            purpose: "reply",
            dedupeKey: "deferred-tap-capacity",
            text: "送信中",
          })
          assert.ok(outbound)
          yield* db.withImmediateTransaction("simulate worker between actions", (tx) => {
            tx.run(
              "UPDATE discord_outbound SET state='sending',updated_at='2099-01-01T00:00:00Z' WHERE id=?",
              outbound.id,
            )
            tx.run(
              "INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:taps',?)",
              JSON.stringify({
                "7777777777777777777": {
                  "✅": {
                    reply: "送信中",
                    outboundId: outbound.id,
                    channelId: TALK,
                  },
                },
                ...retained,
              }),
            )
          })
          return outbound
        }),
      )

      await h.run(post({ text: "別outbound" }))
      const during = JSON.parse(
        (await h.run(Effect.flatMap(Db, (db) => db.meta("discord:taps")))) ?? "{}",
      ) as Record<string, unknown>
      assert.equal(Object.keys(during).length, 21)
      for (const id of Object.keys(retained)) assert.deepEqual(during[id], retained[id])

      await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          yield* db.withImmediateTransaction("complete old deferred outbound", (tx) => {
            tx.run("UPDATE discord_outbound SET updated_at='2000-01-01T00:00:00Z' WHERE id=?", interrupted.id)
            tx.run(
              `UPDATE discord_outbound_actions
                  SET state='succeeded',receipt=?,updated_at='2000-01-01T00:00:00Z'
                WHERE outbound_id=?`,
              JSON.stringify({ channelId: TALK, messageId: "7777777777777777777" }),
              interrupted.id,
            )
          })
          const discord = yield* Discord
          yield* discord.flushQueued()
        }),
      )
      const after = JSON.parse(
        (await h.run(Effect.flatMap(Db, (db) => db.meta("discord:taps")))) ?? "{}",
      ) as Record<string, unknown>
      assert.deepEqual(after, retained)
    })
  })
})

test("HTTP中に停止した古いactionはunknownで閉じて再送しない", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: TALK }, async () => {
    await withHarness(async (h) => {
      const outbound = await h.run(
        Effect.flatMap(Discord, (d) =>
          d.enqueue({ purpose: "reply", dedupeKey: "interrupted-http", text: "本文" }),
        ),
      )
      assert.ok(outbound)
      const fresh = await h.run(
        Effect.flatMap(Discord, (d) =>
          d.enqueue({ purpose: "reply", dedupeKey: "fresh-http", text: "別件" }),
        ),
      )
      assert.ok(fresh)
      await h.run(
        Effect.flatMap(Db, (db) =>
          db.withImmediateTransaction("simulate interrupted HTTP", (tx) => {
            tx.run(
              "UPDATE discord_outbound SET state='sending',updated_at='2000-01-01T00:00:00Z' WHERE id=?",
              outbound.id,
            )
            tx.run(
              "UPDATE discord_outbound_actions SET state='sending',updated_at='2000-01-01T00:00:00Z' WHERE outbound_id=?",
              outbound.id,
            )
          }),
        ),
      )

      const freshFlushed = await h.run(Effect.flatMap(Discord, (d) => d.flushOutbound(fresh.id)))
      assert.deepEqual(
        freshFlushed.map((item) => [item.id, item.state]),
        [[fresh.id, "sent"]],
      )
      assert.equal(
        (await h.run(Effect.flatMap(Discord, (d) => d.getOutbound(outbound.id))))?.state,
        "sending",
      )

      const flushed = await h.run(Effect.flatMap(Discord, (d) => d.flushQueued()))
      const done = await h.run(Effect.flatMap(Discord, (d) => d.getOutbound(outbound.id)))
      assert.deepEqual(
        flushed.map((item) => [item.id, item.state]),
        [[outbound.id, "unknown"]],
      )
      assert.equal(done?.state, "unknown")
      assert.equal(done?.actions[0]?.state, "unknown")
      assert.equal(dc.hits.length, 1)
    })
  })
})

test("ack は本文を1通も出さず、受信メッセージに直接リアクションを付ける", async () => {
  const dc = await fakeDiscord()
  await wired(dc, { talk: CH }, async () => {
    await withHarness(async (h) => {
      // post ヘルパは本文の message id を返すので、本文の無い ack では undefined になる。
      // ここで見るのは実際に飛んだ HTTP のほう。
      await h.run(post({ text: "", ack: { channelId: "999", messageId: "12345", emoji: "👀" } }))
      const puts = dc.hits.filter((x) => x.method === "PUT")
      assert.equal(puts.length, 1)
      assert.ok(puts[0]?.path.includes("/channels/999/messages/12345/reactions/"))
      assert.ok(puts[0]?.path.includes(encodeURIComponent("👀")))
      // 本文は1通も出ない
      assert.equal(dc.hits.filter((x) => x.method === "POST" && x.path.endsWith("/messages")).length, 0)
    })
  })
})

test("画像つき・画像だけのメッセージも受け、実体は media に置いて参照を event に残す", async () => {
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const savedData = process.env.FAMULUS_DATA
  const dir = mkdtempSync(join(tmpdir(), "discord-media-"))
  const dc = await fakeDiscord([{ id: "50", content: "古い一言", author: { id: OWNER } }])
  try {
    process.env.FAMULUS_DATA = dir
    await wired(dc, undefined, async () => {
      await withHarness(async (h) => {
        // 初回で cursor を確定してから、新しいメッセージを積む
        assert.equal(await h.run(drainInbox), 0)
        dc.msgs.unshift({
          id: "60",
          content: "予約票これ",
          author: { id: OWNER },
          attachments: [
            { url: `${dc.url}/cdn/yoyaku.png`, filename: "yoyaku.png", content_type: "image/png", size: 11 },
            // 画像以外の添付は受けない
            { url: `${dc.url}/cdn/doc.pdf`, filename: "doc.pdf", content_type: "application/pdf", size: 11 },
          ],
        })
        dc.msgs.unshift({
          id: "61",
          content: "",
          author: { id: OWNER },
          attachments: [{ url: `${dc.url}/cdn/photo.png`, content_type: "image/png", size: 11 }],
        })
        assert.equal(await h.run(drainInbox), 2)

        const rows = await h.run(
          Effect.flatMap(Db, (db) =>
            db.all(
              "SELECT origin_id, json_extract(content,'$.said') said, json_extract(content,'$.images') imgs FROM events WHERE origin_id IN ('60','61') ORDER BY origin_id",
            ),
          ),
        )
        assert.equal(rows.length, 2)
        const imgs60 = JSON.parse(String(rows[0]?.imgs)) as {
          sha: string
          mediaType: string
          name?: string
        }[]
        assert.equal(imgs60.length, 1) // pdf は落ちる
        assert.equal(imgs60[0]?.name, "yoyaku.png")
        assert.ok(existsSync(join(dir, "media", `${imgs60[0]?.sha}.png`)))
        // 画像だけのメッセージ(本文なし)も1件として入る
        const imgs61 = JSON.parse(String(rows[1]?.imgs)) as { sha: string }[]
        assert.equal(imgs61.length, 1)
        assert.equal(rows[1]?.said, "")
      })
    })
  } finally {
    if (savedData === undefined) delete process.env.FAMULUS_DATA
    else process.env.FAMULUS_DATA = savedData
    rmSync(dir, { recursive: true, force: true })
  }
})

test("添付つきの投稿は multipart で送り、参照切れの添付は落として本文だけ出す", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const savedData = process.env.FAMULUS_DATA
  const dir = mkdtempSync(join(tmpdir(), "discord-files-"))
  const dc = await fakeDiscord()
  try {
    process.env.FAMULUS_DATA = dir
    await wired(dc, { talk: TALK }, async () => {
      await withHarness(async (h) => {
        const { saveMedia } = await import("../../src/core/media.ts")
        const ref = { ...saveMedia(new Uint8Array([137, 80, 78, 71, 9, 9]), "image/png"), name: "fig.png" }
        const sent = await h.run(
          Effect.gen(function* () {
            const discord = yield* Discord
            const o = yield* discord.enqueue({
              purpose: "figure",
              dedupeKey: ref.sha,
              text: "計器のグラフ",
              files: [ref],
            })
            assert.ok(o)
            yield* discord.flushQueued()
            return yield* discord.getOutbound(o.id)
          }),
        )
        assert.equal(sent?.state, "sent")
        assert.deepEqual(
          sent?.actions.map((a) => a.state),
          ["succeeded"],
        )

        // 参照切れ(実体の無い sha)は添付を落として本文だけ届く — 投稿ごと失敗させない
        const broken = await h.run(
          Effect.gen(function* () {
            const discord = yield* Discord
            const o = yield* discord.enqueue({
              purpose: "figure",
              dedupeKey: "broken",
              text: "実体が無い",
              files: [{ sha: "0".repeat(64), mediaType: "image/png", name: "gone.png" }],
            })
            assert.ok(o)
            yield* discord.flushQueued()
            return yield* discord.getOutbound(o.id)
          }),
        )
        assert.equal(broken?.state, "sent")
      })
    })
  } finally {
    if (savedData === undefined) delete process.env.FAMULUS_DATA
    else process.env.FAMULUS_DATA = savedData
    rmSync(dir, { recursive: true, force: true })
  }
})

const PROPOSAL = {
  summary: "8/24 10:00 病院をカレンダーに入れる",
  assessment: "本人が入れろと言っている",
  ask: "入れてよいか",
  what: "primary へ1件入れる",
  when: "承認の次の回",
  who: "famulus" as const,
  how: "calendar_add に渡す",
  howVerified: "calendar で読み直す",
}

/** 出した1通の messageId。押されたことにするために要る。 */
const postedMessageId = (id: string, data: ProposalCard = PROPOSAL) =>
  Effect.gen(function* () {
    const discord = yield* Discord
    const outbound = yield* discord.enqueue(proposalCard(id, data))
    assert.ok(outbound)
    yield* discord.flushQueued()
    const done = yield* discord.getOutbound(outbound.id)
    const receipt = done?.actions.find((a) => a.kind === "message")?.receipt as
      | { messageId?: unknown }
      | undefined
    return String(receipt?.messageId)
  })

const press = (dc: Awaited<ReturnType<typeof fakeDiscord>>, messageId: string, emoji: string): void => {
  const hit = dc.msgs.find((m) => m.id === messageId)?.reactions?.find((r) => r.emoji.name === emoji)
  assert.ok(hit, `付いていない絵文字を押そうとした: ${emoji}`)
  hit.count = 2
}

test("提案のリアクションは承認と却下をそのまま提案へ適用する", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      const { okId, ngId, okMsg, ngMsg } = await h.run(
        Effect.gen(function* () {
          const proposals = yield* Proposals
          const other = { ...PROPOSAL, summary: "別の件" }
          const okId = yield* proposals.create(PROPOSAL)
          const ngId = yield* proposals.create(other)
          return {
            okId,
            ngId,
            okMsg: yield* postedMessageId(okId),
            ngMsg: yield* postedMessageId(ngId, other),
          }
        }),
      )
      // 判断に要るものがチャンネル側の1通に載り、根拠と5要素はスレッドへ落ちる。
      const posted = dc.msgs.find((m) => m.id === okMsg)?.content ?? ""
      assert.match(posted, /^\*\*8\/24 10:00 病院をカレンダーに入れる\*\*$/m)
      assert.match(posted, /^入れてよいか$/m)
      assert.match(posted, /^✅ 承認 \/ 🛑 却下\(理由はスレッドへ\)$/m)
      const note = dc.hits.find(
        (hit) => hit.method === "POST" && String(hit.body?.content ?? "").includes("何を: "),
      )
      assert.match(String(note?.body?.content), /いつ: 承認の次の回/)
      assert.match(String(note?.body?.content), /確認: calendar で読み直す/)

      press(dc, okMsg, "✅")
      press(dc, ngMsg, "🛑")
      assert.equal(await h.run(drainInbox), 2)

      const [ok, ng] = await h.run(
        Effect.flatMap(Proposals, (proposals) => Effect.all([proposals.get(okId), proposals.get(ngId)])),
      )
      assert.equal(ok?.status, "approved")
      assert.equal(ng?.status, "denied")
      // deny は理由が必須。絵文字1つには乗らないので、押した事実そのものを理由に置く。
      assert.equal(ng?.deny_reason, REACTION_DENY_REASON)
      const actions = await h.run(
        Effect.flatMap(Db, (db) =>
          db.all("SELECT proposal_id, action, actor_ref FROM proposal_actions ORDER BY action"),
        ),
      )
      assert.deepEqual(
        actions.map((a) => [a.proposal_id, a.action, a.actor_ref]),
        [
          [okId, "approve", "owner-discord"],
          [ngId, "deny", null],
        ],
      )
    })
  })
})

test("決定済みの提案を押しても受信は止まらない — 適用できなかったことだけ残る", async () => {
  const dc = await fakeDiscord()
  await wired(dc, undefined, async () => {
    await withHarness(async (h) => {
      const { id, messageId } = await h.run(
        Effect.gen(function* () {
          const proposals = yield* Proposals
          const id = yield* proposals.create(PROPOSAL)
          const messageId = yield* postedMessageId(id)
          yield* proposals.deny(id, "先に CLI で却下した")
          return { id, messageId }
        }),
      )
      press(dc, messageId, "✅")
      // 押した文(owner 発言)は入る。落ちると、同じ回に読んだ他の発言まで消える。
      assert.equal(await h.run(drainInbox), 1)

      const after = await h.run(Effect.flatMap(Proposals, (proposals) => proposals.get(id)))
      assert.equal(after?.status, "denied")
      assert.equal(after?.deny_reason, "先に CLI で却下した")
      const noted = await h.run(
        Effect.flatMap(Db, (db) =>
          db.all(
            "SELECT search_text FROM events WHERE source='system' AND search_text LIKE '%適用できなかった%'",
          ),
        ),
      )
      assert.equal(noted.length, 1)
      assert.match(String(noted[0]?.search_text), /承認は適用できなかった/)
    })
  })
})
