CREATE TABLE execution_roots (
  id                    TEXT PRIMARY KEY,
  owner_kind            TEXT NOT NULL,
  owner_id              TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  deadline_at_ms        INTEGER NOT NULL CHECK (deadline_at_ms > 0),
  max_active_loops      INTEGER NOT NULL CHECK (max_active_loops > 0),
  scope_json            TEXT NOT NULL CHECK (json_valid(scope_json)),
  scope_hash            TEXT NOT NULL,
  budget_model_calls    INTEGER NOT NULL CHECK (budget_model_calls >= 0),
  budget_tool_calls     INTEGER NOT NULL CHECK (budget_tool_calls >= 0),
  budget_tokens         INTEGER NOT NULL CHECK (budget_tokens >= 0),
  budget_cost_microusd  INTEGER NOT NULL CHECK (budget_cost_microusd >= 0),
  UNIQUE(owner_kind, owner_id)
) STRICT;

CREATE TRIGGER execution_roots_immutable
BEFORE UPDATE ON execution_roots BEGIN SELECT RAISE(ABORT, 'execution root is immutable'); END;
CREATE TRIGGER execution_roots_no_delete
BEFORE DELETE ON execution_roots BEGIN SELECT RAISE(ABORT, 'execution root cannot be deleted'); END;

