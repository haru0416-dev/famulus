#!/usr/bin/env bun
/**
 * 対話の入口。**人が口を開いて動かす側**(自走は src/tick.ts)。
 *
 * 前はフレームワークが持っていた REPL を使っていた。それが無くなったので、要るものだけを置く:
 * 1行読んで1ターン答え、既読位置を進める。それだけ。
 *
 *   pnpm agent            … 対話を始める
 *   /reset                … 会話を捨てて次から新しく始める
 *   /q(または Ctrl-D)   … 終わる
 *
 * **枠は対話側**(`OPEN_ZERO_LANE` を立てない)。自走とは日次 run 数の内訳が分かれる。
 * 締切は付けない — 待っているのは人で、切る判断はその人がする(Ctrl-C)。
 */
import { createInterface } from "node:readline/promises"
import { Effect } from "effect"
import { createAssistant } from "./agent/assistant.ts"
import { loadEnv } from "./core/env.ts"
import { run, runtime } from "./runtime.ts"
import { Attention } from "./services/Attention.ts"

loadEnv()

const rt = runtime()
const assistant = createAssistant()
const rl = createInterface({ input: process.stdin, output: process.stdout })

console.log(`open-zero(${assistant.modelId})— /reset で会話を捨てる、/q で終わる`)

try {
  while (true) {
    const line = (await rl.question("> ").catch(() => null))?.trim()
    if (line === undefined || line === null || line === "/q" || line === "/quit") break
    if (line === "") continue
    if (line === "/reset") {
      assistant.reset()
      console.log("(会話を捨てた)")
      continue
    }

    // **切るのは人。** Ctrl-C を1回押したらこのターンだけ止め、REPL は残す。
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

    // **既読位置はターンごとに進める。** 進めないと、いま自分で答えた入力が
    // 次の tick で「まだ見ていない入力」として上がり、同じ話にもう一度起きる。
    await run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.commit()
      }),
    ).catch(() => {})
  }
} finally {
  rl.close()
  await rt.dispose()
}
