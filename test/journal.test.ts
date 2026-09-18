/**
 * 締めの文はモデル自身の報告で、実行の証拠にならない。
 * 呼んだ道具と増えた行数は報告文を読まずに出す。
 */

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { currentCycleId, withCycleContext } from "../src/core/cycle-context.ts"
import { localDayRange } from "../src/core/time.ts"
import {
  dailyLogWindow,
  dailyPost,
  readJournal,
  readJournalRange,
  renderJournal,
  runs,
  tally,
} from "../src/journal.ts"
import { Attention } from "../src/services/Attention.ts"
import { Db } from "../src/services/Db.ts"
import { Ledger } from "../src/services/Ledger.ts"
import { Memory } from "../src/services/Memory.ts"
import { Proposals } from "../src/services/Proposals.ts"
import { withHarness } from "./helpers.ts"

/** 旧記録を作るときは cycleId に undefined を明示する。 */
const cycleRow = (c: Record<string, unknown>, wroteAt: string) =>
  Effect.gen(function* () {
    const mem = yield* Memory
    yield* mem.remember({
      kind: "observe",
      source: "system",
      content: { cycleId: currentCycleId() ?? randomUUID(), ...c },
      text: String(c.said ?? ""),
      at: wroteAt,
    })
  })

test("呼んだ道具の並びは、締めの文と別に残る", async () => {
  await withHarness(async (h) => {
    await h.run(
      cycleRow(
        {
          cycle: "2026-08-13T04:54:43Z",
          reasons: ["対応対象の watch が 1 件"],
          said: "この回でやったこと。ハーネス追跡の watch を1本回した。",
          tools: ["shell", "shell", "record_watch_run", "workspaces"],
          steps: 11,
          ms: 305_000,
        },
        "2026-08-13T04:57:55Z",
      ),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.deepEqual([...(e.tools ?? [])], ["shell", "shell", "record_watch_run", "workspaces"])
    assert.equal(e.steps, 11)
    assert.equal(e.ms, 305_000)
    assert.match(e.said, /watch を1本回した/)
    assert.match(dailyPost([e], "2026-08-13"), /- 道具 shell×2 · record_watch_run · workspaces/)
    assert.match(renderJournal([e]), /道具 {4}shell×2 → record_watch_run → workspaces/)
  })
})

test("道具を呼んでも何も残らなかった回は、残った行が全部 0 で出る", async () => {
  await withHarness(async (h) => {
    await h.run(
      cycleRow(
        {
          cycle: "2026-08-13T06:00:00Z",
          reasons: ["期限が近い承認待ち"],
          said: "承認待ちの件について新しい提案を1件出した。",
          tools: ["propose"],
          steps: 3,
          ms: 40_000,
        },
        "2026-08-13T06:00:41Z",
      ),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.deepEqual(e.left, {
      proposals: 0,
      drafts: 0,
      tells: 0,
      shells: 0,
      beliefs: 0,
      watchRuns: 0,
    })
    assert.match(dailyPost([e], "2026-08-13"), /- 残った なし/)
    assert.match(renderJournal([e]), /残った {2}何も残らなかった/)
  })
})

test("同時に動く二つのcycleと対話の行は混ざらず、過去のsource時刻も保持する", async () => {
  await withHarness(async (h) => {
    const at = "2026-08-13T06:00:00Z"
    const sourceAt = "2026-08-12T01:00:00Z"
    const enteredA = Promise.withResolvers<void>()
    const enteredB = Promise.withResolvers<void>()
    const record = (name: string, count: number, outTok: number, journal: boolean) =>
      Effect.gen(function* () {
        const mem = yield* Memory
        const ledger = yield* Ledger
        const proposals = yield* Proposals
        const attention = yield* Attention
        const watch = yield* attention.watch(name, "famulus", { at: sourceAt })
        for (let i = 0; i < count; i++) {
          // await を跨ぐと別の実行が進むので、サービス作成時の ID を保持してはいけない。
          yield* Effect.promise(() => Promise.resolve())
          yield* mem.remember({ source: "system", content: { ran: name }, at: sourceAt })
          yield* mem.remember({ source: "system", content: { told: name }, at })
          yield* mem.remember({ source: "system", content: { drafted: name }, at })
          yield* mem.recordBelief(`${name}-${i}`, name)
          yield* proposals.create({
            summary: name,
            assessment: name,
            ask: name,
            what: name,
            when: name,
            who: "famulus",
            how: name,
            howVerified: name,
            at,
          })
          yield* attention.recordWatchRun(watch, name, sourceAt)
          yield* ledger.record({ kind: "run", role: "assistant", usage: { outTok }, at })
        }
        yield* ledger.record({ kind: "audit", usage: { outTok: 50_000 }, at })
        if (journal) yield* cycleRow({ cycle: at, said: name }, "2026-08-13T06:01:00Z")
      })
    // レイヤーは共有し、帰属は各書き込み時の非同期 context だけで決まる。
    await h.run(Db)
    await Promise.all([
      withCycleContext("cycle-a", async () => {
        enteredA.resolve()
        await enteredB.promise
        await h.run(record("a", 1, 11, true))
      }),
      withCycleContext("cycle-b", async () => {
        enteredB.resolve()
        await enteredA.promise
        await h.run(record("b", 2, 37, true))
      }),
      h.run(record("interactive", 3, 9000, false)),
    ])
    assert.equal(currentCycleId(), undefined)
    const entries = await h.run(readJournal(5))
    assert.equal(entries.length, 2)
    for (const [id, count, outTok] of [
      ["cycle-a", 1, 11],
      ["cycle-b", 2, 74],
    ] as const) {
      const e = entries.find((entry) => entry.cycleId === id)
      assert.ok(e)
      assert.deepEqual(e.left, {
        proposals: count,
        drafts: count,
        tells: count,
        shells: count,
        beliefs: count,
        watchRuns: count,
      })
      assert.equal(e.runs, count)
      assert.equal(e.outTok, outTok)
    }
    const source = await h.run(
      Effect.flatMap(Db, (db) =>
        db.get(
          "SELECT at FROM events WHERE cycle_id = 'cycle-a' AND json_extract(content, '$.ran') IS NOT NULL",
        ),
      ),
    )
    assert.equal(source?.at, sourceAt)
  })
})

test("旧記録は周辺の行があっても数量不明になり、日次集計も未帰属を明示する", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const mem = yield* Memory
        yield* ledger.record({
          kind: "run",
          role: "assistant",
          usage: { outTok: 12_345 },
          at: "2026-08-12T01:01:00Z",
        })
        yield* mem.remember({
          source: "system",
          content: { drafted: "別の仕事" },
          at: "2026-08-12T01:01:00Z",
        })
      }),
    )
    await h.run(
      cycleRow(
        { cycleId: undefined, tick: "2026-08-12T01:00:00Z", reasons: ["入力"], said: "前の形で書かれた回" },
        "2026-08-12T01:02:00Z",
      ),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.equal(e.tools, undefined)
    assert.equal(e.steps, undefined)
    assert.equal(e.cycleId, undefined)
    assert.equal(e.left, undefined)
    assert.equal(e.runs, undefined)
    assert.equal(e.outTok, undefined)
    assert.match(renderJournal([e]), /未帰属/)
    assert.doesNotMatch(renderJournal([e]), /0run|何も残らなかった|12345/)
    const one = dailyPost([e], "2026-08-12")
    assert.match(one, /- 道具 記録なし/)
    // 0秒と出すと一瞬で終わった日に見えるので、合計時間を出さない。
    assert.match(one, /- 動いた 1回$/m)
    assert.doesNotMatch(one, /計0秒/)
    assert.match(one, /未帰属 1回/)
    assert.doesNotMatch(one, /0run|残った なし|12\.3k/)
    await h.run(cycleRow({ cycle: "2026-08-12T02:00:00Z" }, "2026-08-12T02:01:00Z"))
    const mixed = dailyPost(await h.run(readJournal()), "2026-08-12")
    assert.match(mixed, /未帰属 1回/)
    assert.match(mixed, /集計対象 IDあり 1回/)
  })
})

