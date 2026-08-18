/**
 * テスト用の配線。API キーも `claude` バイナリも要らない。
 *
 * DB は `:memory:` だが本物の SQLite で、schema.sql をそのまま適用している
 * (append-only トリガも FTS5 trigram も本物)。Runner だけ Stub 層に差し替える。
 * つまり「ゲートが実際にモデル呼び出しを止めるか」を、モデルを呼ばずに端から端まで検査できる。
 */
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

/**
 * migration 台帳より前(v4)の schema SQL。現行 schema から、以後の migration が加えた差を
 * 文字列の段階で戻す — LEGACY_V4_SCHEMA_FINGERPRINT と一致させるため。
 * migration を足したら、その差をここでも戻すこと。
 */
export const legacyV4Sql = (schemaSql: string): string =>
  schemaSql
    .replace(
      "kind        TEXT NOT NULL CHECK (kind IN ('open_dm','message','thread','reaction','ack')),",
      "kind        TEXT NOT NULL CHECK (kind IN ('open_dm','message','thread','reaction')),",
    )
    .replace(/\n-- 意味検索の索引。[\s\S]*?\) STRICT;\n/, "\n")
    .replace(
      `         review_feedback = CASE WHEN NEW.state = 'sent' THEN review_feedback ELSE NEW.error END,
         decision_origin_id = NULL,
         updated_at = NEW.updated_at
   WHERE state IN ('review_pending','delivery_pending')
     AND (outbound_id = NEW.id OR (outbound_id IS NULL AND NEW.purpose = 'assistant-draft'
          AND id = substr(NEW.dedupe_key, 1, 36)));`,
      `         review_feedback = CASE WHEN NEW.state = 'sent' THEN review_feedback ELSE NEW.error END,
         updated_at = NEW.updated_at
   WHERE state IN ('review_pending','delivery_pending')
     AND (outbound_id = NEW.id OR (outbound_id IS NULL AND NEW.purpose = 'assistant-draft' AND id = NEW.dedupe_key));`,
    )
