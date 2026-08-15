import { randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Conflict, type DbFailed, ProcessIdentityUnavailable } from "../core/errors.ts"
import {
  currentProcessIncarnation,
  type IncarnationLiveness,
  incarnationLiveness,
  type ProcessIncarnation,
} from "../core/process-incarnation.ts"
import { nowIso } from "../core/time.ts"
import {
  canonicalJson,
  digestOf,
  type GenerationRef,
  ZERO_SKILL_PLAN_HASH,
  ZERO_SKILL_PLAN_JSON,
} from "../model/kernel-spec.ts"
import { Db, type DbTx } from "./Db.ts"

export interface BudgetVector {
  readonly modelCalls: number
  readonly toolCalls: number
  readonly tokens: number
  readonly costMicrousd: number
}

export interface ExecutionOwnerRef {
  readonly kind: string
  readonly id: string
}

export interface KernelLoopContext {
  readonly rootId: string
  readonly loopId: string
  readonly loopAttemptId: string
  readonly fence: number
  readonly incarnation: ProcessIncarnation
  readonly profile: GenerationRef
  readonly budget: BudgetVector
  readonly deadlineAtMs: number
  readonly modelTokenAllowance: number
  readonly modelCostAllowanceMicrousd: number
}

export interface ModelAttemptToken {
  readonly id: string
  readonly reservationId: string
  readonly context: KernelLoopContext
  readonly requestDigest: string
}

export interface ModelAttemptLedgerInput {
  readonly kind: string
  readonly role: string
  readonly model: string
  readonly inTok: number
  readonly outTok: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly summary?: string
  readonly provenance: unknown
  readonly at: string
}

export type ModelAttemptFinish =
  | {
      readonly outcome: "succeeded"
      readonly tokens: number
      readonly costMicrousd: number
      readonly response: unknown
      readonly ledger: ModelAttemptLedgerInput
    }
  | { readonly outcome: "unknown"; readonly ledger: ModelAttemptLedgerInput }

export interface OpenSingleLoopInput {
  readonly owner: ExecutionOwnerRef
  readonly stableSlot: string
  readonly role: string
  readonly profile: GenerationRef
  readonly resultContract: GenerationRef
  readonly taskInput: unknown
  readonly deadlineAtMs: number
  readonly budget: BudgetVector
  readonly modelTokenAllowance: number
  readonly modelCostAllowanceMicrousd: number
}

export interface ExecutionKernelDeps {
  readonly current: () => ProcessIncarnation
  readonly liveness: (owner: ProcessIncarnation, current: ProcessIncarnation) => IncarnationLiveness
}

const defaultDeps: ExecutionKernelDeps = {
  current: currentProcessIncarnation,
  liveness: incarnationLiveness,
}

const budgetParams = (budget: BudgetVector) =>
  [budget.modelCalls, budget.toolCalls, budget.tokens, budget.costMicrousd] as const

const incarnationParams = (owner: ProcessIncarnation) =>
  [owner.hostId, owner.bootId, owner.pidNamespace, owner.pid, owner.startTicks, owner.hostname] as const

const contextFrom = (
  row: Record<string, unknown>,
  incarnation: ProcessIncarnation,
  profile: GenerationRef,
  budget: BudgetVector,
  deadlineAtMs: number,
  modelTokenAllowance: number,
  modelCostAllowanceMicrousd: number,
): KernelLoopContext => ({
  rootId: row.root_id as string,
  loopId: row.loop_id as string,
  loopAttemptId: row.loop_attempt_id as string,
  fence: Number(row.fence),
  incarnation,
  profile,
  budget,
  deadlineAtMs,
  modelTokenAllowance,
  modelCostAllowanceMicrousd,
})

const assertCurrent = (tx: DbTx, context: KernelLoopContext, dispatch: boolean): void => {
  const row = tx.get(
    `SELECT a.state,a.fence,a.owner_host_id,a.owner_boot_id,a.owner_pid_namespace,a.owner_pid,a.owner_start_ticks,
            l.profile_digest,r.deadline_at_ms
       FROM loop_attempts a JOIN loop_specs l ON l.id=a.loop_id JOIN execution_roots r ON r.id=l.root_id
      WHERE a.id=?`,
    context.loopAttemptId,
  )
  if (
    row?.state !== "active" ||
    Number(row.fence) !== context.fence ||
    row.owner_host_id !== context.incarnation.hostId ||
    row.owner_boot_id !== context.incarnation.bootId ||
    row.owner_pid_namespace !== context.incarnation.pidNamespace ||
    Number(row.owner_pid) !== context.incarnation.pid ||
    row.owner_start_ticks !== context.incarnation.startTicks ||
    row.profile_digest !== context.profile.digest ||
    Number(row.deadline_at_ms) !== context.deadlineAtMs ||
    (dispatch && Date.now() >= context.deadlineAtMs)
  )
    throw new Error("loop attempt fence is no longer current")
}

