/**
 * 自律実行条件の検査。実行条件が必要なときだけ成立することを見る。
 *
 * cycle で怖いのは動かないことではなく、止まらないことのほう。
 * system由来の書き込みによる自己再実行 / 解消しない理由による無限再実行、の2つは実装を見ても気づきにくく、
 * 気づくのは「一晩で枠を使い切っていた」ときになる。だからここで固定する。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import {
  ACTIVE_COOLDOWN_HOURS,
  Attention,
  IDLE_WAKE_HOURS,
  MAX_COOLDOWN_HOURS,
  REFUSED_LIMIT,
  STALLED_SHOW_MAX,
} from "../src/services/Attention.ts"
import { Db } from "../src/services/Db.ts"
import { Drafts } from "../src/services/Drafts.ts"
import { Memory } from "../src/services/Memory.ts"
import { Proposals } from "../src/services/Proposals.ts"
import { withHarness } from "./helpers.ts"

const T0 = Date.parse("2026-08-08T09:00:00Z")
const hours = (n: number) => n * 3_600_000

// 日次の下書きは別の軸。時刻だけで成立する理由なので、通常の実行条件の検査からは外しておく
// — 混ざると「入力が実行条件になった」のか「20時を過ぎた」のかが assert から区別できない。
process.env.OPEN_ZERO_DAILY_HOUR = "99"

const planAt = (ms: number) =>
  Effect.gen(function* () {
    const att = yield* Attention
    return yield* att.planCycle(ms)
  })

test("何も無ければidleになる — 前回の実働から24時間経つと定期確認が実行条件になる", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )

    const quiet = await h.run(planAt(T0 + hours(1)))
    assert.equal(quiet.idle, true, "1時間後は実行条件がない")

    const later = await h.run(planAt(T0 + hours(IDLE_WAKE_HOURS + 1)))
    assert.equal(later.idle, false, "24時間経てば経過時間だけで実行条件になる")
    assert.match(later.reasons.join(), /前回の実働/)
  })
})

test("source=systemは実行条件にしない — 外部入力だけを新着の実行条件にする", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        const mem = yield* Memory
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
        // cycle が自身の結果を残す。これが実行条件になると自己再実行ループになる。
        yield* mem.remember({ source: "system", content: { cycle: "動いた" } })
      }),
    )
    const d = await h.run(planAt(T0 + hours(2)))
    assert.equal(d.idle, true)
    assert.equal(d.newEvents.length, 0)

    await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ source: "owner", content: { said: "来週の予定は？" } })
      }),
    )
    const woken = await h.run(planAt(T0 + hours(2)))
    assert.equal(woken.idle, false)
    assert.equal(woken.newEvents.length, 1)
    assert.match(woken.reasons.join(), /まだ見ていない入力/)
  })
})

test("completeCycle は cycle 自身の書き込みも消費する(同じ入力を二度実行条件にしない)", async () => {
  await withHarness(async (h) => {
    const before = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        yield* mem.remember({ source: "owner", content: { said: "歯医者どうなってる？" } })
        return yield* att.planCycle(T0)
      }),
    )
    assert.equal(before.newEvents.length, 1)

    const after = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        // cycle が応答を残してから消費位置を確定する。
        yield* mem.remember({ source: "system", content: { said: "見た" } })
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
        return yield* att.planCycle(T0 + hours(0.1))
      }),
    )
    assert.equal(after.newEvents.length, 0, "処理済みの入力を再び実行条件にしない")
    assert.equal(after.idle, true)
  })
})

test("自分が動く番の watch は実行条件になる — ただしcooldown中は実行しない", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.watch("A社への返信を書く", "famulus", { at: "2026-08-08T09:00:00Z" })
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )

    const early = await h.run(planAt(T0 + hours(ACTIVE_COOLDOWN_HOURS - 0.1)))
    assert.equal(early.idle, true, "cooldown中は同じ watch を実行条件にしない")

    const cooled = await h.run(planAt(T0 + hours(ACTIVE_COOLDOWN_HOURS + 0.1)))
    assert.equal(cooled.idle, false)
    assert.equal(cooled.stalled.length, 1)
    assert.equal(cooled.reasonKey, "stalled")
  })
})

/**
 * 実行しても静かにならない状態を止める。
 *
 * `next_move_owner = 'famulus'` は無条件で滞留に入るので、`last_activity_at` を更新しても
 * 自分持ちの watch は次の cycle で再び処理対象になる。実際にそうなり、モデルは最終走行時刻を
 * subject の文字列に書き込んで登録し直すという回避をしていた(列が無いのでそうするしかない)。
 * 止めるのは経過日数ではなく、実行した時刻とcooldown。
 */
