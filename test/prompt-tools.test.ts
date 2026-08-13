/**
 * プロンプトが名指す道具が**実際に登録されているか**を機械で見る。
 *
 * 見方は素朴に、プロンプトの中の \`バッククォート\` で囲んだ小文字の語を全部拾い、
 * 道具の名前か、下の表に載っているかのどれかであることを要求する。
 * **表は「これは道具ではない」と人が言い切った語だけ**を置く場所で、
 * 増えるときは1件ずつ判断が要る。拾いすぎるより、通す条件を人手で書かせるほうを取っている。
 *
 * **道具の出所は1つになった。** 前は枠(フレームワーク)が最初から載せるものがあり、
 * それを数え落として実在する道具を幻だと判定したことがある(docs/adr/0010)。
 * いまは `buildTools()` が返す表と、子に渡す表がすべてなので、両方を同じ正規表現で拾う。
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
  "oz", // CLI の名前(ユーザーが端末で叩くもの)
  "owner", // DB の列の値
  "source", // DB の列名(誰が書いたか)。keeper と dream が材料を絞るのに使う
  "commit", // Attention の関数(冷却の起点を進める側)。モデルからは呼べない
  "at", // 道具の引数名(`ran` に渡す、実際に回した時刻)
  "since", // keeper の引数名(この回の起点)。モデルには見えない
  "purpose", // 道具の引数名(`shell` に渡す、その作業場は何のための場所か)
  "signal", // respond() の引数名(呼ぶ側が締切で切るための AbortSignal)。モデルには見えない
  // ここから下は tick が DB に残す記録の欄名(src/journal.ts が読む側)。**モデルからは触れない** —
  // 呼び出し側が数えて書く値で、道具として呼べるものは1つも無い(docs/adr/0030)。
  "text", // Turn の欄。モデルが書いた締めの文
  "said", // 記録の欄。`text` をそのまま置いたもの(自己申告)
  "tools", // 記録の欄。実際に呼ばれた道具の名前の並び
  "steps", // 記録の欄。手数
  "ms", // 記録の欄。その回に掛かったミリ秒
  // 自分を指す語と、それが入っている列(SOUL.md の「名前」/ docs/adr/0033)。**呼べるものではない。**
  "famulus", // 名前。DB の中では `next_move_owner` / `c_who` の値として「自分」を指す
  "next_move_owner", // watchlist の列名(次に動くのは誰か)
  "c_who", // proposals の列名(誰がやるか)
])

/**
 * 登録されている道具の名前。
 *
 * 拾う形は2つ: 表に直接置いたもの(`remember: tool({`)と、変数に切り出したものを
 * 表に差したもの(`recall: recallTool(state)` / `search: searchTool`)。
 * **子に渡す表も同じ書き方**なので、1つの正規表現で両方が採れる。
 */
function registered(): Set<string> {
  const src = read("src/agent/assistant.ts")
  const names = [...src.matchAll(/\b([a-z][a-z0-9_]*):\s*(?:tool\(\{|[a-zA-Z_]*[Tt]ool\b)/g)].map(
    (m) => m[1] as string,
  )
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