export const makeExecutionKernel = (overrides: Partial<ExecutionKernelDeps> = {}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const deps = { ...defaultDeps, ...overrides }

    const openSingleLoop = (input: OpenSingleLoopInput) =>
      Effect.gen(function* () {
        const incarnation = yield* Effect.try({
          try: deps.current,
          catch: (error) => new ProcessIdentityUnavailable({ reason: String(error) }),
        })
        const taskInputJson = canonicalJson(input.taskInput)
        const semanticHash = digestOf({
          role: input.role,
          profile: input.profile,
          resultContract: input.resultContract,
          taskInputJson,
          skillPlanHash: ZERO_SKILL_PLAN_HASH,
          budget: input.budget,
          modelTokenAllowance: input.modelTokenAllowance,
          modelCostAllowanceMicrousd: input.modelCostAllowanceMicrousd,
        })
        const at = nowIso()
        return yield* db.withImmediateTransaction("open execution root", (tx) => {
          if (
            input.modelTokenAllowance < 0 ||
            input.modelTokenAllowance > input.budget.tokens ||
            input.modelCostAllowanceMicrousd < 0 ||
            input.modelCostAllowanceMicrousd > input.budget.costMicrousd
          )
            throw new Error("model allowance exceeds root budget")
          const existing = tx.get(
            `SELECT r.id root_id,r.deadline_at_ms,l.id loop_id,l.semantic_hash,a.id loop_attempt_id,
                    a.ordinal,a.fence,a.state,a.owner_host_id,a.owner_boot_id,a.owner_pid_namespace,
                    a.owner_pid,a.owner_start_ticks,a.owner_hostname
               FROM execution_roots r
               JOIN loop_specs l ON l.root_id=r.id AND l.stable_slot=?
               JOIN loop_attempts a ON a.loop_id=l.id
               WHERE r.owner_kind=? AND r.owner_id=?
               ORDER BY a.ordinal DESC LIMIT 1`,
            input.stableSlot,
            input.owner.kind,
            input.owner.id,
          )
          if (existing) {
            if (existing.semantic_hash !== semanticHash)
              throw new Conflict({
                what: "execution root",
                id: input.owner.id,
                reason: "同じownerのLoopSpecが変わっている",
              })
            if (existing.state !== "active")
              throw new Conflict({
                what: "execution root",
                id: input.owner.id,
                reason: `既存loopは${String(existing.state)}`,
              })
            const storedIncarnation: ProcessIncarnation = {
              hostId: existing.owner_host_id as string,
              bootId: existing.owner_boot_id as string,
              pidNamespace: existing.owner_pid_namespace as string,
              pid: Number(existing.owner_pid),
              startTicks: existing.owner_start_ticks as string,
              hostname: existing.owner_hostname as string,
            }
            const sameOwner =
              storedIncarnation.hostId === incarnation.hostId &&
              storedIncarnation.bootId === incarnation.bootId &&
              storedIncarnation.pidNamespace === incarnation.pidNamespace &&
              storedIncarnation.pid === incarnation.pid &&
              storedIncarnation.startTicks === incarnation.startTicks
            if (sameOwner)
              return contextFrom(
                existing,
                storedIncarnation,
                input.profile,
                input.budget,
                Number(existing.deadline_at_ms),
                input.modelTokenAllowance,
                input.modelCostAllowanceMicrousd,
              )

            const liveness = deps.liveness(storedIncarnation, incarnation)
            if (liveness.kind !== "dead")
              throw new Conflict({
                what: "execution root",
                id: input.owner.id,
                reason:
                  liveness.kind === "alive"
                    ? "既存loop ownerが生存中"
                    : `owner生死が不明: ${liveness.reason}`,
              })
            const recoveredAt = nowIso()
            const interrupted = tx.all(
              `SELECT m.id,l.role,l.profile_snapshot
                 FROM model_attempts m
                 JOIN loop_attempts a ON a.id=m.loop_attempt_id
                 JOIN loop_specs l ON l.id=a.loop_id
                WHERE m.loop_attempt_id=? AND m.state='started'`,
              existing.loop_attempt_id,
            )
            tx.run(
              `UPDATE budget_reservations
                  SET state='unknown',consumed_tokens=tokens,consumed_cost_microusd=cost_microusd,finished_at=?
                WHERE id IN (
                  SELECT reservation_id FROM model_attempts
                   WHERE loop_attempt_id=? AND state='started'
                ) AND state='consuming'`,
              recoveredAt,
              existing.loop_attempt_id,
            )
            for (const attempt of interrupted) {
              const profile = JSON.parse(attempt.profile_snapshot as string) as { model?: unknown }
              if (typeof profile.model !== "string") throw new Error("stored profile snapshot has no model")
              tx.run(
                `INSERT INTO ledger
                   (id,at,kind,role,model,in_tok,out_tok,cache_read,cache_write,summary,provenance,model_attempt_id)
                 VALUES (?,?,'recovered-model-attempt',?,?,0,0,0,0,NULL,?,?)`,
                randomUUID(),
                recoveredAt,
                attempt.role,
                profile.model,
                canonicalJson({ outcome: "unknown", recovered: true }),
                attempt.id,
              )
            }
            tx.run(
              "UPDATE model_attempts SET state='unknown',finished_at=? WHERE loop_attempt_id=? AND state='started'",
              recoveredAt,
              existing.loop_attempt_id,
            )
            tx.run(
              "UPDATE loop_attempts SET state='unknown',finished_at=? WHERE id=? AND state='active'",
              recoveredAt,
              existing.loop_attempt_id,
            )
            const recoveredAttemptId = randomUUID()
            const recoveredFence = Number(existing.fence) + 1
            tx.run(
              `INSERT INTO loop_attempts
                (id,loop_id,ordinal,state,fence,owner_host_id,owner_boot_id,owner_pid_namespace,owner_pid,
                 owner_start_ticks,owner_hostname,started_at)
               VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
              recoveredAttemptId,
              existing.loop_id,
              Number(existing.ordinal) + 1,
              recoveredFence,
              ...incarnationParams(incarnation),
              recoveredAt,
            )
            return contextFrom(
              {
                ...existing,
                loop_attempt_id: recoveredAttemptId,
                fence: recoveredFence,
              },
              incarnation,
              input.profile,
              input.budget,
              Number(existing.deadline_at_ms),
              input.modelTokenAllowance,
              input.modelCostAllowanceMicrousd,
            )
          }

          const rootId = randomUUID()
          const loopId = randomUUID()
          const loopAttemptId = randomUUID()
          const rootReservationId = randomUUID()
          const loopReservationId = randomUUID()
          const [modelCalls, toolCalls, tokens, costMicrousd] = budgetParams(input.budget)
          tx.run(
            `INSERT INTO execution_roots
              (id,owner_kind,owner_id,created_at,deadline_at_ms,max_active_loops,scope_json,scope_hash,
               budget_model_calls,budget_tool_calls,budget_tokens,budget_cost_microusd)
             VALUES (?,?,?,?,?,1,'{}',?,?,?,?,?)`,
            rootId,
            input.owner.kind,
            input.owner.id,
            at,
            input.deadlineAtMs,
            digestOf({}),
            modelCalls,
            toolCalls,
            tokens,
            costMicrousd,
          )
          tx.run(
            "INSERT INTO execution_root_state(root_id,status,updated_at) VALUES (?,'active',?)",
            rootId,
            at,
          )
          tx.run(
            `INSERT INTO loop_specs
              (id,root_id,stable_slot,role,profile_id,profile_generation,profile_digest,profile_snapshot,
               task_input_json,task_input_hash,artifacts_json,artifacts_hash,skill_plan_json,skill_plan_hash,
               result_contract_id,result_contract_generation,result_contract_digest,result_contract_snapshot,
               tool_bindings_json,tool_bindings_hash,scope_json,scope_hash,stop_policy_json,stop_policy_hash,
               budget_model_calls,budget_tool_calls,budget_tokens,budget_cost_microusd,semantic_hash,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            loopId,
            rootId,
            input.stableSlot,
            input.role,
            input.profile.id,
            input.profile.generation,
            input.profile.digest,
            input.profile.snapshot,
            taskInputJson,
            digestOf(taskInputJson),
            "[]",
            digestOf([]),
            ZERO_SKILL_PLAN_JSON,
            ZERO_SKILL_PLAN_HASH,
            input.resultContract.id,
            input.resultContract.generation,
            input.resultContract.digest,
            input.resultContract.snapshot,
            "[]",
            digestOf([]),
            "{}",
            digestOf({}),
            canonicalJson({ kind: "model-calls", max: 1 }),
            digestOf({ kind: "model-calls", max: 1 }),
            modelCalls,
            toolCalls,
            tokens,
            costMicrousd,
            semanticHash,
            at,
          )
          tx.run(
            `INSERT INTO loop_attempts
              (id,loop_id,ordinal,state,fence,owner_host_id,owner_boot_id,owner_pid_namespace,owner_pid,
               owner_start_ticks,owner_hostname,started_at)
             VALUES (?,?,1,'active',1,?,?,?,?,?,?,?)`,
            loopAttemptId,
            loopId,
            ...incarnationParams(incarnation),
            at,
          )
          tx.run(
            `INSERT INTO budget_reservations
              (id,root_id,loop_id,parent_id,kind,state,model_calls,tool_calls,tokens,cost_microusd,created_at)
             VALUES (?,?,NULL,NULL,'root','held',?,?,?,?,?)`,
            rootReservationId,
            rootId,
            modelCalls,
            toolCalls,
            tokens,
            costMicrousd,
            at,
          )
          tx.run(
            `INSERT INTO budget_reservations
              (id,root_id,loop_id,parent_id,kind,state,model_calls,tool_calls,tokens,cost_microusd,created_at)
             VALUES (?,?,?,?, 'loop','held',?,?,?,?,?)`,
            loopReservationId,
            rootId,
            loopId,
            rootReservationId,
            modelCalls,
            toolCalls,
            tokens,
            costMicrousd,
            at,
          )
          return contextFrom(
            { root_id: rootId, loop_id: loopId, loop_attempt_id: loopAttemptId, fence: 1 },
            incarnation,
            input.profile,
            input.budget,
            input.deadlineAtMs,
            input.modelTokenAllowance,
            input.modelCostAllowanceMicrousd,
          )
        })
      })

    const startModelAttempt = (context: KernelLoopContext, requestDigest: string) =>
      db.withImmediateTransaction("start model attempt", (tx) => {
        assertCurrent(tx, context, true)
        const loopReservation = tx.get(
          "SELECT id FROM budget_reservations WHERE loop_id=? AND kind='loop'",
          context.loopId,
        )
        if (!loopReservation) throw new Error("loop reservation is missing")
        const used = tx.get(
          `SELECT COALESCE(SUM(model_calls),0) model_calls,
                  COALESCE(SUM(CASE WHEN state='consumed' THEN consumed_tokens ELSE tokens END),0) tokens,
                  COALESCE(SUM(CASE WHEN state='consumed' THEN consumed_cost_microusd ELSE cost_microusd END),0) cost_microusd
             FROM budget_reservations WHERE parent_id=? AND state!='released'`,
          loopReservation.id,
        )
        if (
          Number(used?.model_calls ?? 0) + 1 > context.budget.modelCalls ||
          Number(used?.tokens ?? 0) + context.modelTokenAllowance > context.budget.tokens ||
          Number(used?.cost_microusd ?? 0) + context.modelCostAllowanceMicrousd > context.budget.costMicrousd
        )
          throw new Error("loop model budget is exhausted")
        const id = randomUUID()
        const reservationId = randomUUID()
        const at = nowIso()
        const ordinal =
          Number(
            tx.get("SELECT COUNT(*) n FROM model_attempts WHERE loop_attempt_id=?", context.loopAttemptId)
              ?.n ?? 0,
          ) + 1
        tx.run(
          `INSERT INTO budget_reservations
            (id,root_id,loop_id,parent_id,kind,state,model_calls,tool_calls,tokens,cost_microusd,created_at)
           VALUES (?,?,?,?, 'model','consuming',1,0,?,?,?)`,
          reservationId,
          context.rootId,
          context.loopId,
          loopReservation.id,
          context.modelTokenAllowance,
          context.modelCostAllowanceMicrousd,
          at,
        )
        tx.run(
          `INSERT INTO model_attempts
            (id,loop_attempt_id,step_ordinal,attempt_ordinal,state,reservation_id,profile_id,profile_generation,
              profile_digest,request_digest,owner_fence,started_at)
            VALUES (?,?,1,?,'started',?,?,?,?,?,?,?)`,
          id,
          context.loopAttemptId,
          ordinal,
          reservationId,
          context.profile.id,
          context.profile.generation,
          context.profile.digest,
          requestDigest,
          context.fence,
          at,
        )
        return { id, reservationId, context, requestDigest } satisfies ModelAttemptToken
      })

    const finishModelAttempt = (token: ModelAttemptToken, finish: ModelAttemptFinish) =>
      db.withImmediateTransaction(`finish model attempt ${finish.outcome}`, (tx) => {
        assertCurrent(tx, token.context, false)
        const at = nowIso()
        const actualTokens = finish.outcome === "succeeded" ? finish.tokens : 0
        const actualCostMicrousd = finish.outcome === "succeeded" ? finish.costMicrousd : 0
        const overrun =
          finish.outcome === "succeeded" &&
          (actualTokens > token.context.modelTokenAllowance ||
            actualCostMicrousd > token.context.modelCostAllowanceMicrousd)
        const attempt = tx.run(
          `UPDATE model_attempts SET state=?,response_json=?,actual_tokens=?,actual_cost_microusd=?,finished_at=?
            WHERE id=? AND state='started' AND request_digest=?`,
          finish.outcome,
          finish.outcome === "succeeded" ? canonicalJson(finish.response) : null,
          finish.outcome === "succeeded" ? actualTokens : null,
          finish.outcome === "succeeded" ? actualCostMicrousd : null,
          at,
          token.id,
          token.requestDigest,
        )
        if (attempt.changes !== 1) throw new Error("model attempt is not started")
        tx.run(
          `UPDATE budget_reservations SET state=?,consumed_tokens=?,consumed_cost_microusd=?,finished_at=?
            WHERE id=? AND state='consuming'`,
          finish.outcome === "unknown" || overrun ? "unknown" : "consumed",
          finish.outcome === "unknown" || overrun ? token.context.modelTokenAllowance : actualTokens,
          finish.outcome === "unknown" || overrun
            ? token.context.modelCostAllowanceMicrousd
            : actualCostMicrousd,
          at,
          token.reservationId,
        )
        tx.run(
          `INSERT INTO ledger
             (id,at,kind,role,model,in_tok,out_tok,cache_read,cache_write,summary,provenance,model_attempt_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          randomUUID(),
          finish.ledger.at,
          finish.ledger.kind,
          finish.ledger.role,
          finish.ledger.model,
          finish.ledger.inTok,
          finish.ledger.outTok,
          finish.ledger.cacheRead,
          finish.ledger.cacheWrite,
          finish.ledger.summary ?? null,
          canonicalJson(finish.ledger.provenance),
          token.id,
        )
      })

    const finishLoop = (context: KernelLoopContext, state: "completed" | "failed") =>
      db.withImmediateTransaction(`finish loop ${state}`, (tx) => {
        assertCurrent(tx, context, false)
        const at = nowIso()
        tx.run(
          "UPDATE loop_attempts SET state=?,finished_at=? WHERE id=? AND state='active'",
          state,
          at,
          context.loopAttemptId,
        )
        tx.run(
          "UPDATE execution_root_state SET status=?,updated_at=? WHERE root_id=?",
          state,
          at,
          context.rootId,
        )
      })

    const replayModelResult = (context: KernelLoopContext, requestDigest: string) =>
      db.withImmediateTransaction("replay model result", (tx) => {
        assertCurrent(tx, context, false)
        const row = tx.get(
          `SELECT m.response_json
             FROM model_attempts m JOIN loop_attempts a ON a.id=m.loop_attempt_id
             WHERE a.loop_id=? AND m.state='succeeded' AND m.profile_digest=? AND m.request_digest=?
            ORDER BY a.ordinal DESC,m.step_ordinal DESC,m.attempt_ordinal DESC LIMIT 1`,
          context.loopId,
          context.profile.digest,
          requestDigest,
        )
        return row?.response_json ? JSON.parse(row.response_json as string) : undefined
      })

    return { openSingleLoop, startModelAttempt, finishModelAttempt, finishLoop, replayModelResult } as const
  })

export class ExecutionKernel extends Context.Service<
  ExecutionKernel,
  Effect.Success<ReturnType<typeof makeExecutionKernel>>
>()("ExecutionKernel") {
  static readonly layer = Layer.effect(ExecutionKernel, makeExecutionKernel())
  static readonly layerWith = (overrides: Partial<ExecutionKernelDeps>) =>
    Layer.effect(ExecutionKernel, makeExecutionKernel(overrides))
}

export type ExecutionKernelError = DbFailed | Conflict | ProcessIdentityUnavailable