test("一周回した watch は、cooldownが終了するまでプロンプトに載らない", async () => {
  await withHarness(async (h) => {
    const id = await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        const w = yield* att.watch("AI追跡: HN の新着を全部見る", "famulus", {
          at: "2026-08-08T09:00:00Z",
          cooldownHours: 24,
        })
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
        return w
      }),
    )

    const first = await h.run(planAt(T0 + hours(ACTIVE_COOLDOWN_HOURS + 0.1)))
    assert.equal(first.stalled.length, 1)
    assert.equal(first.stalled[0]?.run_count, 0)

    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.recordWatchRun(id, "8/8 時点で新着に該当なし", "2026-08-08T11:00:00Z")
      }),
    )

    const quiet = await h.run(planAt(T0 + hours(12)))
    assert.equal(quiet.stalled.length, 0, "実行直後は掲載対象にならない")

    const back = await h.run(planAt(T0 + hours(26)))
    assert.equal(back.stalled.length, 1, "cooldownが終了すれば再び掲載対象になる")
    assert.equal(back.stalled[0]?.run_count, 1)
    // 前回の結果を渡さないと、毎回まっさらな状態で同じ一覧を読み直すことになる。
    assert.equal(back.stalled[0]?.last_result, "8/8 時点で新着に該当なし")
  })
})

test("何も出てこなかった回も『回した』— 空振りこそ次の cycle に伝える必要がある", async () => {
  await withHarness(async (h) => {
    const id = await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        const w = yield* att.watch("週次で見る件", "famulus", {
          at: "2026-08-08T09:00:00Z",
          cooldownHours: 168,
        })
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
        return w
      }),
    )
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.recordWatchRun(id, "該当なし", "2026-08-08T09:30:00Z")
      }),
    )

    // 動きがあった(touchWatch)と、自分が実行した(ranWatch)は別のこと。
    // 相手から返事が来ても自分は何もしていないので、cooldownは始まらない。
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.touchWatch(id, "famulus", "2026-08-09T09:00:00Z")
      }),
    )

    const mid = await h.run(planAt(T0 + hours(48)))
    assert.equal(mid.stalled.length, 0, "外部の更新があっても、cooldownは短縮しない")
    const [w] = await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        return yield* att.openWatches(T0 + hours(48))
      }),
    )
    assert.equal(w?.dueNow, false)
    assert.equal(w?.dueInHours, 120.5)

    const after = await h.run(planAt(T0 + hours(169)))
    assert.equal(after.stalled.length, 1, "設定したcooldownが終了すれば掲載対象になる")
  })
})

/**
 * 後から記録する道。これが無いと記録そのものが見送られる。
 *
 * 数時間前に実行したものを「今」で記録すると、cooldownがその分だけ後ろへずれる。実際に、
 * ずれるくらいなら呼ばないという判断が起き(端から端まで走らせた回で観測)、watch はプロンプトに残った。
 */
