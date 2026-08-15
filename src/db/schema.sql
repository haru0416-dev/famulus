-- open-zero base schema. Execution-kernel tables are appended from kernel.sql.

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE cycle_lease (
  lease_name          TEXT PRIMARY KEY CHECK (lease_name = 'cycle'),
  state               TEXT NOT NULL CHECK (state IN ('free','held','released')),
  fence               INTEGER NOT NULL CHECK (fence BETWEEN 0 AND 9007199254740991),
  owner_id            TEXT,
  owner_host_id       TEXT,
  owner_boot_id       TEXT,
  owner_pid_namespace TEXT,
  owner_pid           INTEGER,
  owner_start_ticks   TEXT,
  owner_hostname      TEXT,
  acquired_at_ms      INTEGER,
  heartbeat_at_ms     INTEGER,
  expires_at_ms       INTEGER,
  released_at_ms      INTEGER,
  CHECK (
    (state = 'held'
      AND owner_id IS NOT NULL AND owner_host_id IS NOT NULL AND owner_boot_id IS NOT NULL
      AND owner_pid_namespace IS NOT NULL AND owner_pid > 0 AND owner_start_ticks IS NOT NULL
      AND acquired_at_ms IS NOT NULL AND heartbeat_at_ms >= acquired_at_ms
      AND expires_at_ms > heartbeat_at_ms AND released_at_ms IS NULL)
    OR
    (state = 'free' AND owner_id IS NULL AND owner_host_id IS NULL AND owner_boot_id IS NULL
      AND owner_pid_namespace IS NULL AND owner_pid IS NULL AND owner_start_ticks IS NULL
      AND owner_hostname IS NULL AND acquired_at_ms IS NULL AND heartbeat_at_ms IS NULL
      AND expires_at_ms IS NULL AND released_at_ms IS NULL)
    OR
    (state = 'released' AND owner_id IS NULL AND owner_host_id IS NULL AND owner_boot_id IS NULL
      AND owner_pid_namespace IS NULL AND owner_pid IS NULL AND owner_start_ticks IS NULL
      AND owner_hostname IS NULL AND acquired_at_ms IS NULL AND heartbeat_at_ms IS NULL
      AND expires_at_ms IS NULL AND released_at_ms IS NOT NULL)
  )
) STRICT;

INSERT INTO cycle_lease (lease_name, state, fence) VALUES ('cycle', 'free', 0);

CREATE TRIGGER cycle_lease_no_delete
BEFORE DELETE ON cycle_lease
BEGIN
  SELECT RAISE(ABORT, 'cycle lease cannot be deleted');
END;

CREATE TRIGGER cycle_lease_no_reinsert
BEFORE INSERT ON cycle_lease WHEN EXISTS (SELECT 1 FROM cycle_lease)
BEGIN
  SELECT RAISE(ABORT, 'cycle lease singleton cannot be replaced');
END;

CREATE TRIGGER cycle_lease_fence_monotonic
BEFORE UPDATE ON cycle_lease WHEN NEW.fence < OLD.fence
BEGIN
  SELECT RAISE(ABORT, 'cycle lease fence cannot decrease');
END;

CREATE TRIGGER cycle_lease_owner_requires_fence
BEFORE UPDATE ON cycle_lease
WHEN NEW.state = 'held'
 AND (
   OLD.state != 'held' OR NEW.owner_id IS NOT OLD.owner_id
   OR NEW.owner_host_id IS NOT OLD.owner_host_id OR NEW.owner_boot_id IS NOT OLD.owner_boot_id
   OR NEW.owner_pid_namespace IS NOT OLD.owner_pid_namespace OR NEW.owner_pid IS NOT OLD.owner_pid
   OR NEW.owner_start_ticks IS NOT OLD.owner_start_ticks
 )
 AND NEW.fence <= OLD.fence
BEGIN
  SELECT RAISE(ABORT, 'cycle lease owner change requires a higher fence');
END;