test("止まった回は、そのことが記録に残る — 締めの文に書かれるとは限らない", async () => {
  await withHarness(async (h) => {
    await h.run(
      cycleRow(
        {
          cycle: "2026-08-13T07:00:00Z",
          reasons: ["watch"],
          said: "調べ物を進めている。",
          tools: ["shell", "shell"],
          steps: 9,
          ms: 420_000,
          cutOff: "420秒で時間切れ",
        },
        "2026-08-13T07:07:00Z",
      ),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.equal(e.cutOff, "420秒で時間切れ")
    // 上だけ読む人が完走した日と取り違えないよう、止まったことは上に出す。
    const lines = dailyPost([e], "2026-08-13").split("\n")
    assert.match(lines[1] ?? "", /^- \*\*止まった 1回\*\* 420秒で時間切れ$/)
  })
})

test("新しい回が上に来る", async () => {
  await withHarness(async (h) => {
    await h.run(
      cycleRow({ cycle: "2026-08-13T01:00:00Z", reasons: ["古い"], said: "" }, "2026-08-13T01:01:00Z"),
    )
    await h.run(
      cycleRow({ cycle: "2026-08-13T02:00:00Z", reasons: ["新しい"], said: "" }, "2026-08-13T02:01:00Z"),
    )
    const list = await h.run(readJournal(5))
    assert.deepEqual(
      list.map((e) => e.reasons.join()),
      ["新しい", "古い"],
    )
  })
})

test("cycle 以外の system イベントは回として並ばない", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ source: "system", content: { ran: "ls" }, at: "2026-08-13T03:00:00Z" })
        yield* mem.remember({ source: "owner", content: "こんにちは", at: "2026-08-13T03:00:01Z" })
      }),
    )
    assert.deepEqual(await h.run(readJournal(5)), [])
    assert.match(renderJournal([]), /まだ無い/)
  })
})

