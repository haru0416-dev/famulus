/**
 * テスト用の配線。API キーも `claude` バイナリも要らない。
 *
 * DB は `:memory:` だが本物の SQLite で、schema.sql をそのまま適用している
 * (append-only トリガも FTS5 trigram も本物)。Runner だけ Stub 層に差し替える。
 * つまり「ゲートが実際にモデル呼び出しを止めるか」を、モデルを呼ばずに端から端まで検査できる。
 */
import { readFileSync } from "node:fs"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { configureApp } from "../src/core/config.ts"
import { RunnerStub, type StubReply } from "../src/model/Runner.ts"
import { type AppServices, makeAppLayer } from "../src/runtime.ts"
import { DbLive } from "../src/services/Db.ts"

export interface Harness {
  readonly calls: ReturnType<typeof RunnerStub>["calls"]
  readonly run: <A, E>(e: Effect.Effect<A, E, AppServices>) => Promise<A>
  readonly fail: <A, E>(e: Effect.Effect<A, E, AppServices>) => Promise<E>
  readonly dispose: () => Promise<void>
}

export const harness = (script: readonly StubReply[] = [{ text: "ok" }]): Harness => {
  configureApp()
  const stub = RunnerStub(script)
  const rt = ManagedRuntime.make(makeAppLayer(DbLive(":memory:"), stub.layer))
  return {
    calls: stub.calls,
    run: (e) => rt.runPromise(e),
    fail: (e) => rt.runPromise(Effect.flip(e)),
    dispose: () => rt.dispose(),
  }
}

export const withHarness = async (
  fn: (h: Harness) => Promise<void>,
  script?: readonly StubReply[],
): Promise<void> => {
  const h = harness(script)
  try {
    await fn(h)
  } finally {
    await h.dispose()
  }
}

/**
 * assistant のソースから登録済み道具名を採る。
 *
 * 拾う形は2つ: 表に直接置いたもの(`remember: tool({`)と、変数に切り出したものを
 * 表に差したもの(`recall: recallTool(state)` / `search: searchTool`)。
 * 子に渡す表も同じ書き方なので、1つの正規表現で両方が採れる。
 */
export function registeredTools(): Set<string> {
  const src = readFileSync(new URL("../src/agent/assistant.ts", import.meta.url), "utf8")
  const names = [...src.matchAll(/\b([a-z][a-z0-9_]*):\s*(?:tool\(\{|[a-zA-Z_]*[Tt]ool\b)/g)].map(
    (m) => m[1] as string,
  )
  if (names.length <= 5)
    throw new Error(`道具が採れていない(${names.length}件)— 登録の書き方が変わった可能性`)
  return new Set(names)
}

/** `globalThis.fetch` を差し替えて本文を回し、終わりに必ず戻す。 */
export const withFetch = async <T>(impl: unknown, fn: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = impl as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}
