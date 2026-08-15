import { randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  CycleLeaseHeld,
  CycleLeaseLost,
  CycleLeaseRecoveryUncertain,
  type DbFailed,
  ProcessIdentityUnavailable,
} from "../core/errors.ts"
import {
  currentProcessIncarnation,
  type IncarnationLiveness,
  incarnationLiveness,
  type ProcessIncarnation,
} from "../core/process-incarnation.ts"
import { Db, type DbTx, isThenable, type Row } from "./Db.ts"

export interface CycleLeaseToken {
  readonly leaseName: "cycle"
  readonly ownerId: string
  readonly fence: number
  readonly incarnation: ProcessIncarnation
  readonly acquiredAtMs: number
}

export interface CycleLeaseRow extends Row {
  readonly lease_name: "cycle"
  readonly state: "free" | "held" | "released"
  readonly fence: number
  readonly owner_id: string | null
  readonly owner_host_id: string | null
  readonly owner_boot_id: string | null
  readonly owner_pid_namespace: string | null
  readonly owner_pid: number | null
  readonly owner_start_ticks: string | null
  readonly owner_hostname: string | null
  readonly acquired_at_ms: number | null
  readonly heartbeat_at_ms: number | null
  readonly expires_at_ms: number | null
  readonly released_at_ms: number | null
}

export interface CycleLeaseApi {
  readonly acquire: () => Effect.Effect<
    CycleLeaseToken,
    DbFailed | ProcessIdentityUnavailable | CycleLeaseHeld | CycleLeaseRecoveryUncertain
  >
  readonly heartbeat: (token: CycleLeaseToken) => Effect.Effect<void, DbFailed | CycleLeaseLost>
  readonly release: (token: CycleLeaseToken) => Effect.Effect<void, DbFailed | CycleLeaseLost>
  readonly assertCurrent: (token: CycleLeaseToken) => Effect.Effect<void, DbFailed | CycleLeaseLost>
  readonly withFencedTransaction: <A>(
    token: CycleLeaseToken,
    op: string,
    body: (tx: DbTx) => A,
  ) => Effect.Effect<A, DbFailed | CycleLeaseLost>
  readonly status: () => Effect.Effect<CycleLeaseRow, DbFailed>
}

export interface CycleLeaseDeps {
  readonly current: () => ProcessIncarnation
  readonly liveness: (owner: ProcessIncarnation, current: ProcessIncarnation) => IncarnationLiveness
  readonly now: () => number
  readonly ownerId: () => string
  readonly ttlMs: number
}

const defaults: CycleLeaseDeps = {
  current: currentProcessIncarnation,
  liveness: incarnationLiveness,
  now: Date.now,
  ownerId: randomUUID,
  ttlMs: 30_000,
}

const leaseRow = (tx: DbTx): CycleLeaseRow =>
  tx.get("SELECT * FROM cycle_lease WHERE lease_name='cycle'") as CycleLeaseRow

const ownerOf = (row: CycleLeaseRow): ProcessIncarnation => ({
  hostId: row.owner_host_id as string,
  bootId: row.owner_boot_id as string,
  pidNamespace: row.owner_pid_namespace as string,
  pid: row.owner_pid as number,
  startTicks: row.owner_start_ticks as string,
  hostname: row.owner_hostname as string,
})

const isCurrent = (row: CycleLeaseRow, token: CycleLeaseToken): boolean =>
  row.state === "held" &&
  row.fence === token.fence &&
  row.owner_id === token.ownerId &&
  row.owner_host_id === token.incarnation.hostId &&
  row.owner_boot_id === token.incarnation.bootId &&
  row.owner_pid_namespace === token.incarnation.pidNamespace &&
  row.owner_pid === token.incarnation.pid &&
  row.owner_start_ticks === token.incarnation.startTicks

const claim = (
  tx: DbTx,
  row: CycleLeaseRow,
  token: Omit<CycleLeaseToken, "fence">,
  now: number,
  ttlMs: number,
): CycleLeaseToken => {
  const fence = row.fence + 1
  const result = tx.run(
    `UPDATE cycle_lease SET
       state='held', fence=?, owner_id=?, owner_host_id=?, owner_boot_id=?, owner_pid_namespace=?,
       owner_pid=?, owner_start_ticks=?, owner_hostname=?, acquired_at_ms=?, heartbeat_at_ms=?,
       expires_at_ms=?, released_at_ms=NULL
     WHERE lease_name='cycle' AND fence=?`,
    fence,
    token.ownerId,
    token.incarnation.hostId,
    token.incarnation.bootId,
    token.incarnation.pidNamespace,
    token.incarnation.pid,
    token.incarnation.startTicks,
    token.incarnation.hostname,
    now,
    now,
    now + ttlMs,
    row.fence,
  )
  if (result.changes !== 1) throw new Error("cycle lease claim lost its transaction")
  return { ...token, fence, acquiredAtMs: now }
}

