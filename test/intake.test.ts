/**
 * DB の入口の検査。
 *
 * ここで一番壊れやすいのは選別のほう(モデルを呼ばない前段)で、
 * しかも壊れても静かに壊れる — 道具の出力が混ざっても、ユーザーの発話が半分落ちても、
 * 出来上がった要約はそれらしく読める。だから「何を捨て、何を1文字も削らないか」を
 * 素材の段階で直接確かめる。要約の中身ではなく素材の境界が検査対象。
 */

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { afterAll, beforeAll, test } from "vitest"
import { Db } from "../src/services/Db.ts"
import { Intake } from "../src/services/Intake.ts"
import { Memory, renderRecall } from "../src/services/Memory.ts"
import { withHarness } from "./helpers.ts"

let ROOT = ""
let EXPORT = ""
let EXPORT_EN = ""
let EMPTY = ""
const prev = process.env.OPEN_ZERO_TRANSCRIPT_ROOT
const prevExport = process.env.OPEN_ZERO_EXPORT_ROOT

const typed = (sessionId: string, cwd: string, at: string, text: string) =>
  JSON.stringify({
    type: "user",
    promptSource: "typed",
    isSidechain: false,
    sessionId,
    cwd,
    timestamp: at,
    message: { role: "user", content: [{ type: "text", text }] },
  })

const said = (text: string) =>
  JSON.stringify({ type: "assistant", isSidechain: false, message: { content: [{ type: "text", text }] } })

const usedTool = (bytes: number) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { content: [{ type: "tool_use", name: "Read", input: { file: "x".repeat(bytes) } }] },
  })

const sidechain = (sessionId: string, text: string) =>
  JSON.stringify({
    type: "user",
    promptSource: "typed",
    isSidechain: true,
    sessionId,
    message: { role: "user", content: [{ type: "text", text }] },
  })

const injected = (sessionId: string, text: string) =>
  JSON.stringify({
    type: "user",
    promptSource: "slash_command",
    isSidechain: false,
    sessionId,
    message: { role: "user", content: [{ type: "text", text }] },
  })

function only<T>(xs: readonly T[]): T {
  assert.ok(xs.length > 0, "候補が1件も無い")
  return xs[0] as T
}

const WEB_ASK =
  "日本で同性婚が認められていない理由を、法制度の側から知りたい。判例の流れも含めて、" +
  "国際カップルの場合に何が変わるかまで。"

