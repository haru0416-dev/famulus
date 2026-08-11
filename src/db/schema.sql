-- famulus-zero v1 DB スキーマ(G9 — 完全直列化・lineage・冪等性を型で固める)。
-- ストア: bun:sqlite(blueprint §5「正本は append-only events(SQLite テーブル)」/ §4.443)。
-- 設計原則:
--   1. 正本は events。belief_slots / events_fts / vault は projection(silent overwrite 禁止)。
--   2. 時刻は ISO-8601 UTC 'Z'(src/core/brand.ts の IsoUtc)。TEXT で保持。
--   3. bool は INTEGER 0/1。直列化値は JSON を TEXT で保持し json_valid で守る(G41 JsonValue)。
--   4. 実行に触れる境界(承認・スケジュール・配達)は冪等性キーで二重実行を封じる(G20/G21/G37)。
-- 実行時の PRAGMA(接続時に適用、ここには書かない): journal_mode=WAL, foreign_keys=ON, busy_timeout。

-- スキーマ版管理(移植・マイグレーションの土台)。
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================================
-- 1. メモリ正本: events(append-only、MemoryEvent と 1:1。src/memory/events.ts)
-- ============================================================================
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,                       -- ULID/UUID(生成は app)
  at          TEXT NOT NULL,                          -- IsoUtc(発生時刻)
  kind        TEXT NOT NULL CHECK (kind IN ('observe','belief','forget','redact','import')),
  source      TEXT NOT NULL CHECK (source IN ('owner','calendar','gmail','web','system')),
  taint       INTEGER NOT NULL CHECK (taint IN (0,1)),      -- 不信データ由来(gmail/web)
  exposure    TEXT NOT NULL CHECK (exposure IN ('private','public')),
  supersedes  TEXT REFERENCES events(id),             -- lineage(訂正/忘却/抹消の対象)。observe/import は NULL
  provenance  TEXT NOT NULL CHECK (json_valid(provenance)),  -- SourceRef[] の JSON
  content     TEXT CHECK (content IS NULL OR json_valid(content))  -- JsonValue。redact 後は NULL
);
CREATE INDEX IF NOT EXISTS idx_events_at        ON events(at);
CREATE INDEX IF NOT EXISTS idx_events_kind_at   ON events(kind, at);
CREATE INDEX IF NOT EXISTS idx_events_supersedes ON events(supersedes);

-- append-only 不変条件(§5「silent overwrite 禁止」)。
-- DELETE は常に禁止。UPDATE は「content を NULL にする」redact 経路のみ許し、他列の変更は禁止。
CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events is append-only: DELETE forbidden (use a redact/forget event)');
END;

CREATE TRIGGER IF NOT EXISTS events_immutable_except_redact
BEFORE UPDATE ON events
WHEN
  NEW.id IS NOT OLD.id OR NEW.at IS NOT OLD.at OR NEW.kind IS NOT OLD.kind
  OR NEW.source IS NOT OLD.source OR NEW.taint IS NOT OLD.taint
  OR NEW.exposure IS NOT OLD.exposure OR NEW.supersedes IS NOT OLD.supersedes
  OR NEW.provenance IS NOT OLD.provenance
  OR NEW.content IS NOT NULL              -- 許すのは content := NULL(抹消)だけ
BEGIN
  SELECT RAISE(ABORT, 'events is append-only: only content:=NULL (redact) is permitted');
END;

-- ============================================================================
-- 2. projection: belief_slots(現在解決済みの事実)/ events_fts(検索)
--    どちらも events から再構築可能。正本ではない。
-- ============================================================================
-- **時間軸を2本持つ**(bitemporal)。1本だと「6月に転職が終わっていたことを8月に知った」が書けず、
-- 「8月に転職が終わった」としか記録できない。事実がいつ真だったかと、台帳がいつ知ったかは別の話。
--   valid time       … valid_from / valid_until。**その事実がいつ真だったか**
--   transaction time … updated_at。**台帳がいつそれを知ったか**
-- 上書きはしない。古い値は valid_until を打って閉じるだけで、行としては残る
-- (Zep/Graphiti の edge invalidation、SCD Type 2、複式簿記の赤伝と同じ形)。
-- projection なので events から再構築できる。正本ではない。
CREATE TABLE IF NOT EXISTS belief_slots (
  slot         TEXT NOT NULL,                        -- 事実のキー(例: 'dentist.next_appt')
  value        TEXT CHECK (value IS NULL OR json_valid(value)),  -- **この区間の**値(JsonValue)
  exposure     TEXT NOT NULL CHECK (exposure IN ('private','public')),
  resolved_from TEXT NOT NULL REFERENCES events(id),  -- どの belief event が確立したか(訂正鮮度)
  updated_at   TEXT NOT NULL,                         -- transaction time: 台帳が知った時刻(IsoUtc)
  valid_from   TEXT NOT NULL,                         -- valid time: いつからそうなったか
  valid_until  TEXT,                                  -- いつまでそうだったか。**NULL = 今も真**
  -- 何がこの値を終わらせたか。STALE(arXiv 2605.06527)の言う「無効化の出所を残す」。
  -- 理由なしに閉じられた区間は、後から見て訂正なのか記録漏れなのか判別できない。
  invalidated_by     TEXT REFERENCES events(id),
  invalidated_reason TEXT,
  PRIMARY KEY (slot, valid_from)
);