test("回した時刻を渡して後から記録できる。先の時刻は取らない", async () => {
  await withHarness(async (h) => {
    const id = await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        const w = yield* att.watch("朝に回した watch", "famulus", { at: "2026-08-08T09:00:00Z" })
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
        return w
      }),
    )
    const rec = await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        return yield* att.recordWatchRun(id, "該当なし", "2026-08-08T09:00:00Z")
      }),
    )
    assert.equal(rec.last_run_at, "2026-08-08T09:00:00Z", "記録した時刻ではなく回した時刻")

    const before = await h.run(planAt(T0 + hours(23)))
    assert.equal(before.stalled.length, 0)
    const after = await h.run(planAt(T0 + hours(25)))
    assert.equal(after.stalled.length, 1, "cooldownは実行時刻から数える(記録の分だけ後ろへずれない)")

    // 未来は取らない。取ると、一度の記録で好きなだけcooldownを伸ばせる。
    const far = await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        return yield* att.recordWatchRun(id, "先の時刻を渡してみる", "2099-01-01T00:00:00Z")
      }),
    )
    assert.ok(far.last_run_at !== null && far.last_run_at < "2099-01-01T00:00:00Z")
  })
})

test("存在しないwatchの実行記録に失敗してもtransactionを残さない", async () => {
  await withHarness(async (h) => {
    const failed = await h.fail(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.recordWatchRun("missing-watch", "該当なし")
      }),
    )
    assert.equal((failed as { _tag: string })._tag, "NotFound")
    const id = await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        const id = yield* att.watch("失敗後にも追加できるwatch", "famulus")
        yield* att.recordWatchRun(id, "正常に記録できた")
        return id
      }),
    )
    assert.ok(id.length > 0)
  })
})

/**
 * 順番の検査。cooldownは「いつまで載せないか」しか決めない。
 *
 * 同じ日に登録した watch は同時刻に再提示可能になり、対象がすべて同時に掲載候補になる。実測では6件が
 * 毎回そろって載り、cycle はその一覧を読み直すだけで1件も回さずに終えていた(34回中20回が
 * 呼び出し2回以下)。載せる数に上限を置き、載せた順に後ろへ送る。
 */
const sixWatches = Effect.gen(function* () {
  const att = yield* Attention
  const ids: string[] = []
  for (let i = 0; i < 6; i++)
    ids.push(yield* att.watch(`件 ${i}`, "famulus", { at: `2026-08-0${i + 1}T09:00:00Z` }))
  yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
  return ids
})

test("複数のcooldownが同時に終了しても、1回に載せるのは上限まで。残りは件数だけ渡す", async () => {
  await withHarness(async (h) => {
    const ids = await h.run(sixWatches)
    const d = await h.run(planAt(T0 + hours(2)))

    assert.equal(d.stalled.length, STALLED_SHOW_MAX, "載せるのは上限まで")
    assert.equal(d.stalledHeld, 6 - STALLED_SHOW_MAX, "上限を超えた分は除外せず次回分として保持する")
    // 実行条件はcooldownが終了した全件の数。載せた数で書くと、6件待っている回と3件しかない回が
    // 同じ文になり、後ろに何件溜まっているかがどこにも出なくなる。
    assert.match(d.reasons.join(), /watch が 6 件/)
    assert.deepEqual(
      d.stalled.map((w) => w.id),
      ids.slice(0, STALLED_SHOW_MAX),
    )
  })
})

test("載せたのに回さなかった watch も後ろへ回る — 進むのは noteShown を呼んだときだけ", async () => {
  await withHarness(async (h) => {
    const ids = await h.run(sixWatches)
    const first = await h.run(planAt(T0 + hours(2)))

    // planCycle だけでは進まない。planCycle は実行条件が無い回にも走るので、ここで記録すると
    // 誰も読んでいない一覧を載せたことにして順番だけが回る。
    const again = await h.run(planAt(T0 + hours(3)))
    assert.deepEqual(
      again.stalled.map((w) => w.id),
      first.stalled.map((w) => w.id),
      "planCycle を引き直しただけでは順番は動かない",
    )

    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.noteShown(
          first.stalled.map((w) => w.id),
          "2026-08-08T11:00:00Z",
        )
      }),
    )

    // `ran` は1件も呼んでいない。それでも次は別の3件が載る — 回さずに終えた watch が
    // 表示上限を占め続けるのを、ここで止めている。
    const second = await h.run(planAt(T0 + hours(4)))
    assert.deepEqual(
      second.stalled.map((w) => w.id),
      ids.slice(STALLED_SHOW_MAX),
    )

    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.noteShown(
          second.stalled.map((w) => w.id),
          "2026-08-08T12:00:00Z",
        )
      }),
    )
    const third = await h.run(planAt(T0 + hours(5)))
    assert.deepEqual(
      third.stalled.map((w) => w.id),
      ids.slice(0, STALLED_SHOW_MAX),
      "一巡したら先頭へ戻る",
    )
  })
})

