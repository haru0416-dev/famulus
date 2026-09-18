/**
 * valibot のスキーマを AI SDK の道具定義へ渡す変換。Standard Schema に JSON Schema 変換は含まれないので、素で渡すと落ちる。
 * zod に書き換えないのは、src/services の検証も valibot で1プロセスに2つのスキーマ言語が並ぶため。
 * `validate` を省くと AI SDK は検証なしで成功扱いにし、モデルの値がそのまま `execute` へ入る。
 * 検証に落ちた呼び出しは turn を止めず、次の呼び出しに指摘が載る(手数を1つ使う)。
 */
import { toJsonSchema } from "@valibot/to-json-schema"
import { jsonSchema } from "ai"
import * as v from "valibot"

export interface RuntimeSchema<T> {
  readonly jsonSchema: Record<string, unknown>
  readonly validate: (value: unknown) => { success: true; value: T } | { success: false; error: Error }
}

/**
 * `errorMode: "ignore"` は JSON Schema に表せない action(`trim` など)を変換から落とす。検証の正本は
 * `validate`(safeParse)で全 action を実行する。既定の throw だと、表せない action を含む道具が1つあるだけで
 * assistant の組み立てが失敗する。
 */
export const rs = <T extends v.GenericSchema>(s: T): RuntimeSchema<v.InferOutput<T>> => ({
  jsonSchema: toJsonSchema(s, { errorMode: "ignore" }) as Record<string, unknown>,
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
