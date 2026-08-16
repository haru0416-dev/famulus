# fixture 2 比較(機械集計のみ。判定欄は raw を読んで埋める)

| 指標 | current | explore |
|---|---|---|
| claim 総数 | 1 | 0 |
| 一次確認(evidence 付き) | 1 | 0 |
| 空振りとして明示された方向 | - | 7 |
| 重複 | - | 0 |
| 手数(モデル呼び出し) | 5 | 23 |
| 外向き取得 | 2 | 1 |
| 実時間 | 15s | 57s |

## 判定欄(rubric は contract に固定済み。raw を読んで埋める)
| 指標 | current | explore |
|---|---|---|
| 新分野名 | 0 | 0 |
| 新概念名 | 0 | 1(distant の summary に graph isomorphism。ただし claim/evidence 無しの候補どまり) |
| 構造差のある説明 | 0 | 0 |
| 予想を外した結果 | 0 | 1(「WebSocket の外には出ない」という予想に対し、7方向全部が空 — 外が無いことの確認) |
