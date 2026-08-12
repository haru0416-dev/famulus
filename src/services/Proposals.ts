/**
 * 提案と裁可。**エージェントが実行しないための受け皿**。
 *
 * この設計の芯は「実行を伴うことはエージェントが直接やらず、提案として1件書いて止まる」ことなので、
 * 提案を作る側(ツール)と裁可する側(CLI)が同じ1本の API を通るようにしておく。
 * ここが2箇所に分かれた瞬間、片方だけが状態機械を守る、という壊れ方をする。
 *
 * 状態機械(schema.sql の CHECK と一致):
 *   proposed ─approve→ approved ─(実行経路)→ executing → executed / failed
 *      │ deny→ denied
 *      └ 期限切れ→ expired
 * `approve` は **approvals 行を必ず書く**。実行ゲートは approvals.payload_hash と
 * 現在の payload の一致を条件にするので、承認後に payload が差し替わったら実行は通らない。
 * (実行器そのものはまだ無い — コネクタが1つも無いので、approved は「裁可済み・未実行」で止まる。
 *  ここで実行したことにする方が嘘としては大きいので、止めたままにしてある。)
 */
import { createHash, randomUUID } from "node:crypto"
import { Effect } from "effect"
import { Conflict, NotFound } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { Db } from "./Db.ts"

export type ProposalKind =
  | "reminder"
  | "research"
  | "plan"
  | "vault-update"
  | "outbound-draft"
  | "skill-promote"
  | "skill-retire"

export type ProposalStatus =
  | "proposed"
  | "approved"
  | "deferred"
  | "denied"
  | "expired"
  | "executing"
  | "executed"
  | "failed"

export interface CreateInput {
  readonly kind?: ProposalKind
  readonly summary: string
  readonly assessment: string
  readonly ask: string
  /** 完全性ゲート5要素。名指しできない案は提案にしない。 */
  readonly what: string
  readonly when: string
  readonly who: "famulus" | "human"
  readonly how: string
  readonly howVerified: string
  /** 実行内容の完全直列化。省略時は入力そのものを payload とする。 */
  readonly payload?: unknown
  readonly provenance?: unknown
  readonly at?: string
  /** 未裁可のまま放置される上限日数。 */
  readonly pendingDays?: number
}

export interface ProposalRow {
  readonly id: string
  readonly kind: ProposalKind
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
  readonly deferred_until: string | null
  readonly expires_at: string
  readonly deny_reason: string | null
}

/** 未裁可のまま置ける日数。過ぎたものは list の前に expired に落とす。 */
export const MAX_PENDING_DAYS = 7

