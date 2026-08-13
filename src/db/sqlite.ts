/**
 * SQLite の口を1か所にする。**中身は `bun:sqlite`。**
 *
 * 直前まで `node:sqlite` の `DatabaseSync` を各所で直に import していた。
 * Bun 1.3.14 は `node:sqlite` を解決できない(`Could not resolve: "node:sqlite"`)ので、
 * 走らせる側を Bun に寄せるならここを1枚挟むしかない。使っている面は狭い —
 * `exec` / `prepare().all()` / `prepare().run()` / `close()` だけで、
 * `bun:sqlite` の `Database` がそのまま同じ形を持っている。
 *
 * 違うのは開くときの引数名1つ(`readOnly` → `readonly`)。**そこだけ関数にしてある。**
 * 型の名前を `Sqlite` に寄せてあるのは、呼ぶ側が「どちらの実装か」を書かずに済むようにするため。
 */
import { Database } from "bun:sqlite"

export type Sqlite = Database

/** 開く。`readOnly` は node:sqlite 側の綴りに合わせてある(呼ぶ側を書き換えないため)。 */
export const openDb = (path: string, opts?: { readOnly?: boolean }): Sqlite =>
  new Database(path, opts?.readOnly ? { readonly: true } : undefined)