-- Memory source of truth. seq is the explicit cursor used by tick and dream.
CREATE TABLE events (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  at                  TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('observe','belief','redact','import')),
  source              TEXT NOT NULL CHECK (source IN ('owner','calendar','gmail','web','system')),
  taint               INTEGER NOT NULL CHECK (taint IN (0,1)),
  exposure            TEXT NOT NULL CHECK (exposure IN ('private','public')),
  supersedes          TEXT REFERENCES events(id),
  provenance          TEXT NOT NULL CHECK (json_valid(provenance)),
  content             TEXT CHECK (content IS NULL OR json_valid(content)),
  search_text         TEXT,
  origin_kind         TEXT,
  origin_id           TEXT,
  belief_slot         TEXT,
  valid_from          TEXT,
  invalidated_reason  TEXT,
  evidence_event_id   TEXT REFERENCES events(id),
  evidence_quote      TEXT,
  CHECK ((origin_kind IS NULL) = (origin_id IS NULL)),
  CHECK ((kind = 'belief') = (belief_slot IS NOT NULL AND valid_from IS NOT NULL)),
  CHECK (kind = 'belief' OR (invalidated_reason IS NULL AND evidence_event_id IS NULL AND evidence_quote IS NULL))
) STRICT;
CREATE INDEX idx_events_at ON events(at, seq);
CREATE INDEX idx_events_kind_at ON events(kind, at, seq);
CREATE INDEX idx_events_supersedes ON events(supersedes);
CREATE INDEX idx_events_belief ON events(belief_slot, valid_from, seq) WHERE kind = 'belief';
CREATE UNIQUE INDEX idx_events_origin ON events(origin_kind, origin_id)
  WHERE origin_id IS NOT NULL AND content IS NOT NULL;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events is append-only: DELETE forbidden');
END;

CREATE TRIGGER events_immutable_except_redact
BEFORE UPDATE ON events
WHEN
  NEW.seq IS NOT OLD.seq OR NEW.id IS NOT OLD.id OR NEW.at IS NOT OLD.at OR NEW.kind IS NOT OLD.kind
  OR NEW.source IS NOT OLD.source OR NEW.taint IS NOT OLD.taint OR NEW.exposure IS NOT OLD.exposure
  OR NEW.supersedes IS NOT OLD.supersedes OR NEW.provenance IS NOT OLD.provenance
  OR NEW.origin_kind IS NOT OLD.origin_kind OR NEW.origin_id IS NOT OLD.origin_id
  OR NEW.belief_slot IS NOT OLD.belief_slot OR NEW.valid_from IS NOT OLD.valid_from
  OR NEW.invalidated_reason IS NOT OLD.invalidated_reason OR NEW.evidence_event_id IS NOT OLD.evidence_event_id
  OR NEW.evidence_quote IS NOT OLD.evidence_quote OR NEW.content IS NOT NULL OR NEW.search_text IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'events is append-only: only content/search_text redaction is permitted');
END;

CREATE VIRTUAL TABLE events_fts USING fts5(
  event_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

-- Belief history is derived from immutable belief events. The next claim closes the previous interval.
CREATE VIEW belief_slots AS
WITH timeline AS (
  SELECT
    belief_slot AS slot,
    content AS value,
    exposure,
    id AS resolved_from,
    at AS updated_at,
    valid_from,
    LEAD(valid_from) OVER (PARTITION BY belief_slot ORDER BY valid_from, seq) AS valid_until,
    LEAD(invalidated_reason) OVER (PARTITION BY belief_slot ORDER BY valid_from, seq) AS invalidated_reason
  FROM events
  WHERE kind = 'belief'
)
SELECT * FROM timeline WHERE value IS NOT NULL;

CREATE TABLE proposals (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  summary        TEXT NOT NULL,
  assessment     TEXT NOT NULL,
  ask            TEXT NOT NULL,
  c_what         TEXT NOT NULL,
  c_when         TEXT NOT NULL,
  c_who          TEXT NOT NULL CHECK (c_who IN ('famulus','human')),
  c_how          TEXT NOT NULL,
  c_how_verified TEXT NOT NULL,
  payload        TEXT NOT NULL CHECK (json_valid(payload)),
  provenance     TEXT NOT NULL CHECK (json_valid(provenance)),
  status         TEXT NOT NULL CHECK (status IN ('proposed','approved','denied','expired')),
  expires_at     TEXT NOT NULL,
  deny_reason    TEXT,
  settled_at     TEXT,
  settled_note   TEXT,
  CHECK ((status = 'denied') = (deny_reason IS NOT NULL)),
  CHECK ((settled_at IS NULL) = (settled_note IS NULL))
) STRICT;
CREATE INDEX idx_proposals_status ON proposals(status, created_at DESC);
CREATE INDEX idx_proposals_expires ON proposals(expires_at) WHERE status = 'proposed';

CREATE TABLE proposal_actions (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  proposal_id   TEXT NOT NULL REFERENCES proposals(id),
  at            TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('approve','deny','expire')),
  actor         TEXT NOT NULL CHECK (actor IN ('owner','system')),
  actor_ref     TEXT,
  reason        TEXT,
  payload_hash  TEXT,
  latency_ms    INTEGER NOT NULL CHECK (latency_ms >= 0),
  CHECK ((action = 'approve') = (payload_hash IS NOT NULL)),
  CHECK ((action = 'deny') = (reason IS NOT NULL)),
  CHECK (action != 'approve' OR actor = 'owner'),
  CHECK (action != 'expire' OR actor = 'system')
) STRICT;
CREATE UNIQUE INDEX idx_proposal_terminal ON proposal_actions(proposal_id);
CREATE INDEX idx_proposal_actions_at ON proposal_actions(at, seq);

