/**
 * 進み具合の検査。見るのは「報告と記録が分かれているか」。
 *
 * cycle の締めの文は自分で書いた報告なので、そこに「watch を実行した」と書いてあっても
 * 実行したことの証拠にはならない。ここが押さえるのは、報告文を1文字も読まずに
 * 「何を呼んだか」「何行増えたか」が出ること、そしてその2つが食い違ったときに食い違って見えること。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
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
import { Db } from "../src/services/Db.ts"
import { Memory } from "../src/services/Memory.ts"
import { withHarness } from "./helpers.ts"

/** cycle が書く形そのまま。欄名を変えたらここが落ちる(読む側と書く側が離れているので)。 */
const cycleRow = (c: Record<string, unknown>, wroteAt: string) =>
  Effect.gen(function* () {
    const mem = yield* Memory
    yield* mem.remember({
      kind: "observe",
      source: "system",
      content: c,
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
    // 報告文はそのまま持つが、道具の並びはそこから作っていない。
    assert.match(e.said, /watch を1本回した/)
    // Discord は幅が無いので数だけ、`fam journal` は並びごと。どちらも報告文からは作っていない。
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
          // 報告は「提案を出した」と言っているのに、提案は1件も増えていない。
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

test("窓の中に増えた行だけ数える — 前後の回のぶんは混ざらない", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({
          source: "system",
          content: { ran: "ls", exitCode: 0 },
          at: "2026-08-13T05:00:00Z",
        })
        yield* mem.remember({
          source: "system",
          content: { ran: "grep", exitCode: 0 },
          at: "2026-08-13T06:00:10Z",
        })
        yield* mem.remember({
          source: "system",
          content: { told: "下書きが1本できた", body: "…", sent: true },
          at: "2026-08-13T06:00:20Z",
        })
        yield* mem.remember({
          source: "system",
          content: { drafted: "題", body: "…", basis: "…", sent: true },
          at: "2026-08-13T06:10:00Z",
        })
      }),
    )
    await h.run(
      cycleRow(
        { cycle: "2026-08-13T06:00:00Z", reasons: ["下書きの日"], said: "書いた", tools: ["shell", "tell"] },
        "2026-08-13T06:00:30Z",
      ),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.equal(e.left.shells, 1, "窓の前の1件が混ざっている")
    assert.equal(e.left.tells, 1)
    assert.equal(e.left.drafts, 0, "窓の後の1件が混ざっている")
  })
})

test("run 数と出力tokenは窓の中の ledger だけを足す", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const db = yield* Db
        for (const [id, at, out] of [
          ["l0", "2026-08-13T05:59:00Z", 9000],
          ["l1", "2026-08-13T06:00:05Z", 800],
          ["l2", "2026-08-13T06:00:25Z", 400],
          ["l3", "2026-08-13T06:01:00Z", 9000],
        ] as const) {
          yield* db.run("INSERT INTO ledger (id, at, kind, out_tok)VALUES (?, ?, 'run', ?)", id, at, out)
        }
      }),
    )
    await h.run(
      cycleRow({ cycle: "2026-08-13T06:00:00Z", reasons: ["入力"], said: "返した" }, "2026-08-13T06:00:30Z"),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.equal(e.runs, 2)
    assert.equal(e.outTok, 1200)
    assert.match(dailyPost([e], "2026-08-13"), /- 推論 2run \/ 出力1\.2k/)
  })
})

test("金額欄を持たず、出したトークンを出す", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.run(
          "INSERT INTO ledger (id, at, kind, out_tok)VALUES ('m1', '2026-08-13T08:00:10Z', 'turn', 830)",
        )
      }),
    )
    await h.run(
      cycleRow({ cycle: "2026-08-13T08:00:00Z", reasons: ["watch"], said: "見た" }, "2026-08-13T08:00:20Z"),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    const one = dailyPost([e], "2026-08-13")
    assert.match(one, /- 推論 1run \/ 出力830/)
    assert.doesNotMatch(one, /\$/)
  })
})

/** 記録を追加する前の回。「モデル未呼び出し」と「記録なし」を区別する。 */
test("道具の記録を持たない古い回は「—」で出る(0手とは書かない)", async () => {
  await withHarness(async (h) => {
    await h.run(
      cycleRow(
        { tick: "2026-08-12T01:00:00Z", reasons: ["入力"], said: "前の形で書かれた回" },
        "2026-08-12T01:02:00Z",
      ),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.equal(e.tools, undefined)
    assert.equal(e.steps, undefined)
    const one = dailyPost([e], "2026-08-12")
    assert.match(one, /- 道具 記録なし/)
    // 時間の記録が無い回だけの日は、合計時間を出さない。0秒と出すと一瞬で終わった日に見える。
    assert.match(one, /- 動いた 1回$/m)
    assert.doesNotMatch(one, /計0秒/)
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
    // 止まったことは上に出す。下に置くと、上だけ読んで全部走り切った日と見分けが付かない。
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

/** cycle の記録ではない system イベント(shell の跡や下書き)を1回ぶんとして数えない。 */
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
 * 狭い画面の幅を検査に入れる。
 *
 * Discord を携帯で読むときに本文へ使える幅はおよそ 40 桁(全角20文字)。
 * 折り返した2行目は左端に戻るので、幅を超えた行はラベルと中身の対応が消える。
 * 揃えた桁で読ませる形に戻したら、ここが落ちる。
 *
 * 見ているのはこちらが組む行だけ。`理由` は digest が書いた文がそのまま入るので、
 * 長さを決められない(超える回はある)。
 */
test("Discord に出す行は、携帯の幅に収まる", () => {
  const wide = (c: string): number =>
    /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(c) ? 2 : 1
  const cols = (s: string): number =>
    [...s.replace(/\*\*/g, "").replace(/^### |^- /, "")].reduce((n, c) => n + wide(c), 0)

  const e = {
    at: "2026-08-13T05:28:00Z",
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
  // 8種のうち上位6種だけ並び、残りは数になる。
  assert.match(post, /- 道具 recall×3 · draft · search · fetch · shell · tell · 他2種/)
  assert.match(post, /- 残った 下書き 2本 \/ 確定した事実 2件/)
  assert.doesNotMatch(post, /止まった/)
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
  const now = yesterday.endIso // 今日の頭ちょうど
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
