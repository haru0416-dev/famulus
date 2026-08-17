# famulus の評価系(2026-08-17 市場調査からの設計)

## 市場調査の結論

- 二分構造: SaaS 観測系(Braintrust / LangSmith / Langfuse / Arize)と OSS ランナー
  (promptfoo / DeepEval / Inspect)。前者は trace が主対象、後者は scorer が主対象。
- **予想外れ(採用に効いた発見)**: TS/vitest ネイティブが成熟し始めている。evalite
  (v1 beta、ローカル完結・API キー不要・データがローカルから出ない)が最有力。
- LLM-as-judge の偏り(position / verbosity / **self-preference** / format / calibration
  drift)は名前つきで確立。**ADR 0031「精査役は別系列」は self-preference 対策として
  市場側から裏付けられた** — 逆に言うと grok 単系列のいまは judge を制御できない。
- 「実行前に契約(語彙・予想・rubric)を固定する」規律は市場の既定には無い。
  うち(plan 005 の evaluation contract)のほうが厳しい。維持する。

## 設計判断

1. **自前の薄い枠を継続**(`evaluate/*.ts` + `.ward/evals/` の生 artifact)。
   市場ツールに無くてうちに必須のもの: 統治/lane との連動、契約の事前固定、
   秘密データのローカル境界、SQLite/ward への固定。commodity 部分(runner/scorer)は
   bun スクリプトで足りている。UI が欲しくなったら evalite を pin して併用。
2. **機械 scorer 優先**(市場も同じ結論)。照合系(keeper 引用・researcher salvage)は
   全部機械で判定できる。**LLM judge は使わない** — Claude 経路(別系列)ができるまで。
3. 契約(分類規則・fixture)は suite のファイル内に固定し、結果を見てから変えない。
   閾値は初回 baseline を記録してから設ける。
4. eval は実クォータを消費する。**gate には入れない** — モデル/プロンプト変更時と
   定期(手動)で回す。

## Suites

| suite | scorer | 状態 |
|---|---|---|
| `eval:keeper`(引用一致率・capture/false+) | 機械 | **実測済み**: baseline 67%/0/0 → KEEPER_SYSTEM の境界明確化(確言vs推測)で **100%/0/0**(2026-08-17、grok-4.3、12 fixtures) |
| `evaluate:explore`(fan-out 対比較) | 機械+契約 rubric | 実測済み(fixture 2)。1/3 は契約固定済み・未実施 |
| researcher salvage 率 | 機械(dropped/total) | 次候補 — salvageClaims のログから観測可能 |
| draft 形検査 | 機械 | unit test 済み(findLeaks / findShape) |
| reviewer / SOUL 声 | judge 必要 | **保留** — 別系列 judge(Claude)まで着手しない |
