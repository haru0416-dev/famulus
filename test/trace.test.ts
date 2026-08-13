/**
 * DB に残る1行が、後から「何をしたか」を読めるかを見る。
 *
 * 元の実装は返り値を頭から 200字で切っていた。構造化経路の返り値は
 * `{"text":…,"toolCalls":[…]}` の順なので、発話が長い回ほど道具呼び出しが丸ごと消える。
 * 実際に tick を1回走らせたとき、`task` を2つ投げた記録が読めなかった。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { traceOf } from "../src/model/trace.ts"

test("発話が長くても道具呼び出しが残る", () => {
  const raw = JSON.stringify({
    text: "あ".repeat(800),
    toolCalls: [
      { name: "recall", arguments: { query: "Show HN" } },
      { name: "task", arguments: { agent: "researcher", prompt: "い".repeat(500) } },
    ],
  })
  const out = traceOf(raw)
  assert.ok(out.includes("recall(query=Show HN)"), `recall が消えている:\n${out}`)
  assert.ok(out.includes("agent=researcher"), `task の宛先が消えている:\n${out}`)
  assert.ok(out.length < raw.length, "畳めていない")
})

test("同じ道具を複数投げたら、その数だけ行が立つ", () => {
  const out = traceOf(
    JSON.stringify({
      text: "入口を2つに割る",
      toolCalls: [
        { name: "task", arguments: { agent: "researcher", prompt: "新着" } },
        { name: "task", arguments: { agent: "researcher", prompt: "front page" } },
      ],
    }),
  )
  assert.equal(out.split("\n").filter((l) => l.startsWith("→ task")).length, 2, out)
})

test("道具を呼ばない回は発話だけが残る", () => {
  const out = traceOf(JSON.stringify({ text: "今は動かない。理由は材料が無いから", toolCalls: [] }))
  assert.equal(out, "今は動かない。理由は材料が無いから")
})

test("構造化されていない返り値はそのまま扱う", () => {
  assert.equal(traceOf("ただの文"), "ただの文")
  assert.equal(traceOf('{"text":"道具の欄が無い JSON"}'), '{"text":"道具の欄が無い JSON"}')
})

test("1行が青天井にならない", () => {
  const out = traceOf(
    JSON.stringify({
      text: "あ".repeat(2000),
      toolCalls: Array.from({ length: 50 }, () => ({ name: "shell", arguments: { cmd: "x".repeat(500) } })),
    }),
  )
  assert.ok(out.length <= 4001, `${out.length} 字`)
})
