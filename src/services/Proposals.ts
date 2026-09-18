/**
 * proposed から approved / denied / expired へ一度だけ遷移する(schema.sql の CHECK と一致)。
 * approved は実行成功を意味しない。Sandbox の公開通信だけは SandboxNetwork が起動時に指紋を照合する。
 */
import { createHash, randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { currentCycleId } from "../core/cycle-context.ts"
import { Conflict, NotFound } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { Db, type Row } from "./Db.ts"

export type ProposalStatus = "proposed" | "approved" | "denied" | "expired"

export type ProposalDecision = "approve" | "deny"

/** deny は理由が必須(schema の CHECK)だが、リアクションには理由が無いので固定文を入れる。 */
export const REACTION_DENY_REASON = "リアクションで却下(理由なし)"

export interface CreateInput {
  readonly summary: string
  readonly assessment: string
  readonly ask: string
  /** 5要素のどれかを書けない案は提案にしない。 */
  readonly what: string
  readonly when: string
  readonly who: "famulus" | "human"
  readonly how: string
  readonly howVerified: string
  /** 省略時は入力そのものを payload とする。 */
  readonly payload?: unknown
  readonly provenance?: unknown
  readonly at?: string
  readonly pendingDays?: number
}

export interface ProposalRow {
  readonly id: string
  readonly created_at: string
  readonly summary: string
  readonly assessment: string
  readonly ask: string
  readonly c_what: string
  readonly c_when: string
  readonly c_who: string
  readonly c_how: string
  readonly c_how_verified: string
  readonly payload: string
  readonly provenance: string
  readonly status: ProposalStatus
  readonly expires_at: string
  readonly deny_reason: string | null
  /** 自動処理が「今回できることは無い」と記録した時刻。 */
  readonly settled_at: string | null
  readonly settled_note: string | null
}

export const MAX_PENDING_DAYS = 7

const plusDays = (at: string, days: number) =>
  new Date(Date.parse(at) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z")

export const payloadHash = (payload: string): string => createHash("sha256").update(payload).digest("hex")

const DECIDABLE: readonly ProposalStatus[] = ["proposed"]
const FIND_PROPOSAL =
  "SELECT * FROM proposals WHERE id = ?OR id LIKE ? || '%' ORDER BY created_at DESC LIMIT 5"

const resolveProposal = (
  rows: readonly Row[],
  idOrPrefix: string,
):
  | { readonly found: true; readonly value: ProposalRow }
  | { readonly found: false; readonly error: NotFound | Conflict } => {
  const exact = rows.find((r) => r.id === idOrPrefix)
  if (exact) return { found: true, value: exact as unknown as ProposalRow }
  if (rows.length === 0) return { found: false, error: new NotFound({ what: "提案", id: idOrPrefix }) }
  if (rows.length > 1) {
    return {
      found: false,
      error: new Conflict({
        what: "提案",
        id: idOrPrefix,
        reason: `前方一致が ${rows.length} 件ある: ${rows.map((r) => String(r.id).slice(0, 8)).join(", ")}`,
      }),
    }
  }
  return { found: true, value: rows[0] as unknown as ProposalRow }
}

const decisionConflict = (proposal: ProposalRow): Conflict | undefined =>
  DECIDABLE.includes(proposal.status)
    ? undefined
    : new Conflict({
        what: "提案",
        id: proposal.id,
        reason: `承認できる状態ではない(status=${proposal.status})`,
      })

const makeProposals = () =>
  Effect.gen(function* () {
    const db = yield* Db

    const create = (input: CreateInput) =>
      Effect.gen(function* () {
        const id = randomUUID()
        const at = input.at ?? nowIso()
        const payload = JSON.stringify(input.payload ?? input)
        const provenance = JSON.stringify(input.provenance ?? [{ kind: "agent", at }])
        yield* db.run(
          `INSERT INTO proposals
             (id, created_at, summary, assessment, ask,
              c_what, c_when, c_who, c_how, c_how_verified,
              payload, provenance, status, expires_at, cycle_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
          id,
          at,
          input.summary,
          input.assessment,
          input.ask,
          input.what,
          input.when,
          input.who,
          input.how,
          input.howVerified,
          payload,
          provenance,
          plusDays(at, input.pendingDays ?? MAX_PENDING_DAYS),
          currentCycleId() ?? null,
        )
        return id
      })

    /** 読み取り・判断のどの入口でも最初に呼ぶ。 */
    const expireDue = (at: string = nowIso()) =>
      db.withImmediateTransaction("expire proposals", (tx) => {
        const due = tx.all(
          "SELECT id, created_at FROM proposals WHERE status='proposed' AND expires_at <= ?",
          at,
        )
        for (const p of due) {
          tx.run(
            `INSERT INTO proposal_actions
                 (id, proposal_id, at, action, actor, latency_ms)
               VALUES (?, ?, ?, 'expire', 'system', ?)`,
            randomUUID(),
            p.id,
            at,
            Math.max(0, Date.parse(at) - Date.parse(String(p.created_at))),
          )
        }
        tx.run("UPDATE proposals SET status='expired' WHERE status='proposed' AND expires_at <= ?", at)
      })

    /** id の前方一致。複数に一致したら選ばずに失敗させる(曖昧なまま承認させない)。 */
    const get = (idOrPrefix: string, at: string = nowIso()) =>
      Effect.gen(function* () {
        yield* expireDue(at)
        const resolved = resolveProposal(yield* db.all(FIND_PROPOSAL, idOrPrefix, idOrPrefix), idOrPrefix)
        return resolved.found ? resolved.value : yield* Effect.fail(resolved.error)
      })

    const list = (status: ProposalStatus | "all" = "proposed", limit = 20) =>
      Effect.gen(function* () {
        yield* expireDue()
        const rows =
          status === "all"
            ? yield* db.all("SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?", limit)
            : yield* db.all(
                "SELECT * FROM proposals WHERE status = ?ORDER BY created_at DESC LIMIT ?",
                status,
                limit,
              )
        return rows as unknown as ProposalRow[]
      })

    // 承認記録の無い approved を作らないため、action の追記と遷移を同一トランザクションで行う。
    const approve = (idOrPrefix: string, opts?: { approverRef?: string; at?: string }) =>
      Effect.gen(function* () {
        const at = opts?.at ?? nowIso()
        yield* expireDue(at)
        return yield* db.withImmediateTransaction<
          { readonly id: string; readonly payloadHash: string; readonly at: string },
          NotFound | Conflict
        >("approve proposal", (tx, abort) => {
          const resolved = resolveProposal(tx.all(FIND_PROPOSAL, idOrPrefix, idOrPrefix), idOrPrefix)
          if (!resolved.found) return abort(resolved.error)
          const p = resolved.value
          const conflict = decisionConflict(p)
          if (conflict) return abort(conflict)
          const hash = payloadHash(p.payload)
          tx.run(
            `INSERT INTO proposal_actions
               (id, proposal_id, at, action, actor, actor_ref, payload_hash, latency_ms)
             VALUES (?, ?, ?, 'approve', 'owner', ?, ?, ?)`,
            randomUUID(),
            p.id,
            at,
            opts?.approverRef ?? "cli",
            hash,
            Math.max(0, Date.parse(at) - Date.parse(p.created_at)),
          )
          tx.run("UPDATE proposals SET status = 'approved' WHERE id = ?", p.id)
          return { id: p.id, payloadHash: hash, at }
        })
      })

    /** 理由は次の生成に渡すので必須。 */
    const deny = (idOrPrefix: string, reason: string, opts?: { at?: string }) =>
      Effect.gen(function* () {
        const at = opts?.at ?? nowIso()
        yield* expireDue(at)
        return yield* db.withImmediateTransaction<
          { readonly id: string; readonly at: string },
          NotFound | Conflict
        >("deny proposal", (tx, abort) => {
          const resolved = resolveProposal(tx.all(FIND_PROPOSAL, idOrPrefix, idOrPrefix), idOrPrefix)
          if (!resolved.found) return abort(resolved.error)
          const p = resolved.value
          const conflict = decisionConflict(p)
          if (conflict) return abort(conflict)
          tx.run(
            `INSERT INTO proposal_actions
               (id, proposal_id, at, action, actor, reason, latency_ms)
             VALUES (?, ?, ?, 'deny', 'owner', ?, ?)`,
            randomUUID(),
            p.id,
            at,
            reason,
            Math.max(0, Date.parse(at) - Date.parse(p.created_at)),
          )
          tx.run("UPDATE proposals SET status = 'denied', deny_reason = ?WHERE id = ?", reason, p.id)
          return { id: p.id, at }
        })
      })

    /**
     * 状態は動かさない。これが無いと承認待ちを理由に cycle が毎回走り、同じ結論を書き直す。
     * 記録後は `planCycle` が実行条件に数えないが、一覧には残す。上書きしてよい。
     */
    const recordPendingConclusion = (idOrPrefix: string, note: string, opts?: { at?: string }) =>
      Effect.gen(function* () {
        const at = opts?.at ?? nowIso()
        const p = yield* get(idOrPrefix, at)
        yield* db.run("UPDATE proposals SET settled_at = ?, settled_note = ?WHERE id = ?", at, note, p.id)
        return { ...p, settled_at: at, settled_note: note } satisfies ProposalRow
      })

    return { create, get, list, approve, deny, recordPendingConclusion } as const
  })

export class Proposals extends Context.Service<Proposals, Effect.Success<ReturnType<typeof makeProposals>>>()(
  "Proposals",
) {
  static readonly layer = Layer.effect(Proposals, makeProposals())
}