test("自分が動く番でない watch は、一定期間更新が無いときだけ実行条件になる", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.watch("A社からの返信待ち", "human", { at: "2026-08-08T09:00:00Z" })
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )
    const soon = await h.run(planAt(T0 + hours(4)))
    assert.equal(soon.stalled.length, 0, "相手待ちは滞留するまで理由にしない")
    assert.equal(soon.idle, true)
  })
})

test("未解決の問いは実行条件にしない(自分では解消できず無限再実行になるため)", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.ask("美容院の『来週の月曜』は 8/10 でよいか")
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )
    const d = await h.run(planAt(T0 + hours(4)))
    assert.equal(d.idle, true, "問いがあるだけでは実行条件にならない")
    assert.equal(d.openQuestions.length, 1, "別の実行条件が成立したときの入力には含める")
  })
})

/**
 * 問いの終了経路。回答と取り下げは別で、片方しか無いと不要な問いが上限を占有し続ける。
 * 実行条件ではないぶん見落としやすいが、上限に達したプロンプトは新しい問いを除外する — そこまで見る。
 */
test("答えないまま取り下げられる。理由は残る", async () => {
  await withHarness(async (h) => {
    const { dropped, stored, left } = await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        const id = yield* att.ask("現職の就業規則で副業は可能か")
        const dropped = yield* att.drop(id, "副業探し自体を中断した")
        // 返り値と DB の中身の両方を見る。書けたことと、書けたと言うことは別。
        return { dropped, stored: yield* att.findQuestion(id), left: yield* att.openQuestions() }
      }),
    )
    assert.equal(dropped.status, "dropped")
    assert.deepEqual({ ...stored }, { ...dropped }, "返した行が DB に入っている行と一致する")
    assert.equal(stored.answer, "副業探し自体を中断した", "なぜ追わないかは残す")
    assert.deepEqual(left, [], "取り下げた問いは cycle の材料から外れる")
  })
})

test("不要になった未解決質問が上限を占有すると新しい問いが cycle に届かない — 取り下げれば届く", async () => {
  await withHarness(async (h) => {
    const ids = await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        const dead: string[] = []
        // 上限は古い順の 20 件。先に立てたものだけで埋める。
        for (let i = 0; i < 20; i++) dead.push(yield* att.ask(`前の向きで立てた問い ${i}`))
        yield* att.ask("いま追っている問い")
        return dead
      }),
    )

    const listOpen = Effect.gen(function* () {
      return yield* (yield* Attention).openQuestions()
    })

    const before = await h.run(listOpen)
    assert.equal(before.length, 20)
    assert.equal(
      before.some((q) => q.question === "いま追っている問い"),
      false,
      "上限が古いもので埋まっている間は新しい問いが載らない",
    )

    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        for (const id of ids) yield* att.drop(id, "向きが変わった")
      }),
    )
    const after = await h.run(listOpen)
    assert.deepEqual(
      after.map((q) => q.question),
      ["いま追っている問い"],
    )
  })
})

