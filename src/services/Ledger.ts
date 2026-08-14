/**
 * 記録。全 run を1行残す。
 * Governance の日次 run 数は `role IS NOT NULL` の行を数えるので、
 * モデルを呼んだ run は必ず role を入れる(入れないと日次上限を適用できない)。
 */
import { randomUUID } from "node:crypto"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { localDayRange, nowIso } from "../core/time.ts"
import { Db } from "./Db.ts"

/**
 * 入力は3つに割れる。`inTok` はキャッシュに載らなかった分だけで、system やスキーマ定義は
 * `cacheWrite`(初回)か `cacheRead`(2回目以降)に入る。
 * どれか1つを「入力」として読むと桁が変わるので、見るときは必ず3つ足す。
 */
export interface Usage {
  readonly inTok?: number
  readonly outTok?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

export interface RecordInput {
  /** 'turn' | 'run' | 'briefing' | 'scout' … */
  readonly kind: string
  /** モデルを呼んだ run は必ず入れる(日次 run 数の数え上げ対象になる)。 */
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
             (id, at, kind, role, model, in_tok, out_tok, cache_read, cache_write, summary, provenance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        )
        return id
      })

    /** 今日の使用状況。CLI と朝会が同じ数字を見るための1点。 */
    const today = (at: string = nowIso()) =>
      Effect.gen(function* () {
        // 見出しも集計もユーザーの1日で切る(core/time.ts)。
        const day = localDayRange(at)
        const r = yield* db.get(
          // 入力は3列の和で出す。in_tok だけを「入力」として出すと、桁の違う数字が表に出る。
          `SELECT COUNT(*)runs, COALESCE(SUM(in_tok + cache_read + cache_write),0)in_tok,
                  COALESCE(SUM(out_tok),0)out_tok
             FROM ledger WHERE role IS NOT NULL AND at >= ?AND at < ?`,
          day.startIso,
          day.endIso,
        )
        return {
          day: day.key,
          runs: Number(r?.runs ?? 0),
          /** 総入力(in_tok + cache_read + cache_write)。 */
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
