/**
 * 記録。全 run を1行残す。**単価不明を黙って 0 円にしない**(`unpriced=1` で立てる)。
 *
 * 定額枠(meter="quota")の run は `usd=0` かつ `unpriced=0` で入れる。
 * ここが従量経路との決定的な違いで、「値段が分からないから0」ではなく「限界費用が本当に0」。
 * この2つを同じ 0 にしてしまうと、Governance の USD 上限が意味を失うか、
 * 逆に定額 run を金額で止め始める(= サブスクを買った意味を捨てる)。
 *
 * Governance の日次 run 数は `role IS NOT NULL` の行を数えるので、
 * モデルを呼んだ run は必ず role を入れる(入れないと歯止めが効かない)。
 */
import { randomUUID } from "node:crypto"
import * as Effect from "effect/Effect"
import { dayRange, monthRange, nowIso } from "../core/time.ts"
import { Db } from "./Db.ts"
import type { Meter } from "./Governance.ts"

/**
 * **入力は3つに割れる。** `inTok` はキャッシュに載らなかった分だけで、system やスキーマ定義は
 * `cacheWrite`(初回)か `cacheRead`(2回目以降)に入る。
 * どれか1つを「入力」として読むと桁が変わるので、見るときは必ず3つ足す。
 */
export interface Usage {
  readonly inTok?: number
  readonly outTok?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  /** 従量経路で実際に掛かった USD。定額枠なら 0。 */
  readonly usd?: number
}

export interface RecordInput {
  /** 'turn' | 'run' | 'briefing' | 'scout' … */
  readonly kind: string
  /** モデルを呼んだ run は必ず入れる(日次 run 数の数え上げ対象になる)。 */
  readonly role?: string
  readonly model?: string
  readonly meter: Meter
  readonly usage?: Usage
  readonly proposalId?: string
  readonly summary?: string
  readonly provenance?: unknown
  readonly at?: string
}

export class Ledger extends Effect.Service<Ledger>()("Ledger", {
  effect: Effect.gen(function* () {
    const db = yield* Db

    const record = (input: RecordInput) =>
      Effect.gen(function* () {
        const id = randomUUID()
        const at = input.at ?? nowIso()
        const u = input.usage ?? {}
        // quota: 限界費用 0(既知)。usd: 金額が来ていなければ単価未登録として立てる。
        const unpriced = input.meter === "quota" ? 0 : u.usd === undefined ? 1 : 0
        yield* db.run(
          `INSERT INTO ledger (id, at, kind, role, model, in_tok, out_tok, cache_read, cache_write,
                               usd, unpriced, proposal_id, summary, provenance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          at,
          input.kind,
          input.role ?? null,
          input.model ?? null,
          u.inTok ?? 0,
          u.outTok ?? 0,
          u.cacheRead ?? 0,
          u.cacheWrite ?? 0,
          u.usd ?? 0,
          unpriced,
          input.proposalId ?? null,
          input.summary ?? null,
          input.provenance === undefined ? null : JSON.stringify(input.provenance),
        )
        return id
      })

    /** 今日の使用状況。CLI と朝会が同じ数字を見るための1点。 */
    const today = (at: string = nowIso()) =>
      Effect.gen(function* () {
        // 見出しも集計も**ユーザーの1日**で切る(core/time.ts)。
        const day = dayRange(at)
        const month = monthRange(at)
        const r = yield* db.get(
          // 入力は3列の和で出す。in_tok だけを「入力」として出すと、桁の違う数字が表に出る。
          `SELECT COUNT(*)runs, COALESCE(SUM(usd),0)usd, COALESCE(SUM(unpriced),0)unpriced,
                  COALESCE(SUM(in_tok + cache_read + cache_write),0)in_tok,
                  COALESCE(SUM(out_tok),0)out_tok
             FROM ledger WHERE role IS NOT NULL AND at >= ?AND at < ?`,
          day.startIso,
          day.endIso,
        )
        const m = yield* db.get(
          "SELECT COALESCE(SUM(usd),0)usd FROM ledger WHERE at >= ?AND at < ?",
          month.startIso,
          month.endIso,
        )
        return {
          day: day.key,
          runs: Number(r?.runs ?? 0),
          usd: Number(r?.usd ?? 0),
          unpriced: Number(r?.unpriced ?? 0),
          /** 総入力(in_tok + cache_read + cache_write)。 */
          inTok: Number(r?.in_tok ?? 0),
          outTok: Number(r?.out_tok ?? 0),
          monthUsd: Number(m?.usd ?? 0),
        }
      })

    return { record, today } as const
  }),
}) {}