test("同じ道具が続いたら回数に畳む — 並びは崩さない", () => {
  assert.equal(runs(["shell", "shell", "ran", "shell"]), "shell×2 → ran → shell")
  assert.equal(runs([]), "")
})

test("数だけに畳むほうは、離れて呼んだぶんも足す — 多い順、同数なら先に呼んだ順", () => {
  assert.equal(
    tally(["recall", "draft", "remember", "draft", "recall", "draft", "ask"]),
    "draft×3 · recall×2 · remember · ask",
  )
  assert.equal(tally([]), "")
})

/**
 * 携帯の Discord で本文に使える幅はおよそ 40 桁。折り返すとラベルと中身の対応が崩れる。
 * `理由` は digest の文がそのまま入り長さを決められないので対象外。
 */
test("Discord に出す行は、携帯の幅に収まる", () => {
  const wide = (c: string): number =>
    /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(c) ? 2 : 1
  const cols = (s: string): number =>
    [...s.replace(/\*\*/g, "").replace(/^### |^- /, "")].reduce((n, c) => n + wide(c), 0)

  const e = {
    at: "2026-08-13T05:28:00Z",
    cycleId: "cycle-width",
    reasons: ["下書きの時間"],
    tools: ["recall", "recall", "draft", "remember", "draft", "ask"],
    steps: 15,
    ms: 554_000,
    said: "",
    left: { proposals: 1, drafts: 0, tells: 1, shells: 0, beliefs: 0, watchRuns: 0 },
    runs: 17,
    outTok: 33_700,
  }
  const over = dailyPost([e], "2026-08-13")
    .split("\n")
    .filter((l: string) => !l.startsWith("- 理由 "))
    .filter((l: string) => cols(l) > 40)
  assert.deepEqual(over, [], `40桁を超えた行がある(携帯で折り返す):\n${over.join("\n")}`)
})

test("戸惑い(confusion)は残した回の journal にだけ出て、Discord のログには出ない", async () => {
  await withHarness(async (h) => {
    await h.run(
      cycleRow(
        {
          cycle: "2026-08-14T07:00:00Z",
          reasons: ["watch"],
          said: "進めた。",
          tools: ["recall"],
          steps: 2,
          ms: 60_000,
          confusion: "watch の「前回:」がどの回を指すのか分からなかった",
        },
        "2026-08-14T07:02:00Z",
      ),
    )
    await h.run(
      cycleRow(
        {
          cycle: "2026-08-14T08:00:00Z",
          reasons: ["watch"],
          said: "進めた。",
          tools: [],
          steps: 1,
          ms: 1_000,
        },
        "2026-08-14T08:01:00Z",
      ),
    )
    const entries = await h.run(readJournal(5))
    const [latest, withConfusion] = entries
    assert.equal(withConfusion?.confusion, "watch の「前回:」がどの回を指すのか分からなかった")
    assert.equal(latest?.confusion, undefined)
    assert.match(renderJournal(entries), /戸惑い {2}watch の「前回:」/)
    assert.ok(
      !renderJournal(entries)
        .split("\n")
        .some((l) => l.includes("戸惑い") && l.includes("08:00")),
    )
    assert.doesNotMatch(dailyPost([...entries], "2026-08-14"), /戸惑い/)
  })
})

test("1日ぶんは合計して1通に畳む — 道具は上位6種+他n種", () => {
  const base = {
    reasons: ["watch"],
    cycleId: "cycle-daily",
    said: "",
    left: { proposals: 0, drafts: 1, tells: 0, shells: 0, beliefs: 1, watchRuns: 0 },
    runs: 5,
    outTok: 1_000,
  }
  const a = { ...base, at: "2026-08-17T01:00:00Z", ms: 60_000, tools: ["recall", "recall", "draft"] }
  const b = {
    ...base,
    at: "2026-08-17T02:00:00Z",
    ms: 90_000,
    tools: ["recall", "search", "fetch", "shell", "tell", "ask", "belief"],
  }
  const post = dailyPost([a, b], "2026-08-17")
  assert.match(post, /^### 2026-08-17 のまとめ$/m)
  assert.match(post, /- 動いた 2回 \/ 計2分30秒/)
  assert.match(post, /- 推論 10run \/ 出力2\.0k/)
  assert.match(post, /- 道具 recall×3 · draft · search · fetch · shell · tell · 他2種/)
  assert.match(post, /- 残った 下書き 2本 \/ 確定した事実 2件/)
  assert.doesNotMatch(post, /止まった/)
  // 承認待ちは前日の集計ではなく出す時点の残数。0 なら行を出さない。
  assert.doesNotMatch(post, /承認待ち/)
  assert.match(dailyPost([a, b], "2026-08-17", 3), /- 承認待ち 3件\(現在\)$/m)
})

test("出しどきの判定 — 初回は境界を置くだけで出さない", () => {
  const now = "2026-08-18T03:00:00Z"
  const today = localDayRange(now)
  assert.deepEqual(dailyLogWindow(undefined, now), { set: today.startIso })
})

test("出しどきの判定 — 同じ日のうちは出さない", () => {
  const now = "2026-08-18T03:00:00Z"
  const today = localDayRange(now)
  assert.equal(dailyLogWindow(today.startIso, now), undefined)
})

test("出しどきの判定 — 日が変わったら前の日ぶんの窓が返る", () => {
  const yesterday = localDayRange("2026-08-17T12:00:00Z")
  const now = yesterday.endIso
  const w = dailyLogWindow(yesterday.startIso, now)
  assert.ok(w?.post)
  assert.equal(w.post.fromIso, yesterday.startIso)
  assert.equal(w.post.toIso, yesterday.endIso)
  assert.equal(w.post.label, yesterday.key)
  assert.equal(w.set, yesterday.endIso)
})

test("出しどきの判定 — 空白日を跨いだら1通にまとめ、ラベルが期間になる", () => {
  const d15 = localDayRange("2026-08-15T12:00:00Z")
  const now = "2026-08-18T01:00:00Z"
  const today = localDayRange(now)
  const w = dailyLogWindow(d15.startIso, now)
  assert.ok(w?.post)
  assert.equal(w.post.fromIso, d15.startIso)
  assert.equal(w.post.toIso, today.startIso)
  assert.match(w.post.label, /^2026-08-15〜2026-08-1[67]$/)
})

test("窓の中の回だけ読む — readJournalRange は書いた時刻で切る", async () => {
  await withHarness(async (h) => {
    for (const [cycle, wrote] of [
      ["2026-08-16T23:00:00Z", "2026-08-16T23:01:00Z"],
      ["2026-08-17T01:00:00Z", "2026-08-17T01:01:00Z"],
      ["2026-08-18T01:00:00Z", "2026-08-18T01:01:00Z"],
    ] as const) {
      await h.run(cycleRow({ cycle, reasons: ["watch"], said: "" }, wrote))
    }
    const got = await h.run(readJournalRange("2026-08-17T00:00:00Z", "2026-08-18T00:00:00Z"))
    assert.deepEqual(
      got.map((e) => e.at),
      ["2026-08-17T01:00:00Z"],
    )
  })
})
