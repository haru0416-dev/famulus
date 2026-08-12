/**
 * プロンプトが名指す道具が**実際に登録されているか**を機械で見る。
 *
 * 心拍のプロンプトに `task` という道具の使い方が書いてあった時期がある。そんな道具は無い。
 * しかも規律には「一覧に無い道具は最初から呼ばない」と書いてあるので、モデルは正しく無視した —
 * つまり**その行は最初から誰にも読まれていなかった**。書いた側は指示したつもりでいる。
 * 型検査も lint も文字列の中までは見ないので、気付く経路が無かった(docs/adr/0004)。
 *
 * 見方は素朴に、プロンプトの中の \`バッククォート\` で囲んだ小文字の語を全部拾い、
 * 道具の名前か、下の免除表に載っているかのどちらかであることを要求する。
 * **免除表は「道具ではない」と人が言い切った語だけ**を置く場所で、増えるときは1件ずつ判断が要る。
 * 拾いすぎるより、通す条件を人手で書かせるほうを取っている。
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8")

/** モデルに渡る文が入っている場所。ここに文を足す先が増えたら、この表にも足す。 */
const PROMPTS = ["SOUL.md", "src/agent/soul.ts", "src/agent/assistant.ts", "src/tick.ts"]

/** 道具ではないと分かっている語。**足すときは「なぜ道具ではないか」を書く。** */
const NOT_TOOLS = new Set([
  "oz", // CLI の名前(持ち主が端末で叩くもの)
  "owner", // 台帳の列の値
])

/** 登録されている道具の名前。`useTool`/`useSubagent` に渡す `name` から採る。 */
function registered(): Set<string> {
  const src = read("src/agent/assistant.ts")
  const names = [...src.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1] as string)
  assert.ok(names.length > 5, `道具が採れていない(${names.length}件)— 登録の書き方が変わった可能性`)
  return new Set(names)
}

test("プロンプトが名指す道具は全部登録されている", () => {
  const tools = registered()
  const missing: string[] = []
  for (const file of PROMPTS) {
    for (const m of read(file).matchAll(/`([a-z][a-z0-9_]*)`/g)) {
      const word = m[1] as string
      if (!tools.has(word) && !NOT_TOOLS.has(word)) missing.push(`${file}: \`${word}\``)
    }
  }
  assert.deepEqual(
    missing,
    [],
    `プロンプトに無い道具の名前がある。登録するか、道具でないなら NOT_TOOLS に理由付きで足す:\n${missing.join("\n")}`,
  )
})

test("免除表に道具の名前を入れて検査を素通しさせていない", () => {
  const tools = registered()
  for (const word of NOT_TOOLS) {
    assert.ok(!tools.has(word), `${word} は実在する道具なので免除表に要らない`)
  }
})
