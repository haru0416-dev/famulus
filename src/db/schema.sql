-- open-zero base schema. Execution-kernel tables are appended from kernel.sql.

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE discord_outbound (
  id          TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  spec        TEXT NOT NULL CHECK (json_valid(spec)),
  spec_hash   TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('queued','sending','sent','failed','partial','unknown')),
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (purpose, dedupe_key),
  CHECK ((state IN ('failed','partial','unknown')) = (error IS NOT NULL))
) STRICT;

CREATE TABLE discord_outbound_actions (
  outbound_id TEXT NOT NULL REFERENCES discord_outbound(id),
  ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
  kind        TEXT NOT NULL CHECK (kind IN ('open_dm','message','thread','reaction')),
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
CREATE INDEX idx_discord_outbound_state ON discord_outbound(state, created_at);

CREATE TABLE research_dossiers (
  id                  TEXT PRIMARY KEY,
  question            TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('open','concluded','inconclusive')),
  conclusion_claim_id TEXT,
  limitations         TEXT,
  created_at          TEXT NOT NULL,
  concluded_at        TEXT,
  CHECK (
    (state = 'open' AND conclusion_claim_id IS NULL AND limitations IS NULL AND concluded_at IS NULL)
    OR (state = 'concluded' AND conclusion_claim_id IS NOT NULL AND length(trim(limitations)) > 0 AND concluded_at IS NOT NULL)
    OR (state = 'inconclusive' AND conclusion_claim_id IS NULL AND length(trim(limitations)) > 0 AND concluded_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE research_claims (
  id          TEXT PRIMARY KEY,
  dossier_id  TEXT NOT NULL REFERENCES research_dossiers(id),
  statement   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('observation','hypothesis','conclusion')),
  state       TEXT NOT NULL CHECK (state IN ('open','supported','refuted','inconclusive')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (id, dossier_id),
  CHECK ((state = 'open') = (resolved_at IS NULL))
) STRICT;
CREATE INDEX idx_research_claims_dossier ON research_claims(dossier_id, created_at);

CREATE TABLE research_artifacts (
  id            TEXT PRIMARY KEY,
  dossier_id    TEXT NOT NULL REFERENCES research_dossiers(id),
  kind          TEXT NOT NULL CHECK (kind IN ('source_snapshot','sandbox_output')),
  media_type    TEXT NOT NULL,
  content       TEXT,
  uri           TEXT,
  sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
  source_ref    TEXT,
  captured_at   TEXT NOT NULL,
  provenance    TEXT NOT NULL CHECK (json_valid(provenance)),
  supersedes_id TEXT REFERENCES research_artifacts(id),
  created_at    TEXT NOT NULL,
  CHECK ((content IS NULL) != (uri IS NULL)),
  CHECK (kind != 'source_snapshot' OR (content IS NOT NULL AND source_ref IS NOT NULL))
) STRICT;
CREATE INDEX idx_research_artifacts_dossier ON research_artifacts(dossier_id, created_at);

CREATE TABLE research_experiment_runs (
  id                  TEXT PRIMARY KEY,
  hypothesis_claim_id TEXT NOT NULL REFERENCES research_claims(id),
  protocol            TEXT NOT NULL CHECK (json_valid(protocol)),
  environment         TEXT NOT NULL CHECK (json_valid(environment)),
  workspace           TEXT NOT NULL,
  command             TEXT NOT NULL,
  command_artifact_id TEXT NOT NULL REFERENCES research_artifacts(id),
  command_status      TEXT NOT NULL CHECK (command_status IN ('completed','timed_out','unavailable')),
  command_exit_code   INTEGER,
  check_command       TEXT NOT NULL,
  check_artifact_id   TEXT REFERENCES research_artifacts(id),
  check_status        TEXT CHECK (check_status IN ('completed','timed_out','unavailable')),
  check_exit_code     INTEGER,
  verdict             TEXT NOT NULL CHECK (verdict IN ('verified','failed','inconclusive')),
  started_at          TEXT NOT NULL,
  finished_at         TEXT NOT NULL,
  CHECK ((command_status = 'completed') = (command_exit_code IS NOT NULL)),
  CHECK (
    (check_status IS NULL AND check_artifact_id IS NULL AND check_exit_code IS NULL)
    OR (check_status IS 'completed' AND check_artifact_id IS NOT NULL AND check_exit_code IS NOT NULL)
    OR (check_status IN ('timed_out','unavailable') AND check_artifact_id IS NOT NULL AND check_exit_code IS NULL)
  ),
  CHECK (
    (verdict = 'verified' AND check_status IS 'completed' AND check_exit_code IS 0)
    OR (verdict = 'failed' AND check_status IS 'completed' AND check_exit_code IS NOT 0)
    OR (verdict = 'inconclusive' AND (check_status IS NULL OR check_status IN ('timed_out','unavailable')))
  ),
  CHECK (length(trim(command)) > 0 AND length(trim(check_command)) > 0)
) STRICT;
CREATE INDEX idx_research_runs_claim ON research_experiment_runs(hypothesis_claim_id, started_at);

CREATE TABLE research_claim_evidence (
  id                TEXT PRIMARY KEY,
  claim_id          TEXT NOT NULL REFERENCES research_claims(id),
  artifact_id       TEXT REFERENCES research_artifacts(id),
  experiment_run_id TEXT REFERENCES research_experiment_runs(id),
  polarity          TEXT NOT NULL CHECK (polarity IN ('support','refute','context')),
  quote             TEXT,
  location          TEXT,
  added_at          TEXT NOT NULL,
  CHECK ((artifact_id IS NULL) != (experiment_run_id IS NULL)),
  CHECK (quote IS NULL OR length(trim(quote)) > 0),
  CHECK (artifact_id IS NULL OR polarity = 'context' OR quote IS NOT NULL)
) STRICT;
CREATE INDEX idx_research_evidence_claim ON research_claim_evidence(claim_id, added_at);

CREATE TRIGGER research_artifacts_immutable
BEFORE UPDATE ON research_artifacts BEGIN
  SELECT RAISE(ABORT, 'research artifacts are immutable');
END;
CREATE TRIGGER research_artifacts_no_delete
BEFORE DELETE ON research_artifacts BEGIN
  SELECT RAISE(ABORT, 'research artifacts are immutable');
END;
CREATE TRIGGER research_runs_immutable
BEFORE UPDATE ON research_experiment_runs BEGIN
  SELECT RAISE(ABORT, 'research experiment runs are immutable');
END;
CREATE TRIGGER research_runs_no_delete
BEFORE DELETE ON research_experiment_runs BEGIN
  SELECT RAISE(ABORT, 'research experiment runs are immutable');
END;
CREATE TRIGGER research_evidence_immutable
BEFORE UPDATE ON research_claim_evidence BEGIN
  SELECT RAISE(ABORT, 'research evidence is immutable');
END;
CREATE TRIGGER research_evidence_no_delete
BEFORE DELETE ON research_claim_evidence BEGIN
  SELECT RAISE(ABORT, 'research evidence is immutable');
END;
CREATE TRIGGER research_claim_identity_immutable
BEFORE UPDATE ON research_claims
WHEN NEW.id != OLD.id OR NEW.dossier_id != OLD.dossier_id OR NEW.statement != OLD.statement
  OR NEW.kind != OLD.kind OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'research claim identity is immutable');
END;
CREATE TRIGGER research_claim_no_delete
BEFORE DELETE ON research_claims BEGIN
  SELECT RAISE(ABORT, 'research claims are immutable');
END;
CREATE TRIGGER research_claim_insert_open
BEFORE INSERT ON research_claims WHEN NEW.state != 'open' OR NEW.resolved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'research claims must be inserted open');
END;
CREATE TRIGGER research_claim_resolution_requires_evidence
BEFORE UPDATE OF state ON research_claims
WHEN NEW.state IN ('supported','refuted') AND NOT EXISTS (
  SELECT 1 FROM research_claim_evidence
   WHERE claim_id = NEW.id AND polarity = CASE NEW.state WHEN 'supported' THEN 'support' ELSE 'refute' END
)
BEGIN
  SELECT RAISE(ABORT, 'resolved research claim requires matching evidence');
END;
CREATE TRIGGER research_evidence_verified_run
BEFORE INSERT ON research_claim_evidence
WHEN NEW.experiment_run_id IS NOT NULL AND NEW.polarity != 'context'
 AND NOT EXISTS (SELECT 1 FROM research_experiment_runs WHERE id = NEW.experiment_run_id AND verdict = 'verified')
BEGIN
  SELECT RAISE(ABORT, 'only verified experiment runs can support or refute claims');
END;
CREATE TRIGGER research_evidence_source_artifact_only
BEFORE INSERT ON research_claim_evidence
WHEN NEW.artifact_id IS NOT NULL AND NEW.polarity != 'context' AND NOT EXISTS (
  SELECT 1 FROM research_artifacts WHERE id = NEW.artifact_id AND kind = 'source_snapshot'
)
BEGIN
  SELECT RAISE(ABORT, 'only source snapshots can directly support or refute claims');
END;
CREATE TRIGGER research_evidence_same_dossier
BEFORE INSERT ON research_claim_evidence
WHEN NEW.artifact_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM research_claims c JOIN research_artifacts a ON a.dossier_id = c.dossier_id
   WHERE c.id = NEW.claim_id AND a.id = NEW.artifact_id
)
BEGIN
  SELECT RAISE(ABORT, 'research artifact evidence must belong to the claim dossier');
