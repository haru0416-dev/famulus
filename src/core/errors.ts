/**
 * 拒否の型付きチャネル(Effect の error channel に載せる)。
 *
 * famulus-zero では governance の判定が `{ ok: false, reason: string }` の直和で返っていた。
 * 型としては全部同じ形なので、**呼び出し側が「どの拒否を握り潰したか」をコンパイラに問われない**。
 * Effect に載せる目的はここで、拒否ごとに別タグを持たせて `Effect.catchTag` で個別に扱わせる。
 *
 * 重要な区別(famulus-zero governance/budget.ts, quota.ts の設計をそのまま持ち上げる):
 *   - `Halt`          … 人間が明示解除するまで自動で明けない。全停止。
 *   - `QuotaCooldown` … 窓が明ければ自動で戻る。**その枠だけ**避ける。朝会を殺さないため halt にしない。
 * この2つを同じ `Error` にすると、フォールバック実装がうっかり halt をリトライしてしまう。
 */
import { Data } from "effect"

/** 予算ブレーカーの停止。schema_meta の 'halt' が立っている。自動解除しない。 */
export class Halt extends Data.TaggedError("Halt")<{
  readonly reason: string
  readonly at: string
}> {}

/** サブスク枠のクールダウン。`untilMs` まで**この枠だけ**避ける(他の枠は使える)。 */
export class QuotaCooldown extends Data.TaggedError("QuotaCooldown")<{
  readonly pool: string
  readonly window: string
  readonly untilMs: number
}> {}

/** 日次 run 数の上限。定額枠では USD ではなくこれが量的な歯止め。 */
export class DailyRunLimit extends Data.TaggedError("DailyRunLimit")<{
  readonly count: number
  readonly limit: number
}> {}

/** 単価未登録モデルの事前拒否(従量経路のみ。記帳されずに USD 上限を素通りする穴を塞ぐ)。 */
export class UnpricedModel extends Data.TaggedError("UnpricedModel")<{
  readonly model: string
}> {}

/** egress allowlist 違反。外向き接続を1点で数える不変条件の実装点。 */
export class EgressDenied extends Data.TaggedError("EgressDenied")<{
  readonly url: string
  readonly reason: string
}> {}

/** 送信直前検査(pre-send verify)での差し戻し。 */
export class DeliveryRejected extends Data.TaggedError("DeliveryRejected")<{
  readonly reason: string
}> {}

/** runner(サブスク CLI)の失敗。枠シグナルが取れていれば添える。 */
export class RunnerFailed extends Data.TaggedError("RunnerFailed")<{
  readonly pool: string
  readonly message: string
  readonly exhausted?: boolean
}> {}

/** 指定した提案が無い。CLI の打ち間違い(id 前方一致で当たらない)もここ。 */
export class ProposalNotFound extends Data.TaggedError("ProposalNotFound")<{
  readonly id: string
}> {}

/**
 * 提案の状態が操作と噛み合わない(裁可済みを再裁可、id 前方一致が複数など)。
 * **曖昧なまま裁可を通さない**ための失敗で、拒否(Refusal)とは別物 — 統治が止めたのではない。
 */
export class ProposalConflict extends Data.TaggedError("ProposalConflict")<{
  readonly id: string
  readonly reason: string
}> {}

/** DB 層の失敗(スキーマ不変条件違反を含む)。append-only トリガの発火もここに来る。 */
export class DbFailed extends Data.TaggedError("DbFailed")<{
  readonly op: string
  readonly message: string
}> {}

/** governance が出しうる拒否の総和。ツール実行前・送信前のゲートはこれを返す。 */
export type Refusal = Halt | QuotaCooldown | DailyRunLimit | UnpricedModel | EgressDenied | DeliveryRejected

/** 人間に見せる一行(裁可ボード・CLI 共通)。 */
export function describeRefusal(r: Refusal): string {
  switch (r._tag) {
    case "Halt":
      return `停止中(halt): ${r.reason} — 明示解除するまで走らない`
    case "QuotaCooldown": {
      const min = Math.max(0, Math.ceil((r.untilMs - Date.now()) / 60_000))
      return `枠 ${r.pool}/${r.window} はクールダウン中(あと約${min}分)`
    }
    case "DailyRunLimit":
      return `日次 run 上限に到達(${r.count}/${r.limit})`
    case "UnpricedModel":
      return `単価未登録のモデルは従量経路で走らせない: ${r.model}`
    case "EgressDenied":
      return `egress 拒否: ${r.reason}`
    case "DeliveryRejected":
      return `送信前検査で差し戻し: ${r.reason}`
  }
}
