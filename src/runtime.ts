/**
 * Layer の合成と、Flue の async フックから Effect を呼ぶための橋。
 *
 * Flue のフックは `Promise<void>` を返す普通の非同期関数なので、Effect はここで
 * `ManagedRuntime` に閉じ込めて `runPromise` で渡す。**エフェクトを外へ漏らさない**のが要点で、
 * エージェント側のコードは「拒否は例外として飛んでくる」だけを知っていればよい。
 *
 * Db を Layer の一番下に置いてあるので、テストは `makeRuntime(DbLive(":memory:"))` で
 * 実 DB に触らずに同じ配線を走らせられる(スキーマもトリガも本物のまま)。
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import { type DbFailed, describeRefusal, type Refusal } from "./core/errors.ts"
import { type Runner, RunnerClaudeCli } from "./model/Runner.ts"
import { Attention } from "./services/Attention.ts"
import { type Db, DbLive } from "./services/Db.ts"
import { Discord } from "./services/Discord.ts"
import { Governance } from "./services/Governance.ts"
import { Intake } from "./services/Intake.ts"
import { Ledger } from "./services/Ledger.ts"
import { Memory } from "./services/Memory.ts"
import { Proposals } from "./services/Proposals.ts"

/** Db の上に載る素のサービス群。 */
const services = Layer.mergeAll(
  Governance.Default,
  Memory.Default,
  Ledger.Default,
  Proposals.Default,
  Attention.Default,
  Intake.Default,
  Discord.Default,
)

/**
 * アプリ全体の Layer。`runner` を差し替えれば `claude` を呼ばない構成にできる
 * (テストは `RunnerStub([...]).layer` を渡す)。
 */
export type DbLayer = Layer.Layer<Db, DbFailed>
export type RunnerLayer = Layer.Layer<Runner, never, Governance | Ledger>

export const makeAppLayer = (db: DbLayer = DbLive(), runner: RunnerLayer = RunnerClaudeCli) =>
  Layer.provideMerge(runner, Layer.provideMerge(services, db))

export const makeRuntime = (db: DbLayer = DbLive(), runner: RunnerLayer = RunnerClaudeCli) =>
  ManagedRuntime.make(makeAppLayer(db, runner))

export type AppRuntime = ReturnType<typeof makeRuntime>

/**
 * 既定のランタイム。プロセスに1つ。
 * 差し替えの経路は `run(effect, rt)` の第2引数だけにしてある。
 * 入口を2つ持つと、どちらが効いているのかを読んで確かめないと分からなくなる。
 */
let current: AppRuntime | undefined
export const runtime = (): AppRuntime => {
  current ??= makeRuntime()
  return current
}

const REFUSAL_TAGS = new Set([
  "Halt",
  "QuotaCooldown",
  "DailyRunLimit",
  "UnpricedModel",
  "EgressDenied",
  "DeliveryRejected",
])

/** 拒否を人間に読める Error にして投げる。Flue のフックはこれを見て submission を止める。 */
export class RefusedError extends Error {
  readonly refusal: Refusal
  constructor(refusal: Refusal) {
    super(describeRefusal(refusal))
    this.name = "RefusedError"
    this.refusal = refusal
  }
}

export function isRefusal(e: unknown): e is Refusal {
  return typeof e === "object" && e !== null && "_tag" in e && REFUSAL_TAGS.has(String(e._tag))
}

/**
 * Flue のフック本体から Effect を走らせる。拒否は `RefusedError` に翻訳して投げる
 * — フックが throw すると Flue はモデルを呼ぶ前に submission を落とすので、
 * **ゲートが実際にモデル呼び出しを止める**のはここ。
 */
export type AppServices =
  | Db
  | Governance
  | Memory
  | Ledger
  | Proposals
  | Attention
  | Intake
  | Discord
  | Runner

export function run<A, E>(effect: Effect.Effect<A, E, AppServices>, rt: AppRuntime = runtime()): Promise<A> {
  return rt.runPromise(
    effect.pipe(
      Effect.catchAll((e) => (isRefusal(e) ? Effect.die(new RefusedError(e)) : Effect.fail(e))),
    ) as Effect.Effect<A, E, AppServices>,
  )
}