const LONG_ASK =
  "歯医者の予約は水曜の18時にしたい。ただし来週は出張なので、その週だけは金曜に寄せてほしい。" +
  "あと、予約の確認メールは自分宛てには要らない。"

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "oz-intake-"))
  process.env.OPEN_ZERO_TRANSCRIPT_ROOT = ROOT

  const dir = join(ROOT, "-home-haru-Project-demo")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "s1.jsonl"),
    [
      typed("s1", "/home/haru/Project/demo", "2026-08-01T09:00:00.000Z", LONG_ASK),
      usedTool(50_000),
      usedTool(50_000),
      said("調べています。まず現在の予約を確認します。"),
      said("水曜18時で押さえました。金曜への振り替えは来週ぶんだけ別に入れます。"),
      sidechain("s1", "サブエージェントへの指示。これはユーザーの言葉ではない。"),
      injected("s1", "/compact"),
      typed(
        "s1",
        "/home/haru/Project/demo",
        "2026-08-01T09:30:00.000Z",
        "確認メールは要らないって言ったよね",
      ),
      said("失礼しました。確認メールの送付は止めます。"),
    ].join("\n"),
  )

  const dir2 = join(ROOT, "-tmp-scratch")
  mkdirSync(dir2, { recursive: true })
  writeFileSync(join(dir2, "s2.jsonl"), [said("誰にも頼まれていない独り言"), usedTool(1000)].join("\n"))

  EMPTY = join(ROOT, "no-export")
  mkdirSync(EMPTY, { recursive: true })
  mkdirSync(join(ROOT, "no-logs"), { recursive: true })
  process.env.OPEN_ZERO_EXPORT_ROOT = EMPTY

  EXPORT = join(ROOT, "export")
  mkdirSync(join(EXPORT, "design_chats"), { recursive: true })
  writeFileSync(
    join(EXPORT, "conversations.json"),
    JSON.stringify([
      {
        uuid: "w1",
        name: "同性婚の扱い",
        created_at: "2026-07-02T04:00:00.000000Z",
        chat_messages: [
          { sender: "human", text: WEB_ASK, content: [] },
          {
            sender: "assistant",
            text: "",
            content: [{ type: "text", text: "婚姻の平等をめぐる judicial な流れから。" }],
          },
          // 思考は応答ですらない。地の文だけを拾う。
          { sender: "assistant", text: "", content: [{ type: "thinking", thinking: "内部の独り言" }] },
        ],
      },
      // 本文フィールドが空の会話レコード。uuid と日時だけ残る(書き出し側の都合)。
      {
        uuid: "w2",
        name: "",
        created_at: "2026-03-10T04:00:00.000000Z",
        chat_messages: [
          { sender: "human", text: "", content: [] },
          { sender: "assistant", text: "", content: [] },
        ],
      },
    ]),
  )
  writeFileSync(
    join(EXPORT, "design_chats", "d1.json"),
    JSON.stringify({
      uuid: "d1",
      title: "配色の詰め",
      project: { name: "Vim 練習台" },
      created_at: "2026-06-12T04:30:30.402311+00:00",
      messages: [
        {
          uuid: "m1",
          role: "user",
          // 本文は一段深い `content.content`。`attachments` は仕組みが毎回差し込む定型文。
          content: {
            authorName: "Haru",
            content: "白ベースで、バンディングが出ない範囲でグラデーションを浅くしてほしい",
            attachments: [{ content: "This project uses Design Components: every design is a single file." }],
          },
        },
        { uuid: "m2", role: "assistant", content: { content: "色相を固定して明度だけ動かします。" } },
      ],
    }),
  )
  writeFileSync(
    join(EXPORT, "memories.json"),
    JSON.stringify([
      {
        account_uuid: "acc",
        conversations_memory: "**Top of mind**\n\n配色とグラデーションの詰めを続けている。\n",
        memory_files: [
          {
            path: "/topics/interests.md",
            content:
              "---\nname: interests\ndescription: 配色・デザインの関心\n---\n- [stated] 配色とグラデーションに強い関心\n",
            updated_at: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
    ]),
  )

  // 英語だけの覚え書き。索引は trigram なので、このままでは日本語のクエリに一生当たらない。
  EXPORT_EN = join(ROOT, "export-en")
  mkdirSync(EXPORT_EN, { recursive: true })
  writeFileSync(
    join(EXPORT_EN, "memories.json"),
    JSON.stringify([
      {
        account_uuid: "acc",
        conversations_memory: "",
        memory_files: [
          {
            path: "/topics/job-searching.md",
            content: "---\nname: job-searching\n---\n- [stated] Considering a move to a smaller team.\n",
            updated_at: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
    ]),
  )
})

afterAll(() => {
  if (prev === undefined) delete process.env.OPEN_ZERO_TRANSCRIPT_ROOT
  else process.env.OPEN_ZERO_TRANSCRIPT_ROOT = prev
  if (prevExport === undefined) delete process.env.OPEN_ZERO_EXPORT_ROOT
  else process.env.OPEN_ZERO_EXPORT_ROOT = prevExport
  if (ROOT) rmSync(ROOT, { recursive: true, force: true })
})

/**
 * transcript 入力を無効化し、書き出し側だけを有効にする。
 * 取り込み元が2つあるので、両方を有効にすると「候補に出た1件がどちらの入口から来たか」が言えない。
 */
async function onlyExport<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  process.env.OPEN_ZERO_TRANSCRIPT_ROOT = join(ROOT, "no-logs")
  process.env.OPEN_ZERO_EXPORT_ROOT = dir
  try {
    return await fn()
  } finally {
    process.env.OPEN_ZERO_TRANSCRIPT_ROOT = ROOT
    process.env.OPEN_ZERO_EXPORT_ROOT = EMPTY
  }
}

const onlyWeb = <T>(fn: () => Promise<T>): Promise<T> => onlyExport(EXPORT, fn)

test("Claude.ai の書き出しからも候補が上がる — 本文フィールドが空の会話は数えない", async () => {
  await onlyWeb(async () => {
    await withHarness(async (h) => {
      const refs = await h.run(
        Effect.gen(function* () {
          return yield* (yield* Intake).scan(10)
        }),
      )
      assert.equal(refs.length, 2)
      assert.ok(
        refs.every((r) => r.kind === "claude-web"),
        "作業ログ側と混ざっていない",
      )
      assert.deepEqual(refs.map((r) => r.label).sort(), ["Vim 練習台 / 配色の詰め", "同性婚の扱い"].sort())
    })
  })
})

test("本文のある会話はそのまま素材になる — 中間応答は除外するがユーザーの発話は削らない", async () => {
  await onlyWeb(async () => {
    await withHarness(async (h) => {
      const m = await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const refs = yield* intake.scan(10)
          const web = refs.find((r) => r.label === "同性婚の扱い")
          assert.ok(web)
          return yield* intake.material(web)
        }),
      )
      assert.ok(m)
      assert.ok(m.text.includes(WEB_ASK), "ユーザーの発話は途中で切らない")
      assert.match(m.text, /agent: /, "応答も文脈として残る")
    })
  })
})

