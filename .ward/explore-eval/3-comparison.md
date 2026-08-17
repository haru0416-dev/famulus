# fixture 3 比較(機械集計のみ。判定欄は raw を読んで埋める)

| 指標 | current | explore |
|---|---|---|
| claim 総数 | 2 | 0 |
| 一次確認(evidence 付き) | 2 | 0 |
| 空振りとして明示された方向 | - | 7 |
| 重複 | - | 0 |
| 手数(モデル呼び出し) | 3 | 18 |
| 外向き取得 | 2 | 0 |
| 実時間 | 16s | 46s |

## 判定欄(rubric は contract に固定済み。raw を読んで埋める)
| 指標 | current | explore |
|---|---|---|
| 新分野名 | 0 | 0 |
| 新概念名 | 0 | 1(distant の summary に flaky test isolation。claim/evidence 無しの候補どまり) |
| 構造差のある説明 | 0 | 0 |
| 予想を外した結果 | 1(「一般論が出る」の予想に反し、current は resolv.conf/systemd-resolved の具体機構を一次確認した) | 0 |
