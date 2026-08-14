/**
 * valibot のスキーマを AI SDK の道具定義に渡せる形にする1枚。
 *
 * AI SDK は道具の入力を JSON Schema に落としてモデルへ載せる。valibot は Standard Schema を
 * 実装しているが、その規格に JSON Schema 変換は含まれていない —
 * 素で渡すと `Standard schema vendor 'valibot' does not support JSON Schema conversion.` で落ちる。
 *
 * 落とした案: 道具18件を zod で書き直す。変換は要らなくなるが、
 * DB 側(src/services/*.ts)の検証も全部 valibot なので、1つのプロセスに2つのスキーマ言語が並ぶ。
 * 変換を1枚挟むほうが、書き換える行数も後から読む人の負担も小さい。
 *
 * ## `validate` を渡す
 * 渡さないと検証されない。AI SDK の `safeValidateTypes` は `schema.validate == null` を
 * 「検証なしで成功」として通す。つまり `validate` を省くと、valibot のスキーマは
 * JSON Schema を作るためだけに使われ、モデルが返した値はそのまま `execute` へ入る —
 * 実行時検証が無いと `hours: "24"`(文字列)も、必須の欠けも通る。
 *
 * 落ちた呼び出しは turn を止めない。AI SDK が `tool-error` を積み、次の呼び出しの
 * 「## ツール結果」に valibot の指摘が載るので、モデルは同じ turn の中で呼び直せる。
 * 代わりに手数(`stepCountIs`)を1つ使う。
 */
import { toJsonSchema } from "@valibot/to-json-schema"
import { jsonSchema } from "ai"
import * as v from "valibot"

export interface RuntimeSchema<T> {
  readonly jsonSchema: Record<string, unknown>
  readonly validate: (value: unknown) => { success: true; value: T } | { success: false; error: Error }
}

/** Runner の構造化出力を、モデルへ渡す JSON Schema と実行時検証の組で持つ。 */
export const rs = <T extends v.GenericSchema>(s: T): RuntimeSchema<v.InferOutput<T>> => ({
  jsonSchema: toJsonSchema(s) as Record<string, unknown>,
  validate: (value) => {
    const r = v.safeParse(s, value)
    return r.success
      ? { success: true, value: r.output as v.InferOutput<T> }
      : { success: false, error: new Error(v.summarize(r.issues)) }
  },
})

export const vs = <T extends v.GenericSchema>(s: T) => {
  const schema = rs(s)
  return jsonSchema<v.InferOutput<T>>(schema.jsonSchema, { validate: schema.validate })
}