END;
CREATE TRIGGER research_experiment_evidence_same_dossier
BEFORE INSERT ON research_claim_evidence
WHEN NEW.experiment_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM research_claims target
   JOIN research_experiment_runs r ON r.id = NEW.experiment_run_id
   JOIN research_claims hypothesis ON hypothesis.id = r.hypothesis_claim_id
   WHERE target.id = NEW.claim_id AND target.dossier_id = hypothesis.dossier_id
)
BEGIN
  SELECT RAISE(ABORT, 'research experiment evidence must belong to the claim dossier');
END;
CREATE TRIGGER research_evidence_quote_present
BEFORE INSERT ON research_claim_evidence
WHEN NEW.artifact_id IS NOT NULL AND NEW.quote IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM research_artifacts WHERE id = NEW.artifact_id AND content IS NOT NULL AND instr(content, NEW.quote) > 0
)
BEGIN
  SELECT RAISE(ABORT, 'research evidence quote must exist in the artifact');
END;
CREATE TRIGGER research_experiment_open_dossier
BEFORE INSERT ON research_experiment_runs
WHEN NOT EXISTS (
  SELECT 1 FROM research_claims c JOIN research_dossiers d ON d.id = c.dossier_id
   WHERE c.id = NEW.hypothesis_claim_id AND c.kind = 'hypothesis' AND d.state = 'open'
)
BEGIN
  SELECT RAISE(ABORT, 'research experiments require an open dossier hypothesis');