export const makeCycleLease = (overrides: Partial<CycleLeaseDeps> = {}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const deps = { ...defaults, ...overrides }

    const status = () =>
      db.get("SELECT * FROM cycle_lease WHERE lease_name='cycle'") as Effect.Effect<CycleLeaseRow, DbFailed>

    const acquire = (): CycleLeaseApi["acquire"] extends () => infer A ? A : never =>
      Effect.gen(function* () {
        const incarnation = yield* Effect.try({
          try: deps.current,
          catch: (error) => new ProcessIdentityUnavailable({ reason: String(error) }),
        })
        const base = {
          leaseName: "cycle" as const,
          ownerId: deps.ownerId(),
          incarnation,
          acquiredAtMs: deps.now(),
        }

        for (let attempt = 0; attempt < 4; attempt++) {
          const now = deps.now()
          const decision = yield* db.withImmediateTransaction("acquire cycle lease", (tx) => {
            const row = leaseRow(tx)
            if (row.state !== "held")
              return { kind: "claimed" as const, token: claim(tx, row, base, now, deps.ttlMs) }
            if ((row.expires_at_ms as number) > now) return { kind: "held" as const, row }
            return { kind: "expired" as const, row }
          })
          if (decision.kind === "claimed") return decision.token
          if (decision.kind === "held")
            return yield* new CycleLeaseHeld({
              ownerId: decision.row.owner_id as string,
              fence: decision.row.fence,
              expiresAtMs: decision.row.expires_at_ms as number,
            })

          const liveness = deps.liveness(ownerOf(decision.row), incarnation)
          if (liveness.kind === "alive")
            return yield* new CycleLeaseHeld({
              ownerId: decision.row.owner_id as string,
              fence: decision.row.fence,
              expiresAtMs: decision.row.expires_at_ms as number,
            })
          if (liveness.kind === "unknown")
            return yield* new CycleLeaseRecoveryUncertain({
              ownerId: decision.row.owner_id as string,
              fence: decision.row.fence,
              reason: liveness.reason,
            })

          const recovered = yield* db.withImmediateTransaction("recover cycle lease", (tx) => {
            const current = leaseRow(tx)
            if (
              current.fence !== decision.row.fence ||
              current.owner_id !== decision.row.owner_id ||
              current.heartbeat_at_ms !== decision.row.heartbeat_at_ms ||
              current.expires_at_ms !== decision.row.expires_at_ms
            )
              return undefined
            return claim(tx, current, base, deps.now(), deps.ttlMs)
          })
          if (recovered) return recovered
        }
        return yield* new CycleLeaseRecoveryUncertain({
          ownerId: "changed-during-recovery",
          fence: -1,
          reason: "cycle lease changed repeatedly during recovery",
        })
      })

    const withFencedTransaction: CycleLeaseApi["withFencedTransaction"] = (token, op, body) =>
      db
        .withImmediateTransaction(op, (tx) => {
          if (!isCurrent(leaseRow(tx), token)) return { ok: false as const }
          const value = body(tx)
          if (isThenable(value)) throw new Error("fenced transaction callback must be synchronous")
          return { ok: true as const, value }
        })
        .pipe(
          Effect.flatMap((result) =>
            result.ok ? Effect.succeed(result.value) : Effect.fail(new CycleLeaseLost(token)),
          ),
        )

    const assertCurrent = (token: CycleLeaseToken) =>
      withFencedTransaction(token, "assert cycle lease", () => undefined)

    const heartbeat = (token: CycleLeaseToken) =>
      withFencedTransaction(token, "heartbeat cycle lease", (tx) => {
        const row = leaseRow(tx)
        const heartbeatAt = Math.max(row.heartbeat_at_ms as number, deps.now())
        const result = tx.run(
          "UPDATE cycle_lease SET heartbeat_at_ms=?, expires_at_ms=? WHERE lease_name='cycle' AND fence=? AND owner_id=?",
          heartbeatAt,
          heartbeatAt + deps.ttlMs,
          token.fence,
          token.ownerId,
        )
        if (result.changes !== 1) throw new Error("cycle lease heartbeat lost its transaction")
      })

    const release = (token: CycleLeaseToken) =>
      withFencedTransaction(token, "release cycle lease", (tx) => {
        const result = tx.run(
          `UPDATE cycle_lease SET state='released', owner_id=NULL, owner_host_id=NULL, owner_boot_id=NULL,
             owner_pid_namespace=NULL, owner_pid=NULL, owner_start_ticks=NULL, owner_hostname=NULL,
             acquired_at_ms=NULL, heartbeat_at_ms=NULL, expires_at_ms=NULL, released_at_ms=?
           WHERE lease_name='cycle' AND fence=? AND owner_id=?`,
          deps.now(),
          token.fence,
          token.ownerId,
        )
        if (result.changes !== 1) throw new Error("cycle lease release lost its transaction")
      })

    return {
      acquire,
      heartbeat,
      release,
      assertCurrent,
      withFencedTransaction,
      status,
    } satisfies CycleLeaseApi
  })

export class CycleLease extends Context.Service<CycleLease, CycleLeaseApi>()("CycleLease") {
  static readonly layer = Layer.effect(CycleLease, makeCycleLease())
}
