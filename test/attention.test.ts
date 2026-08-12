/**
 * 自走の検査。**「起きるべきときに起き、起きるべきでないときに起きない」だけを見る**。
 *
 * 心拍で怖いのは動かないことではなく、止まらないことのほう。
 * 自分の書き込みで自分を起こす / 解消しない理由で永久に焚く、の2つは実装を見ても気づきにくく、
 * 気づくのは「一晩で枠を使い切っていた」ときになる。だからここで固定する。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import {
  ACTIVE_COOLDOWN_HOURS,
  Attention,
  IDLE_WAKE_HOURS,
  MAX_COOLDOWN_HOURS,
} from "../src/services/Attention.ts"
import { Db } from "../src/services/Db.ts"
import { Memory } from "../src/services/Memory.ts"
import { withHarness } from "./helpers.ts"

const T0 = Date.parse("2026-08-08T09:00:00Z")
const hours = (n: number) => n * 3_600_000

// **日次の下書きは別の軸**。時刻だけで立つ理由なので、起床条件の検査からは外しておく
// — 混ざると「入力で起きた」のか「20時を過ぎた」のかが assert から区別できない。
process.env.OPEN_ZERO_DAILY_HOUR = "99"

/** 「もう一度起きた」を作る。時刻を進めた digest を引くだけ。 */
const digestAt = (ms: number) =>
  Effect.gen(function* () {
    const att = yield* Attention
    return yield* att.digest(ms)
  })

test("何も無ければ起きない — 前回の棚卸しから24時間経つと1回だけ起きる", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        // 初回は last_active が無く「起点なし」なので必ず起きる。そこを消費して基準を作る。
        yield* att.commit({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )

    const quiet = await h.run(digestAt(T0 + hours(1)))
    assert.equal(quiet.idle, true, "1時間後は起きない")

    const later = await h.run(digestAt(T0 + hours(IDLE_WAKE_HOURS + 1)))
    assert.equal(later.idle, false, "24時間経てば棚卸しで起きる")
    assert.match(later.reasons.join(), /棚卸し/)
  })
})

test("自分が書いたもの(source=system)では起きない — 外から来た入力だけが起こす", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        const mem = yield* Memory
        yield* att.commit({ active: true, at: "2026-08-08T09:00:00Z" })
        // 心拍が自分の結果を残す。これで起きたら自家中毒。
        yield* mem.remember({ source: "system", content: { tick: "動いた" } })
      }),
    )
    const d = await h.run(digestAt(T0 + hours(2)))
    assert.equal(d.idle, true)
    assert.equal(d.newEvents.length, 0)

    // 持ち主の入力なら、冷却の途中でも起きる。
    await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ source: "owner", content: { said: "来週の予定は？" } })
      }),
    )
    const woken = await h.run(digestAt(T0 + hours(2)))
    assert.equal(woken.idle, false)
    assert.equal(woken.newEvents.length, 1)
    assert.match(woken.reasons.join(), /まだ見ていない入力/)
  })
})

test("commit は心拍自身の書き込みも消費する(同じ入力で二度起きない)", async () => {
  await withHarness(async (h) => {
    const before = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        yield* mem.remember({ source: "owner", content: { said: "歯医者どうなってる？" } })
        return yield* att.digest(T0)
      }),
    )
    assert.equal(before.newEvents.length, 1)

    const after = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        // 心拍が応答を残してから消費位置を確定する。
        yield* mem.remember({ source: "system", content: { said: "見た" } })
        yield* att.commit({ active: true, at: "2026-08-08T09:00:00Z" })
        return yield* att.digest(T0 + hours(0.1))
      }),
    )
    assert.equal(after.newEvents.length, 0, "見た入力でもう一度起きない")
    assert.equal(after.idle, true)
  })
})

test("自分が動く番の見張りは起こす理由になる — ただし冷却中は起きない", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.watch("A社への返信を書く", "famulus", { at: "2026-08-08T09:00:00Z" })
        yield* att.commit({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )

    const early = await h.run(digestAt(T0 + hours(ACTIVE_COOLDOWN_HOURS - 0.1)))
    assert.equal(early.idle, true, "冷却中は同じ見張りで起きない")

    const cooled = await h.run(digestAt(T0 + hours(ACTIVE_COOLDOWN_HOURS + 0.1)))
    assert.equal(cooled.idle, false)
    assert.equal(cooled.stalled.length, 1)
    assert.equal(cooled.reasonKey, "stalled")
  })
})

test("相手が動く番の見張りは、動きが止まって初めて起こす", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.watch("A社からの返信待ち", "counterparty", { at: "2026-08-08T09:00:00Z" })
        yield* att.commit({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )
    const soon = await h.run(digestAt(T0 + hours(4)))
    assert.equal(soon.stalled.length, 0, "相手待ちは滞留するまで理由にしない")
    assert.equal(soon.idle, true)
  })
})

test("未解決の問いは起こす理由にしない(自分では解消できないので永久に焚くことになる)", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.ask("美容院の『来週の月曜』は 8/10 でよいか")
        yield* att.commit({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )
    const d = await h.run(digestAt(T0 + hours(4)))
    assert.equal(d.idle, true, "問いがあるだけでは起きない")
    assert.equal(d.openQuestions.length, 1, "起きたときの材料としては渡す")
  })
})

