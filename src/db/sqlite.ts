/** SQLite connection and the current schema boundary. */

import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"

export type Sqlite = Database
export const SCHEMA_VERSION = "9"
const KERNEL_SQL = readFileSync(new URL("./kernel.sql", import.meta.url), "utf8")
export const SCHEMA_SQL = `${readFileSync(new URL("./schema.sql", import.meta.url), "utf8")}\n${KERNEL_SQL}`

interface Migration {
  readonly from: string
  readonly to: string
  readonly name: string
  readonly sql: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    from: "4",
    to: "5",
    name: "schema-migrations",
    sql: `CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;`,
  },
  {
    from: "5",
    to: "6",
    name: "cycle-lease",
    sql: `CREATE TABLE cycle_lease (
      lease_name TEXT PRIMARY KEY CHECK (lease_name = 'cycle'),
      state TEXT NOT NULL CHECK (state IN ('free','held','released')),
      fence INTEGER NOT NULL CHECK (fence BETWEEN 0 AND 9007199254740991),
      owner_id TEXT,
      owner_host_id TEXT,
      owner_boot_id TEXT,
      owner_pid_namespace TEXT,
      owner_pid INTEGER,
      owner_start_ticks TEXT,
      owner_hostname TEXT,
      acquired_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      expires_at_ms INTEGER,
      released_at_ms INTEGER,
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
    END;`,
  },
  {
    from: "6",
    to: "7",
    name: "cycle-lease-invariants",
    sql: `ALTER TABLE cycle_lease RENAME TO cycle_lease_v6;
    CREATE TABLE cycle_lease (
      lease_name TEXT PRIMARY KEY CHECK (lease_name = 'cycle'),
      state TEXT NOT NULL CHECK (state IN ('free','held','released')),
      fence INTEGER NOT NULL CHECK (fence BETWEEN 0 AND 9007199254740991),
      owner_id TEXT,
      owner_host_id TEXT,
      owner_boot_id TEXT,
      owner_pid_namespace TEXT,
      owner_pid INTEGER,
      owner_start_ticks TEXT,
      owner_hostname TEXT,
      acquired_at_ms INTEGER,
      heartbeat_at_ms INTEGER,
      expires_at_ms INTEGER,
      released_at_ms INTEGER,
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
    INSERT INTO cycle_lease SELECT * FROM cycle_lease_v6;
    DROP TABLE cycle_lease_v6;
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
    END;`,
  },
  {
    from: "7",
    to: "8",
    name: "execution-kernel",
    sql: KERNEL_SQL,
  },
  {
    from: "8",
    to: "9",
    name: "model-attempt-request-identity",
    sql: `ALTER TABLE model_attempts RENAME TO model_attempts_v8;
    CREATE TABLE model_attempts (
      id                   TEXT PRIMARY KEY,
      loop_attempt_id      TEXT NOT NULL REFERENCES loop_attempts(id),
      step_ordinal         INTEGER NOT NULL CHECK (step_ordinal > 0),
      attempt_ordinal      INTEGER NOT NULL CHECK (attempt_ordinal > 0),
      state                TEXT NOT NULL CHECK (state IN ('started','succeeded','failed','unknown')),
      reservation_id       TEXT NOT NULL UNIQUE REFERENCES budget_reservations(id),
      profile_id           TEXT NOT NULL,
      profile_generation   INTEGER NOT NULL CHECK (profile_generation > 0),
      profile_digest       TEXT NOT NULL,
      request_digest       TEXT NOT NULL,
      owner_fence          INTEGER NOT NULL CHECK (owner_fence > 0),
      response_json        TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
      actual_tokens        INTEGER CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
      actual_cost_microusd INTEGER CHECK (actual_cost_microusd IS NULL OR actual_cost_microusd >= 0),
      started_at           TEXT NOT NULL,
      finished_at          TEXT,
      UNIQUE(loop_attempt_id, step_ordinal, attempt_ordinal),
      CHECK ((state = 'started') = (finished_at IS NULL)),
      CHECK ((state = 'succeeded') = (response_json IS NOT NULL))
    ) STRICT;
    INSERT INTO model_attempts
      (id,loop_attempt_id,step_ordinal,attempt_ordinal,state,reservation_id,profile_id,profile_generation,
       profile_digest,request_digest,owner_fence,response_json,actual_tokens,actual_cost_microusd,started_at,finished_at)
    SELECT m.id,m.loop_attempt_id,m.step_ordinal,m.attempt_ordinal,m.state,m.reservation_id,m.profile_id,
           m.profile_generation,m.profile_digest,'legacy:' || m.id,m.owner_fence,m.response_json,
           CASE WHEN m.state='started' THEN NULL ELSE b.consumed_tokens END,
           CASE WHEN m.state='started' THEN NULL ELSE b.consumed_cost_microusd END,m.started_at,m.finished_at
      FROM model_attempts_v8 m JOIN budget_reservations b ON b.id=m.reservation_id;
    DROP TABLE model_attempts_v8;`,
  },
]

