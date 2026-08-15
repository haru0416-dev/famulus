/**
 * DB サービス。新規 DB は `src/db/schema.sql` から作り、既存 DB は順番にmigrationする。
 *
 * events の append-only は SQL トリガで強制する(DELETE 禁止 / content:=NULL 以外の UPDATE 禁止)。
 * どのドライバから触っても同じように掛かる。
 *
 * 外に出る行為の冪等性は担保していない。用のテーブルは作ったが読み書きする側が書かれず、
 * 落とした。
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
import {
  assertCurrentSchema,
  assertUnownedEmptyDb,
  migrateToCurrent,
  openDb,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from "../db/sqlite.ts"
export interface Row {
  readonly [k: string]: unknown
}

export interface DbApi {
  readonly all: (sql: string, ...params: readonly unknown[]) => Effect.Effect<Row[], DbFailed>
  readonly get: (sql: string, ...params: readonly unknown[]) => Effect.Effect<Row | undefined, DbFailed>
  readonly run: (sql: string, ...params: readonly unknown[]) => Effect.Effect<unknown, DbFailed>
  readonly meta: (key: string) => Effect.Effect<string | undefined, DbFailed>
  readonly setMeta: (key: string, value: string) => Effect.Effect<unknown, DbFailed>
}

export class Db extends Context.Service<Db, DbApi>()("Db") {}

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
                  d.prepare("INSERT INTO schema_meta (key, value)VALUES ('version', ?)").run(SCHEMA_VERSION)
                  d.prepare("INSERT INTO schema_migrations (version, name, applied_at)VALUES (?, ?, ?)").run(
                    Number(SCHEMA_VERSION),
                    "baseline",
                    new Date().toISOString(),
                  )
                  assertCurrentSchema(d, path)
                } else {
                  migrateToCurrent(d, path)
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
                migrateToCurrent(d, path)
                assertCurrentSchema(d, path)
                d.exec("COMMIT")
              } catch (e) {
                d.exec("ROLLBACK")
                throw e
              }
            }
            // 現行 schema を受理した DB だけ、旧実行状態を一度だけ新しい名前へ移す。
            d.exec("BEGIN IMMEDIATE")
            try {
              d.exec(`INSERT INTO schema_meta (key, value)
                SELECT 'cycle:' || substr(key, 6), value FROM schema_meta
                 WHERE key LIKE 'tick:%'
                   AND NOT EXISTS (
                     SELECT 1 FROM schema_meta current
                      WHERE current.key = 'cycle:' || substr(schema_meta.key, 6)
                   );
                DELETE FROM schema_meta WHERE key LIKE 'tick:%';`)
              d.exec("COMMIT")
            } catch (e) {
              d.exec("ROLLBACK")
              throw e
            }
            // 版を受理してから永続設定を変える。拒否したDBは接続モードも変更しない。
            if (path !== ":memory:") d.exec("PRAGMA journal_mode = WAL;")
            return d
          },
          catch: (e) => new DbFailed({ op: `open ${path}`, message: String(e) }),
        }),
        (d) => Effect.sync(() => d.close()),
      )

      const all = (sql: string, ...params: readonly unknown[]) =>
        Effect.try({
          try: () => db.prepare(sql).all(...(params as never[])) as Row[],
          catch: (e) => new DbFailed({ op: sql.slice(0, 40), message: String(e) }),
        })

      const get = (sql: string, ...params: readonly unknown[]) =>
        all(sql, ...params).pipe(Effect.map((rows) => rows[0]))

      const run = (sql: string, ...params: readonly unknown[]) =>
        Effect.try({
          try: () => db.prepare(sql).run(...(params as never[])) as unknown,
          catch: (e) => new DbFailed({ op: sql.slice(0, 40), message: String(e) }),
        })

      /** schema_meta の1行を読む。halt / quota:* / cursor 類の置き場。 */
      const meta = (key: string) =>
        get("SELECT value FROM schema_meta WHERE key = ?", key).pipe(
          Effect.map((r) => (r?.value as string | undefined) ?? undefined),
        )

      const setMeta = (key: string, value: string) =>
        run("INSERT OR REPLACE INTO schema_meta (key, value)VALUES (?, ?)", key, value)

      return { all, get, run, meta, setMeta } satisfies DbApi
    }),
  )
