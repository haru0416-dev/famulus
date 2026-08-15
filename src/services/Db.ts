/**
 * DB サービス。新規 DB は `src/db/schema.sql` から一度だけ作り、既存 DB は現行shapeだけを受理する。
 *
 * events の append-only は SQL トリガで強制する(DELETE 禁止 / content:=NULL 以外の UPDATE 禁止)。
 * どのドライバから触っても同じように掛かる。
 *
 * Discord outbound は action と receipt を現行 schema に永続化し、曖昧な結果を再送しない。
 *
 * Tag + Layer にしてあるので、テストは `DbLive(":memory:")` を積むだけでトリガ込みの
 * 本物のスキーマを相手にできる。
 */
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { appConfig } from "../core/config.ts"
import { DbFailed } from "../core/errors.ts"
import { assertCurrentSchema, assertUnownedEmptyDb, openDb, SCHEMA_SQL, type Sqlite } from "../db/sqlite.ts"
export interface Row {
  readonly [k: string]: unknown
}

export interface DbRunResult {
  readonly changes: number
  readonly lastInsertRowid: number | bigint
}

export interface DbTx {
  readonly all: (sql: string, ...params: readonly unknown[]) => Row[]
  readonly get: (sql: string, ...params: readonly unknown[]) => Row | undefined
  readonly run: (sql: string, ...params: readonly unknown[]) => DbRunResult
}

export type DbTxAbort<E> = (error: E) => never

type SyncResult<A> = A extends PromiseLike<unknown> ? never : A

export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function"

const firstSqlKeyword = (sql: string): string => {
  let rest = sql
  while (true) {
    rest = rest.trimStart()
    if (rest.startsWith(";")) {
      rest = rest.slice(1)
      continue
    }
    if (rest.startsWith("--")) {
      const newline = rest.indexOf("\n")
      rest = newline < 0 ? "" : rest.slice(newline + 1)
      continue
    }
    if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/", 2)
      if (close < 0) return ""
      rest = rest.slice(close + 2)
      continue
    }
    return /^[a-z]+/i.exec(rest)?.[0]?.toLowerCase() ?? ""
  }
}

const TRANSACTION_SQL = new Set(["begin", "commit", "end", "rollback", "savepoint", "release"])
const TRANSACTION_DML = new Set(["select", "with", "insert", "update", "delete"])

export interface DbApi {
  readonly all: (sql: string, ...params: readonly unknown[]) => Effect.Effect<Row[], DbFailed>
  readonly get: (sql: string, ...params: readonly unknown[]) => Effect.Effect<Row | undefined, DbFailed>
  readonly run: (sql: string, ...params: readonly unknown[]) => Effect.Effect<unknown, DbFailed>
  readonly meta: (key: string) => Effect.Effect<string | undefined, DbFailed>
  readonly setMeta: (key: string, value: string) => Effect.Effect<unknown, DbFailed>
  readonly withImmediateTransaction: <A, E = never>(
    op: string,
    body: (tx: DbTx, abort: DbTxAbort<E>) => SyncResult<A>,
  ) => Effect.Effect<SyncResult<A>, DbFailed | E>
}

export class Db extends Context.Service<Db, DbApi>()("Db") {}

class DbTxAbortSignal<E> {
  readonly error: E

  constructor(error: E) {
    this.error = error
  }
}

export const defaultDbPath = (): string => appConfig().paths.db

