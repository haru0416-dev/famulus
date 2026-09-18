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
  readonly dossier_id: string
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
  readonly dossierId: string
}

export type DraftDecision = "accept" | "revise" | "discard"

/**
 * 版ごとに変える(改稿の再配送が前の配送の dedupe に当たらないため)。
 * drafts_sync_delivery トリガが先頭36字(UUID)から draft を引くので id を先頭に置く。
 */
export const deliveryKey = (id: string, contentHash: string): string => `${id}@${contentHash.slice(0, 12)}`

// 指摘の本文はスレッドの owner イベントにあるので、ここには読み方だけを書く。
const REVISE_FEEDBACK =
  "ユーザーが「直す」を押した。指摘は下書きスレッドの発言にある(未読入力か recall で読む)。" +
  "指摘に沿って本文を書き直し、draft を呼び直す。"

const row = (value: Row): DraftRow => value as unknown as DraftRow

const SELECT_DAY = "SELECT * FROM drafts WHERE local_day = ?"
const SELECT_PENDING = `SELECT * FROM drafts
  WHERE delivered_at IS NULL AND state IN ('review_pending','revision_needed','delivery_pending')
  ORDER BY local_day,created_at LIMIT 1`

const selectDay = (tx: DbTx, day: string): DraftRow | undefined => {
  const found = tx.get(SELECT_DAY, day)
  return found ? row(found) : undefined
}

const selectPending = (tx: DbTx): DraftRow | undefined => {
  const found = tx.get(SELECT_PENDING)
  return found ? row(found) : undefined
}

const makeDrafts = () =>
  Effect.gen(function* () {
    const db = yield* Db

    const forDay = (at: string = nowIso()) =>
      db.get(SELECT_DAY, localDayRange(at).key).pipe(Effect.map((found) => (found ? row(found) : undefined)))

    const pending = () => db.get(SELECT_PENDING).pipe(Effect.map((found) => (found ? row(found) : undefined)))

    const materialize = (input: DraftInput, at: string = nowIso()) =>
      db.withImmediateTransaction("materialize draft", (tx) => {
        const day = localDayRange(at).key
        const existing = selectPending(tx) ?? selectDay(tx, day)
        if (existing && existing.state !== "revision_needed") return existing

        const dossier = tx.get("SELECT state FROM research_dossiers WHERE id=?", input.dossierId)
        if (!dossier || dossier.state === "open")
          throw new Error(`Terminal research dossier not found: ${input.dossierId}`)
        const contentHash = digestOf({ title: input.title, body: input.body, dossierId: input.dossierId })
        if (existing) {
          if (existing.content_hash === contentHash) return existing
          tx.run(
            `UPDATE drafts
                SET title=?,body=?,dossier_id=?,content_hash=?,state='review_pending',review_feedback=NULL,updated_at=?
              WHERE id=? AND state='revision_needed'`,
            input.title,
            input.body,
            input.dossierId,
            contentHash,
            at,
            existing.id,
          )
          return row(tx.get("SELECT * FROM drafts WHERE id=?", existing.id) as Row)
        }

        const id = randomUUID()
        tx.run(
          `INSERT INTO drafts
            (id,local_day,title,body,dossier_id,content_hash,state,created_at,updated_at)
           VALUES (?,?,?,?,?,?,'review_pending',?,?)`,
          id,
          day,
          input.title,
          input.body,
          input.dossierId,
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

    const failDelivery = (id: string, reason: string, at: string = nowIso()) =>
      db.withImmediateTransaction("fail draft delivery", (tx) => {
        const changed = tx.run(
          `UPDATE drafts SET state='delivery_failed',review_feedback=?,updated_at=?
            WHERE id=? AND state='review_pending'`,
          reason,
          at,
          id,
        )
        if (changed.changes !== 1) throw new Error(`Draft is no longer awaiting delivery: ${id}`)
        tx.run(
          "INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('health:draft:last_failure',?)",
          JSON.stringify({ at, stage: "delivery", error: reason }),
        )
        const draft = tx.get("SELECT * FROM drafts WHERE id=?", id)
        if (!draft) throw new Error(`Draft not found: ${id}`)
        return row(draft)
      })

    const attachOutbound = (id: string, outboundId: string, at: string = nowIso()) =>
      db.withImmediateTransaction("attach draft outbound", (tx) => {
        const current = tx.get("SELECT content_hash FROM drafts WHERE id=?", id)
        if (!current) throw new Error(`Draft not found: ${id}`)
        const outbound = tx.get(
          "SELECT purpose,dedupe_key,state,error,updated_at FROM discord_outbound WHERE id=?",
          outboundId,
        )
        if (!outbound) throw new Error(`Discord outbound not found: ${outboundId}`)
        if (
          outbound.purpose !== "assistant-draft" ||
          outbound.dedupe_key !== deliveryKey(id, String(current.content_hash))
        ) {
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
        // decision_origin_id を空に戻して、新しい版への決定を受け付ける。
        tx.run(
          `UPDATE drafts
              SET state=?,outbound_id=?,delivered_at=?,review_feedback=?,decision_origin_id=NULL,updated_at=?
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
        const draft = tx.get("SELECT state,delivered_at,content_hash FROM drafts WHERE id=?", id)
        if (!draft) return false
        if (draft.delivered_at == null) {
          const outbound = tx.get(
            `SELECT o.id,o.updated_at FROM discord_outbound o
              WHERE o.purpose='assistant-draft' AND o.dedupe_key=? AND o.state='sent'
                AND EXISTS (
                  SELECT 1 FROM discord_outbound_actions a
                   WHERE a.outbound_id=o.id AND a.kind='message' AND a.state='succeeded' AND a.receipt IS NOT NULL
                )`,
            deliveryKey(id, String(draft.content_hash)),
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
        // ✏️ は差し戻し。配送前の状態に戻すと SELECT_PENDING と draftDue が拾い、改稿から再配送まで回る。
        const result =
          decision === "revise"
            ? tx.run(
                `UPDATE drafts
                    SET state='revision_needed',review_feedback=?,delivered_at=NULL,outbound_id=NULL,
                        decision_origin_id=?,updated_at=?
                  WHERE id=? AND delivered_at IS NOT NULL AND decision_origin_id IS NULL`,
                REVISE_FEEDBACK,
                originId,
                at,
                id,
              )
            : tx.run(
                `UPDATE drafts
                    SET state=?,decision_origin_id=?,updated_at=?
                  WHERE id=? AND delivered_at IS NOT NULL AND decision_origin_id IS NULL`,
                decision === "accept" ? "accepted" : "discarded",
                originId,
                at,
                id,
              )
        return result.changes === 1
      })

    return {
      forDay,
      pending,
      materialize,
      requestRevision,
      failDelivery,
      attachOutbound,
      applyDecision,
    } as const
  })

export class Drafts extends Context.Service<Drafts, Effect.Success<ReturnType<typeof makeDrafts>>>()(
  "Drafts",
) {
  static readonly layer = Layer.effect(Drafts, makeDrafts())
}
