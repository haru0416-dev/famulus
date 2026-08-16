# plan 005 比較評価の記録

## 実施済み

- fixture 2(deep 形の実問い「Discord Gateway の再接続でセッションを捨てるとき、シーケンス番号も捨てるべきか」)
  - 契約固定 → current → explore → 比較の順(2026-08-17)。raw は 2-*.json、比較は 2-comparison.md。
  - current: 5手 / 2取得 / 15秒で一次確認つき claim 1件と正直な limitations。
  - explore: 23手 / 1取得 / 57秒で **7方向すべて明示的な空振り**。実体の claim 0件。
    dossier 291c3450 に空振りごと固定済み(oz dossier で見える)。

## 受け入れ判断(plan 005 step 9 / done criteria)

**explore は opt-in のまま**(researcher の mode=explore)。この fixture では
どの変形も accepted evidence を足さず、コストは手数 4.6 倍・実時間 3.8 倍。
done criteria の「差が出なければ常設の overhead にしない」に該当する。

ただし n=1 で、deep 形の種は explore に最も不利な形。fixture 1(wide 形)と
fixture 3 の対は未実施 — 契約は固定してから回すこと。空振り7件が「種の枠の外は
空だと確認できた」という副産物価値を持つかは、この評価では測っていない。
