/**
 * tick の締めの文に残った比喩を書き換える。
 *
 * `draft` と `tell` は道具なので「出していない」と返せば書いた側が直す。締めの文は
 * 道具ループが終わったあとなので返す先が無く、当たったときだけ書き換えを1回呼ぶ。
 * 失敗したら元の文を出す — 書き換えに失敗した回に無言で終えるほうが害が大きい。
 */
import * as Effect from "effect/Effect"
import { Runner } from "../model/Runner.ts"
import { findFigures } from "./drafting.ts"

/** これを下回るなら呼ばずに元の文を出す。 */
export const REWRITE_MS = 40_000

const INSTRUCTION = (words: readonly string[]) =>
  `下の返信から比喩だけを取り除いて、全文をそのまま書き直してください。

当たった語: ${words.map((w) => `「${w}」`).join(" ")}

- **中身を変えない。** 数字・ファイル名・id・URL・提案の可否は1文字も動かさない。
- 比喩は、実際の動作か状態に展開して書き換える(検索は空振りした→検索は0件だった)。
- 短くしない。要約しない。段落の分かれ方も変えない。
- 説明を付けない。書き直した本文だけを返す。`

/** 半分未満に縮んだ返りは採らない。要約されていて、比喩と一緒に中身も落ちている。 */
export const withoutFigures = (text: string, leftMs: number) =>
  Effect.gen(function* () {
    const words = findFigures(text)
    if (words.length === 0 || leftMs < REWRITE_MS) return text
    const runner = yield* Runner
    const out = yield* runner
      .run({ role: "scout", kind: "figure-rewrite", prompt: `${INSTRUCTION(words)}\n\n---\n${text}` })
      .pipe(Effect.orElseSucceed(() => undefined))
    const rewritten = out?.text?.trim()
    if (!rewritten || rewritten.length < text.length / 2) return text
    return rewritten
  })
