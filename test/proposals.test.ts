/**
 * 承認の検査。「承認したのに承認記録が無い」状態を作れないことが主眼。
 * 実行の仕組みはまだ無いので、ここで守るのは「実行の前提条件が揃っているか」だけ。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { Db } from "../src/services/Db.ts"
import { type CreateInput, Proposals, payloadHash } from "../src/services/Proposals.ts"
import { withHarness } from "./helpers.ts"

const draft = (over: Partial<CreateInput> = {}): CreateInput => ({
  summary: "歯医者に予約変更のメールを送る",
  assessment: "水曜18時は会議と重なる",
  ask: "送っていいか",
  what: "予約を木曜に変える依頼メールを送る",
  when: "今日中",
  who: "famulus",
  how: "Gmail 経由で本文を送信",
  howVerified: "送信済みトレイに1通あること",
  ...over,
})

test("提案は proposed で始まり、実行はされない", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const p = yield* Proposals
        const id = yield* p.create(draft())
        const row = yield* p.get(id)
        const list = yield* p.list("proposed")
        return { row, n: list.length }
      }),
    )
    assert.equal(out.row.status, "proposed")
    assert.equal(out.n, 1)
    assert.equal(out.row.c_who, "famulus")
  })
})

test("approve は approvals 行と status 遷移を必ず一緒に残す", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const p = yield* Proposals
        const db = yield* Db
        const id = yield* p.create(draft())
        const r = yield* p.approve(id)
        const row = yield* p.get(id)
        const ap = yield* p.approvalOf(id)
        const dec = yield* db.get("SELECT verb FROM decisions WHERE proposal_id = ?", id)
        return { r, row, ap, verb: dec?.verb }
      }),
    )
    assert.equal(out.row.status, "approved")
    assert.equal(out.ap?.approver, "owner")
    assert.equal(out.ap?.verb, "approve")
    // 承認時に見ていた payload の指紋が残る = 後から中身が変わったら実行ゲートで弾ける。
    assert.equal(out.ap?.payload_hash, payloadHash(out.row.payload))
    assert.equal(out.r.payloadHash, out.ap?.payload_hash)
    assert.equal(out.verb, "approve")
  })
})

test("二重承認はできない(承認済みは承認の対象ではない)", async () => {
  await withHarness(async (h) => {
    const id = await h.run(
      Effect.gen(function* () {
        const p = yield* Proposals
        const id = yield* p.create(draft())
        yield* p.approve(id)
        return id
      }),
    )
    const e = await h.fail(
      Effect.gen(function* () {
        const p = yield* Proposals
        yield* p.approve(id)
      }),
    )
    assert.equal((e as { _tag: string })._tag, "Conflict")

    const n = await h.run(
      Effect.gen(function* () {
        const db = yield* Db
        const r = yield* db.get("SELECT COUNT(*)n FROM approvals WHERE proposal_id = ?", id)
        return Number(r?.n ?? 0)
      }),
    )
    assert.equal(n, 1)
  })
})

test("deny は理由を残し、以後は承認できない", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const p = yield* Proposals
        const id = yield* p.create(draft())
        yield* p.deny(id, "相手に直接電話するので不要")
        return yield* p.get(id)
      }),
    )
    assert.equal(out.status, "denied")
    assert.equal(out.deny_reason, "相手に直接電話するので不要")

    const e = await h.fail(
      Effect.gen(function* () {
        const p = yield* Proposals
        yield* p.approve(out.id)
      }),
    )
    assert.equal((e as { _tag: string })._tag, "Conflict")
  })
})

test("id は前方一致で引ける。曖昧なら選ばずに失敗する", async () => {
  await withHarness(async (h) => {
    const id = await h.run(
      Effect.gen(function* () {
        const p = yield* Proposals
        return yield* p.create(draft())
      }),
    )
    const row = await h.run(
      Effect.gen(function* () {
        const p = yield* Proposals
        return yield* p.get(id.slice(0, 8))
      }),
    )
    assert.equal(row.id, id)

    // 空文字は全件に当たる。曖昧なまま承認に進ませない。
    await h.run(
      Effect.gen(function* () {
        const p = yield* Proposals
        yield* p.create(draft({ summary: "もう1件" }))
      }),
    )
    const e = await h.fail(
      Effect.gen(function* () {
        const p = yield* Proposals
        yield* p.get("")
      }),
    )
    assert.equal((e as { _tag: string })._tag, "Conflict")
  })
})

test("存在しない id は NotFound", async () => {
  await withHarness(async (h) => {
    const e = await h.fail(
      Effect.gen(function* () {
        const p = yield* Proposals
        yield* p.get("zzzzzzzz")
      }),
    )
    assert.equal((e as { _tag: string })._tag, "NotFound")
  })
})

test("期限切れは list の前に expired へ落ちる(承認待ちが実態とずれない)", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const p = yield* Proposals
        const old = new Date(Date.now() - 8 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z")
        const id = yield* p.create(draft({ at: old }))
        const pending = yield* p.list("proposed")
        const row = yield* p.get(id)
        return { pending: pending.length, status: row.status }
      }),
    )
    assert.equal(out.pending, 0)
    assert.equal(out.status, "expired")
  })
})
