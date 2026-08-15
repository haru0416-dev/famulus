import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { Db } from "../src/services/Db.ts"
import { Ledger } from "../src/services/Ledger.ts"
import { withHarness } from "./helpers.ts"

const AT = "2026-08-08T09:00:00Z"

test("today は role のある行だけを run として数える", async () => {
  await withHarness(async (h) => {
    const t = await h.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.record({ kind: "run", role: "dialogue", at: AT })
        yield* ledger.record({ kind: "run", role: "dialogue", at: AT })
        yield* ledger.record({ kind: "note", at: AT })
        yield* ledger.record({ kind: "run", role: "dialogue", at: "2026-08-07T09:00:00Z" })
        return yield* ledger.today(AT)
      }),
    )
    assert.equal(t.day, "2026-08-08")
    assert.equal(t.runs, 2)
  })
})

test("入力は3列に分けて持ち、集計では足し合わせる", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const db = yield* Db
        yield* ledger.record({
          kind: "run",
          role: "dialogue",
          usage: { inTok: 10, outTok: 131, cacheRead: 0, cacheWrite: 7048 },
          at: AT,
        })
        yield* ledger.record({
          kind: "run",
          role: "dialogue",
          usage: { inTok: 10, outTok: 20, cacheRead: 7048, cacheWrite: 0 },
          at: AT,
        })
        const row = yield* db.get("SELECT in_tok, cache_read, cache_write FROM ledger ORDER BY rowid")
        return { row, today: yield* ledger.today(AT) }
      }),
    )
    assert.deepEqual([out.row?.in_tok, out.row?.cache_read, out.row?.cache_write], [10, 0, 7048])
    assert.equal(out.today.inTok, 10 + 7048 + 10 + 7048)
    assert.equal(out.today.outTok, 151)
  })
})

test("provenance は JSON として保存される", async () => {
  await withHarness(async (h) => {
    const row = await h.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const db = yield* Db
        yield* ledger.record({
          kind: "run",
          role: "dialogue",
          provenance: { pool: "chatgpt-oauth", notionalUsd: 0.031 },
          at: AT,
        })
        return yield* db.get("SELECT provenance FROM ledger")
      }),
    )
    assert.deepEqual(JSON.parse(String(row?.provenance)), { pool: "chatgpt-oauth", notionalUsd: 0.031 })
  })
})