test("design_chats の定型の添付は素材に入らない — ユーザーが打った文字ではない", async () => {
  await onlyWeb(async () => {
    await withHarness(async (h) => {
      const m = await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const refs = yield* intake.scan(10)
          const d = refs.find((r) => r.label.startsWith("Vim 練習台"))
          assert.ok(d)
          return yield* intake.material(d)
        }),
      )
      assert.ok(m)
      assert.match(m.text, /バンディング/, "ユーザーの言葉は残る")
      assert.doesNotMatch(m.text, /Design Components/, "仕組みが差し込む定型文は入らない")
    })
  })
})

test("記憶ファイルはモデルを呼ばずに DB へ入る — 二度目は増えない", async () => {
  await onlyWeb(async () => {
    await withHarness(async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const first = yield* intake.ingestMemories
          const second = yield* intake.ingestMemories
          const hit = yield* (yield* Memory).recall("配色")
          return { first, second, hit }
        }),
      )
      assert.equal(out.first.added, 2)
      assert.equal(out.second.added, 0, "二度目は入らない")
      assert.equal(out.second.skipped, 2)
      // 枠を1回も使っていない。既に要約済みのものを要約し直さないのが要点。
      assert.equal(h.calls.length, 0, "モデルを呼ばない")
      // 記憶ファイルと散文の節、どちらも配色に触れている。両方出るのが正しい。
      assert.equal(out.hit.length, 2)
      assert.ok(
        out.hit.every((r) => r.taint === 1),
        "書いたのはユーザーではない。信用済みにしない",
      )
      assert.match(renderRecall(out.hit), /取り込み\]/)
    })
  })
})

test("英語だけの覚え書きには日本語の見出しが付く — 本文は訳さず原文のまま", async () => {
  await onlyExport(EXPORT_EN, async () => {
    await withHarness(
      async (h) => {
        const out = await h.run(
          Effect.gen(function* () {
            const intake = yield* Intake
            const added = yield* intake.ingestMemories
            const mem = yield* Memory
            return { added, jp: yield* mem.recall("転職"), en: yield* mem.recall("smaller team") }
          }),
        )
        assert.equal(out.added.added, 1)
        assert.equal(h.calls.length, 1)
        assert.equal(out.jp.length, 1, "日本語のクエリで当たる")
        assert.equal(out.en.length, 1, "原文でも当たる")
        assert.match(out.en[0]?.text ?? "", /Considering a move to a smaller team/)
      },
      [
        {
          text: "",
          structured: {
            line: "少人数のチームへの転職を検討している件の覚え書き",
            words: ["転職", "少人数", "チーム", "職場", "検討"],
          },
        },
      ],
    )
  })
})