END;
CREATE TRIGGER research_experiment_artifacts_same_dossier
BEFORE INSERT ON research_experiment_runs
WHEN NOT EXISTS (
  SELECT 1 FROM research_claims c
   JOIN research_artifacts command_artifact ON command_artifact.id = NEW.command_artifact_id
   LEFT JOIN research_artifacts check_artifact ON check_artifact.id = NEW.check_artifact_id
   WHERE c.id = NEW.hypothesis_claim_id
     AND command_artifact.dossier_id = c.dossier_id
     AND (NEW.check_artifact_id IS NULL OR check_artifact.dossier_id = c.dossier_id)
)
BEGIN
  SELECT RAISE(ABORT, 'research experiment artifacts must belong to the hypothesis dossier');
END;
CREATE TRIGGER research_experiment_artifacts_unowned
BEFORE INSERT ON research_experiment_runs
WHEN NEW.command_artifact_id = NEW.check_artifact_id
 OR EXISTS (
   SELECT 1 FROM research_artifacts a
    WHERE a.id IN (NEW.command_artifact_id, NEW.check_artifact_id)
      AND a.kind != 'sandbox_output'
 )
 OR EXISTS (
   SELECT 1 FROM research_experiment_runs r
    WHERE r.command_artifact_id IN (NEW.command_artifact_id, NEW.check_artifact_id)
       OR r.check_artifact_id IN (NEW.command_artifact_id, NEW.check_artifact_id)
 )
