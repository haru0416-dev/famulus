/**
 * 下書きの一生の検査。materialize(1日1枚)→ 差し戻し → 配送の付け合わせ → 承認の順で、
 * 状態遷移が schema の CHECK・トリガと矛盾なく進むことを見る。
 *
 * outbound 行はここでは直接 INSERT する。drafts_sync_delivery トリガは discord_outbound の
 * UPDATE でしか発火しないので、こうすると attachOutbound / applyDecision 自身の判定だけを
 * 切り出して検査できる(トリガ経由の同期は discord.test.ts が見る)。
 */

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { Db } from "../../src/services/Db.ts"
import { Drafts } from "../../src/services/Drafts.ts"
import { Research } from "../../src/services/Research.ts"
import { withHarness } from "../helpers.ts"

const AT = "2026-08-08T09:00:00Z"
const AT_SENT = "2026-08-08T09:05:00Z"

const terminalDossier = (question: string) =>
  Effect.flatMap(Research, (research) =>
    research.recordWebDossier({ question, limitations: "test fixture", snapshots: [], claims: [] }),
  )

const insertOutbound = (draftId: string, state: "sent" | "queued", withReceipt: boolean) =>
  Effect.gen(function* () {
    const db = yield* Db
    const id = randomUUID()
    yield* db.run(
      `INSERT INTO discord_outbound (id,purpose,dedupe_key,spec,spec_hash,state,error,created_at,updated_at)
       VALUES (?,?,?,?,?,?,NULL,?,?)`,
      id,
      "assistant-draft",
      draftId,
      "{}",
      "spec",
      state,
      AT_SENT,
      AT_SENT,
    )
    if (withReceipt) {
      yield* db.run(
        `INSERT INTO discord_outbound_actions (outbound_id,ordinal,kind,spec,spec_hash,state,receipt,error,updated_at)
         VALUES (?,0,'message',?,?,'succeeded',?,NULL,?)`,
        id,
        "{}",
        "spec",
        JSON.stringify({ messageId: "m1", channelId: "c1" }),
        AT_SENT,
      )
    }
    return id
  })

const materialized = (question: string, title = "題", body = "本文") =>
  Effect.gen(function* () {
    const drafts = yield* Drafts
    const dossier = yield* terminalDossier(question)
    return yield* drafts.materialize({ title, body, dossierId: dossier.id }, AT)
  })

test("materialize は1日1枚 — 既存が review_pending なら内容が違っても同じ行を返す", async () => {
  await withHarness(async (h) => {
    const { first, second } = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const first = yield* materialized("draft-a")
        const dossier = yield* terminalDossier("draft-b")
        const second = yield* drafts.materialize({ title: "別題", body: "別文", dossierId: dossier.id }, AT)
        return { first, second }
      }),
    )
    assert.equal(first.state, "review_pending")
    assert.equal(second.id, first.id)
    assert.equal(second.title, "題")
  })
})

test("materialize は終端 dossier を要求する — open や実在しない id は拒否", async () => {
  await withHarness(async (h) => {
    const openError = await h.fail(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const db = yield* Db
        yield* db.run(
          "INSERT INTO research_dossiers (id,question,state,created_at) VALUES ('open-1','q','open',?)",
          AT,
        )
        return yield* drafts.materialize({ title: "題", body: "本文", dossierId: "open-1" }, AT)
      }),
    )
    assert.match(String(openError), /Terminal research dossier not found/)

    const missingError = await h.fail(
      Effect.flatMap(Drafts, (drafts) =>
        drafts.materialize({ title: "題", body: "本文", dossierId: "nope" }, AT),
      ),
    )
    assert.match(String(missingError), /Terminal research dossier not found/)
  })
})

test("差し戻し後の materialize は同じ行を書き換える — 同一内容なら書き換えない", async () => {
  await withHarness(async (h) => {
    const { revised, unchanged, rewritten } = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const first = yield* materialized("draft-rev")
        yield* drafts.requestRevision(first.id, "題が硬い", AT)
        // 同一内容: revision_needed のまま返る(review_pending に戻さない)
        const unchanged = yield* drafts.materialize(
          { title: "題", body: "本文", dossierId: first.dossier_id },
          AT,
        )
        const rewritten = yield* drafts.materialize(
          { title: "柔題", body: "本文", dossierId: first.dossier_id },
          AT,
        )
        const revised = yield* drafts.forDay(AT)
        return { revised, unchanged, rewritten }
      }),
    )
    assert.equal(unchanged.state, "revision_needed")
    assert.equal(rewritten.state, "review_pending")
    assert.equal(rewritten.title, "柔題")
    assert.equal(rewritten.review_feedback, null)
    assert.equal(revised?.id, rewritten.id)
  })
})