test("選別は道具の入出力を捨て、ユーザーの発話は1文字も削らない", async () => {
  await withHarness(async (h) => {
    const m = await h.run(
      Effect.gen(function* () {
        const intake = yield* Intake
        const refs = yield* intake.scan(10)
        assert.equal(refs.length, 1, "人が打っていないログは候補に上がらない")
        return yield* intake.material(only(refs))
      }),
    )
    assert.ok(m)
    // 道具の payload が素材の予算を消費すると、後続の owner 発話が落ちうる。
    assert.ok(m.rawBytes > 100_000, `元の JSONL ログは 100KB 超のはず: ${m.rawBytes}`)
    assert.ok(m.keptBytes < 2_000, `残すのは 2KB 未満のはず: ${m.keptBytes}`)
    assert.doesNotMatch(m.text, /xxxx/, "道具の入力は素材に入らない")
    // ユーザーの言葉だけは全文。要約させる前に削ると、原文はもうどこにも無い。
    assert.ok(m.text.includes(LONG_ASK), "ユーザーの発話は途中で切らない")
    assert.ok(m.text.includes("確認メールは要らないって言ったよね"))
    assert.doesNotMatch(m.text, /サブエージェント/, "サブエージェントの往復は入らない")
    assert.doesNotMatch(m.text, /compact/, "打鍵していない入力は入らない")
  })
})

test("1往復から残る応答は最後の1件(途中経過ではなく結論)", async () => {
  await withHarness(async (h) => {
    const m = await h.run(
      Effect.gen(function* () {
        const intake = yield* Intake
        const refs = yield* intake.scan(10)
        return yield* intake.material(only(refs))
      }),
    )
    assert.ok(m)
    assert.match(m.text, /水曜18時で押さえました/, "結論は残る")
    assert.doesNotMatch(m.text, /まず現在の予約を確認します/, "途中経過は残さない")
  })
})

test("取り込みは1セッション1イベント — system が書いた import で、由来は信用しない", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const db = yield* Db
          const refs = yield* intake.scan(10)
          const r = yield* intake.ingest(only(refs))
          const row = yield* db.get("SELECT * FROM events WHERE kind = 'import'")
          return { r, row, n: yield* (yield* Memory).count }
        }),
      )
      assert.equal(out.n, 1, "1セッション = 1行")
      assert.equal(out.row?.source, "system", "書いたのは自分。ユーザーが言ったことにしない")
      assert.equal(out.row?.taint, 1, "コーディングログは web もファイルも通り抜けている。信用済みにしない")
      // 二重取り込みの歯止めは events 自身が持つ(別表を作らない)。
      assert.match(String(out.row?.provenance), /"ref":"s1"/)
      assert.equal(out.r?.digest.topic, "歯医者の予約の調整")
    },
    [
      {
        text: "",
        structured: {
          topic: "歯医者の予約の調整",
          decisions: [
            { what: "予約は水曜18時", why: "ユーザーの希望", said: "歯医者の予約は水曜の18時にしたい" },
          ],
          preferences: [
            { what: "予約の確認メールは本人宛てには送らない", said: "確認メールは要らないって言ったよね" },
          ],
          corrections: [
            { what: "確認メールを送ろうとしたのを止められた", said: "確認メールは要らないって言ったよね" },
          ],
        },
      },
    ],
  )
})

test("owner から引けない好み・訂正は DB に入らない — 印象と本人の言葉を混ぜない", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const db = yield* Db
          const r = yield* intake.ingest(only(yield* intake.scan(10)))
          // 索引に載った文字列で見る。引けなかった項目は検索からも消えていることまで確かめる。
          return { r, row: yield* db.get("SELECT text FROM events_fts WHERE event_id = ?", r?.id ?? "") }
        }),
      )
      assert.equal(out.r?.digest.preferences.length, 1, "原文から引けるものだけ残る")
      assert.equal(out.r?.digest.corrections.length, 0, "原文から引けない訂正は落ちる")
      const text = String(out.row?.text)
      assert.ok(text.includes("好み: 確認メールは送らない(「確認メールは要らないって言ったよね」)"), text)
      assert.doesNotMatch(text, /丁寧な言い回しを好む/, "引用の無い項目は索引にも残らない")
    },
    [
      {
        text: "",
        structured: {
          topic: "歯医者の予約の調整",
          decisions: [],
          preferences: [
            { what: "確認メールは送らない", said: "確認メールは要らないって言ったよね" },
            // モデルが素材から読み取った「印象」。原文に無い文を引用欄へ置いても残さない。
            { what: "丁寧な言い回しを好む", said: "丁寧な言い回しを好むと話した" },
          ],
          corrections: [{ what: "急かされるのを嫌う", said: "急かされるのを嫌うと話した" }],
        },
      },
    ],
  )
})

