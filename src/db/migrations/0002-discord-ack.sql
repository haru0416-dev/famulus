-- 受信メッセージへ直接付けるリアクション(ack)を action の種類に足す。
-- CHECK 制約は ALTER では変えられないので、表を作り直して移し替える。
--
-- 手順は SQLite の表定義変更の定石どおり「旧表を退避 → 最終名で新表を作る → 移す → 捨てる」。
-- 逆順(新表を仮名で作って RENAME)にすると、定義文に引用符付きの表名が残って schema の
-- 指紋照合(assertCurrentSchema)が新規作成 DB と一致しなくなる。
--
-- 依存するトリガ(drafts_sync_delivery)がこの表を参照している。既定の ALTER RENAME は
-- トリガ本文の参照まで書き換えるので、legacy_alter_table を立てて止める
-- — 参照先は同じ名前の新表であってほしい。

PRAGMA legacy_alter_table=ON;
ALTER TABLE discord_outbound_actions RENAME TO discord_outbound_actions_old;
PRAGMA legacy_alter_table=OFF;

CREATE TABLE discord_outbound_actions (
  outbound_id TEXT NOT NULL REFERENCES discord_outbound(id),
  ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
  kind        TEXT NOT NULL CHECK (kind IN ('open_dm','message','thread','reaction','ack')),
  spec        TEXT NOT NULL CHECK (json_valid(spec)),
  spec_hash   TEXT NOT NULL,
  nonce       TEXT CHECK (nonce IS NULL OR length(nonce) <= 25),
  state       TEXT NOT NULL CHECK (state IN ('queued','sending','succeeded','failed','unknown')),
  receipt     TEXT CHECK (receipt IS NULL OR json_valid(receipt)),
  error       TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (outbound_id, ordinal),
  CHECK ((state IN ('failed','unknown')) = (error IS NOT NULL)),
  CHECK ((state = 'succeeded') = (receipt IS NOT NULL))
) STRICT;

INSERT INTO discord_outbound_actions
  SELECT outbound_id,ordinal,kind,spec,spec_hash,nonce,state,receipt,error,updated_at
    FROM discord_outbound_actions_old;

DROP TABLE discord_outbound_actions_old;
