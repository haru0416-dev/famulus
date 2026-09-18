/**
 * Effect は `ManagedRuntime` の中に閉じ、外へは拒否が例外として出るだけにする。
 * Db が Layer の最下層なので、テストは `makeRuntime(DbLive(":memory:"))` で同じ配線を走らせられる。
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { type DbFailed, describeRefusal, type Refusal } from "./core/errors.ts"
import { type Runner, RunnerLive } from "./model/Runner.ts"
import { Attention } from "./services/Attention.ts"
import { CycleLease } from "./services/CycleLease.ts"
import { type Db, DbLive } from "./services/Db.ts"
import { Discord } from "./services/Discord.ts"
import { Drafts } from "./services/Drafts.ts"
import { ExecutionKernel } from "./services/ExecutionKernel.ts"
import { Governance } from "./services/Governance.ts"
import { Intake } from "./services/Intake.ts"
import { Ledger } from "./services/Ledger.ts"
import { Memory } from "./services/Memory.ts"
import { Proposals } from "./services/Proposals.ts"
import { Research } from "./services/Research.ts"

const services = Layer.mergeAll(
  Governance.layer,
  Memory.layer,
  Ledger.layer,
  Proposals.layer,
  Attention.layer,
  CycleLease.layer,
  Intake.layer,
  Discord.layer,
  Drafts.layer,
  ExecutionKernel.layer,
  Research.layer,
)

/** `runner` を差し替えると `claude` を呼ばない構成になる(テストは `RunnerStub([...]).layer`)。 */
export type DbLayer = Layer.Layer<Db, DbFailed>
export type RunnerLayer = Layer.Layer<Runner, never, Governance | Ledger | ExecutionKernel>

export const makeAppLayer = (db: DbLayer = DbLive(), runner: RunnerLayer = RunnerLive) =>
  Layer.provideMerge(runner, Layer.provideMerge(services, db))

export const makeRuntime = (db: DbLayer = DbLive(), runner: RunnerLayer = RunnerLive) =>
  ManagedRuntime.make(makeAppLayer(db, runner))

export type AppRuntime = ReturnType<typeof makeRuntime>

/** プロセスに1つ。差し替えは `run(effect, rt)` の第2引数だけ。 */
let current: AppRuntime | undefined
export const runtime = (): AppRuntime => {
  current ??= makeRuntime()
  return current
}

const REFUSAL_TAGS = new Set(["Halt", "QuotaCooldown", "DailyRunLimit", "DeliveryRejected"])

class RefusedError extends Error {
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

export type AppServices =
  | Db
  | Governance
  | Memory
  | Ledger
  | Proposals
  | Attention
  | CycleLease
  | Intake
  | Discord
  | Drafts
  | ExecutionKernel
  | Research
  | Runner

export function run<A, E>(effect: Effect.Effect<A, E, AppServices>, rt: AppRuntime = runtime()): Promise<A> {
  return rt.runPromise(
    effect.pipe(
      Effect.catch((e) => (isRefusal(e) ? Effect.die(new RefusedError(e)) : Effect.fail(e))),
    ) as Effect.Effect<A, E, AppServices>,
  )
}