test("owner の原文に無い引用は DB に入らない — agent の推測やモデルの捏造を根拠にしない", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const r = yield* intake.ingest(only(yield* intake.scan(10)))
          return r?.digest
        }),
      )
      assert.deepEqual(out?.preferences, [
        { what: "確認メールは送らない", said: "確認メールは要らないって言ったよね" },
      ])
      assert.deepEqual(out?.corrections, [], "素材に無い文を引用の形にしても残らない")
    },
    [
      {
        text: "",
        structured: {
          topic: "歯医者の予約の調整",
          decisions: [],
          preferences: [{ what: "確認メールは送らない", said: "確認メールは要らないって言ったよね" }],
          corrections: [
            { what: "電話を避けたい", said: "電話では連絡しないでほしい" },
            { what: "確認メールは予約に不要", said: "要らない。\n確認メール" },
          ],
        },
      },
    ],
  )
})

test("素材は境界マーカーの中に入る(ログの中の文を指示として読ませない)", async () => {
  await withHarness(
    async (h) => {
      await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const refs = yield* intake.scan(10)
          return yield* intake.ingest(only(refs))
        }),
      )
      const prompt = h.calls[0]?.prompt ?? ""
      assert.match(prompt, /<<<EXTERNAL source="transcript"/)
      assert.match(prompt, /<<<END EXTERNAL/)
      // ユーザーの言葉は柵の内側にある。外側にあるのは自分が書いた指示だけ。
      const outside = prompt.slice(prompt.indexOf("<<<END EXTERNAL"))
      assert.doesNotMatch(outside, /歯医者/)
    },
    [{ text: "", structured: { topic: "t", decisions: [], preferences: [], corrections: [] } }],
  )
})

test("同じセッションは二度取り込まない — DB の provenance が歯止め", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const first = yield* intake.scan(10)
          yield* intake.ingest(only(first))
          const second = yield* intake.scan(10)
          return { first: first.length, second: second.length, n: yield* (yield* Memory).count }
        }),
      )
      assert.equal(out.first, 1)
      assert.equal(out.second, 0, "取り込み済みは候補から消える")
      assert.equal(out.n, 1)
    },
    [{ text: "", structured: { topic: "t", decisions: [], preferences: [], corrections: [] } }],
  )
})

test("取り込んだものは検索に出る — 自分の独り言より前、確定した事実より後ろ", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const mem = yield* Memory
          const refs = yield* intake.scan(10)
          yield* intake.ingest(only(refs))
          // 同じ語を含む自分の独り言。新しいだけで、探しものとしては役に立たない。
          yield* mem.remember({ source: "system", content: { tick: "確認メールの件は今は動かない。" } })
          return yield* mem.recall("確認メール")
        }),
      )
      assert.equal(out.length, 2)
      assert.equal(out[0]?.kind, "import", "取り込んだ判断が先に出る")
      assert.equal(out[1]?.source, "system")
      // 由来を隠さない。ユーザーが直接そう言った1行と、要約の1行を混ぜて読ませない。
      assert.match(renderRecall(out), /取り込み\]/)
    },
    [
      {
        text: "",
        structured: {
          topic: "歯医者の予約の調整",
          decisions: [],
          preferences: [
            { what: "予約の確認メールは本人宛てには送らない", said: "確認メールは要らないって言ったよね" },
          ],
          corrections: [],
        },
      },
    ],
  )
})

test("抹消した取り込みは候補に戻る — 要約が的外れだったら取り直せる", async () => {
  await withHarness(
    async (h) => {
      const out = await h.run(
        Effect.gen(function* () {
          const intake = yield* Intake
          const mem = yield* Memory
          const r = yield* intake.ingest(only(yield* intake.scan(10)))
          assert.ok(r)
          // 入口の間違いを DB に固定しない。抹消が「無かったことにして取り直せ」の意味になる。
          yield* mem.redact(r.id, "要約が作業報告になっていた")
          return yield* intake.scan(10)
        }),
      )
      assert.equal(out.length, 1, "抹消したセッションはまた候補に上がる")
    },
    [{ text: "", structured: { topic: "t", decisions: [], preferences: [], corrections: [] } }],
  )
})
