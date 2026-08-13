/**
 * テスト用の配線。API キーも `claude` バイナリも要らない。
 *
 * DB は `:memory:` だが本物の SQLite で、schema.sql をそのまま適用している
 * (append-only トリガも FTS5 trigram も本物)。Runner だけ Stub 層に差し替える。
 * つまり「ゲートが実際にモデル呼び出しを止めるか」を、モデルを呼ばずに端から端まで検査できる。
 */
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
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