BEGIN
  SELECT RAISE(ABORT, 'research experiment artifacts must be distinct unowned sandbox outputs');
END;
CREATE TRIGGER research_dossier_conclusion_valid
BEFORE UPDATE OF state ON research_dossiers
WHEN NEW.state = 'concluded' AND NOT EXISTS (
  SELECT 1 FROM research_claims
   WHERE id = NEW.conclusion_claim_id AND dossier_id = NEW.id AND kind = 'conclusion' AND state = 'supported'
)
BEGIN
  SELECT RAISE(ABORT, 'dossier conclusion must be a supported conclusion claim');
END;
CREATE TRIGGER research_dossier_insert_open
BEFORE INSERT ON research_dossiers WHEN NEW.state != 'open'
BEGIN
  SELECT RAISE(ABORT, 'research dossiers must be inserted open');
END;
CREATE TRIGGER research_dossier_terminal_immutable
BEFORE UPDATE ON research_dossiers WHEN OLD.state != 'open'
BEGIN
  SELECT RAISE(ABORT, 'terminal research dossier is immutable');
END;
CREATE TRIGGER research_dossier_no_delete
BEFORE DELETE ON research_dossiers BEGIN
  SELECT RAISE(ABORT, 'research dossier cannot be deleted');
END;
CREATE TRIGGER research_claim_open_dossier_insert
BEFORE INSERT ON research_claims
WHEN NOT EXISTS (SELECT 1 FROM research_dossiers WHERE id = NEW.dossier_id AND state = 'open')
BEGIN
  SELECT RAISE(ABORT, 'research claims require an open dossier');
END;
CREATE TRIGGER research_claim_open_dossier_update
BEFORE UPDATE ON research_claims
WHEN NOT EXISTS (SELECT 1 FROM research_dossiers WHERE id = NEW.dossier_id AND state = 'open')
BEGIN
  SELECT RAISE(ABORT, 'terminal dossier claims are immutable');
END;
CREATE TRIGGER research_artifact_open_dossier
BEFORE INSERT ON research_artifacts
WHEN NOT EXISTS (SELECT 1 FROM research_dossiers WHERE id = NEW.dossier_id AND state = 'open')
BEGIN
  SELECT RAISE(ABORT, 'research artifacts require an open dossier');
END;
CREATE TRIGGER research_artifact_supersedes_same_dossier
BEFORE INSERT ON research_artifacts
WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM research_artifacts old
   WHERE old.id = NEW.supersedes_id AND old.dossier_id = NEW.dossier_id
)
BEGIN
  SELECT RAISE(ABORT, 'superseded research artifact must belong to the same dossier');
END;
CREATE TRIGGER research_evidence_open_dossier
BEFORE INSERT ON research_claim_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM research_claims c JOIN research_dossiers d ON d.id = c.dossier_id
   WHERE c.id = NEW.claim_id AND d.state = 'open'
)
BEGIN
  SELECT RAISE(ABORT, 'research evidence requires an open dossier');
END;