-- slot ごとに「今の値」は高々1本。**この部分 UNIQUE がバイテンポラルの不変条件そのもの**で、
-- 区間を閉じ忘れたまま次を入れると、ここで落ちる(黙って2つの現在値が並ばない)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_belief_current
  ON belief_slots (slot) WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS idx_belief_history
  ON belief_slots (slot, valid_from, valid_until);

-- 全文検索の projection。日本語は **trigram tokenizer**(G3)。unicode61 は日本語を分かち書きできず
-- 「会議」で「明日の会議資料」が引けない。trigram は3文字窓で部分一致する(2文字クエリは未対応=
-- vector 併用のハイブリッド(marble)は v1.5)。projection なので消して再導出できる。
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  event_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

-- ============================================================================
-- 3. proposals(提案。src/tasks/proposal.ts の Proposal と 1:1、状態機械 G25)
-- ============================================================================
CREATE TABLE IF NOT EXISTS proposals (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('reminder','research','plan','vault-update','outbound-draft','skill-promote','skill-retire')),
  created_at     TEXT NOT NULL,                       -- IsoUtc
  -- 裁可カード面
  summary        TEXT NOT NULL,
  assessment     TEXT NOT NULL,
  ask            TEXT NOT NULL,
  -- 完全性ゲート5要素(G26)。名指しできない案は提案にしない(C9)
  c_what         TEXT NOT NULL,
  c_when         TEXT NOT NULL,
  c_who          TEXT NOT NULL CHECK (c_who IN ('famulus','human')),
  c_how          TEXT NOT NULL,
  c_how_verified TEXT NOT NULL,
  -- 実行内容(完全直列化 G41)
  payload        TEXT NOT NULL CHECK (json_valid(payload)),
  provenance     TEXT NOT NULL CHECK (json_valid(provenance)),
  -- 状態(G25)
  status         TEXT NOT NULL CHECK (status IN
                   ('proposed','approved','deferred','denied','expired','executing','executed','failed')),
  deferred_until TEXT,                                -- later 時のみ(IsoUtc)
  expires_at     TEXT NOT NULL,                       -- created_at + MAX_PENDING_DAYS
  deny_reason    TEXT                                 -- deny 時。次の生成へ還流(学習信号)
);
CREATE INDEX IF NOT EXISTS idx_proposals_status  ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_expires ON proposals(expires_at) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS idx_proposals_deferred ON proposals(deferred_until) WHERE status = 'deferred';

-- 承認記録(G21 — 承認の権威境界)。誰が・いつ・何を(hash)承認したかを独立レコードに。
-- 実行ゲートは payload_hash 一致を条件にする(承認後に payload が変われば実行しない)。
CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,
  proposal_id    TEXT NOT NULL REFERENCES proposals(id),
  approver       TEXT NOT NULL CHECK (approver = 'owner'),  -- v1 は所有者1名固定
  approver_ref   TEXT NOT NULL,                       -- Discord user id(interaction の照合元)
  at             TEXT NOT NULL,                       -- IsoUtc
  verb           TEXT NOT NULL CHECK (verb IN ('approve','edit')),
  payload_hash   TEXT NOT NULL,                       -- 承認時に表示していた payload の sha256
  edited_payload TEXT CHECK (edited_payload IS NULL OR json_valid(edited_payload))  -- edit 時のみ
);
CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON approvals(proposal_id);

