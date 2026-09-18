-- 時刻ではなく実行IDで集計する。旧行の帰属は推測せずNULLのまま残す。
ALTER TABLE events ADD COLUMN cycle_id TEXT;
ALTER TABLE ledger ADD COLUMN cycle_id TEXT;
ALTER TABLE proposals ADD COLUMN cycle_id TEXT;
ALTER TABLE watch_runs ADD COLUMN cycle_id TEXT;
-- 中断したモデル呼び出しを後の回で回復しても、開始した回への帰属は変えない。
ALTER TABLE model_attempts ADD COLUMN cycle_id TEXT;

CREATE INDEX idx_events_cycle ON events(cycle_id, kind) WHERE cycle_id IS NOT NULL;
CREATE INDEX idx_ledger_cycle ON ledger(cycle_id) WHERE cycle_id IS NOT NULL AND role IS NOT NULL;
CREATE INDEX idx_proposals_cycle ON proposals(cycle_id) WHERE cycle_id IS NOT NULL;
CREATE INDEX idx_watch_runs_cycle ON watch_runs(cycle_id) WHERE cycle_id IS NOT NULL;

-- 本文を抹消できても実行IDは変更できない。
CREATE TRIGGER events_cycle_immutable
BEFORE UPDATE OF cycle_id ON events
WHEN NEW.cycle_id IS NOT OLD.cycle_id
BEGIN
  SELECT RAISE(ABORT, 'event cycle attribution is immutable');
END;
