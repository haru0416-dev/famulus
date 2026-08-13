/**
 * valibot のスキーマを AI SDK の道具定義に渡せる形にする1枚。
 *
 * AI SDK は道具の入力を JSON Schema に落としてモデルへ載せる。valibot は Standard Schema を
 * 実装しているが、**その規格に JSON Schema 変換は含まれていない** —
 * 素で渡すと `Standard schema vendor 'valibot' does not support JSON Schema conversion.` で落ちる。
 *
 * 落とした案: **道具18件を zod で書き直す。** 変換は要らなくなるが、
 * DB 側(src/services/*.ts)の検証も全部 valibot なので、1つのプロセスに2つのスキーマ言語が並ぶ。
 * 変換を1枚挟むほうが、書き換える行数も後から読む人の負担も小さい。
 */
import { toJsonSchema } from "@valibot/to-json-schema"
import { jsonSchema } from "ai"
import type * as v from "valibot"

export const vs = <T extends v.GenericSchema>(s: T) =>
  jsonSchema<v.InferOutput<T>>(toJsonSchema(s) as Record<string, unknown>)
