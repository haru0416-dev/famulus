/**
 * ファイルが勝つと `FOO=x fam ...` で差し替えられず、テストも本番の `.env` を読む。
 * 読み込み済みフラグはモジュール単位なので、各テストでモジュールキャッシュを消す。
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

/** `OUTER` は import 時の環境を読むので、先に設定してから呼ぶ。 */
const fresh = async (): Promise<typeof import("../../src/core/env.ts")> => {
  vi.resetModules()
  return import("../../src/core/env.ts")
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
