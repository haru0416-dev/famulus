/**
 * 提案と承認。エージェントが実行しないための受け皿。
 *
 * この設計の要点は「実行を伴うことはエージェントが直接やらず、提案として1件書いて止まる」ことなので、
 * 提案を作る側(ツール)と承認する側(CLI)が同じ1本の API を通るようにしておく。
 * ここが2箇所に分かれた瞬間、片方だけが状態機械を守る、という壊れ方をする。
 *
 * 状態機械(schema.sql の CHECK と一致):
 *   proposed ─approve→ approved ・・・ここで止まる
 *      │ deny→ denied
 *      └ 期限切れ→ expired
 *
 * 実行状態と旧 `deferred` は型と CHECK から削除した。
 * approved は「承認済み・未実行」で止まり、実際に動かすのはユーザー。
 * ここで実行したことにする方が嘘としては大きいので、止めたままにしてある。
 *
 * `approve` は proposal_actions 行を必ず書く。承認した時点の payload の指紋を残すためで、
 * 実行する側を作るときに「承認後に中身が差し替わっていないか」を照合できるようにしてある。
 * 照合する側はまだ無い。今あるのは記録だけ。
 */
import { createHash, randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Conflict, NotFound } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { Db } from "./Db.ts"

/**
 * 提案の種類。`plan` の1つだけ。
 *
 * 前は7種あった(`reminder` `research` `vault-update` `outbound-draft` `skill-promote` `skill-retire`)。
 * 全部 famulus-zero から持ってきた種類で、こちらのコードが作れるのは `plan` だけだった
 * — 実データも8件全部 `plan`。種別が7つあると、読んだ側は「6つの経路がある」と読む。
 */
/**
 * 提案の状態。実行の3つ(`executing` `executed` `failed`)は落とした。
 *
 * 承認しても実行する仕組みが無い。到達しない状態を残すと、`oz list` を読んだ側が
 * 「承認すれば動く」と読む。実行を付ける日が来たら、そのときに足す。
 */
export type ProposalStatus = "proposed" | "approved" | "denied" | "expired"

export interface CreateInput {
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
  /** 未承認のまま放置される上限日数。 */
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
  /** 自動処理が「今回できることは無い」と結論を置いた時刻。null = まだ何も言っていない。 */
  readonly settled_at: string | null
  readonly settled_note: string | null
}

/** 未承認のまま置ける日数。過ぎたものは list の前に expired に落とす。 */
export const MAX_PENDING_DAYS = 7

const plusDays = (at: string, days: number) =>
  new Date(Date.parse(at) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z")

/** 承認した時点の payload の指紋。照合する側を作るまでは、ただの記録。 */
export const payloadHash = (payload: string): string => createHash("sha256").update(payload).digest("hex")

const DECIDABLE: readonly ProposalStatus[] = ["proposed"]

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
              payload, provenance, status, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
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
        )
        return id
      })

    /**
     * id 前方一致で1件引く。CLI で 36 文字の UUID を打たせないため。
     * 複数に当たったら選ばずに失敗させる — 曖昧なまま承認を通すのが一番まずい。
     */
    const get = (idOrPrefix: string) =>
      Effect.gen(function* () {
        const rows = yield* db.all(
          "SELECT * FROM proposals WHERE id = ?OR id LIKE ? || '%' ORDER BY created_at DESC LIMIT 5",
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

    /** 期限切れを expired に落とす。承認待ちの一覧が実態とずれないよう list の前に呼ぶ。 */
    const expireDue = (at: string = nowIso()) =>
      Effect.gen(function* () {
        yield* db.run("BEGIN IMMEDIATE")
        return yield* Effect.gen(function* () {
          const due = yield* db.all(
            "SELECT id, created_at FROM proposals WHERE status='proposed' AND expires_at < ?",
            at,
          )
          for (const p of due) {
            yield* db.run(
              `INSERT INTO proposal_actions
                 (id, proposal_id, at, action, actor, latency_ms)
               VALUES (?, ?, ?, 'expire', 'system', ?)`,
              randomUUID(),
              p.id,
              at,
              Math.max(0, Date.parse(at) - Date.parse(String(p.created_at))),
            )
          }
          yield* db.run(
            "UPDATE proposals SET status='expired' WHERE status='proposed' AND expires_at < ?",
            at,
          )
          yield* db.run("COMMIT")
        }).pipe(Effect.tapError(() => db.run("ROLLBACK").pipe(Effect.ignore)))
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

    const ensureDecidable = (p: ProposalRow) =>
      DECIDABLE.includes(p.status)
        ? Effect.void
        : Effect.fail(
            new Conflict({ what: "提案", id: p.id, reason: `承認できる状態ではない(status=${p.status})` }),
          )

    /**
     * 承認actionの追記とstatus遷移を同一トランザクションで行う
     * (承認記録の無い approved を作らない = 後で照合する相手を必ず残す)。
     */
    const approve = (idOrPrefix: string, opts?: { approverRef?: string; at?: string }) =>
      Effect.gen(function* () {
        const at = opts?.at ?? nowIso()
        yield* db.run("BEGIN IMMEDIATE")
        return yield* Effect.gen(function* () {
          const p = yield* get(idOrPrefix)
          yield* ensureDecidable(p)
          const hash = payloadHash(p.payload)
          yield* db.run(
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
          yield* db.run("UPDATE proposals SET status = 'approved' WHERE id = ?", p.id)
          yield* db.run("COMMIT")
          return { id: p.id, payloadHash: hash, at }
        }).pipe(Effect.tapError(() => db.run("ROLLBACK").pipe(Effect.ignore)))
      })

    /** 却下。理由は次の生成へ還流させる学習信号なので必須にする。 */
    const deny = (idOrPrefix: string, reason: string, opts?: { at?: string }) =>
      Effect.gen(function* () {
        const at = opts?.at ?? nowIso()
        yield* db.run("BEGIN IMMEDIATE")
        return yield* Effect.gen(function* () {
          const p = yield* get(idOrPrefix)
          yield* ensureDecidable(p)
          yield* db.run(
            `INSERT INTO proposal_actions
               (id, proposal_id, at, action, actor, reason, latency_ms)
             VALUES (?, ?, ?, 'deny', 'owner', ?, ?)`,
            randomUUID(),
            p.id,
            at,
            reason,
            Math.max(0, Date.parse(at) - Date.parse(p.created_at)),
          )
          yield* db.run("UPDATE proposals SET status = 'denied', deny_reason = ?WHERE id = ?", reason, p.id)
          yield* db.run("COMMIT")
          return { id: p.id, at }
        }).pipe(Effect.tapError(() => db.run("ROLLBACK").pipe(Effect.ignore)))
      })

    /**
     * 承認待ちについて、自動処理側の結論を置く。提案の状態は動かさない。
     *
     * 承認を出せるのはユーザーだけなので、自動処理には決着をつけられない。つけられるのは
     * 「今回できることは無い」まで — それを書く場所が無いと、この件を理由に毎回実行され、
     * 毎回同じ結論を書き直す(実測で4回、いずれも道具呼び出し4回以下)。
     *
     * 書いた後は `planCycle` が実行条件に数えない。一覧からは消さない — 承認はまだ要る。
     * `recordWatchRun` と同じく、実行したことと対象を一覧に残すことを別に記録する。
     * 上書きしてよい: 状況が動けば結論も変わる。
     */
    const recordPendingConclusion = (idOrPrefix: string, note: string, opts?: { at?: string }) =>
      Effect.gen(function* () {
        const p = yield* get(idOrPrefix)
        const at = opts?.at ?? nowIso()
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
