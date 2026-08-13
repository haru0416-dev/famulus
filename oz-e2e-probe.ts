/** 端から端まで。外を見る役が実際に開いた URL を、global fetch を包んで数える。 */
import { createAssistant } from "./src/agent/assistant.ts"
import { runtime } from "./src/runtime.ts"

const hits: string[] = []
const orig = globalThis.fetch
const started = Date.now()
const trace = (s: string): void => {
  hits.push(s)
  console.error(`[+${Math.round((Date.now() - started) / 1000)}s] ${s}`)
}
globalThis.fetch = async (input: RequestInfo | URL, init2?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input)
  const t0 = Date.now()
  try {
    const res = await orig(input, init2)
    trace(`${res.status} ${Date.now() - t0}ms ${decodeURIComponent(u).slice(0, 220)}`)
    return res
  } catch (e) {
    trace(`ERR ${decodeURIComponent(u).slice(0, 220)} — ${(e as Error).message}`)
    throw e
  }
}

const rt = runtime()
const t0 = Date.now()
try {
  const assistant = createAssistant()
  const turn = await assistant.respond(process.argv[2] ?? "", {
    signal: AbortSignal.timeout(900_000),
  })
  console.log(`\n=== ${Math.round((Date.now() - t0) / 1000)}s / ${turn.steps} 手 ===`)
  console.log(turn.text || "(発話なし)")
  if (turn.cutOff) console.log(`止まった: ${turn.cutOff}`)
} finally {
  const uniq = new Set(hits.map((h) => h.replace(/^\S+ \S+ /, "")))
  console.log(`\n=== 外へ出た ${hits.length} 回 / 相異なる URL ${uniq.size} ===`)
  for (const h of hits) console.log(h)
  await rt.dispose()
}