test("同じ理由で実行が続くとcooldownが倍に伸びる。新しい入力が来れば元に戻る", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.watch("自分が動く番のまま解消しない件", "famulus", { at: "2026-08-08T09:00:00Z" })
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )

    // 1.5h → 3h → 6h … と伸びる。毎回「cooldown後に再実行したが理由は解消しなかった」を再現する。
    let at = T0
    const seen: number[] = []
    for (let i = 0; i < 8; i++) {
      const d = await h.run(planAt(at + hours(MAX_COOLDOWN_HOURS)))
      assert.equal(d.idle, false)
      assert.equal(d.reasonKey, "stalled", "組み合わせは経過時間で変わらない(変わると上限が上限でなくなる)")
      seen.push(d.cooldownHours)
      at += hours(d.cooldownHours + 0.1)
      await h.run(
        Effect.gen(function* () {
          const att = yield* Attention
          yield* att.completeCycle({ active: true, at: new Date(at).toISOString(), reasonKey: d.reasonKey })
        }),
      )
    }
    // 倍々に伸びて 24 時間で止まる = 最後は1日1回まで下がる(完全には止めない)。
    assert.deepEqual(seen, [1.5, 3, 6, 12, 24, 24, 24, 24])

    const capped = await h.run(planAt(at + hours(MAX_COOLDOWN_HOURS)))
    assert.equal(capped.cooldownHours, MAX_COOLDOWN_HOURS)
    assert.equal(capped.idle, false, "上限に達しても1日1回は実行条件になる")
    const tooSoon = await h.run(planAt(at + hours(MAX_COOLDOWN_HOURS - 1)))
    assert.equal(tooSoon.idle, true, "上限に達したら24時間は再実行しない")

    // 外部入力が来たら指数バックオフをリセットする。
    const fresh = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        yield* mem.remember({ source: "owner", content: { said: "その件やっといて" } })
        const d = yield* att.planCycle(at + hours(0.1))
        yield* att.completeCycle({ active: true, at: new Date(at).toISOString(), reasonKey: d.reasonKey })
        return d
      }),
    )
    assert.equal(fresh.idle, false, "cooldown中でも新しい入力は実行条件になる")
    assert.equal(fresh.reasonKey, "", "新しい入力では指数バックオフを最初から数え直す")

    const back = await h.run(planAt(at + hours(ACTIVE_COOLDOWN_HOURS + 0.1)))
    assert.equal(back.cooldownHours, ACTIVE_COOLDOWN_HOURS, "cooldownが最短に戻っている")
  })
})

test("期限が近い承認待ちは実行条件になる", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const db = yield* Db
        const att = yield* Attention
        yield* db.run(
          `INSERT INTO proposals (id, created_at, summary, assessment, ask,
             c_what, c_when, c_who, c_how, c_how_verified, payload, provenance, status, expires_at)
           VALUES ('p1','2026-08-08T09:00:00Z','歯医者に変更依頼','根拠','判断',
                   'w','t','famulus','h','v','{}','[]','proposed', ?)`,
          new Date(T0 + hours(24)).toISOString(),
        )
        yield* att.completeCycle({ active: true, at: "2026-08-08T09:00:00Z" })
      }),
    )
    const d = await h.run(planAt(T0 + hours(4)))
    assert.equal(d.idle, false)
    assert.equal(d.pending.length, 1)
    assert.match(d.reasons.join(), /期限が近い承認待ち/)

    // 結論を1回書いたら、同じ件を実行条件にしない。承認を出せるのはユーザーだけなので、
    // 再実行しても「あなた待ちです」をもう一度書くところまでしか進まない。
    await h.run(
      Effect.gen(function* () {
        const proposals = yield* Proposals
        yield* proposals.recordPendingConclusion("p1", "承認はユーザーしか出せない。こちらからは進まない。")
      }),
    )
    const after = await h.run(planAt(T0 + hours(8)))
    assert.equal(after.idle, true, "結論を置いた提案は実行条件にしない")
    // 一覧からは消さない。承認はまだ要るので、別件の実行時にはプロンプトへ載る。
    assert.equal(after.pending.length, 1)
    assert.equal(after.pending[0]?.settled_note, "承認はユーザーしか出せない。こちらからは進まない。")
  })
})

