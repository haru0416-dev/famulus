/**
 * `.env` の読み込みの検査。外から渡した値が勝つかだけを見る。
 *
 * 逆向き(ファイルが勝つ)にすると、`FOO=x fam ...` で一度だけ差し替えることができなくなり、
 * テストも本番の `.env` に引きずられる。順序が壊れても実行時には何も起きないので、
 * ここで固定していないと壊れたことに気づけない。
 *
 * 読み込み済みフラグはモジュール単位なので、各テストで Vitest のモジュールキャッシュを消して
 * 1テスト1インスタンスとして読み込み直している。
 */

import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, vi } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "fam-env-"))

const envFile = (name: string, body: string): string => {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

/** 毎回まっさらな env.ts を得る。`OUTER` は import 時の環境を捕まえるので、先に差してから呼ぶ。 */
const fresh = async (): Promise<typeof import("../src/core/env.ts")> => {
  vi.resetModules()
  return import("../src/core/env.ts")
}

test("外から渡した値は .env に上書きされない", async () => {
  process.env.OZ_TEST_OUTER = "外から"
  const { loadEnv } = await fresh()
  loadEnv(envFile("outer.env", "OZ_TEST_OUTER=ファイルから\nOZ_TEST_NEW=ファイルから\n"))
  assert.equal(process.env.OZ_TEST_OUTER, "外から")
  assert.equal(process.env.OZ_TEST_NEW, "ファイルから")
})

test(".env が無くても失敗しない", async () => {
  const { loadEnv } = await fresh()
  loadEnv(join(dir, "ここには何も置いていない.env"))
})

test("壊れた .env でも失敗しない", async () => {
  const { loadEnv } = await fresh()
  loadEnv(envFile("broken.env", "これは = の無い行\n"))
})

test("2回目以降は読まない", async () => {
  const { loadEnv } = await fresh()
  loadEnv(envFile("first.env", "OZ_TEST_TWICE=1回目\n"))
  loadEnv(envFile("second.env", "OZ_TEST_TWICE=2回目\n"))
  assert.equal(process.env.OZ_TEST_TWICE, "1回目")
})
