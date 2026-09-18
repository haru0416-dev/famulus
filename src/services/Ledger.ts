import { randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { currentCycleId } from "../core/cycle-context.ts"
import { localDayRange, nowIso } from "../core/time.ts"
import { Db } from "./Db.ts"

/** `inTok` はキャッシュに載らなかった分だけ。総入力は inTok + cacheWrite + cacheRead。 */
export interface Usage {
  readonly inTok?: number
  readonly outTok?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

export interface RecordInput {
  readonly kind: string
  /** モデルを呼んだ run は必ず入れる(日次 run 数の集計対象)。 */
  readonly role?: string
  readonly model?: string
  readonly usage?: Usage
  readonly summary?: string
  readonly provenance?: unknown
  readonly at?: string
}

const makeLedger = () =>
  Effect.gen(function* () {
    const db = yield* Db

    const record = (input: RecordInput) =>
      Effect.gen(function* () {
        const id = randomUUID()
        const at = input.at ?? nowIso()
        const u = input.usage ?? {}
        yield* db.run(
          `INSERT INTO ledger
             (id, at, kind, role, model, in_tok, out_tok, cache_read, cache_write, summary, provenance, cycle_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          at,
          input.kind,
          input.role ?? null,
          input.model ?? null,
          u.inTok ?? 0,
          u.outTok ?? 0,
          u.cacheRead ?? 0,
          u.cacheWrite ?? 0,
          input.summary ?? null,
          input.provenance === undefined ? null : JSON.stringify(input.provenance),
          currentCycleId() ?? null,
        )
        return id
      })

    const today = (at: string = nowIso()) =>
      Effect.gen(function* () {
        const day = localDayRange(at)
        const r = yield* db.get(
          `SELECT COUNT(*)runs, COALESCE(SUM(in_tok + cache_read + cache_write),0)in_tok,
                  COALESCE(SUM(out_tok),0)out_tok
             FROM ledger WHERE role IS NOT NULL AND at >= ?AND at < ?`,
          day.startIso,
          day.endIso,
        )
        return {
          day: day.key,
          runs: Number(r?.runs ?? 0),
          /** in_tok + cache_read + cache_write */
          inTok: Number(r?.in_tok ?? 0),
          outTok: Number(r?.out_tok ?? 0),
        }
      })

    return { record, today } as const
  })

export class Ledger extends Context.Service<Ledger, Effect.Success<ReturnType<typeof makeLedger>>>()(
  "Ledger",
) {
  static readonly layer = Layer.effect(Ledger, makeLedger())
}
