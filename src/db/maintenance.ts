import { randomUUID } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { assertCurrentSchema, openDb, schemaVersion } from "./sqlite.ts"

const BACKUP_FILE = /^open-zero-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]+\.db$/

export interface DatabaseCheck {
  readonly path: string
  readonly schemaVersion: string
  readonly bytes: number
}

export interface BackupResult extends DatabaseCheck {
  readonly createdAt: string
  readonly removed: readonly string[]
}

const assertFileDatabase = (path: string): void => {
  if (path === ":memory:") throw new Error("memory database cannot be backed up or restored")
  if (!existsSync(path)) throw new Error(`database does not exist: ${path}`)
}

/** Verify data integrity, foreign keys, and the exact current schema shape. */
export const checkDatabase = (path: string): DatabaseCheck => {
  assertFileDatabase(path)
  const db = openDb(path)
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;")
    const integrity = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(`integrity_check failed: ${integrity.map((row) => row.integrity_check).join(", ")}`)
    }
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all()
    if (foreignKeys.length !== 0)
      throw new Error(`foreign_key_check failed: ${foreignKeys.length} violation(s)`)
    assertCurrentSchema(db, path)
    return { path, schemaVersion: schemaVersion(db) as string, bytes: statSync(path).size }
  } finally {
    db.close()
  }
}

/** Copy a backup to a throwaway location and open that restored copy for verification. */
export const verifyRestore = (backupPath: string): DatabaseCheck => {
  assertFileDatabase(backupPath)
  const root = mkdtempSync(join(tmpdir(), "open-zero-restore-"))
  const restored = join(root, "restored.db")
  try {
    copyFileSync(backupPath, restored)
    return checkDatabase(restored)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

export const listBackups = (backupDir: string): string[] => {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir)
    .filter((name) => BACKUP_FILE.test(name))
    .map((name) => join(backupDir, name))
    .map((path) => {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`backup is not a regular file: ${path}`)
      return { path, mtimeMs: stat.mtimeMs }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
    .map(({ path }) => path)
}

export const latestBackup = (backupDir: string): string | undefined => listBackups(backupDir).at(-1)

const withBackupLock = <A>(backupDir: string, body: () => A): A => {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const directory = lstatSync(backupDir)
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error(`backup path is not a regular directory: ${backupDir}`)
  chmodSync(backupDir, 0o700)
  const lockPath = join(backupDir, ".backup-lock.db")
  const lockFile = lstatSync(lockPath, { throwIfNoEntry: false })
  if (lockFile) {
    if (!lockFile.isFile() || lockFile.isSymbolicLink())
      throw new Error(`backup lock is not a regular file: ${lockPath}`)
  }
  const lock = openDb(lockPath)
  chmodSync(lockPath, 0o600)
  try {
    lock.exec(`PRAGMA busy_timeout = 120000;
      CREATE TABLE IF NOT EXISTS backup_lock(id INTEGER PRIMARY KEY CHECK(id=1));
      BEGIN IMMEDIATE;`)
    try {
      const result = body()
      lock.exec("COMMIT")
      return result
    } catch (error) {
      lock.exec("ROLLBACK")
      throw error
    }
  } finally {
    lock.close()
  }
}

const recordVerification = (
  sourcePath: string,
  backupPath: string,
  at: string,
  options: { readonly backup: boolean },
): void => {
  const db = openDb(sourcePath)
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;")
    try {
      const set = db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES (?,?)")
      if (options.backup) {
        set.run("backup:last_at", at)
        set.run("backup:last_path", backupPath)
      }
      set.run("restore:last_verified_at", at)
      set.run("restore:last_verified_path", backupPath)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  } finally {
    db.close()
  }
}

export const verifyAndRecordRestore = (
  sourcePath: string,
  backupPath: string,
  now: Date = new Date(),
): DatabaseCheck => {
  const check = verifyRestore(backupPath)
  recordVerification(sourcePath, backupPath, now.toISOString(), { backup: false })
  return check
}

/** Create a transaction-consistent SQLite snapshot, rehearse restore, then prune old successful backups. */
export const createBackup = (
  sourcePath: string,
  backupDir: string,
  options: { readonly keep: number; readonly now?: Date } = { keep: 7 },
): BackupResult => {
  assertFileDatabase(sourcePath)
  if (!Number.isSafeInteger(options.keep) || options.keep < 1)
    throw new Error("backup retention must be positive")
  checkDatabase(sourcePath)
  return withBackupLock(backupDir, () => {
    const createdAt = (options.now ?? new Date()).toISOString()
    const stamp = createdAt.replaceAll(":", "-").replace(".", "-")
    const id = randomUUID()
    const backupPath = join(backupDir, `open-zero-${stamp}-${id}.db`)
    const pendingPath = join(backupDir, `.open-zero-${stamp}-${id}.tmp`)
    const source = openDb(sourcePath)
    try {
      source.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
      source.prepare("VACUUM INTO ?").run(pendingPath)
    } catch (error) {
      rmSync(pendingPath, { force: true })
      throw error
    } finally {
      source.close()
    }
    chmodSync(pendingPath, 0o600)

    let restored: DatabaseCheck
    try {
      restored = verifyRestore(pendingPath)
      renameSync(pendingPath, backupPath)
      recordVerification(sourcePath, backupPath, createdAt, { backup: true })
    } catch (error) {
      rmSync(pendingPath, { force: true })
      rmSync(backupPath, { force: true })
      throw error
    }

    const backups = listBackups(backupDir)
    const removeCount = Math.max(0, backups.length - options.keep)
    const removed = backups.filter((path) => path !== backupPath).slice(0, removeCount)
    for (const path of removed) rmSync(path, { force: true })
    return {
      path: backupPath,
      createdAt,
      schemaVersion: restored.schemaVersion,
      bytes: restored.bytes,
      removed: removed.map((path) => basename(path)),
    }
  })
}