-- ============================================================================
-- 4. 冪等性・クラッシュ境界(G20 blocker)
--    DB更新 → LLM/API実行 → Discord配達 の途中で落ちても二重実行しない。
--    execution_attempts = atomic claim + idempotency key、outbox = transactional outbox。
-- ============================================================================
CREATE TABLE IF NOT EXISTS execution_attempts (
  id              TEXT PRIMARY KEY,                   -- attempt id
  proposal_id     TEXT NOT NULL REFERENCES proposals(id),
  idempotency_key TEXT NOT NULL UNIQUE,               -- 同一 (proposal, approval) は1回だけ claim できる
  claimed_at      TEXT NOT NULL,                      -- IsoUtc(claim 成功時刻)
  state           TEXT NOT NULL CHECK (state IN ('claimed','succeeded','failed')),
  finished_at     TEXT,                               -- succeeded/failed 到達時刻
  attempt_no      INTEGER NOT NULL DEFAULT 1,         -- replan は1回まで(§4)
  result          TEXT CHECK (result IS NULL OR json_valid(result)),  -- 実行結果/エラー要約
  ledger_id       TEXT REFERENCES ledger(id)          -- 記帳との突合(下記 ledger)
);
CREATE INDEX IF NOT EXISTS idx_attempts_proposal ON execution_attempts(proposal_id);

-- transactional outbox(G20)。副作用(Discord/Gmail/Calendar 配達)は
-- 「DB 更新と同一トランザクションで outbox に積む」→ 別プロセスが配達して sent に遷移。
-- destination_key の UNIQUE が配達の二重化を封じる(例: 'briefing:2026-07-24' は1回だけ)。
CREATE TABLE IF NOT EXISTS outbox (
  id              TEXT PRIMARY KEY,
  attempt_id      TEXT REFERENCES execution_attempts(id),  -- 朝会など提案外の配達は NULL 可
  destination     TEXT NOT NULL CHECK (destination IN ('discord','gmail','calendar')),
  destination_key TEXT NOT NULL UNIQUE,               -- 冪等キー(配達の一意性)
  payload         TEXT NOT NULL CHECK (json_valid(payload)),
  state           TEXT NOT NULL CHECK (state IN ('pending','sent','failed','canceled')),
  created_at      TEXT NOT NULL,                      -- IsoUtc
  sent_at         TEXT,                               -- sent 到達時刻
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(state) WHERE state = 'pending';

-- ============================================================================
-- 5. schedule(durable な時限配達。G10/G37 — 再起動を跨ぐ・TTL 誤発火を防ぐ)
-- ============================================================================
CREATE TABLE IF NOT EXISTS schedule (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT REFERENCES proposals(id),        -- リマインドの由来(朝会など固定枠は NULL)
  fire_at       TEXT NOT NULL,                        -- IsoUtc(発火予定・絶対時刻。相対 TTL は保存時に絶対化 G37)
  channel       TEXT NOT NULL,                        -- 配達先(Discord channel 論理名: morning/proposals/talk)
  payload       TEXT NOT NULL CHECK (json_valid(payload)),
  state         TEXT NOT NULL CHECK (state IN ('pending','fired','canceled','missed')),
  fired_at      TEXT,                                 -- 実発火時刻
  outbox_id     TEXT REFERENCES outbox(id)            -- 配達は outbox 経由(冪等)
);
CREATE INDEX IF NOT EXISTS idx_schedule_due ON schedule(fire_at) WHERE state = 'pending';

-- ============================================================================
-- 6. ledger(全 run・全 turn の記帳。§6 会計。unpriced も 0円にしない)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ledger (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,                         -- IsoUtc
  kind         TEXT NOT NULL,                         -- 'turn' | 'run' | 'briefing' | 'scout' ...
  role         TEXT,                                  -- src/config/models.ts の Role(任意)
  model        TEXT,                                  -- 使用モデル id
  -- 入力は3つに割れて返る。**in_tok だけ見ると嘘になる**(実測 2026-08-10: in_tok=10 / cache_write=7,048)。
  -- 総入力 = in_tok + cache_read + cache_write。どれか1つを「入力」と呼ばない。
  in_tok       INTEGER NOT NULL DEFAULT 0,            -- キャッシュに載らなかった分だけ
  out_tok      INTEGER NOT NULL DEFAULT 0,
  cache_read   INTEGER NOT NULL DEFAULT 0,            -- cache_read=0 監視(§6、対話経路のみ)
  cache_write  INTEGER NOT NULL DEFAULT 0,            -- 初回に書いた分(定義文・system はここに入る)
  usd          REAL NOT NULL DEFAULT 0,
  unpriced     INTEGER NOT NULL DEFAULT 0 CHECK (unpriced IN (0,1)),  -- 単価不明を黙って0円にしない
  proposal_id  TEXT REFERENCES proposals(id),         -- 実行記帳のとき
  summary      TEXT,                                  -- 秘密リダクション済みの要約
  provenance   TEXT CHECK (provenance IS NULL OR json_valid(provenance))
);
CREATE INDEX IF NOT EXISTS idx_ledger_at   ON ledger(at);
CREATE INDEX IF NOT EXISTS idx_ledger_kind ON ledger(kind, at);

-- ============================================================================
-- 7. watchlist(監視中の未決事項。§8 朝会の材料・T1 の滞留検知)
-- ============================================================================
CREATE TABLE IF NOT EXISTS watchlist (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,                      -- 何を見張っているか(例: 'A社 契約更新の返信')
  opened_at       TEXT NOT NULL,                      -- IsoUtc
  last_activity_at TEXT NOT NULL,                     -- 最終動き(滞留日数の起点)
  next_move_owner TEXT NOT NULL CHECK (next_move_owner IN ('human','counterparty','famulus')),
  status          TEXT NOT NULL CHECK (status IN ('open','closed')),
  source_ref      TEXT CHECK (source_ref IS NULL OR json_valid(source_ref))  -- SourceRef
);
CREATE INDEX IF NOT EXISTS idx_watchlist_open ON watchlist(status) WHERE status = 'open';

-- ============================================================================
-- 8. questions(問いレジストリ。quaere: belief と question を分ける。§5.5)
--    「未 probe の仮説」を belief に昇格させないための独立台帳。
-- ============================================================================
CREATE TABLE IF NOT EXISTS questions (
  id                TEXT PRIMARY KEY,
  question          TEXT NOT NULL,
  opened_at         TEXT NOT NULL,                    -- IsoUtc
  status            TEXT NOT NULL CHECK (status IN ('open','answered','dropped')),
  confidence        TEXT NOT NULL CHECK (confidence IN ('unverified','confirmed'))  -- probe 前は unverified
                    DEFAULT 'unverified',
  answer            TEXT,
  resolved_event_id TEXT REFERENCES events(id)        -- answered 時、根拠 event
);
CREATE INDEX IF NOT EXISTS idx_questions_open ON questions(status) WHERE status = 'open';

-- ============================================================================
-- 9. thread_map(Discord private thread ↔ 実体の対応表。§7 詳細展開)
-- ============================================================================
CREATE TABLE IF NOT EXISTS thread_map (
  thread_id   TEXT PRIMARY KEY,                       -- Discord thread id
  channel_id  TEXT NOT NULL,                          -- 親チャンネル
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('proposal','watchlist','question','briefing')),
  entity_id   TEXT NOT NULL,                          -- 対応する実体 id
  created_at  TEXT NOT NULL                           -- IsoUtc
);
CREATE INDEX IF NOT EXISTS idx_thread_entity ON thread_map(entity_kind, entity_id);

