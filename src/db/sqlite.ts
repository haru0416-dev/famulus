/** SQLite connection and the current schema boundary. */

import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"

export type Sqlite = Database
export const SCHEMA_VERSION = "4"
export const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8")

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
      WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name`)
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

export const assertSchemaV4 = (db: Sqlite, path: string): void => {
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
}
