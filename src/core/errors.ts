/**
 * 拒否ごとに別タグにして、呼び出し側が未処理の拒否をコンパイラに指摘されるようにする。
 * `Halt` と `QuotaCooldown` を同じ型にすると、フォールバックが halt をリトライしてしまう。
 */
import * as Data from "effect/Data"

/** schema_meta の 'halt'。自動解除しない。 */
export class Halt extends Data.TaggedError("Halt")<{
  readonly reason: string
  readonly at: string
}> {}

/** `untilMs` までこの pool だけ避ける。朝会を止めないため halt にしない。 */
export class QuotaCooldown extends Data.TaggedError("QuotaCooldown")<{
  readonly pool: string
  readonly window: string
  readonly untilMs: number
}> {}

/** 定額利用では USD ではなくこれが異常反復の上限になる。 */
export class DailyRunLimit extends Data.TaggedError("DailyRunLimit")<{
  readonly count: number
  readonly limit: number
}> {}

export class DeliveryRejected extends Data.TaggedError("DeliveryRejected")<{
  readonly reason: string
}> {}

export class RunnerFailed extends Data.TaggedError("RunnerFailed")<{
  readonly pool: string
  readonly message: string
  readonly exhausted?: boolean
}> {}

/** `what` を省けるようにすると、別の種類の行を探しているのに「提案が無い」と出る文言が流用される。 */
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly what: string
  readonly id: string
}> {}

/** 承認済みの再承認や id 前方一致の複数一致など。governance の拒否(Refusal)ではない。 */
export class Conflict extends Data.TaggedError("Conflict")<{
  readonly what: string
  readonly id: string
  readonly reason: string
}> {}

/** append-only トリガの発火もここに来る。 */
export class DbFailed extends Data.TaggedError("DbFailed")<{
  readonly op: string
  readonly message: string
}> {}

/** 空の正常応答とは区別する。 */
export class ConnectorFailed extends Data.TaggedError("ConnectorFailed")<{
  readonly connector: string
  readonly operation: string
  readonly message: string
}> {}

export class ProcessIdentityUnavailable extends Data.TaggedError("ProcessIdentityUnavailable")<{
  readonly reason: string
}> {}

export class CycleLeaseHeld extends Data.TaggedError("CycleLeaseHeld")<{
  readonly ownerId: string
  readonly fence: number
  readonly expiresAtMs: number
}> {}

export class CycleLeaseRecoveryUncertain extends Data.TaggedError("CycleLeaseRecoveryUncertain")<{
  readonly ownerId: string
  readonly fence: number
  readonly reason: string
}> {}

export class CycleLeaseLost extends Data.TaggedError("CycleLeaseLost")<{
  readonly ownerId: string
  readonly fence: number
}> {}

export type Refusal = Halt | QuotaCooldown | DailyRunLimit | DeliveryRejected

/** 返り値は「止まった: …」として DB に残りユーザーが読む。道具ループが `Error` を入れ子にするので `cause` を辿る。 */
export function causeReason(e: unknown): string {
  const seen = new Set<unknown>()
  let cur: unknown = e
  let deepest: string | undefined
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur)
    const msg = (cur as { message?: unknown }).message
    if (typeof msg === "string" && msg) deepest = msg
    cur = (cur as { cause?: unknown }).cause
  }
  return deepest ?? String(e)
}

export function describeRefusal(r: Refusal): string {
  switch (r._tag) {
    case "Halt":
      return `停止中(halt): ${r.reason} — 明示解除するまで走らない`
    case "QuotaCooldown": {
      const min = Math.max(0, Math.ceil((r.untilMs - Date.now()) / 60_000))
      return `クォータ ${r.pool}/${r.window} はクールダウン中(あと約${min}分)`
    }
    case "DailyRunLimit":
      return `日次 run 上限に到達(${r.count}/${r.limit})`
    case "DeliveryRejected":
      return `送信前検査で差し戻し: ${r.reason}`
  }
}
