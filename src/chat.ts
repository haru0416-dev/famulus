#!/usr/bin/env bun
/**
 * 対話の入口。人が打って動かす側(自走は src/cycle.ts)。
 *
 * 前はフレームワークが持っていた REPL を使っていた。それが無くなったので、要るものだけを置く:
 * 1行読んで1ターン答え、既読位置を進める。それだけ。
 *
 *   bun run agent         … 対話を始める
 *   /reset                … 会話を捨てて次から新しく始める
 *   /q(または Ctrl-D)   … 終わる
 *
 * 枠は対話側。自走とは日次 run 数の内訳が分かれる。
 * 締切は付けない — 待っているのは人で、切る判断はその人がする(Ctrl-C)。
 */
import { createInterface } from "node:readline/promises"
import * as Effect from "effect/Effect"
import { createAssistant } from "./agent/assistant.ts"
import { KEEP_MS, keep } from "./agent/keeper.ts"
import { configureApp } from "./core/config.ts"
import { loadEnv } from "./core/env.ts"
import { causeReason } from "./core/errors.ts"
import { run, runtime } from "./runtime.ts"
import { Attention } from "./services/Attention.ts"
import { Memory } from "./services/Memory.ts"

loadEnv()
configureApp()

const rt = runtime()
const assistant = createAssistant()
const rl = createInterface({ input: process.stdin, output: process.stdout })

/**
 * 入力の終わり(Ctrl-D / パイプの尽き)を2通りとも受ける。
 *
 * 待っている最中に閉じると `question` の約束は解決も棄却もされず、そのまま止まる。
 * 閉じた後に呼ぶと同期で投げる(`ERR_USE_AFTER_CLOSE`)ので `.catch()` では捕まらない。
 * 前者を signal で棄却に変え、後者を try で受ける。どちらも「終わる」1本に落とす。
 */
const closed = new AbortController()
rl.on("close", () => closed.abort())

console.log(`open-zero(${assistant.modelId})— /reset で会話を捨てる、/q で終わる`)

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

    // 切るのは人。Ctrl-C を1回押したらこのターンだけ止め、REPL は残す。
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

    // 対話の入口でも締めの keeper を通す。cycle だけに置くと、REPL で明言された値が
    // 確定記憶へ上がらない。返信は先に表示し、keeper が終わってから次の入力を受ける。
    if (!turn.cutOff) {
      const kept = await run(
        keep({
          material: `owner: ${line}`,
          ...(turn.inputEventId ? { evidence: [{ id: turn.inputEventId, text: `owner: ${line}` }] } : {}),
          ...(turn.inputEventId ? { executionOwner: { kind: "owner-event", id: turn.inputEventId } } : {}),
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

    // 既読位置はターンごとに進める。進めないと、いま自分で答えた入力が
    // 次の cycle で「まだ見ていない入力」として上がり、同じ話にもう一度起きる。
    await run(
      Effect.gen(function* () {
        const att = yield* Attention
        yield* att.completeCycle()
      }),
    ).catch(() => {})
  }
} finally {
  rl.close()
  await rt.dispose()
}