test("同じ理由で起き続けると冷却が倍に伸びる。新しい入力が来れば元に戻る", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.watch("自分が動く番のまま解消しない件", "famulus", { at: "2026-08-08T09:00:00Z" })
        yield* att.commit({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )

    // 1.5h → 3h → 6h … と伸びる。毎回「冷却が明けたので起きて、動いても解消しなかった」を再現する。
    let at = T0
    const seen: number[] = []
    for (let i = 0; i < 8; i++) {
      const d = await h.run(digestAt(at + hours(MAX_COOLDOWN_HOURS)))
      assert.equal(d.idle, false)
      assert.equal(d.reasonKey, "stalled", "顔ぶれは経過時間で変わらない(変わると上限が上限でなくなる)")
      seen.push(d.cooldownHours)
      at += hours(d.cooldownHours + 0.1)
      await h.run(
        Effect.gen(function* () {
          const att = yield* Attention
          yield* att.commit({ active: true, at: new Date(at).toISOString(), reasonKey: d.reasonKey })
        }),
      )
    }
    // 倍々に伸びて 24 時間で止まる = 最後は1日1回の棚卸しに落ち着く(完全には黙らせない)。
    assert.deepEqual(seen, [1.5, 3, 6, 12, 24, 24, 24, 24])

    const capped = await h.run(digestAt(at + hours(MAX_COOLDOWN_HOURS)))
    assert.equal(capped.cooldownHours, MAX_COOLDOWN_HOURS)
    assert.equal(capped.idle, false, "伸びきっても1日1回は起きる")
    const tooSoon = await h.run(digestAt(at + hours(MAX_COOLDOWN_HOURS - 1)))
    assert.equal(tooSoon.idle, true, "上限に達したら24時間は起きない")

    // 外から入力が来たら後退は解ける。
    const fresh = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        yield* mem.remember({ source: "owner", content: { said: "その件やっといて" } })
        const d = yield* att.digest(at + hours(0.1))
        yield* att.commit({ active: true, at: new Date(at).toISOString(), reasonKey: d.reasonKey })
        return d
      }),
    )
    assert.equal(fresh.idle, false, "冷却中でも新しい入力なら起きる")
    assert.equal(fresh.reasonKey, "", "新しい入力で起きたら後退は数え直し")

    const back = await h.run(digestAt(at + hours(ACTIVE_COOLDOWN_HOURS + 0.1)))
    assert.equal(back.cooldownHours, ACTIVE_COOLDOWN_HOURS, "冷却が最短に戻っている")
  })
})

test("期限が近い裁可待ちは起こす理由になる", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const db = yield* Db
        const att = yield* Attention
        yield* db.run(
          `INSERT INTO proposals (id, kind, created_at, summary, assessment, ask,
             c_what, c_when, c_who, c_how, c_how_verified, payload, provenance, status, expires_at)
           VALUES ('p1','plan','2026-08-08T09:00:00Z','歯医者に変更依頼','根拠','判断',
                   'w','t','famulus','h','v','{}','[]','proposed', ?)`,
          new Date(T0 + hours(24)).toISOString(),
        )
        yield* att.commit({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )
    const d = await h.run(digestAt(T0 + hours(4)))
    assert.equal(d.idle, false)
    assert.equal(d.pending.length, 1)
    assert.match(d.reasons.join(), /期限が近い裁可待ち/)
  })
})

/**
 * 1日1本の下書き。**回数が持ち主の集中の切断回数**なので、日を跨ぐまで二度立たないことを固定する。
 * 冷却の外に出してあるのも意図的で、夕方に別件で動いた日に下書きが落ちないため。
 */
test("下書きは決めた時刻から1日1回だけ立つ", async () => {
  const keep = process.env.OPEN_ZERO_DAILY_HOUR
  // T0 は 18:00(持ち主の時計)。17時を境にすると T0 の時点で既に過ぎている。
  process.env.OPEN_ZERO_DAILY_HOUR = "17"
  try {
    await withHarness(async (h) => {
      await h.run(
        Effect.gen(function* () {
          const att = yield* Attention
          // 直前に動いたことにする。冷却中でも下書きは立つ、が見たいこと。
          yield* att.commit({ active: true, at: new Date(T0).toISOString() })
        }),
      )
      const due = await h.run(digestAt(T0 + hours(0.5)))
      assert.equal(due.draftDue, true, "時刻を過ぎたら冷却中でも立つ")
      assert.match(due.reasons.join(), /下書き/)

      await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          yield* db.setMeta("daily:draft", "2026-08-08")
        }),
      )
      const done = await h.run(digestAt(T0 + hours(1)))
      assert.equal(done.draftDue, false, "その日ぶんが済んでいれば二度は立たない")
      assert.equal(done.idle, true)

      // 日が変わればまた立つ。T0+9h = 翌 03:00 なので、さらに 14 時間進めて 17 時を跨ぐ。
      const nextDay = await h.run(digestAt(T0 + hours(23)))
      assert.equal(nextDay.draftDue, true, "日が変われば立ち直る")
    })
  } finally {
    process.env.OPEN_ZERO_DAILY_HOUR = keep
  }
})

test("決めた時刻より前には立たない — その日の走行記録がまだ無い", async () => {
  const keep = process.env.OPEN_ZERO_DAILY_HOUR
  process.env.OPEN_ZERO_DAILY_HOUR = "23"
  try {
    await withHarness(async (h) => {
      const d = await h.run(digestAt(T0))
      assert.equal(d.draftDue, false)
      assert.equal(d.reasons.join().includes("下書き"), false)
    })
  } finally {
    process.env.OPEN_ZERO_DAILY_HOUR = keep
  }
})
