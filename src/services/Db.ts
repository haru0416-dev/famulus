/**
 * DB サービス。famulus-zero の `src/db/schema.sql` を**そのまま正本として**使う。
 *
 * schema.sql を書き換えないのが移行の成否条件。events の append-only はアプリ側のお行儀ではなく
 * SQL トリガで強制されていて(DELETE 禁止 / content:=NULL 以外の UPDATE 禁止)、
 * 冪等性は `execution_attempts.idempotency_key` と `outbox.destination_key` の UNIQUE で担保されている。
 * この不変条件は bun:sqlite でも node:sqlite でも同じように効く(検証済み: 22 テーブル)。
 *
 * Tag + Layer にしてあるのは**接続先を積み替えられるようにするため**。
 * テストは `DbLive(":memory:")` を積むだけで、実 DB にもモックにも触らずに
 * トリガ込みの本物のスキーマを相手にできる(SQL の不変条件を検査から外さない)。
 */
import { mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer } from "effect"
import { DbFailed } from "../core/errors.ts"
import { migrate } from "../db/migrate.ts"

const SCHEMA_PATH = fileURLToPath(new URL("../db/schema.sql", import.meta.url))
const SCHEMA_VERSION = "2"

export interface Row {
  readonly [k: string]: unknown
}

export interface DbApi {
  readonly raw: DatabaseSync
  readonly all: (sql: string, ...params: readonly unknown[]) => Effect.Effect<Row[], DbFailed>
  readonly get: (sql: string, ...params: readonly unknown[]) => Effect.Effect<Row | undefined, DbFailed>
  readonly run: (sql: string, ...params: readonly unknown[]) => Effect.Effect<unknown, DbFailed>
  readonly meta: (key: string) => Effect.Effect<string | undefined, DbFailed>
  readonly setMeta: (key: string, value: string) => Effect.Effect<unknown, DbFailed>
}

export class Db extends Context.Tag("Db")<Db, DbApi>() {}

export const DEFAULT_DB_PATH = process.env.OPEN_ZERO_DB ?? ".data/open-zero.db"

/** 接続を開き、スキーマを適用する。`:memory:` を渡せばプロセス内だけの本物の SQLite。 */
export const DbLive = (path: string = DEFAULT_DB_PATH): Layer.Layer<Db, DbFailed> =>
  Layer.scoped(
    Db,
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
            const d = new DatabaseSync(path)
            // WAL: 再起動・並行読み取りに強い。foreign_keys: FK 強制(approvals→proposals の不変条件)。
            if (path !== ":memory:") d.exec("PRAGMA journal_mode = WAL;")
            d.exec("PRAGMA foreign_keys = ON;")
            d.exec("PRAGMA busy_timeout = 5000;")
            // **schema.sql より先**。旧い形を寄せてから `IF NOT EXISTS` を通す(src/db/migrate.ts)。
            migrate(d)
            d.exec(readFileSync(SCHEMA_PATH, "utf8"))
            d.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(
              SCHEMA_VERSION,
            )
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

      /** schema_meta の 1 行を読む。halt / quota:* の格納先。 */
      const meta = (key: string) =>
        get("SELECT value FROM schema_meta WHERE key = ?", key).pipe(
          Effect.map((r) => (r?.value as string | undefined) ?? undefined),
        )

      const setMeta = (key: string, value: string) =>
        run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)", key, value)

      return { raw: db, all, get, run, meta, setMeta } satisfies DbApi
    }),
  )