const denied = (n: number, at: string, reason: string | null) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.run(
      `INSERT INTO proposals (id, created_at, summary, assessment, ask,
         c_what, c_when, c_who, c_how, c_how_verified, payload, provenance, status, expires_at, deny_reason)
       VALUES (?,?,?,'根拠','判断','w','t','famulus','h','v','{}','[]','denied',?,?)`,
      `d${n}`,
      at,
      `${n} 件目の用件`,
      at,
      reason,
    )
  })

/**
 * 断られたことを次の回に渡す。渡さないと、同じ相手に同じ用件を出し直す。
 * watch に前回の結果を渡すのと同じ理由。
 */
test("断られた提案はプロンプトに載る — ただし実行条件にはしない", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* denied(1, "2026-08-08T08:00:00Z", "希望日が経過した")
        yield* att.completeCycle({ active: true, at: new Date(T0).toISOString() })
      }),
    )
    const d = await h.run(planAt(T0 + hours(1)))
    assert.deepEqual(
      d.refused.map((r) => [r.summary, r.reason]),
      [["1 件目の用件", "希望日が経過した"]],
    )
    // 却下済みの提案を実行条件にしても処理は進まない。同じ却下による無限再実行を避ける。
    assert.equal(d.idle, true)
    assert.equal(d.reasons.length, 0)
  })
})

test("断られたぶんは新しい順に決めた数だけ — 古いものから落ちる", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const att = yield* Attention
        for (let n = 1; n <= REFUSED_LIMIT + 2; n++) {
          yield* denied(n, `2026-08-0${n}T08:00:00Z`, `理由 ${n}`)
        }
        yield* att.completeCycle({ active: true, at: new Date(T0).toISOString() })
      }),
    )
    const d = await h.run(planAt(T0 + hours(1)))
    assert.equal(d.refused.length, REFUSED_LIMIT)
    assert.equal(d.refused[0]?.summary, `${REFUSED_LIMIT + 2} 件目の用件`)
  })
})

/**
 * 1日1本の下書き。同日に下書き生成条件が二度成立しないことを固定する。
 * cooldownの対象外にしてあるのは、夕方に別件を処理した日でも下書き生成を省略しないため。
 */
test("下書き生成条件は決めた時刻から1日1回だけ成立する", async () => {
  const keep = process.env.OPEN_ZERO_DAILY_HOUR
  process.env.OPEN_ZERO_DAILY_HOUR = "17"
  try {
    await withHarness(async (h) => {
      await h.run(
        Effect.gen(function* () {
          const att = yield* Attention
          yield* att.completeCycle({ active: true, at: new Date(T0).toISOString() })
        }),
      )
      const due = await h.run(planAt(T0 + hours(0.5)))
      assert.equal(due.draftDue, true, "時刻を過ぎたらcooldown中でも成立する")
      assert.match(due.reasons.join(), /下書き/)

      const saved = await h.run(
        Effect.gen(function* () {
          const drafts = yield* Drafts
          const first = yield* drafts.materialize(
            { title: "元の題", body: "元の本文", basis: "run 1" },
            "2026-08-08T09:30:00Z",
          )
          const resumed = yield* drafts.materialize(
            { title: "別の題", body: "別の本文", basis: "run 2" },
            "2026-08-08T10:00:00Z",
          )
          return { first, resumed }
        }),
      )
      assert.equal(saved.resumed.id, saved.first.id)
      assert.equal(saved.resumed.body, "元の本文", "レビュー待ちの本文は再開時の入力で上書きしない")
      const pending = await h.run(planAt(T0 + hours(1)))
      assert.equal(pending.draftDue, true, "保存やレビュー待ちだけでは日次完了にしない")
      assert.equal(pending.pendingDraft?.body, "元の本文")
      const revised = await h.run(
        Effect.gen(function* () {
          const drafts = yield* Drafts
          yield* drafts.requestRevision(saved.first.id, "本文を直す")
          const basisOnly = yield* drafts.materialize(
            { title: "元の題", body: "元の本文", basis: "根拠だけ変更" },
            "2026-08-08T10:10:00Z",
          )
          const changed = yield* drafts.materialize(
            { title: "元の題", body: "改稿本文", basis: "run 2" },
            "2026-08-08T10:20:00Z",
          )
          return { basisOnly, changed }
        }),
      )
      assert.equal(revised.basisOnly.state, "revision_needed", "レビュー対象の本文が同じなら再レビューしない")
      assert.equal(revised.changed.state, "review_pending")
      const crossDay = await h.run(planAt(T0 + hours(23)))
      assert.equal(crossDay.pendingDraft?.body, "改稿本文", "日付をまたいでも未完了の同じ本文を再開する")

      await h.run(
        Effect.gen(function* () {
          const db = yield* Db
          yield* db.run(
            `INSERT INTO discord_outbound
              (id,purpose,dedupe_key,spec,spec_hash,state,created_at,updated_at)
             VALUES ('draft-out','test','draft-out','{}','hash','sent','2026-08-09T09:00:00Z','2026-08-09T09:01:00Z')`,
          )
          yield* db.run(
            `INSERT INTO discord_outbound_actions
              (outbound_id,ordinal,kind,spec,spec_hash,state,receipt,updated_at)
             VALUES ('draft-out',0,'message','{}','hash','succeeded','{"messageId":"1"}','2026-08-09T09:01:00Z')`,
          )
          const drafts = yield* Drafts
          yield* drafts.attachOutbound(saved.first.id, "draft-out")
        }),
      )
      const done = await h.run(planAt(T0 + hours(24)))
      assert.equal(done.draftDue, false, "持越しdraftもDiscord実送信した日の完了に数える")

      const nextDay = await h.run(planAt(T0 + hours(47)))
      assert.equal(nextDay.draftDue, true, "日が変われば再び成立する")
    })
  } finally {
    process.env.OPEN_ZERO_DAILY_HOUR = keep
  }
})

