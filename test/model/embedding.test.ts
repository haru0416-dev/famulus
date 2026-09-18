/** 実モデル(ruri)はネットワークが要るので呼ばない。検索品質は eval:recall で見る。 */

import assert from "node:assert/strict"
import { test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { EMBEDDING_DIM, embedPassage, embedQuery, stubEmbed } from "../../src/model/embedding.ts"

const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0)
  return s
}

test("stub は決定的で、2-gram を共有する文ほど近い", () => {
  const a = stubEmbed("問題空間の誤定義仮説を検証した")
  const b = stubEmbed("問題空間の誤定義仮説を検証した")
  assert.equal(a.length, EMBEDDING_DIM)
  assert.deepEqual([...a], [...b])

  const near = cosine(stubEmbed("誤定義の仮説"), a)
  const far = cosine(stubEmbed("ポケカ販売サイトのデザイン"), a)
  assert.ok(near > far, `共有 2-gram の多い文が遠い: near=${near} far=${far}`)
})

test("off では埋め込みを作らない(recall は FTS だけで動く)", async () => {
  const saved = process.env.FAMULUS_EMBEDDING
  try {
    process.env.FAMULUS_EMBEDDING = "off"
    configureApp()
    assert.equal(await embedQuery("何か"), undefined)
    assert.equal(await embedPassage("何か"), undefined)
  } finally {
    process.env.FAMULUS_EMBEDDING = saved
    configureApp()
  }
})

test("空文字と空白だけの文は埋め込まない", async () => {
  configureApp()
  assert.equal(await embedPassage(""), undefined)
  assert.equal(await embedPassage("   "), undefined)
})