CREATE TABLE ledger (
  seq          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  role         TEXT,
  model        TEXT,
  in_tok       INTEGER NOT NULL DEFAULT 0 CHECK (in_tok >= 0),
  out_tok      INTEGER NOT NULL DEFAULT 0 CHECK (out_tok >= 0),
  cache_read   INTEGER NOT NULL DEFAULT 0 CHECK (cache_read >= 0),
  cache_write  INTEGER NOT NULL DEFAULT 0 CHECK (cache_write >= 0),
  summary      TEXT,
  provenance   TEXT CHECK (provenance IS NULL OR json_valid(provenance))
) STRICT;
CREATE INDEX idx_ledger_at ON ledger(at, seq);
CREATE INDEX idx_ledger_role_at ON ledger(role, at) WHERE role IS NOT NULL;

CREATE TABLE watchlist (
  id               TEXT PRIMARY KEY,
  subject          TEXT NOT NULL,
  opened_at        TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  next_move_owner  TEXT NOT NULL CHECK (next_move_owner IN ('human','famulus')),
  status           TEXT NOT NULL CHECK (status IN ('open','closed')),
  source_ref       TEXT CHECK (source_ref IS NULL OR json_valid(source_ref)),
  last_run_at      TEXT,
  cooldown_hours   REAL NOT NULL DEFAULT 24 CHECK (cooldown_hours > 0),
  run_count        INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  last_result      TEXT,
  last_shown_at    TEXT,
  CHECK (
    (run_count = 0 AND last_run_at IS NULL AND last_result IS NULL)
    OR (run_count > 0 AND last_run_at IS NOT NULL AND last_result IS NOT NULL)
  )
) STRICT;
CREATE INDEX idx_watchlist_open ON watchlist(last_activity_at) WHERE status = 'open';

CREATE TABLE watch_runs (
  seq       INTEGER PRIMARY KEY,
  watch_id  TEXT NOT NULL REFERENCES watchlist(id),
  at        TEXT NOT NULL,
  result    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_watch_runs_at ON watch_runs(at, seq);
CREATE INDEX idx_watch_runs_watch ON watch_runs(watch_id, seq);

CREATE TABLE questions (
  id                TEXT PRIMARY KEY,
  question          TEXT NOT NULL,
  opened_at         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('open','answered','dropped')),
  confidence        TEXT NOT NULL DEFAULT 'unverified' CHECK (confidence IN ('unverified','confirmed')),
  answer            TEXT,
  resolved_event_id TEXT REFERENCES events(id),
  CHECK ((status = 'open') = (answer IS NULL))
) STRICT;
CREATE INDEX idx_questions_open ON questions(opened_at) WHERE status = 'open';

CREATE TABLE workspaces (
  name       TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  keep       INTEGER NOT NULL DEFAULT 0 CHECK (keep IN (0,1))
) STRICT;
