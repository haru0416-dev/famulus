/**
 * 外に出す文の漏れ検査。**「止めるべきものを止める」と「止めなくていいものを通す」の両方**を見る。
 *
 * 片方だけでは役に立たない。素通しなら医院名の載った記事がそのまま公開されるし、
 * 疑わしいものまで弾けば一度も出せなくなり、出せない検査は外される。
 * 実際に1本目の下書きに何が混ざったかを標本にしてある。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { findLeaks, findShape, findSmells } from "../src/agent/drafting.ts"

/** 非公開の確定値。台帳にはこの形で入っている(JSON 文字列の中身)。 */
const SECRETS = [
  "歯医者(さくら歯科)の次回予約は2026年8月19日(水)18:00に変更。",
  "歯科医院はさくら歯科、連絡先メールは info@sakura-dental.example。",
  "美容室サロンKの希望枠は8月17日(月)10:00。",
]

test("連絡先はそのまま当たる — 出れば取り消せない", () => {
  const leaks = findLeaks("問い合わせ先は info@sakura-dental.example だった。", SECRETS)
  // 断片ではなく**一致しているところ全体**が1件で返る。前後にどこまで伸びるかは本文次第なので、
  // 境界は固定しない — 21個の窓が並ばないことと、消す対象が読めることを見る。
  assert.equal(leaks.length, 1)
  assert.equal(leaks[0]?.includes("info@sakura-dental.example"), true)
})

test("非公開の値と長く一致する断片を拾う", () => {
  // 1本目の下書きに実際に入っていた書き方。
  const body = "歯科医院への予約変更依頼。次回予約は2026年8月19日(水)18:00に変更されていた。"
  assert.equal(findLeaks(body, SECRETS).length > 0, true)
})

test("仕組みと数字だけなら通る — 伏せて書けば出せる", () => {
  const body = [
    "提案5件のうち2件が、裁可される前に実行不能になった。",
    "提案A(id 04481205)は参照していた確定値が1日9時間後に書き換わり、",
    "提案B は中身の期日が提案の有効期限より先に来た。n=1、期間は5日間。",
  ].join("\n")
  assert.deepEqual(findLeaks(body, SECRETS), [])
})

test("一般語では当たらない — 「歯科医院」程度で弾くと一度も出せなくなる", () => {
  assert.deepEqual(findLeaks("歯科医院に送る予約変更の依頼を1件立てた。", SECRETS), [])
})

test("非公開の値が無ければ何も当たらない", () => {
  assert.deepEqual(findLeaks("どんな本文でも", []), [])
})

test("評価だけで閉じた文を落とす — 1本目が実際に通した書き方", () => {
  const body = "重要なのは、これを検出できたのが自分の走行記録だったことだ。"
  assert.deepEqual(findSmells("題", body), ["重要"])
})

test("因果として使うぶんは通す — 締めているときだけ落とす", () => {
  assert.deepEqual(findSmells("題", "有効期限を外したら、実行不能が5件から0件になった。"), [])
  assert.deepEqual(findSmells("題", "この設定が効く。"), ["効く。"])
})

test("定型はどこに出ても落とす", () => {
  const smells = findSmells("題", "本稿では、さまざまな条件を並べていきます。")
  assert.deepEqual(smells.sort(), ["さまざまな", "本稿では", "ていきます"].sort())
})

test("測ったことだけを書いた本文は素通しする", () => {
  const body = [
    "提案5件のうち2件が、押される前に実行できなくなっていた。",
    "1件は参照していた確定値が9時間後に書き換わり、もう1件は中身の期日が有効期限より先に来た。",
    "n=1、期間は5日間。他の条件では確かめていない。",
  ].join("\n")
  assert.deepEqual(findSmells("提案が実行前に使えなくなった件", body), [])
})

test("比喩と擬人を落とす — 1本目が全部やっていた", () => {
  const smells = findSmells(
    "裁可待ちキューを挟んだら、提案は実行される前に腐った",
    "キューは何も気づかず引きずっている。皮肉なことに、提案はまだ生きている。",
  )
  assert.deepEqual(smells.sort(), ["腐った", "気づかず", "引きずって", "皮肉", "生きている"].sort())
})

test("横棒は題では通し、本文では落とす", () => {
  assert.deepEqual(findSmells("提案が実行前に使えなくなる — n=1 の5日間", "5件中2件だった。"), [])
  assert.deepEqual(findSmells("題", "2件が実行不能になった — 理由は別々だった。"), ["—"])
})

/** 密度の検査に足りる長さの地の文。中身は問わないので、当たる語を含まないものを繰り返す。 */
const filler = (chars: number) => "実行不能になった提案は5件中2件だった。".repeat(Math.ceil(chars / 20))

test("太字が段落ごとに付いていたら出さない — 合図が多いと合図でなくなる", () => {
  const body = ["**A**", "**B**", "**C**", "**D**", "**E**", filler(400)].join("\n\n")
  const shape = findShape(body)
  assert.equal(shape.length, 1)
  assert.match(shape[0] ?? "", /^太字が 5 箇所ある/)
})

test("太字が1つなら通す — 強調そのものを禁じてはいない", () => {
  assert.deepEqual(findShape(`**型エラーは2,641件だった。**\n\n${filler(600)}`), [])
})

test("役割の札を貼った見出しは、中身が付いていても落とす", () => {
  const body = `## 課題：既存コードに linter を入れると失敗する\n\n${filler(300)}`
  assert.deepEqual(findShape(body), [
    "見出し「課題：既存コードに linter を入れると失敗する」が中身を名指していない。" +
      "何が起きたかを見出しにする(役割の札は外す)",
  ])
})

test("役割の名前だけの見出しも落とす", () => {
  const body = `## まとめ\n\n${filler(300)}`
  assert.equal(findShape(body).length, 1)
})

test("中身を名指す見出しは通す — 見出しを減らすこと自体は目的ではない", () => {
  const body = `## 型エラーが2,641件出た\n\n${filler(400)}\n\n## any の半分は catch だった\n\n${filler(400)}`
  assert.deepEqual(findShape(body), [])
})

test("時刻と URL を役割の札と読み違えない", () => {
  const body = `## 18:00 の起動だけが落ちた\n\n${filler(400)}\n\n## https://example.test の応答\n\n${filler(400)}`
  assert.deepEqual(findShape(body), [])
})

test("見出しが多いのは話が複数あるということ", () => {
  const body = ["## 型が消えた", "## any が残った", "## 検査が落ちた", "## 走行が止まった", filler(200)].join(
    "\n\n",
  )
  assert.equal(
    findShape(body).some((s) => s.startsWith("見出しが 4 個ある")),
    true,
  )
})
