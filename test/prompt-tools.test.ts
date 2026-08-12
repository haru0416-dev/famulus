/**
 * プロンプトが名指す道具が**実際に登録されているか**を機械で見る。
 *
 * 見方は素朴に、プロンプトの中の \`バッククォート\` で囲んだ小文字の語を全部拾い、
 * 道具の名前か、下の2つの表に載っているかのどれかであることを要求する。
 * **表は「これは道具ではない」「これは枠の側の道具だ」と人が言い切った語だけ**を置く場所で、
 * 増えるときは1件ずつ判断が要る。拾いすぎるより、通す条件を人手で書かせるほうを取っている。
 *
 * **`assistant.ts` の \`name:\` だけを見ると足りない。** 道具には2つの出所がある —
 * こちらが `useTool` / `useSubagent` で登録するものと、Flue が最初から載せるもの。
 * 後者を数え落とすと、**実在する道具を幻だと判定する**(それを一度やったのが docs/adr/0010)。
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
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
  "commit", // Attention の関数(冷却の起点を進める側)。モデルからは呼べない
  "at", // 道具の引数名(`ran` に渡す、実際に回した時刻)
  "since", // keeper の引数名(この回の起点)。モデルには見えない
])

/**
 * Flue が最初から載せる道具。**こちらの登録には出てこないが、モデルの一覧には出ている。**
 * 下の `framework()` が dist の中に実在を確かめに行くので、この表は「名前を知っている」だけの役。
 */
const FRAMEWORK = ["task", "activate_skill"]

/** 枠の側の道具が本当に載っているかを、Flue の実体で確かめる。名前だけ信じない。 */
function framework(): Set<string> {
  const dist = fileURLToPath(new URL("../node_modules/@flue/runtime/dist", import.meta.url))
  const blob = readdirSync(dist)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => readFileSync(`${dist}/${f}`, "utf8"))
    .join("")
  const found = FRAMEWORK.filter((n) => blob.includes(`name: "${n}"`))
  assert.deepEqual(
    found,
    FRAMEWORK,
    `Flue が載せているはずの道具が実体に無い。版を上げて名前が変わった可能性: ${FRAMEWORK.filter((n) => !found.includes(n)).join(", ")}`,
  )
  return new Set(FRAMEWORK)
}

/** 登録されている道具の名前。`useTool`/`useSubagent` の `name` と、枠が載せるものを足す。 */
function registered(): Set<string> {
  const src = read("src/agent/assistant.ts")
  const names = [...src.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1] as string)
  assert.ok(names.length > 5, `道具が採れていない(${names.length}件)— 登録の書き方が変わった可能性`)
  return new Set([...names, ...framework()])
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