-- ============================================================================
-- 10. feedback(裁可の学習信号。T1 approve 率飽和検知・deny 還流)
--     決定の生ログ(decisions)+ 集計重み(feedback_weights)。
-- ============================================================================
CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  at          TEXT NOT NULL,                          -- IsoUtc
  verb        TEXT NOT NULL CHECK (verb IN ('approve','edit','deny','later','expire')),
  kind        TEXT NOT NULL,                          -- 提案 kind(飽和検知を kind 別に見る)
  latency_ms  INTEGER                                 -- 提示→裁可の所要(親指の速さ = UX 指標)
);
CREATE INDEX IF NOT EXISTS idx_decisions_at ON decisions(at);

CREATE TABLE IF NOT EXISTS feedback_weights (
  dimension    TEXT PRIMARY KEY,                      -- 例: 'kind:research', 'signal:calendar'
  weight       REAL NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL                          -- IsoUtc
);

-- ============================================================================
-- 11. owner_allowlist(Discord ingress。§7 owner-only。v1 は所有者1名)
-- ============================================================================
CREATE TABLE IF NOT EXISTS owner_allowlist (
  platform  TEXT NOT NULL CHECK (platform IN ('discord')),
  user_id   TEXT NOT NULL,
  added_at  TEXT NOT NULL,                            -- IsoUtc
  PRIMARY KEY (platform, user_id)
);

-- ============================================================================
-- 12. turns(会話ターンのログ。working/episodic 補助・監査)
-- ============================================================================
CREATE TABLE IF NOT EXISTS turns (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,                           -- IsoUtc
  surface    TEXT NOT NULL CHECK (surface IN ('discord','cli','web')),
  input      TEXT NOT NULL CHECK (json_valid(input)),   -- TurnInput(リダクション後)
  output     TEXT NOT NULL CHECK (json_valid(output)),  -- TurnOutput(リダクション後)
  ledger_id  TEXT REFERENCES ledger(id)
);
CREATE INDEX IF NOT EXISTS idx_turns_at ON turns(at);
