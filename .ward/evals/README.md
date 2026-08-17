# famulus の評価系 — 現在地

**この1枚は追記しない。毎回まるごと書き直す**(形式は ~/dev/test/STATUS.md から輸入)。
生の結果は `.ward/evals/` と `.ward/explore-eval/` に追記式で残り、消さない。

## 0. 規律(~/dev/test の誤前提シリーズから輸入したもの)

- **判定は成果物と実行で行う。報告文を測定にしない**(pitfalls §4.1)。keeper 評価は DB の
  belief 行を読む。explore 評価は dossier と raw JSON を読む。
- **経路は (ハーネス, バックエンド, モデルID) の三つ組 + commit rev で記録**(§2.1/2.2)。
  eval artifact に `route` と `rev` が入る。モデル名だけの比較は再現しない。
- **契約(fixture・分類規則・rubric)は実行前に固定し、結果を見てから変えない**(§5.4)。
- **結論には成立条件を併記する**(§5.1)。「explore は効かない」ではなく
  「grok-4.3 分岐・6手・現行ブリーフの条件で、accepted evidence への寄与ゼロ」。
- **単発の走で語らない**(§5.2)。形の効果は最低2回の独立走で確かめる。
- **投入数と完了数を突き合わせる。空ランと失敗ランを区別する**(§3.1〜3.3)。
  探索評価の fixture 3 で1回、エラーを tail で握りつぶして黙って欠けた(再実行で回復)。
- **環境の混入を疑う**(§1.1/1.2)。eval は `:memory:` DB + 明示プロンプトのみで走らせる。
  将来 Claude を judge に使うときは **`~/.claude/CLAUDE.md` に完了判定が入っている**ため、
  素の `claude -p` では床が測れない — 隔離設定が必須(STATUS §6 の罠)。
- LLM judge は使わない(self-preference bias。別系列 = Claude 経路ができるまで)。
  機械 scorer 優先。

## 1. 主張してよいこと(2026-08-17 時点)

### keeper(引用一致率・capture)— `bun run eval:keeper`

条件: open-zero keeper × api.x.ai responses × grok-4.3、合成 12 fixtures、`:memory:` DB。

| 走 | capture | false+ | 照合違反 |
|---|---|---|---|
| baseline(境界修正前) | 6/9 | 0 | 0 |
| 修正後 1回目 | 9/9 | 0 | 0 |
| 修正後 2回目(独立) | 9/9 | 0 | 0 |

取りこぼしの型は「抽出成功→過剰保守の自己棄却」。KEEPER_SYSTEM に
「境界は確言か推測かで、現在か未来かではない」を1段書いて解消。
**grok 移行後の引用一致率は 3走 36 fixtures で違反 0**(keepGrounded がコードで強制)。

### explore(fan-out 対比較)— `bun run evaluate:explore`

条件: grok-4.3 分岐 × 6手 × 現行ブリーフ、契約先固定、n=3 fixtures(wide/deep/debug 形)。

- 21分岐で accepted evidence への寄与 **0件**、手数約5倍 → **opt-in 継続が最終判断**。
- 予想を外した発見は3件中2件が **current 側**から出た。
- 分岐の失敗の型(未検証仮説): 変形を「探す方向」でなく「検索語の制約」に直訳している。
  改善候補3つは RESULTS.md に記録済み。試すなら同じ契約・同じ fixtures で対を取り直す。

### researcher salvage 率(観測)

salvageClaims の落とし分は dossier の limitations に「引用照合で落とした claim:」で残る。
自走の蓄積後に `oz dossier` から集計する。まだ n が無い。

## 2. 撤回した主張

(まだ無い。出たらここに集約する — 追記の海に散逸させない)

## 3. 未決

1. keeper fixtures は合成のみ。実発話での capture は未測定(私的データの扱いを決めてから)。
2. explore 改善候補3つ(ブリーフに翻訳例 / 分岐を4.6 / 翻訳を親に)— どれも未測定。
3. reviewer / SOUL 声の評価 — 別系列 judge 待ち。
4. eval 実行のクォータ会計が本番 ledger に載らない(`:memory:` DB のため)。
   物理消費はある。1 suite ≈ 12〜30 呼び出し。

## 4. 市場調査の要約(2026-08-17)

SaaS 観測系(Braintrust/LangSmith/Langfuse/Arize)と OSS ランナー(promptfoo/DeepEval/
Inspect)の二分。TS/vitest ネイティブは evalite が v1 beta(ローカル完結)— UI が
欲しくなったときの候補。judge の5偏り(position/verbosity/self-preference/format/
calibration drift)は文献で確立 — ADR 0031 の別系列規律はこの対策に一致。
「契約の事前固定」は市場の既定に無い(うちの方が厳しい。維持)。