test("決めた時刻より前は下書き生成条件が成立しない — その日の走行記録がまだ無い", async () => {
  const keep = process.env.OPEN_ZERO_DAILY_HOUR
  process.env.OPEN_ZERO_DAILY_HOUR = "23"
  try {
    await withHarness(async (h) => {
      const d = await h.run(planAt(T0))
      assert.equal(d.draftDue, false)
      assert.equal(d.reasons.join().includes("下書き"), false)
    })
  } finally {
    process.env.OPEN_ZERO_DAILY_HOUR = keep
  }
})

test("走っている最中に届いたぶんは既読にしない — 返さないまま消えるのを塞ぐ", async () => {
  await withHarness(async (h) => {
    const seen = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        yield* mem.remember({ source: "owner", content: "1本目" })
        return yield* att.planCycle(T0)
      }),
    )
    assert.equal(seen.newEvents.length, 1)

    const after = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        // cycle が走り終える前に届いた2本目。この回の planCycle には載っていない。
        yield* mem.remember({ source: "owner", content: "2本目" })
        yield* mem.remember({ source: "system", content: { said: "1本目に答えた" } })
        yield* att.completeCycle({
          active: true,
          at: "2026-08-08T09:00:00Z",
          upto: seen.newEvents.at(-1)?.rowid ?? seen.cursor,
        })
        return yield* att.planCycle(T0 + hours(0.1))
      }),
    )
    assert.equal(after.newEvents.length, 1, "見ていない入力は残る")
    assert.equal(after.newEvents[0]?.content, '"2本目"')
    assert.equal(after.idle, false, "未処理入力が残っている限り次の cycle の実行条件になる")
  })
})

test("idle でも位置は進めない — 判定と入れ違いに届いたぶんが消えない", async () => {
  await withHarness(async (h) => {
    const d = await h.run(planAt(T0))
    const after = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        yield* mem.remember({ source: "owner", content: "入れ違い" })
        yield* att.completeCycle({ upto: d.cursor })
        return yield* att.planCycle(T0 + hours(0.1))
      }),
    )
    assert.equal(after.newEvents.length, 1)
    assert.equal(after.newEvents[0]?.content, '"入れ違い"')
  })
})
