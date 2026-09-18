#!/usr/bin/env bun
/**
 * 対話の入口(自走は src/cycle.ts)。run 数は対話の枠で計上する。
 * 締切は付けない。止める判断は待っている人がする(Ctrl-C)。
 */
import { createInterface } from "node:readline/promises"
import * as Effect from "effect/Effect"
import { createAssistant } from "./agent/assistant.ts"
import { KEEP_MS, keep } from "./agent/keeper.ts"
import { configureApp } from "./core/config.ts"
import { loadEnv } from "./core/env.ts"
import { causeReason } from "./core/errors.ts"
import { run, runtime } from "./runtime.ts"
import { Memory } from "./services/Memory.ts"

loadEnv()
configureApp()

const rt = runtime()
const assistant = createAssistant({ inputOriginKind: "chat" })
const rl = createInterface({ input: process.stdin, output: process.stdout })

/**
 * 入力の終わり(Ctrl-D / パイプの尽き)を2通りとも受ける。待機中に閉じると `question` は解決も棄却も
 * されずに止まるので signal で棄却にする。閉じた後に呼ぶと同期で例外になるので try で受ける。
 */
const closed = new AbortController()
rl.on("close", () => closed.abort())

console.log(`famulus(${assistant.modelId})— /reset で会話を捨てる、/q で終わる`)

try {
  while (true) {
    let asked: string
    try {
      asked = await rl.question("> ", { signal: closed.signal })
    } catch {
      break
    }
    const line = asked.trim()
    if (line === "/q" || line === "/quit") break
    if (line === "") continue
    if (line === "/reset") {
      assistant.reset()
      console.log("(会話を捨てた)")
      continue
    }

    // Ctrl-C 1回ではこのターンだけ止め、REPL は残す。
    const stop = new AbortController()
    const onSigint = () => stop.abort(new Error("Ctrl-C で止めた"))
    process.on("SIGINT", onSigint)
    let turn: Awaited<ReturnType<typeof assistant.respond>>
    try {
      turn = await assistant.respond(line, { signal: stop.signal })
    } finally {
      process.off("SIGINT", onSigint)
    }

    if (turn.text) console.log(`\n${turn.text}\n`)
    if (turn.cutOff) console.log(`(止まった: ${turn.cutOff})\n`)

    // cycle だけで keeper を通すと、REPL で明言された値が確定記憶へ上がらない。
    // 返信は先に表示し、keeper の完了後に次の入力を受ける。
    if (!turn.cutOff) {
      const kept = await run(
        keep({
          material: `owner: ${line}`,
          ...(turn.inputEventId
            ? {
                evidence: [{ id: turn.inputEventId, text: `owner: ${line}` }],
                executionOwner: { kind: "owner-event", id: turn.inputEventId },
              }
            : {}),
          signal: AbortSignal.timeout(KEEP_MS),
        }),
      ).catch((e: unknown) => `keeper: 落ちた(${causeReason(e)})`)
      await run(
        Effect.gen(function* () {
          const mem = yield* Memory
          yield* mem.remember({ source: "system", content: { keeper: kept }, text: "" })
        }),
      ).catch(() => {})
    }
  }
} finally {
  rl.close()
  await rt.dispose()
}
