/**
 * DB サービス。新規 DB の目標形は `src/db/schema.sql`、既存 DB との差分は
 * `src/db/migrate.ts` が schema.sql 適用前に吸収する。
 *
 * events の append-only は SQL トリガで強制する(DELETE 禁止 / content:=NULL 以外の UPDATE 禁止)。
 * どのドライバから触っても同じように掛かる。
 *
 * 外に出る行為の冪等性は担保していない。用のテーブルは作ったが読み書きする側が書かれず、
 * 落とした(docs/adr/0007)。
 *
 * Tag + Layer にしてあるので、テストは `DbLive(":memory:")` を積むだけでトリガ込みの
 * 本物のスキーマを相手にできる。
 */
import { mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { DbFailed } from "../core/errors.ts"
import { migrate } from "../db/migrate.ts"
import { openDb, type Sqlite } from "../db/sqlite.ts"

const SCHEMA_PATH = fileURLToPath(new URL("../db/schema.sql", import.meta.url))
const SCHEMA_VERSION = "2"

export interface Row {
  readonly [k: string]: unknown
}

export interface DbApi {
  readonly raw: Sqlite
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
            const d = openDb(path)
            // busy_timeout が先。これより前の文はロック待ちをせず、その場で locked になる。
            // poll と tick が同じ瞬間に開くと journal_mode が WAL の復旧ロックに当たって落ちていた。
            d.exec("PRAGMA busy_timeout = 5000;")
            // WAL は並行読み取りのため。foreign_keys は approvals→proposals の FK を効かせるため。
            if (path !== ":memory:") d.exec("PRAGMA journal_mode = WAL;")
            d.exec("PRAGMA foreign_keys = ON;")
            // schema.sql より先。旧い形を寄せてから `IF NOT EXISTS` を通す(src/db/migrate.ts)。
            migrate(d)
            d.exec(readFileSync(SCHEMA_PATH, "utf8"))
            // 同じ値なら書かない。開くたびに書き込みロックを取ると、同時に開いた側を待たせる。
            const cur = d.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
              | { value?: string }
              | undefined
            if (cur?.value !== SCHEMA_VERSION)
              d.prepare("INSERT OR REPLACE INTO schema_meta (key, value)VALUES ('version', ?)").run(
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

      /** schema_meta の1行を読む。halt / quota:* / cursor 類の置き場。 */
      const meta = (key: string) =>
        get("SELECT value FROM schema_meta WHERE key = ?", key).pipe(
          Effect.map((r) => (r?.value as string | undefined) ?? undefined),
        )

      const setMeta = (key: string, value: string) =>
        run("INSERT OR REPLACE INTO schema_meta (key, value)VALUES (?, ?)", key, value)

      return { raw: db, all, get, run, meta, setMeta } satisfies DbApi
    }),
  )
