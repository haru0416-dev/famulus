/**
 * 記録の検査。焦点は usd=0 の意味が2つあること。
 *   quota → 限界費用が本当に 0(unpriced=0)
 *   usd で金額が来ていない → 単価不明(unpriced=1)
 * ここを同じ 0 にすると、USD 上限が意味を失うか、定額 run を金額で止め始める。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as Effect from "effect/Effect"
import { Db } from "../src/services/Db.ts"
import { Ledger } from "../src/services/Ledger.ts"
import { withHarness } from "./helpers.ts"

const AT = "2026-08-08T09:00:00Z"

test("定額枠の run は usd=0 / unpriced=0、従量で金額不明は unpriced=1", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const db = yield* Db
        yield* ledger.record({ kind: "run", role: "dialogue", meter: "quota", at: AT })
        yield* ledger.record({ kind: "run", role: "scout", meter: "usd", at: AT })
        yield* ledger.record({
          kind: "run",
          role: "classify",
          meter: "usd",
          usage: { usd: 0.42 },
          at: AT,
        })
        return yield* db.all("SELECT role, usd, unpriced FROM ledger ORDER BY role")
      }),
    )
    assert.deepEqual(
      rows.map((r) => [r.role, r.usd, r.unpriced]),
      [
        ["classify", 0.42, 0],
        ["dialogue", 0, 0], // 限界費用 0(既知)
        ["scout", 0, 1], // 金額不明。黙って 0 円にしない
      ],
    )
  })
})

test("today は role のある行だけを run として数える", async () => {
  await withHarness(async (h) => {
    const t = await h.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.record({ kind: "run", role: "dialogue", meter: "quota", at: AT })
        yield* ledger.record({ kind: "run", role: "dialogue", meter: "quota", at: AT })
        yield* ledger.record({ kind: "note", meter: "quota", at: AT }) // role なし = 推論していない
        yield* ledger.record({ kind: "run", role: "dialogue", meter: "quota", at: "2026-08-07T09:00:00Z" })
        return yield* ledger.today(AT)
      }),
    )
    assert.equal(t.day, "2026-08-08")
    assert.equal(t.runs, 2)
    assert.equal(t.usd, 0)
  })
})

test("入力は3列に分けて持ち、集計では足し合わせる", async () => {
  // 実測: haiku 経路は in_tok=10 / cache_write=7,048。in_tok だけを「入力」として読むと 1/700 になる。
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const db = yield* Db
        yield* ledger.record({
          kind: "run",
          role: "dialogue",
          meter: "quota",
          usage: { inTok: 10, outTok: 131, cacheRead: 0, cacheWrite: 7048 },
          at: AT,
        })
        yield* ledger.record({
          kind: "run",
          role: "dialogue",
          meter: "quota",
          usage: { inTok: 10, outTok: 20, cacheRead: 7048, cacheWrite: 0 },
          at: AT,
        })
        const row = yield* db.get("SELECT in_tok, cache_read, cache_write FROM ledger ORDER BY rowid")
        return { row, today: yield* ledger.today(AT) }
      }),
    )
    // 3つは別々に残す。混ぜて1列にすると、キャッシュが効いているかどうかが後から見えない。
    assert.deepEqual([out.row?.in_tok, out.row?.cache_read, out.row?.cache_write], [10, 0, 7048])
    assert.equal(out.today.inTok, 10 + 7048 + 10 + 7048)
    assert.equal(out.today.outTok, 151)
  })
})

test("provenance は JSON として保存される(スキーマの json_valid を満たす)", async () => {
  await withHarness(async (h) => {
    const row = await h.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const db = yield* Db
        yield* ledger.record({
          kind: "run",
          role: "dialogue",
          meter: "quota",
          provenance: { pool: "claude-max", notionalUsd: 0.031 },
          at: AT,
        })
        return yield* db.get("SELECT provenance FROM ledger")
      }),
    )
    const p = JSON.parse(String(row?.provenance)) as { pool: string; notionalUsd: number }
    // 影の値段は provenance にだけ残す。usd 列には入れない(入れると定額 run が金額で止まる)。
    assert.equal(p.pool, "claude-max")
    assert.equal(p.notionalUsd, 0.031)
  })
})
