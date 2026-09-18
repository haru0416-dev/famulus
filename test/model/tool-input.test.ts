/** モデルが返した引数が検証されずに `execute` へ入る回帰を防ぐ。 */

import assert from "node:assert/strict"
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { Experimental_Agent as Agent, stepCountIs, tool } from "ai"
import * as v from "valibot"
import { test } from "vitest"
import { vs } from "../../src/model/schema.ts"

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

test("落ちた呼び出しは tool-error として積まれ、turn は続く", async () => {
  const { res } = await run(JSON.stringify({ hours: "24", reason: "眠い" }))
  assert.equal(res.text, "終わり")
  const parts = res.steps.flatMap((s) => s.content)
  const err = parts.find((p) => p.type === "tool-error")
  assert.ok(err, "tool-error が積まれていない")
  assert.match(String((err as { error?: unknown }).error), /snooze/)
})

/** valibot の `object` は未知の鍵を値から外す。 */
test("正しい引数は解析済みの値で渡り、余計な鍵は落ちる", async () => {
  const { got } = await run(JSON.stringify({ hours: 24, reason: "眠い", extra: "余計な鍵" }))
  assert.deepEqual(got, { hours: 24, reason: "眠い" })
})
