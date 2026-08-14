/**
 * 進み具合の検査(docs/adr/0030)。見るのは「報告と記録が分かれているか」。
 *
 * tick の締めの文は自分で書いた報告なので、そこに「watch を実行した」と書いてあっても
 * 実行したことの証拠にはならない。ここが押さえるのは、報告文を1文字も読まずに
 * 「何を呼んだか」「何行増えたか」が出ること、そしてその2つが食い違ったときに食い違って見えること。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { logPost, readJournal, renderJournal, runs, tally } from "../src/journal.ts"
import { Db } from "../src/services/Db.ts"
import { Memory } from "../src/services/Memory.ts"
import { withHarness } from "./helpers.ts"

/** tick が書く形そのまま。欄名を変えたらここが落ちる(読む側と書く側が離れているので)。 */
const tickRow = (c: Record<string, unknown>, wroteAt: string) =>
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
      tickRow(
        {
          tick: "2026-08-13T04:54:43Z",
          reasons: ["対応対象の watch が 1 件"],
          said: "この回でやったこと。ハーネス追跡の watch を1本回した。",
          tools: ["shell", "shell", "ran", "workspaces"],
          steps: 11,
          ms: 305_000,
        },
        "2026-08-13T04:57:55Z",
      ),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.deepEqual([...(e.tools ?? [])], ["shell", "shell", "ran", "workspaces"])
    assert.equal(e.steps, 11)
    assert.equal(e.ms, 305_000)
    // 報告文はそのまま持つが、道具の並びはそこから作っていない。
    assert.match(e.said, /watch を1本回した/)
    // Discord は幅が無いので数だけ、`oz journal` は並びごと。どちらも報告文からは作っていない。
    assert.match(logPost(e), /- 道具 shell×2 · ran · workspaces/)
    assert.match(renderJournal([e]), /道具 {4}shell×2 → ran → workspaces/)
  })
})

test("道具を呼んでも何も残らなかった回は、残った行が全部 0 で出る", async () => {
  await withHarness(async (h) => {
    await h.run(
      tickRow(
        {
          tick: "2026-08-13T06:00:00Z",
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
    assert.match(logPost(e), /- 残った なし/)
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
      tickRow(
        { tick: "2026-08-13T06:00:00Z", reasons: ["下書きの日"], said: "書いた", tools: ["shell", "tell"] },
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

test("実費は窓の中の ledger だけを足す", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const db = yield* Db
        for (const [id, at, usd, out] of [
          ["l0", "2026-08-13T05:59:00Z", 9, 9000],
          ["l1", "2026-08-13T06:00:05Z", 0.2, 800],
          ["l2", "2026-08-13T06:00:25Z", 0.05, 400],
          ["l3", "2026-08-13T06:01:00Z", 9, 9000],
        ] as const) {
          yield* db.run(
            "INSERT INTO ledger (id, at, kind, usd, out_tok)VALUES (?, ?, 'run', ?, ?)",
            id,
            at,
            usd,
            out,
          )
        }
      }),
    )
    await h.run(
      tickRow({ tick: "2026-08-13T06:00:00Z", reasons: ["入力"], said: "返した" }, "2026-08-13T06:00:30Z"),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.equal(e.runs, 2)
    assert.equal(e.outTok, 1200)
    assert.equal(Number(e.usd.toFixed(3)), 0.25)
    assert.match(logPost(e), /- 推論 2run \/ 出力1\.2k \/ \$0\.250/)
  })
})

/** 定額の枠で走った回は `usd` が 0 で入る。0 円と書くと、無料で済んだように読める。 */
test("実費が 0 の回に $0.000 とは書かない — 出したトークンは出す", async () => {
  await withHarness(async (h) => {
    await h.run(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.run(
          "INSERT INTO ledger (id, at, kind, usd, out_tok)VALUES ('m1', '2026-08-13T08:00:10Z', 'turn', 0, 830)",
        )
      }),
    )
    await h.run(
      tickRow({ tick: "2026-08-13T08:00:00Z", reasons: ["watch"], said: "見た" }, "2026-08-13T08:00:20Z"),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    const one = logPost(e)
    assert.match(one, /- 推論 1run \/ 出力830/)
    assert.doesNotMatch(one, /\$/)
  })
})

/** 記録を追加する前の回。「モデル未呼び出し」と「記録なし」を区別する。 */
test("道具の記録を持たない古い回は「—」で出る(0手とは書かない)", async () => {
  await withHarness(async (h) => {
    await h.run(
      tickRow(
        { tick: "2026-08-12T01:00:00Z", reasons: ["入力"], said: "前の形で書かれた回" },
        "2026-08-12T01:02:00Z",
      ),
    )
    const [e] = await h.run(readJournal(5))
    assert.ok(e)
    assert.equal(e.tools, undefined)
    assert.equal(e.steps, undefined)
    const one = logPost(e)
    assert.match(one, /- 道具 記録なし/)
    // 「呼ばなかった」と書かない。0手と出すと、走ったのに何もしなかった回に見える。
    assert.match(one, /手数の記録なし/)
    assert.doesNotMatch(one, /\d手/)
  })
})

test("止まった回は、そのことが記録に残る — 締めの文に書かれるとは限らない", async () => {
  await withHarness(async (h) => {
    await h.run(
      tickRow(
        {
          tick: "2026-08-13T07:00:00Z",
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
    // 止まったことは上に出す。下に置くと、上だけ読んで最後まで走った回と見分けが付かない。
    const lines = logPost(e).split("\n")
    assert.match(lines[1] ?? "", /^- \*\*止まった\*\* 420秒で時間切れ$/)
  })
})

test("新しい回が上に来る", async () => {
  await withHarness(async (h) => {
    await h.run(
      tickRow({ tick: "2026-08-13T01:00:00Z", reasons: ["古い"], said: "" }, "2026-08-13T01:01:00Z"),
    )
    await h.run(
      tickRow({ tick: "2026-08-13T02:00:00Z", reasons: ["新しい"], said: "" }, "2026-08-13T02:01:00Z"),
    )
    const list = await h.run(readJournal(5))
    assert.deepEqual(
      list.map((e) => e.reasons.join()),
      ["新しい", "古い"],
    )
  })
})

/** tick の記録ではない system イベント(shell の跡や下書き)を1回ぶんとして数えない。 */
test("tick 以外の system イベントは回として並ばない", async () => {
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
    usd: 0,
  }
  const over = logPost(e)
    .split("\n")
    .filter((l) => !l.startsWith("- 理由 "))
    .filter((l) => cols(l) > 40)
  assert.deepEqual(over, [], `40桁を超えた行がある(携帯で折り返す):\n${over.join("\n")}`)
})
