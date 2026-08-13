/**
 * 道具の入力が実行の手前で検証されるかを、loop を1回転させて見る。
 *
 * `vs()` に `validate` が無かった間、モデルが返した引数は何の検査も受けずに `execute` へ入っていた。
 * 実測(2026-08-13): `{"hours":"24","extra":"余計な鍵"}` を返させると、`hours` は文字列のまま、
 * 必須の `reason` は `undefined` のまま道具が走り、結果は「成功」として記録された。
 * valibot のスキーマは JSON Schema を作るためだけに使われていた(docs/adr/0025)。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { Experimental_Agent as Agent, stepCountIs, tool } from "ai"
import * as v from "valibot"
import { vs } from "../src/model/schema.ts"

/** 1回目に `input` をそのまま返し、2回目で終わる偽モデル。 */
const fakeModel = (input: string): LanguageModelV4 => {
  let step = 0
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  }
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "fake",
    supportedUrls: {},
    async doGenerate() {
      step += 1
      if (step === 1) {
        return {
          content: [{ type: "tool-call" as const, toolCallId: "t1", toolName: "snooze", input }],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        }
      }
      return {
        content: [{ type: "text" as const, text: "終わり" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      }
    },
    async doStream(): Promise<{ stream: ReadableStream<LanguageModelV4StreamPart> }> {
      throw new Error("この検査では使わない")
    },
  }
}

const run = async (input: string) => {
  let got: unknown
  const agent = new Agent({
    model: fakeModel(input),
    tools: {
      snooze: tool({
        description: "指定時間だけ止める",
        inputSchema: vs(
          v.object({
            hours: v.pipe(v.number(), v.description("止める時間")),
            reason: v.pipe(v.string(), v.description("理由")),
          }),
        ),
        execute: async (i) => {
          got = i
          return "ok"
        },
      }),
    },
    stopWhen: stepCountIs(4),
    maxRetries: 0,
  })
  const res = await agent.generate({ prompt: "止めて" })
  return { got, res }
}

test("型の合わない引数では道具を走らせない", async () => {
  const { got, res } = await run(JSON.stringify({ hours: "24", reason: "眠い" }))
  assert.equal(got, undefined, "execute が呼ばれている")
  assert.deepEqual(res.toolResults, [])
})

test("必須が欠けていても道具を走らせない", async () => {
  const { got } = await run(JSON.stringify({ hours: 24 }))
  assert.equal(got, undefined, "execute が呼ばれている")
})

/** 落ちても turn は止まらない。指摘が次の呼び出しに載るので、同じ turn の中で呼び直せる。 */
test("落ちた呼び出しは tool-error として積まれ、turn は続く", async () => {
  const { res } = await run(JSON.stringify({ hours: "24", reason: "眠い" }))
  assert.equal(res.text, "終わり")
  const parts = res.steps.flatMap((s) => s.content)
  const err = parts.find((p) => p.type === "tool-error")
  assert.ok(err, "tool-error が積まれていない")
  assert.match(String((err as { error?: unknown }).error), /snooze/)
})

/** スキーマに無い鍵は落とさず捨てる。valibot の `object` は未知の鍵を通さず、値から外す。 */
test("正しい引数は解析済みの値で渡り、余計な鍵は落ちる", async () => {
  const { got } = await run(JSON.stringify({ hours: 24, reason: "眠い", extra: "余計な鍵" }))
  assert.deepEqual(got, { hours: 24, reason: "眠い" })
})