/** 接続を開き、スキーマを適用する。`:memory:` を渡せばプロセス内だけの本物の SQLite。 */
export const DbLive = (path: string = defaultDbPath()): Layer.Layer<Db, DbFailed> =>
  Layer.effect(
    Db,
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
            const d = openDb(path)
            // busy_timeout が先。これより前の文はロック待ちをせず、その場で locked になる。
            // poll と cycle が同じ瞬間に開くと journal_mode が WAL の復旧ロックに当たって落ちていた。
            d.exec("PRAGMA busy_timeout = 5000;")
            d.exec("PRAGMA foreign_keys = ON;")
            const objects = d.prepare("SELECT count(*)AS n FROM sqlite_master").get() as { n: number }
            if (objects.n === 0) {
              d.exec("BEGIN IMMEDIATE")
              try {
                const afterLock = d.prepare("SELECT count(*)AS n FROM sqlite_master").get() as { n: number }
                if (afterLock.n === 0) {
                  assertUnownedEmptyDb(d, path)
                  d.exec(SCHEMA_SQL)
                  assertCurrentSchema(d, path)
                } else {
                  assertCurrentSchema(d, path)
                }
                d.exec("COMMIT")
              } catch (e) {
                d.exec("ROLLBACK")
                throw e
              }
            } else {
              d.exec("BEGIN IMMEDIATE")
              try {
                assertCurrentSchema(d, path)
                d.exec("COMMIT")
              } catch (e) {
                d.exec("ROLLBACK")
                throw e
              }
            }
            // shapeを受理してから接続モードを変更する。拒否したDBは変更しない。
            if (path !== ":memory:") d.exec("PRAGMA journal_mode = WAL;")
            return d
          },
          catch: (e) => new DbFailed({ op: `open ${path}`, message: String(e) }),
        }),
        (d) => Effect.sync(() => d.close()),
      )

      let transactionActive = false
      const assertPublicAccess = () => {
        if (transactionActive) throw new Error("public DB API cannot run inside withImmediateTransaction")
      }

      const assertPublicSql = (sql: string) => {
        assertPublicAccess()
        if (TRANSACTION_SQL.has(firstSqlKeyword(sql))) {
          throw new Error("transaction control SQL is not allowed; use withImmediateTransaction")
        }
      }

      const all = (sql: string, ...params: readonly unknown[]) =>
        Effect.try({
          try: () => {
            assertPublicSql(sql)
            return db.prepare(sql).all(...(params as never[])) as Row[]
          },
          catch: (e) => new DbFailed({ op: sql.slice(0, 40), message: String(e) }),
        })

      const get = (sql: string, ...params: readonly unknown[]) =>
        all(sql, ...params).pipe(Effect.map((rows) => rows[0]))

      const run = (sql: string, ...params: readonly unknown[]) =>
        Effect.try({
          try: () => {
            assertPublicSql(sql)
            return db.prepare(sql).run(...(params as never[])) as unknown
          },
          catch: (e) => new DbFailed({ op: sql.slice(0, 40), message: String(e) }),
        })

      /** schema_meta の1行を読む。halt / quota:* / cursor 類の置き場。 */
      const meta = (key: string) =>
        get("SELECT value FROM schema_meta WHERE key = ?", key).pipe(
          Effect.map((r) => (r?.value as string | undefined) ?? undefined),
        )

      const setMeta = (key: string, value: string) =>
        run("INSERT OR REPLACE INTO schema_meta (key, value)VALUES (?, ?)", key, value)

      const withImmediateTransaction = <A, E = never>(
        op: string,
        body: (tx: DbTx, abort: DbTxAbort<E>) => SyncResult<A>,
      ) =>
        Effect.try({
          try: () => {
            assertPublicAccess()
            let aborted: DbTxAbortSignal<E> | undefined
            try {
              return db
                .transaction(() => {
                  transactionActive = true
                  let active = true
                  const prepare = (sql: string): ReturnType<Sqlite["prepare"]> => {
                    if (!active) throw new Error("transaction handle is no longer active")
                    const keyword = firstSqlKeyword(sql)
                    if (TRANSACTION_SQL.has(keyword))
                      throw new Error("transaction control SQL is not allowed")
                    if (!TRANSACTION_DML.has(keyword))
                      throw new Error(`${keyword || "unknown"} SQL is not allowed`)
                    return db.prepare(sql)
                  }
                  const tx: DbTx = {
                    all: (sql, ...params) => prepare(sql).all(...(params as never[])) as Row[],
                    get: (sql, ...params) =>
                      (prepare(sql).get(...(params as never[])) as Row | null | undefined) ?? undefined,
                    run: (sql, ...params) => prepare(sql).run(...(params as never[])) as DbRunResult,
                  }
                  const abort: DbTxAbort<E> = (error) => {
                    if (!active) throw new Error("transaction abort handle is no longer active")
                    aborted = new DbTxAbortSignal(error)
                    throw aborted
                  }
                  try {
                    const result = body(tx, abort)
                    if (aborted) throw aborted
                    if (isThenable(result)) throw new Error("transaction callback must be synchronous")
                    return result
                  } finally {
                    active = false
                    transactionActive = false
                  }
                })
                .immediate()
            } catch (error) {
              if (aborted) throw aborted
              throw error
            }
          },
          catch: (e) => (e instanceof DbTxAbortSignal ? e.error : new DbFailed({ op, message: String(e) })),
        })

      return { all, get, run, meta, setMeta, withImmediateTransaction } satisfies DbApi
    }),
  )
