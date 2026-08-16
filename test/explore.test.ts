/**
 * 調査モード(.ward/plans/005)の検査。分岐の隔離・締切による道具の絞り・重複の可視化と、
 * explore dossier の記録規律(空振りも予想も evidence 検証も)を見る。
 * 分岐ループの実走はモデルが要るのでここでは見ない — 実走は evaluate:explore が担う。
 */

import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import {
  activeToolsFor,
  branchBrief,
  EXPLORE_TRANSFORMS,
  findDuplicates,
  salvageClaims,
  TRANSFORM_GOAL,
  wideInstructions,
} from "../src/agent/explore.ts"
import { Research } from "../src/services/Research.ts"
import { withHarness } from "./helpers.ts"

test("変形は7種で、分岐ブリーフは種と自分の変形しか含まない", () => {
  assert.equal(EXPLORE_TRANSFORMS.length, 7)
  const seed = "エージェントの自走が空回りする条件"
  for (const transform of EXPLORE_TRANSFORMS) {
    const brief = branchBrief(seed, transform)
    assert.ok(brief.includes(seed), transform)
    assert.ok(brief.includes(TRANSFORM_GOAL[transform]), transform)
    // 兄弟の変形の目標文言が混ざっていない。混ざると分岐の独立が壊れる。
    for (const other of EXPLORE_TRANSFORMS) {
      if (other === transform) continue
      assert.ok(!brief.includes(TRANSFORM_GOAL[other]), `${transform} に ${other} が混ざった`)
    }
  }
})

test("wide の指示は目標件数を持つ", () => {
  assert.ok(wideInstructions(12).includes("12 件"))
})

test("残り時間で道具が絞られる", () => {
  assert.equal(activeToolsFor(300_000), undefined) // 余裕あり: 制限なし
  assert.deepEqual(activeToolsFor(60_000), ["search"]) // fetch(20秒級)を止める
  assert.deepEqual(activeToolsFor(30_000), []) // 手持ちで書かせる
})

test("重複は兄弟間だけを数え、消さずに一覧で返す", () => {
  const branch = (transform: (typeof EXPLORE_TRANSFORMS)[number], statements: string[]) => ({
    transform,
    output: {
      empty: statements.length === 0,
      summary: "",
      limitations: "",
      claims: statements.map((statement) => ({
        statement,
        kind: "observation" as const,
        evidence: [],
      })),
    },
    snapshots: [],
    steps: 0,
    elapsedMs: 0,
  })
  const duplicates = findDuplicates([
    branch("direct", ["POA と POD の分離", "同一分岐内の重複", "同一分岐内の重複"]),
    branch("distant", ["POAとPODの分離"]), // 空白と句読点の揺れは同じ候補として数える
    branch("falsify", []),
  ])
  assert.equal(duplicates.length, 1)
  assert.deepEqual(duplicates[0]?.transforms, ["direct", "distant"])
})

test("explore dossier は予想・空振り・失敗・重複を残し、inconclusive で終端化する", async () => {
  await withHarness(async (h) => {
    const body = "計測位置が解決率を分ける。ENTRY 69% / COMPONENT 4%。"
    const { id } = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        return yield* research.recordExploreDossier({
          seed: "エージェントの自走が空回りする条件",
          prediction: "冷却の設計が主因と出るはず",
          exclusions: ["ハードウェア障害"],
          branches: [
            {
              transform: "direct",
              empty: false,
              summary: "測定位置の議論に当たった",
              limitations: "1件だけ",
              snapshots: [
                { url: "https://example.com/a", content: body, status: 200 },
                // 失敗した取得は artifact にしない(quote の当たり先にもならない)
                { url: "https://example.com/404", content: "", status: 404 },
              ],
              claims: [
                {
                  statement: "計測位置が解決率を分ける",
                  kind: "observation",
                  evidence: [{ url: "https://example.com/a", quote: "ENTRY 69%", polarity: "support" }],
                },
              ],
            },
            {
              transform: "falsify",
              empty: true,
              summary: "反証は見つからず",
              limitations: "",
              snapshots: [],
              claims: [],
            },
            {
              transform: "human",
              empty: true,
              summary: "分岐が失敗した: timeout",
              limitations: "実行失敗。結果なし。",
              failed: "timeout",
              snapshots: [],
              claims: [],
            },
          ],
          duplicates: [{ statement: "計測位置が解決率を分ける", transforms: ["direct", "distant"] }],
        })
      }),
    )
    const rows = await h.run(
      Effect.gen(function* () {
        const research = yield* Research
        return yield* research.bundle(id)
      }),
    )
    const dossier = rows.dossier as { state?: unknown } | undefined
    assert.equal(dossier?.state, "inconclusive") // 統合前 — conclusion は分岐の仕事ではない
    const claims = rows.claims as { statement: string; state: string }[]
    const texts = claims.map((c) => c.statement)
    assert.ok(texts.some((t) => t.startsWith("[explore:予想]")))
    assert.ok(texts.some((t) => t.startsWith("[explore:除外予定]")))
    assert.ok(texts.some((t) => t.includes("[explore:falsify] 空振り")))
    assert.ok(texts.some((t) => t.includes("[explore:human] 失敗")))
    assert.ok(texts.some((t) => t.startsWith("[explore:重複]")))
    const substantive = claims.find((c) => c.statement === "[direct] 計測位置が解決率を分ける")
    assert.equal(substantive?.state, "supported")
  })
})

test("explore dossier は snapshot に無い quote を拒否する", async () => {
  await withHarness(async (h) => {
    const error = await h
      .run(
        Effect.gen(function* () {
          const research = yield* Research
          return yield* research.recordExploreDossier({
            seed: "seed",
            branches: [
              {
                transform: "direct",
                empty: false,
                summary: "s",
                limitations: "",
                snapshots: [{ url: "https://example.com/a", content: "本文", status: 200 }],
                claims: [
                  {
                    statement: "捏造",
                    kind: "observation",
                    evidence: [
                      { url: "https://example.com/a", quote: "本文に無い引用", polarity: "support" },
                    ],
                  },
                ],
              },
            ],
            duplicates: [],
          })
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    assert.match(String(error), /not present in fetched snapshot/)
  })
})

/**
 * 引用の救済。照合失敗1件で委譲まるごとを捨てない — 照合できた claim は残し、
 * 落とした分は文の一覧で返す(limitations 行き)。捏造を通さない砦は記録側に残る。
 */
test("照合できない claim は落とし、できた分だけ残す", () => {
  const snapshots = [{ url: "https://a", content: "実在する本文", status: 200 }]
  const { kept, dropped } = salvageClaims(
    [
      {
        statement: "実在",
        evidence: [
          { url: "https://a", quote: "実在する本文" },
          { url: "https://a", quote: "無い引用" }, // この evidence だけ落ちる
        ],
      },
      { statement: "捏造", evidence: [{ url: "https://a", quote: "全部無い" }] },
      { statement: "取得失敗先", evidence: [{ url: "https://404", quote: "実在する本文" }] },
    ],
    snapshots,
  )
  assert.equal(kept.length, 1)
  assert.deepEqual(kept[0]?.evidence, [{ url: "https://a", quote: "実在する本文" }])
  assert.deepEqual(dropped, ["捏造", "取得失敗先"])
})