test("failDelivery は一度だけ — 失敗は health メタに残り、二度目は拒否", async () => {
  await withHarness(async (h) => {
    const { failed, health } = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const db = yield* Db
        const draft = yield* materialized("draft-fail")
        const failed = yield* drafts.failDelivery(draft.id, "HTTP 503", AT_SENT)
        return { failed, health: yield* db.meta("health:draft:last_failure") }
      }),
    )
    assert.equal(failed.state, "delivery_failed")
    assert.equal(failed.review_feedback, "HTTP 503")
    assert.match(String(health), /HTTP 503/)

    const again = await h.fail(
      Effect.flatMap(Drafts, (drafts) => drafts.failDelivery(failed.id, "再送", AT_SENT)),
    )
    assert.match(String(again), /no longer awaiting delivery/)
  })
})

test("attachOutbound は所属を検証する — 実在しない・他人の outbound は拒否", async () => {
  await withHarness(async (h) => {
    const missing = await h.fail(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const draft = yield* materialized("draft-attach-miss")
        return yield* drafts.attachOutbound(draft.id, "no-such-outbound", AT_SENT)
      }),
    )
    assert.match(String(missing), /Discord outbound not found/)

    const foreign = await h.fail(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const draft = yield* materialized("draft-attach-foreign")
        const otherId = yield* insertOutbound("someone-else", "sent", true)
        return yield* drafts.attachOutbound(draft.id, otherId, AT_SENT)
      }),
    )
    assert.match(String(foreign), /does not belong to draft/)
  })
})

test("attachOutbound: sent+receipt は delivered、receipt 無しの sent は delivery_failed、queued は delivery_pending", async () => {
  await withHarness(async (h) => {
    const delivered = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const draft = yield* materialized("draft-delivered")
        const outboundId = yield* insertOutbound(draft.id, "sent", true)
        return yield* drafts.attachOutbound(draft.id, outboundId, AT_SENT)
      }),
    )
    assert.equal(delivered.state, "delivered")
    assert.equal(delivered.delivered_at, AT_SENT)
  })

  await withHarness(async (h) => {
    const noReceipt = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const draft = yield* materialized("draft-no-receipt")
        const outboundId = yield* insertOutbound(draft.id, "sent", false)
        return yield* drafts.attachOutbound(draft.id, outboundId, AT_SENT)
      }),
    )
    assert.equal(noReceipt.state, "delivery_failed")
    assert.match(String(noReceipt.review_feedback), /receipt is missing/)
  })

  await withHarness(async (h) => {
    const pending = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const draft = yield* materialized("draft-queued")
        const outboundId = yield* insertOutbound(draft.id, "queued", false)
        const attached = yield* drafts.attachOutbound(draft.id, outboundId, AT_SENT)
        return { attached, pending: yield* drafts.pending() }
      }),
    )
    assert.equal(pending.attached.state, "delivery_pending")
    assert.equal(pending.attached.delivered_at, null)
    // delivery_pending は配送待ちとして pending() に残る
    assert.equal(pending.pending?.id, pending.attached.id)
  })
})

test("applyDecision は配送実績を要求する — receipt があれば delivered を遡って埋めてから決める", async () => {
  await withHarness(async (h) => {
    // 配送実績なし: 決定できない
    const { refused, draft } = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        const draft = yield* materialized("draft-decide")
        const refused = yield* drafts.applyDecision(draft.id, "accept", "origin-0", AT_SENT)
        return { refused, draft }
      }),
    )
    assert.equal(refused, false)

    // sent+receipt の outbound を置くと、attachOutbound を経ていなくても決定が通る
    const { decided, row, again, unknown } = await h.run(
      Effect.gen(function* () {
        const drafts = yield* Drafts
        yield* insertOutbound(draft.id, "sent", true)
        const decided = yield* drafts.applyDecision(draft.id, "accept", "origin-1", AT_SENT)
        const again = yield* drafts.applyDecision(draft.id, "discard", "origin-2", AT_SENT)
        const unknown = yield* drafts.applyDecision("no-such-draft", "accept", "origin-3", AT_SENT)
        return { decided, row: yield* drafts.forDay(AT), again, unknown }
      }),
    )
    assert.equal(decided, true)
    assert.equal(row?.state, "accepted")
    assert.equal(row?.delivered_at, AT_SENT)
    assert.equal(row?.decision_origin_id, "origin-1")
    // 決定は一度だけ。未知の id も false
    assert.equal(again, false)
    assert.equal(unknown, false)
  })
})
