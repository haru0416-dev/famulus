/**
 * 拒否の型付きチャネル(Effect の error channel に載せる)。
 *
 * `{ ok: false, reason: string }` で返すと型としては全部同じ形になり、
 * **呼び出し側が「どの拒否を握り潰したか」をコンパイラに問われない**。
 * 拒否ごとに別タグを持たせて `Effect.catchTag` で個別に扱わせる。
 *
 * 区別:
 *   - `Halt`          … 人間が明示解除するまで自動で明けない。全停止。
 *   - `QuotaCooldown` … 窓が明ければ自動で戻る。**その枠だけ**避ける。朝会を殺さないため halt にしない。
 * この2つを同じ `Error` にすると、フォールバック実装がうっかり halt をリトライしてしまう。
 */
import * as Data from "effect/Data"

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

/** 単価未登録モデルの事前拒否(従量経路のみ。記録されずに USD 上限を素通りする穴を塞ぐ)。 */
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

/**
 * 指定した行が無い。CLI の打ち間違い(id 前方一致で当たらない)もここ。
 *
 * `what` は何の DB を引いたか(「提案」「問い」「watch」)。**必須にしてある** —
 * 省けるようにすると、提案の文言が問いにも watch にも流用されて
 * 「そんな提案は無い」と言いながら問いを探している、が起きる。
 */
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly what: string
  readonly id: string
}> {}

/**
 * 行の状態が操作と噛み合わない(承認済みを再承認、id 前方一致が複数など)。
 * **曖昧なまま承認を通さない**ための失敗で、拒否(Refusal)とは別物 — 統治が止めたのではない。
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

/** governance が出しうる拒否の総和。ツール実行前・送信前のゲートはこれを返す。 */
export type Refusal = Halt | QuotaCooldown | DailyRunLimit | UnpricedModel | EgressDenied | DeliveryRejected

/**
 * 包まれた失敗から**本当の理由**を一行で取り出す。ここで返した文字列がそのまま
 * 「止まった: …」として DB に残り、ユーザーが読む1行になる。
 *
 * 元は枠(Flue)が dispatch の失敗を `Agent run failed (submission sub_…)` にまとめてしまい、
 * 表に出た文字列だけを記録すると自走枠の使い切りも provider の落ちも同じ顔になっていた
 * (docs/adr/0011)。実際の理由は内側の `meta.reason` にあった。
 *
 * **枠が無くなっても包まれ方は残る。** いまゲートが投げるのは素の `Error` で、道具ループが
 * それをさらに包むことがある。だから `cause` を辿り、いちばん内側の `message` を返す —
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
    const meta = (cur as { meta?: { reason?: unknown } }).meta
    if (typeof meta?.reason === "string" && meta.reason) return meta.reason
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