const plusDays = (at: string, days: number) =>
  new Date(Date.parse(at) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z")

/** 承認した時点の payload を指紋にする。承認後に中身が変わったら実行させないための鍵。 */
export const payloadHash = (payload: string): string => createHash("sha256").update(payload).digest("hex")

/** 裁可を受け付ける状態。executing 以降は人の裁可の対象ではない。 */
const DECIDABLE: readonly ProposalStatus[] = ["proposed", "deferred"]

export class Proposals extends Effect.Service<Proposals>()("Proposals", {
  effect: Effect.gen(function* () {
    const db = yield* Db

    const create = (input: CreateInput) =>
      Effect.gen(function* () {
        const id = randomUUID()
        const at = input.at ?? nowIso()
        const payload = JSON.stringify(input.payload ?? input)
        const provenance = JSON.stringify(input.provenance ?? [{ kind: "agent", at }])
        yield* db.run(
          `INSERT INTO proposals
             (id, kind, created_at, summary, assessment, ask,
              c_what, c_when, c_who, c_how, c_how_verified,
              payload, provenance, status, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
          id,
          input.kind ?? "plan",
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
        )
        return id
      })

    /**
     * id 前方一致で1件引く。CLI で 36 文字の UUID を打たせないため。
     * **複数に当たったら選ばずに失敗させる** — 曖昧なまま裁可を通すのが一番まずい。
     */
    const get = (idOrPrefix: string) =>
      Effect.gen(function* () {
        const rows = yield* db.all(
          "SELECT * FROM proposals WHERE id = ? OR id LIKE ? || '%' ORDER BY created_at DESC LIMIT 5",
          idOrPrefix,
          idOrPrefix,
        )
        const exact = rows.find((r) => r.id === idOrPrefix)
        if (exact) return exact as unknown as ProposalRow
        if (rows.length === 0) return yield* Effect.fail(new NotFound({ what: "提案", id: idOrPrefix }))
        if (rows.length > 1) {
          return yield* Effect.fail(
            new Conflict({
              what: "提案",
              id: idOrPrefix,
              reason: `前方一致が ${rows.length} 件ある: ${rows.map((r) => String(r.id).slice(0, 8)).join(", ")}`,
            }),
          )
        }
        return rows[0] as unknown as ProposalRow
      })

    /** 期限切れを expired に落とす。裁可待ちの一覧が実態とずれないよう list の前に呼ぶ。 */
    const expireDue = (at: string = nowIso()) =>
      db
        .run("UPDATE proposals SET status = 'expired' WHERE status = 'proposed' AND expires_at < ?", at)
        .pipe(Effect.as(undefined))

    const list = (status: ProposalStatus | "all" = "proposed", limit = 20) =>
      Effect.gen(function* () {
        yield* expireDue()
        const rows =
          status === "all"
            ? yield* db.all("SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?", limit)
            : yield* db.all(
                "SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?",
                status,
                limit,
              )
        return rows as unknown as ProposalRow[]
      })

    /** 裁可の生ログ。approve 率の飽和検知と deny の還流に使う(まだ読む側は無い)。 */
    const noteDecision = (p: ProposalRow, verb: string, at: string) =>
      db.run(
        "INSERT INTO decisions (id, proposal_id, at, verb, kind, latency_ms) VALUES (?, ?, ?, ?, ?, ?)",
        randomUUID(),
        p.id,
        at,
        verb,
        p.kind,
        Math.max(0, Date.parse(at) - Date.parse(p.created_at)),
      )

    const ensureDecidable = (p: ProposalRow) =>
      DECIDABLE.includes(p.status)
        ? Effect.void
        : Effect.fail(
            new Conflict({ what: "提案", id: p.id, reason: `裁可できる状態ではない(status=${p.status})` }),
          )

    /**
     * 承認。**approvals 行と status 遷移を同一トランザクションで**行う
     * (承認記録の無い approved を作らない = 実行ゲートが照合する相手を必ず残す)。
     */
    const approve = (idOrPrefix: string, opts?: { approverRef?: string; at?: string }) =>
      Effect.gen(function* () {
        const p = yield* get(idOrPrefix)
        yield* ensureDecidable(p)
        const at = opts?.at ?? nowIso()
        const hash = payloadHash(p.payload)

        yield* db.run("BEGIN")
        yield* Effect.gen(function* () {
          yield* db.run(
            `INSERT INTO approvals (id, proposal_id, approver, approver_ref, at, verb, payload_hash)
             VALUES (?, ?, 'owner', ?, ?, 'approve', ?)`,
            randomUUID(),
            p.id,
            opts?.approverRef ?? "cli",
            at,
            hash,
          )
          yield* db.run("UPDATE proposals SET status = 'approved' WHERE id = ?", p.id)
          yield* noteDecision(p, "approve", at)
          yield* db.run("COMMIT")
        }).pipe(Effect.tapError(() => db.run("ROLLBACK").pipe(Effect.ignore)))

        return { id: p.id, payloadHash: hash, at }
      })

    /** 却下。理由は次の生成へ還流させる学習信号なので必須にする。 */
    const deny = (idOrPrefix: string, reason: string, opts?: { at?: string }) =>
      Effect.gen(function* () {
        const p = yield* get(idOrPrefix)
        yield* ensureDecidable(p)
        const at = opts?.at ?? nowIso()
        yield* db.run("BEGIN")
        yield* Effect.gen(function* () {
          yield* db.run("UPDATE proposals SET status = 'denied', deny_reason = ? WHERE id = ?", reason, p.id)
          yield* noteDecision(p, "deny", at)
          yield* db.run("COMMIT")
        }).pipe(Effect.tapError(() => db.run("ROLLBACK").pipe(Effect.ignore)))
        return { id: p.id, at }
      })

    /** 承認記録。実行器が payload_hash を照合するときに引く。 */
    const approvalOf = (proposalId: string) =>
      db.get("SELECT * FROM approvals WHERE proposal_id = ? ORDER BY at DESC LIMIT 1", proposalId)

    return { create, get, list, expireDue, approve, deny, approvalOf } as const
  }),
}) {}
