/**
 * Effect の error channel に載せる、拒否と運用上の失敗の型。
 *
 * `{ ok: false, reason: string }` で返すと型としては全部同じ形になり、
 * 呼び出し側が「どの拒否を未処理にしたか」をコンパイラに問われない。
 * 拒否ごとに別タグを持たせて `Effect.catchTag` で個別に扱わせる。
 *
 * 区別:
 *   - `Halt`          … 人間が明示解除するまで解除されない。全停止。
 *   - `QuotaCooldown` … リセット時刻を過ぎれば自動で戻る。そのクォータだけ避ける。朝会を止めないため halt にしない。
 * この2つを同じ `Error` にすると、フォールバック実装がうっかり halt をリトライしてしまう。
 * `NotFound` / `Conflict` / `DbFailed` / `RunnerFailed` は拒否ではなく、操作・基盤側の失敗。
 */
import * as Data from "effect/Data"

/** 全停止状態。schema_meta の 'halt' が設定されている。自動解除しない。 */
export class Halt extends Data.TaggedError("Halt")<{
  readonly reason: string
  readonly at: string
}> {}

/** サブスクリプションクォータの再実行抑止。`untilMs` までこの pool だけ避ける(他の pool は使える)。 */
export class QuotaCooldown extends Data.TaggedError("QuotaCooldown")<{
  readonly pool: string
  readonly window: string
  readonly untilMs: number
}> {}

/** 日次 run 数の上限。定額利用では USD ではなくこれが異常反復の安全上限。 */
export class DailyRunLimit extends Data.TaggedError("DailyRunLimit")<{
  readonly count: number
  readonly limit: number
}> {}

/** 送信直前検査(pre-send verify)での差し戻し。 */
export class DeliveryRejected extends Data.TaggedError("DeliveryRejected")<{
  readonly reason: string
}> {}

/** runner(サブスク CLI)の失敗。クォータシグナルが取れていれば添える。 */
export class RunnerFailed extends Data.TaggedError("RunnerFailed")<{
  readonly pool: string
  readonly message: string
  readonly exhausted?: boolean
}> {}

/**
 * 指定した行が無い。CLI の打ち間違い(id 前方一致で当たらない)もここ。
 *
 * `what` は何の DB を引いたか(「提案」「問い」「watch」)。必須にしてある —
 * 省けるようにすると、提案の文言が問いにも watch にも流用されて
 * 「そんな提案は無い」と言いながら問いを探している、が起きる。
 */
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly what: string
  readonly id: string
}> {}

/**
 * 行の状態が操作と合わない(承認済みを再承認、id 前方一致が複数など)。
 * 曖昧なまま承認を通さないための失敗で、拒否(Refusal)とは別物 — 統治が止めたのではない。
 */
export class Conflict extends Data.TaggedError("Conflict")<{
  readonly what: string
  readonly id: string
  readonly reason: string
}> {}

/** DB 層の失敗(スキーマ不変条件違反を含む)。append-only トリガの発火もここに来る。 */
export class DbFailed extends Data.TaggedError("DbFailed")<{
  readonly op: string
  readonly message: string
}> {}

/** 外部connectorへの通信・応答解釈に失敗した。空の正常応答とは区別する。 */
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

/** governance が出しうる拒否の総和。ツール実行前・送信前のゲートはこれを返す。 */
export type Refusal = Halt | QuotaCooldown | DailyRunLimit | DeliveryRejected

/**
 * 包まれた失敗から、いちばん内側の理由を一行で取り出す。ここで返した文字列がそのまま
 * 「止まった: …」として DB に残り、ユーザーが読む1行になる。
 *
 * 事前検査が投げるのは素の `Error` で、道具ループが
 * それをさらに入れ子にすることがある。だから `cause` を辿り、いちばん内側の `message` を返す —
 * 実測では halt 中の1ターンが `Error: 停止中(halt): …` として出ていて、
 * `String(e)` のままだと先頭に `Error: ` が付いたまま記録される。
 * `message` を持たないもの(Effect のタグ付き失敗など)は元の文字列に落とす。
 */
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

/** 人間に見せる一行(承認ボード・CLI 共通)。 */
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
