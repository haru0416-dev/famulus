/** SQLite connection and the current schema boundary. */

import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import * as sqliteVec from "sqlite-vec"

export type Sqlite = Database
const KERNEL_SQL = readFileSync(new URL("./kernel.sql", import.meta.url), "utf8")
const CURRENT_SCHEMA_SQL = `${readFileSync(new URL("./schema.sql", import.meta.url), "utf8")}\n${KERNEL_SQL}`

interface Migration {
  readonly version: number
  readonly name: string
  readonly checksum: string
  readonly sql: string
}

const migration = (version: number, name: string, url: URL): Migration => {
  const sql = readFileSync(url, "utf8")
  return { version, name, sql, checksum: createHash("sha256").update(sql).digest("hex") }
}

const MIGRATIONS: readonly Migration[] = [
  migration(1, "migration-ledger", new URL("./migrations/0001-migration-ledger.sql", import.meta.url)),
  migration(2, "discord-ack", new URL("./migrations/0002-discord-ack.sql", import.meta.url)),
  migration(3, "recall-vec", new URL("./migrations/0003-recall-vec.sql", import.meta.url)),
  migration(4, "draft-delivery-key", new URL("./migrations/0004-draft-delivery-key.sql", import.meta.url)),
]

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`
const migrationRecordSql = (
  item: Migration,
): string => `INSERT INTO schema_migrations(version,name,checksum,applied_at)
VALUES (${item.version},${sqlString(item.name)},${sqlString(item.checksum)},strftime('%Y-%m-%dT%H:%M:%fZ','now'));`

/** Fresh databases are still created from one current snapshot. */
export const SCHEMA_SQL = [CURRENT_SCHEMA_SQL, ...MIGRATIONS.map(migrationRecordSql)].join("\n")

const LEGACY_V4_SCHEMA_FINGERPRINT = "536dbc2eb1e3b6592b65245fd91361268d1d3decdc5e229dba8b9d64b0e643ad"

export const openDb = (path: string): Sqlite => {
  const db = new Database(path)
  // events_vec(vec0 仮想テーブル)を持つ schema は、拡張が載っていない接続では
  // 形の検査すら通らない。開く場所はここ1つなので、必ずここで載せる。
  sqliteVec.load(db)
  db.exec("PRAGMA recursive_triggers = ON;")
  return db
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

const objectsFrom = (sql: string): Map<string, string> => {
  const db = new Database(":memory:")
  try {
    sqliteVec.load(db)
    db.exec(sql)
    return schemaObjects(db)
  } finally {
    db.close()
  }
}

let expectedObjects: Map<string, string> | undefined
const canonicalObjects = (): Map<string, string> => (expectedObjects ??= objectsFrom(SCHEMA_SQL))

const schemaFingerprint = (objects: Map<string, string>): string =>
  createHash("sha256")
    .update([...objects].map(([key, sql]) => `${key}\n${sql}`).join("\n"))
    .digest("hex")

const assertSchemaObjects = (db: Sqlite, path: string, expected: Map<string, string>): void => {
  const actual = schemaObjects(db)
  const wrong = new Set<string>()
  for (const [key, sql] of expected) if (actual.get(key) !== sql) wrong.add(key)
  for (const key of actual.keys()) if (!expected.has(key)) wrong.add(key)
  if (wrong.size !== 0) {
    throw new Error(`Invalid database shape: path=${path} objects=${[...wrong].sort().join(",")}`)
  }
}

const hasMigrationLedger = (db: Sqlite): boolean =>
  Number(
    (
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .get() as {
        n: number
      }
    ).n,
  ) === 1

const appliedMigrationCount = (db: Sqlite, path: string): number => {
  if (!hasMigrationLedger(db)) return 0
  const rows = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all() as {
    version: number
    name: string
    checksum: string
  }[]
  if (rows.length > MIGRATIONS.length) {
    throw new Error(
      `Unknown schema migration: path=${path} version=${rows[MIGRATIONS.length]?.version ?? "?"}`,
    )
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const expected = MIGRATIONS[index]
    if (
      !row ||
      !expected ||
      row.version !== expected.version ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum
    ) {
      throw new Error(`Invalid schema migration ledger: path=${path} version=${row?.version ?? "missing"}`)
    }
  }
  return rows.length
}

/** Upgrade only a recognized schema state. The caller owns the surrounding transaction. */
export const migrateToCurrentSchema = (db: Sqlite, path: string): void => {
  if (!hasMigrationLedger(db)) {
    assertUnownedMetadata(db, path)
    const fingerprint = schemaFingerprint(schemaObjects(db))
    if (fingerprint !== LEGACY_V4_SCHEMA_FINGERPRINT) {
      throw new Error(`Invalid database baseline: path=${path} fingerprint=${fingerprint}`)
    }
  }
  const applied = appliedMigrationCount(db, path)
  for (const item of MIGRATIONS.slice(applied)) {
    db.exec(item.sql)
    db.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at)VALUES(?,?,?,?)").run(
      item.version,
      item.name,
      item.checksum,
      new Date().toISOString(),
    )
  }
}

export const assertCurrentSchema = (db: Sqlite, path: string): void => {
  assertSchemaObjects(db, path, canonicalObjects())
  const applied = appliedMigrationCount(db, path)
  if (applied !== MIGRATIONS.length) {
    throw new Error(
      `Database migrations are incomplete: path=${path} applied=${applied} expected=${MIGRATIONS.length}`,
    )
  }
  const leases = db.prepare("SELECT count(*) AS n FROM cycle_lease WHERE lease_name='cycle'").get() as {
    n: number
  }
  if (leases.n !== 1) throw new Error(`Invalid cycle lease singleton: path=${path}`)
}

export const assertUnownedMetadata = (db: Sqlite, path: string): void => {
  const metadata = db.prepare("PRAGMA user_version").get() as { user_version: number }
  const application = db.prepare("PRAGMA application_id").get() as { application_id: number }
  if (metadata.user_version !== 0 || application.application_id !== 0) {
    throw new Error(
      `Refusing to initialize database with foreign metadata: path=${path}, ` +
        `user_version=${metadata.user_version}, application_id=${application.application_id}. The database was not modified.`,
    )
  }
}

/** Initialize or migrate one database while holding the schema write lock. */
export const ensureCurrentSchema = (
  db: Sqlite,
  path: string,
  options: { readonly allowInitialize?: boolean } = {},
): void => {
  db.exec("BEGIN IMMEDIATE")
  try {
    const objects = db.prepare("SELECT count(*)AS n FROM sqlite_master").get() as { n: number }
    if (objects.n === 0) {
      if (options.allowInitialize === false) {
        throw new Error(`Refusing to restore a database without schema objects: path=${path}`)
      }
      assertUnownedMetadata(db, path)
      db.exec(SCHEMA_SQL)
    } else {
      migrateToCurrentSchema(db, path)
    }
    assertCurrentSchema(db, path)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

const sleepSignal = new Int32Array(new SharedArrayBuffer(4))

/** SQLite does not honor busy_timeout while changing journal_mode. */
export const enableWalJournalMode = (db: Sqlite, timeoutMs: number = 5_000): void => {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const row = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string }
      if (row.journal_mode !== "wal") throw new Error(`journal_mode did not become WAL: ${row.journal_mode}`)
      return
    } catch (error) {
      if (!/database is (?:locked|busy)/i.test(String(error)) || Date.now() >= deadline) throw error
      Atomics.wait(sleepSignal, 0, 0, 25)
    }
  }
}