CREATE TABLE drafts (
  id                 TEXT PRIMARY KEY,
  local_day          TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  dossier_id         TEXT NOT NULL REFERENCES research_dossiers(id),
  content_hash       TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('review_pending','revision_needed','delivery_pending','delivery_failed','delivered','accepted','revise_requested','discarded')),
  review_feedback    TEXT,
  outbound_id        TEXT UNIQUE REFERENCES discord_outbound(id),
  delivered_at       TEXT,
  decision_origin_id TEXT UNIQUE,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK ((state IN ('delivery_pending','delivery_failed','delivered','accepted','revise_requested','discarded')) = (outbound_id IS NOT NULL)),
  CHECK ((delivered_at IS NOT NULL) = (state IN ('delivered','accepted','revise_requested','discarded')))
) STRICT;

CREATE TRIGGER drafts_terminal_dossier_insert
BEFORE INSERT ON drafts
WHEN NOT EXISTS (SELECT 1 FROM research_dossiers WHERE id = NEW.dossier_id AND state != 'open')
BEGIN
  SELECT RAISE(ABORT, 'draft requires a terminal research dossier');
END;
CREATE TRIGGER drafts_terminal_dossier_update
BEFORE UPDATE OF dossier_id ON drafts
WHEN NOT EXISTS (SELECT 1 FROM research_dossiers WHERE id = NEW.dossier_id AND state != 'open')
BEGIN
  SELECT RAISE(ABORT, 'draft requires a terminal research dossier');
END;

CREATE TRIGGER drafts_sync_delivery
AFTER UPDATE OF state ON discord_outbound
WHEN NEW.state != OLD.state AND NEW.state IN ('sent','failed','partial','unknown')
BEGIN
  UPDATE drafts
     SET outbound_id = COALESCE(outbound_id, NEW.id),
         state = CASE
           WHEN NEW.state = 'sent' AND EXISTS (
             SELECT 1 FROM discord_outbound_actions
              WHERE outbound_id = NEW.id AND kind = 'message' AND state = 'succeeded' AND receipt IS NOT NULL
           ) THEN 'delivered'
           ELSE 'delivery_failed'
         END,
         delivered_at = CASE
           WHEN NEW.state = 'sent' AND EXISTS (
             SELECT 1 FROM discord_outbound_actions
              WHERE outbound_id = NEW.id AND kind = 'message' AND state = 'succeeded' AND receipt IS NOT NULL
           ) THEN NEW.updated_at
           ELSE NULL
         END,
         review_feedback = CASE WHEN NEW.state = 'sent' THEN review_feedback ELSE NEW.error END,
         updated_at = NEW.updated_at
   WHERE state IN ('review_pending','delivery_pending')
     AND (outbound_id = NEW.id OR (outbound_id IS NULL AND NEW.purpose = 'assistant-draft' AND id = NEW.dedupe_key));
  INSERT OR REPLACE INTO schema_meta(key,value)
    SELECT 'health:draft:last_success',NEW.updated_at
     WHERE EXISTS (SELECT 1 FROM drafts WHERE outbound_id=NEW.id AND state='delivered');
  INSERT OR REPLACE INTO schema_meta(key,value)
    SELECT 'health:draft:last_failure',json_object('at',NEW.updated_at,'stage','delivery','error',NEW.error)
     WHERE NEW.state IN ('failed','partial','unknown')
       AND EXISTS (SELECT 1 FROM drafts WHERE outbound_id=NEW.id AND state='delivery_failed');
END;

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

CREATE TRIGGER events_web_never_belief
BEFORE INSERT ON events WHEN NEW.kind = 'belief' AND NEW.source = 'web'
BEGIN
  SELECT RAISE(ABORT, 'web claims cannot become beliefs');
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
  provenance   TEXT CHECK (provenance IS NULL OR json_valid(provenance)),
  model_attempt_id TEXT REFERENCES model_attempts(id)
) STRICT;
CREATE INDEX idx_ledger_at ON ledger(at, seq);
CREATE INDEX idx_ledger_role_at ON ledger(role, at) WHERE role IS NOT NULL;
CREATE UNIQUE INDEX idx_ledger_model_attempt ON ledger(model_attempt_id) WHERE model_attempt_id IS NOT NULL;

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