CREATE TABLE execution_root_state (
  root_id     TEXT PRIMARY KEY REFERENCES execution_roots(id),
  status      TEXT NOT NULL CHECK (status IN ('active','completed','failed','cancelled')),
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE loop_specs (
  id                          TEXT PRIMARY KEY,
  root_id                     TEXT NOT NULL REFERENCES execution_roots(id),
  stable_slot                 TEXT NOT NULL,
  role                        TEXT NOT NULL,
  profile_id                  TEXT NOT NULL,
  profile_generation          INTEGER NOT NULL CHECK (profile_generation > 0),
  profile_digest              TEXT NOT NULL,
  profile_snapshot            TEXT NOT NULL CHECK (json_valid(profile_snapshot)),
  task_input_json             TEXT NOT NULL CHECK (json_valid(task_input_json)),
  task_input_hash             TEXT NOT NULL,
  artifacts_json              TEXT NOT NULL CHECK (json_valid(artifacts_json)),
  artifacts_hash              TEXT NOT NULL,
  skill_plan_json             TEXT NOT NULL CHECK (json_valid(skill_plan_json)),
  skill_plan_hash             TEXT NOT NULL,
  result_contract_id          TEXT NOT NULL,
  result_contract_generation  INTEGER NOT NULL CHECK (result_contract_generation > 0),
  result_contract_digest      TEXT NOT NULL,
  result_contract_snapshot    TEXT NOT NULL CHECK (json_valid(result_contract_snapshot)),
  tool_bindings_json          TEXT NOT NULL CHECK (json_valid(tool_bindings_json)),
  tool_bindings_hash          TEXT NOT NULL,
  scope_json                  TEXT NOT NULL CHECK (json_valid(scope_json)),
  scope_hash                  TEXT NOT NULL,
  stop_policy_json            TEXT NOT NULL CHECK (json_valid(stop_policy_json)),
  stop_policy_hash            TEXT NOT NULL,
  budget_model_calls          INTEGER NOT NULL CHECK (budget_model_calls >= 0),
  budget_tool_calls           INTEGER NOT NULL CHECK (budget_tool_calls >= 0),
  budget_tokens               INTEGER NOT NULL CHECK (budget_tokens >= 0),
  budget_cost_microusd        INTEGER NOT NULL CHECK (budget_cost_microusd >= 0),
  semantic_hash               TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  UNIQUE(root_id, stable_slot)
) STRICT;

CREATE TRIGGER loop_specs_immutable
BEFORE UPDATE ON loop_specs BEGIN SELECT RAISE(ABORT, 'loop spec is immutable'); END;
CREATE TRIGGER loop_specs_no_delete
BEFORE DELETE ON loop_specs BEGIN SELECT RAISE(ABORT, 'loop spec cannot be deleted'); END;

CREATE TABLE loop_attempts (
  id                   TEXT PRIMARY KEY,
  loop_id              TEXT NOT NULL REFERENCES loop_specs(id),
  ordinal              INTEGER NOT NULL CHECK (ordinal > 0),
  state                TEXT NOT NULL CHECK (state IN ('active','completed','failed','unknown')),
  fence                INTEGER NOT NULL CHECK (fence > 0),
  owner_host_id        TEXT NOT NULL,
  owner_boot_id        TEXT NOT NULL,
  owner_pid_namespace  TEXT NOT NULL,
  owner_pid            INTEGER NOT NULL CHECK (owner_pid > 0),
  owner_start_ticks    TEXT NOT NULL,
  owner_hostname       TEXT NOT NULL,
  started_at           TEXT NOT NULL,
  finished_at          TEXT,
  UNIQUE(loop_id, ordinal),
  UNIQUE(loop_id, fence),
  CHECK ((state = 'active') = (finished_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX idx_loop_attempt_active ON loop_attempts(loop_id) WHERE state='active';

CREATE TABLE budget_reservations (
  id                       TEXT PRIMARY KEY,
  root_id                  TEXT NOT NULL REFERENCES execution_roots(id),
  loop_id                  TEXT REFERENCES loop_specs(id),
  parent_id                TEXT REFERENCES budget_reservations(id),
  kind                     TEXT NOT NULL CHECK (kind IN ('root','coordinator','loop','model','tool')),
  state                    TEXT NOT NULL CHECK (state IN ('held','consuming','consumed','released','unknown')),
  model_calls              INTEGER NOT NULL CHECK (model_calls >= 0),
  tool_calls               INTEGER NOT NULL CHECK (tool_calls >= 0),
  tokens                   INTEGER NOT NULL CHECK (tokens >= 0),
  cost_microusd            INTEGER NOT NULL CHECK (cost_microusd >= 0),
  consumed_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (consumed_tokens >= 0 AND consumed_tokens <= tokens),
  consumed_cost_microusd   INTEGER NOT NULL DEFAULT 0 CHECK (consumed_cost_microusd >= 0 AND consumed_cost_microusd <= cost_microusd),
  created_at               TEXT NOT NULL,
  finished_at              TEXT,
  CHECK ((state IN ('consumed','released','unknown')) = (finished_at IS NOT NULL))
) STRICT;
CREATE INDEX idx_budget_parent ON budget_reservations(parent_id, state);

CREATE TABLE model_attempts (
  id                  TEXT PRIMARY KEY,
  loop_attempt_id     TEXT NOT NULL REFERENCES loop_attempts(id),
  step_ordinal        INTEGER NOT NULL CHECK (step_ordinal > 0),
  attempt_ordinal     INTEGER NOT NULL CHECK (attempt_ordinal > 0),
  state               TEXT NOT NULL CHECK (state IN ('started','succeeded','failed','unknown')),
  reservation_id      TEXT NOT NULL UNIQUE REFERENCES budget_reservations(id),
  profile_id          TEXT NOT NULL,
  profile_generation  INTEGER NOT NULL CHECK (profile_generation > 0),
  profile_digest      TEXT NOT NULL,
  request_digest      TEXT NOT NULL,
  owner_fence         INTEGER NOT NULL CHECK (owner_fence > 0),
  response_json       TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  actual_tokens       INTEGER CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
  actual_cost_microusd INTEGER CHECK (actual_cost_microusd IS NULL OR actual_cost_microusd >= 0),
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  UNIQUE(loop_attempt_id, step_ordinal, attempt_ordinal),
  CHECK ((state = 'started') = (finished_at IS NULL)),
  CHECK ((state = 'succeeded') = (response_json IS NOT NULL))
) STRICT;
