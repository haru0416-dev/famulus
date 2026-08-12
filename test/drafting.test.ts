/**
 * 外に出す文の漏れ検査。**「止めるべきものを止める」と「止めなくていいものを通す」の両方**を見る。
 *
 * 片方だけでは役に立たない。素通しなら医院名の載った記事がそのまま公開されるし、
 * 疑わしいものまで弾けば一度も出せなくなり、出せない検査は外される。
 * 実際に1本目の下書きに何が混ざったかを標本にしてある。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { findLeaks, findSmells } from "../src/agent/drafting.ts"

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
  assert.deepEqual(findSmells(body), ["重要"])
})

test("因果として使うぶんは通す — 締めているときだけ落とす", () => {
  assert.deepEqual(findSmells("有効期限を外したら、実行不能が5件から0件になった。"), [])
  assert.deepEqual(findSmells("この設定が効く。"), ["効く。"])
})

test("定型はどこに出ても落とす", () => {
  const smells = findSmells("本稿では、さまざまな条件を並べていきます。")
  assert.deepEqual(smells.sort(), ["さまざまな", "本稿では", "ていきます"].sort())
})

test("測ったことだけを書いた本文は素通しする", () => {
  const body = [
    "提案5件のうち2件が、押される前に実行できなくなっていた。",
    "1件は参照していた確定値が9時間後に書き換わり、もう1件は中身の期日が有効期限より先に来た。",
    "n=1、期間は5日間。他の条件では確かめていない。",
  ].join("\n")
  assert.deepEqual(findSmells(body), [])
})
