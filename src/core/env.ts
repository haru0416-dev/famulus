/**
 * `.env` を読む。**入口(cli / tick / agent)の先頭で1回だけ呼ぶ。**
 *
 * systemd から起きる tick はログインシェルを通らないので、シェルに書いた値は届かない。
 * かといって unit ファイルに書くと、644 の設定ファイルに秘密を置くことになる。
 * 600 の `.env`(git 管理外)を読む側で解決すれば、どの入口から起きても同じ値が見える。
 *
 * 無くても失敗しない。**設定が無いのは異常ではない** — 通知先を決めていない状態は普通にある。
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url))

/** このプロセスが起動した時点の環境。`.env` より外から渡された値のほうを勝たせるために取っておく。 */
const OUTER = new Map(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

let done = false

/**
 * `.env` の値を `process.env` に載せる。2回目以降は何もしない。
 * 既にプロセスに入っていた値は `.env` で上書きしない(systemd の `Environment=` と
 * `FOO=x oz ...` が常に勝つ)。
 */
export function loadEnv(path: string = ENV_PATH): void {
  if (done) return
  done = true
  if (!existsSync(path)) return
  try {
    process.loadEnvFile(path)
  } catch {
    return
  }
  for (const [key, value] of OUTER) process.env[key] = value
}