export const openDb = (path: string): Sqlite => new Database(path)

export const schemaVersion = (db: Sqlite): string | undefined => {
  try {
    return (
      db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
        | { value?: string }
        | undefined
    )?.value
  } catch {
    return undefined
  }
}

const normalizeSql = (sql: string): string => {
  let out = ""
  let quoted = false
  for (let i = 0; i < sql.length; i++) {
    const char = sql.charAt(i)
    if (char === "'") {
      out += char
      if (quoted && sql[i + 1] === "'") out += sql[++i]
      else quoted = !quoted
    } else if (!quoted && /\s/.test(char)) continue
    else out += quoted ? char : char.toLowerCase()
  }
  return out
}

const schemaObjects = (db: Sqlite): Map<string, string> =>
  new Map(
    (
      db
        .prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE sql IS NOT NULL
        AND name NOT IN ('sqlite_stat1','sqlite_stat2','sqlite_stat3','sqlite_stat4')
      ORDER BY type,name`)
        .all() as {
        type: string
        name: string
        tbl_name: string
        sql: string
      }[]
    ).map((row) => [`${row.type}:${row.name}:${row.tbl_name}`, normalizeSql(row.sql)]),
  )

let expectedObjects: Map<string, string> | undefined
const canonicalObjects = (): Map<string, string> => {
  if (expectedObjects) return expectedObjects
  const db = new Database(":memory:")
  try {
    db.exec(SCHEMA_SQL)
    expectedObjects = schemaObjects(db)
    return expectedObjects
  } finally {
    db.close()
  }
}

export const assertCurrentSchema = (db: Sqlite, path: string): void => {
  const version = schemaVersion(db)
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported database schema: path=${path}, found=${version ?? "missing"}, expected=${SCHEMA_VERSION}. ` +
        "Rebuild the database from the current schema; the database was not modified.",
    )
  }
  const expected = canonicalObjects()
  const actual = schemaObjects(db)
  const wrong = new Set<string>()
  for (const [key, sql] of expected) if (actual.get(key) !== sql) wrong.add(key)
  for (const key of actual.keys()) if (!expected.has(key)) wrong.add(key)
  if (wrong.size !== 0) {
    throw new Error(
      `Invalid version ${SCHEMA_VERSION} database shape: path=${path} objects=${[...wrong].sort().join(",")}`,
    )
  }
  const leases = db.prepare("SELECT count(*) AS n FROM cycle_lease WHERE lease_name='cycle'").get() as {
    n: number
  }
  if (leases.n !== 1) throw new Error(`Invalid version ${SCHEMA_VERSION} cycle lease singleton: path=${path}`)
}

export const migrateToCurrent = (db: Sqlite, path: string): void => {
  let version = schemaVersion(db)
  while (version !== SCHEMA_VERSION) {
    const migration = MIGRATIONS.find((candidate) => candidate.from === version)
    if (!migration) {
      throw new Error(
        `Unsupported database schema: path=${path}, found=${version ?? "missing"}, expected=${SCHEMA_VERSION}. ` +
          "The database was not modified.",
      )
    }
    db.exec(migration.sql)
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      Number(migration.to),
      migration.name,
      new Date().toISOString(),
    )
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(migration.to)
    version = migration.to
  }
}

export const assertUnownedEmptyDb = (db: Sqlite, path: string): void => {
  const metadata = db.prepare("PRAGMA user_version").get() as { user_version: number }
  const application = db.prepare("PRAGMA application_id").get() as { application_id: number }
  if (metadata.user_version !== 0 || application.application_id !== 0) {
    throw new Error(
      `Refusing to initialize database with foreign metadata: path=${path}, ` +
        `user_version=${metadata.user_version}, application_id=${application.application_id}. The database was not modified.`,
    )
  }
}
