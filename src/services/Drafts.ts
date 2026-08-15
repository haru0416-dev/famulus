import { randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { localDayRange, nowIso } from "../core/time.ts"
import { digestOf } from "../model/kernel-spec.ts"
import { Db, type DbTx, type Row } from "./Db.ts"

export type DraftState =
  | "review_pending"
  | "revision_needed"
  | "delivery_pending"
  | "delivery_failed"
  | "delivered"
  | "accepted"
  | "revise_requested"
  | "discarded"

export interface DraftRow {
  readonly id: string
  readonly local_day: string
  readonly title: string
  readonly body: string
  readonly basis: string
  readonly content_hash: string
  readonly state: DraftState
  readonly review_feedback: string | null
  readonly outbound_id: string | null
  readonly delivered_at: string | null
  readonly decision_origin_id: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface DraftInput {
  readonly title: string
  readonly body: string
  readonly basis: string
}

export type DraftDecision = "accept" | "revise" | "discard"

const row = (value: Row): DraftRow => value as unknown as DraftRow

const selectDay = (tx: DbTx, day: string): DraftRow | undefined => {
  const found = tx.get("SELECT * FROM drafts WHERE local_day = ?", day)
  return found ? row(found) : undefined
}

const selectPending = (tx: DbTx): DraftRow | undefined => {
  const found = tx.get(
    `SELECT * FROM drafts
      WHERE delivered_at IS NULL AND state IN ('review_pending','revision_needed','delivery_pending')
      ORDER BY local_day,created_at LIMIT 1`,
  )
  return found ? row(found) : undefined
}

const makeDrafts = () =>
  Effect.gen(function* () {
    const db = yield* Db

    const forDay = (at: string = nowIso()) =>
      db
        .get("SELECT * FROM drafts WHERE local_day = ?", localDayRange(at).key)
        .pipe(Effect.map((found) => (found ? row(found) : undefined)))

    const pending = () =>
      db
        .get(
          `SELECT * FROM drafts
            WHERE delivered_at IS NULL AND state IN ('review_pending','revision_needed','delivery_pending')
            ORDER BY local_day,created_at LIMIT 1`,
        )
        .pipe(Effect.map((found) => (found ? row(found) : undefined)))

    const materialize = (input: DraftInput, at: string = nowIso()) =>
      db.withImmediateTransaction("materialize draft", (tx) => {
        const day = localDayRange(at).key
        const existing = selectPending(tx) ?? selectDay(tx, day)
        if (existing && existing.state !== "revision_needed") return existing

        const contentHash = digestOf({ title: input.title, body: input.body })
        if (existing) {
          if (existing.content_hash === contentHash) return existing
          tx.run(
            `UPDATE drafts
                SET title=?,body=?,basis=?,content_hash=?,state='review_pending',review_feedback=NULL,updated_at=?
              WHERE id=? AND state='revision_needed'`,
            input.title,
            input.body,
            input.basis,
            contentHash,
            at,
            existing.id,
          )
          return row(tx.get("SELECT * FROM drafts WHERE id=?", existing.id) as Row)
        }

        const id = randomUUID()
        tx.run(
          `INSERT INTO drafts
            (id,local_day,title,body,basis,content_hash,state,created_at,updated_at)
           VALUES (?,?,?,?,?,?,'review_pending',?,?)`,
          id,
          day,
          input.title,
          input.body,
          input.basis,
          contentHash,
          at,
          at,
        )
        return selectDay(tx, day) as DraftRow
      })

    const requestRevision = (id: string, feedback: string, at: string = nowIso()) =>
      db.run(
        "UPDATE drafts SET state='revision_needed',review_feedback=?,updated_at=? WHERE id=? AND state='review_pending'",
        feedback,
        at,
        id,
      )

    const attachOutbound = (id: string, outboundId: string, at: string = nowIso()) =>
      db.withImmediateTransaction("attach draft outbound", (tx) => {
        const outbound = tx.get(
          "SELECT purpose,dedupe_key,state,error,updated_at FROM discord_outbound WHERE id=?",
          outboundId,
        )
        if (!outbound) throw new Error(`Discord outbound not found: ${outboundId}`)
        if (outbound.purpose !== "assistant-draft" || outbound.dedupe_key !== id) {
          throw new Error(`Discord outbound does not belong to draft: ${outboundId}`)
        }
        const outboundState = String(outbound.state)
        const hasReceipt = Boolean(
          tx.get(
            `SELECT 1 FROM discord_outbound_actions
              WHERE outbound_id=? AND kind='message' AND state='succeeded' AND receipt IS NOT NULL LIMIT 1`,
            outboundId,
          ),
        )
        const delivered = outboundState === "sent" && hasReceipt
        const failed = ["failed", "partial", "unknown"].includes(outboundState)
        tx.run(
          `UPDATE drafts
              SET state=?,outbound_id=?,delivered_at=?,review_feedback=?,updated_at=?
            WHERE id=? AND state='review_pending'`,
          delivered
            ? "delivered"
            : failed || outboundState === "sent"
              ? "delivery_failed"
              : "delivery_pending",
          outboundId,
          delivered ? String(outbound.updated_at) : null,
          failed || (outboundState === "sent" && !hasReceipt)
            ? String(outbound.error ?? "Discord message receipt is missing")
            : null,
          at,
          id,
        )
        const draft = tx.get("SELECT * FROM drafts WHERE id=?", id)
        if (!draft) throw new Error(`Draft not found: ${id}`)
        return row(draft)
      })

    const applyDecision = (id: string, decision: DraftDecision, originId: string, at: string = nowIso()) =>
      db.withImmediateTransaction("apply draft decision", (tx) => {
        const draft = tx.get("SELECT state,delivered_at FROM drafts WHERE id=?", id)
        if (!draft) return false
        if (draft.delivered_at == null) {
          const outbound = tx.get(
            `SELECT o.id,o.updated_at FROM discord_outbound o
              WHERE o.purpose='assistant-draft' AND o.dedupe_key=? AND o.state='sent'
                AND EXISTS (
                  SELECT 1 FROM discord_outbound_actions a
                   WHERE a.outbound_id=o.id AND a.kind='message' AND a.state='succeeded' AND a.receipt IS NOT NULL
                )`,
            id,
          )
          if (!outbound) return false
          tx.run(
            "UPDATE drafts SET state='delivered',outbound_id=?,delivered_at=?,updated_at=? WHERE id=? AND delivered_at IS NULL",
            outbound.id,
            outbound.updated_at,
            at,
            id,
          )
        }
        const result = tx.run(
          `UPDATE drafts
              SET state=?,decision_origin_id=?,updated_at=?
            WHERE id=? AND delivered_at IS NOT NULL AND decision_origin_id IS NULL`,
          decision === "accept" ? "accepted" : decision === "revise" ? "revise_requested" : "discarded",
          originId,
          at,
          id,
        )
        return result.changes === 1
      })

    return { forDay, pending, materialize, requestRevision, attachOutbound, applyDecision } as const
  })

export class Drafts extends Context.Service<Drafts, Effect.Success<ReturnType<typeof makeDrafts>>>()(
  "Drafts",
) {
  static readonly layer = Layer.effect(Drafts, makeDrafts())
}
