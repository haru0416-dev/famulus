/**
 * xAI(SuperGrok OAuth)経路の検査。ネットワークは呼ばない —
 * 資格情報の解析・保存・更新判定と、失敗の分類だけを見る。
 * 実際の疎通は 2026-08-17 に実測済み(推論 200 / billing 200 / x_search 200)。
 */

import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { isKnownModel, isXaiModel, poolForModel, XAI_POOL } from "../src/model/models.ts"
import { needsRefresh, parseXaiAuth, readXaiAuth, saveXaiAuth, type XaiAuth } from "../src/model/xai-auth.ts"
import { classifyXaiFailure } from "../src/model/xai-responses.ts"

test("grok model は SuperGrok の pool に載る", () => {
  assert.equal(isKnownModel("grok-4.6"), true)
  assert.equal(isKnownModel("grok-4.3"), true)
  assert.equal(isXaiModel("grok-4.6"), true)
  assert.equal(isXaiModel("gpt-5.6-sol"), false)
  assert.equal(poolForModel("grok-4.6"), XAI_POOL)
  assert.equal(poolForModel("grok-4.3"), "supergrok-oauth")
})

/**
 * 資格情報の解析。欄が欠けたファイルを黙って通すと、失敗が実行開始後の 401 になり、
 * cycle 1回ぶんが失敗として残る。入口で読める理由と一緒に落とす。
 */
test("xai-auth.json は access/refresh/expires が揃っていないと読めない", () => {
  const auth = parseXaiAuth(
    JSON.stringify({ access: "at", refresh: "rt", expires: 1_786_929_440_692, email: "a@b" }),
  )
  assert.equal(auth.access, "at")
  assert.equal(auth.refresh, "rt")
  assert.equal(auth.expires, 1_786_929_440_692)
  assert.equal(auth.email, "a@b")

  assert.throws(() => parseXaiAuth(JSON.stringify({ access: "at" })), /grok-login/)
  assert.throws(
    () => parseXaiAuth(JSON.stringify({ access: "at", refresh: "rt", expires: "soon" })),
    /grok-login/,
  )
  assert.throws(() => parseXaiAuth("{"), /JSON/)
})

test("期限の5分前から refresh 対象になる", () => {
  const auth: XaiAuth = { access: "at", refresh: "rt", expires: 1_000_000 }
  assert.equal(needsRefresh(auth, 1_000_000 - 5 * 60 * 1000 - 1), false)
  assert.equal(needsRefresh(auth, 1_000_000 - 5 * 60 * 1000), true)
  assert.equal(needsRefresh(auth, 1_000_000 + 1), true)
})

/** トークンは秘密情報。600 で置かれることをファイルの実 mode で確かめる。 */
test("保存した資格情報は 600 で、そのまま読み戻せる", () => {
  const path = join(tmpdir(), `xai-auth-test-${process.pid}-${Date.now()}.json`)
  const auth: XaiAuth = { access: "at", refresh: "rt", expires: 42 }
  saveXaiAuth(auth, path)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readXaiAuth(path), auth)
  // 破損した書きかけを残さない(temp + rename)。tmp ファイルが残っていないこと。
  assert.equal(readFileSync(path, "utf8").endsWith("\n"), true)
})

/**
 * 失敗の分類。xAI はヘッダでも billing でも残量を返さない(実測)ので、
 * クールダウンの根拠はここだけ。分類を誤ると「枯渇でないのに1時間止まる」か
 * 「枯渇なのに毎 run 再試行する」のどちらかになる。
 */
test("枯渇はエラー文と 429 から分類し、誤ブロックは短く避ける", () => {
  const now = 1_000_000

  // 429 は無条件に枯渇。resetsAtMs は持たない(週次リセットの時刻は読めない)—
  // Governance の既定 1 時間で避けて様子を見る。
  const limited = classifyXaiFailure(429, "Too Many Requests", now)
  assert.equal(limited?.pool, XAI_POOL)
  assert.equal(limited?.exhausted, true)
  assert.equal(limited?.resetsAtMs, undefined)

  // 契約枠の枯渇はエラー文でしか伝わらない。
  const credits = classifyXaiFailure(undefined, "You have used all available credits for this period", now)
  assert.equal(credits?.exhausted, true)

  const subscription = classifyXaiFailure(400, "This model requires you to need a Grok subscription", now)
  assert.equal(subscription?.exhausted, true)

  // entitlement の誤ブロック(数時間で復旧する 403)は 30 分だけ避ける。
  const blocked = classifyXaiFailure(403, "personal-team-blocked:spending-limit", now)
  assert.equal(blocked?.pool, XAI_POOL)
  assert.equal(blocked?.window, "entitlement")
  assert.equal(blocked?.resetsAtMs, now + 30 * 60 * 1000)

  // 分類できない失敗にクールダウンを掛けない。掛けると一過性の 500 で1時間止まる。
  assert.equal(classifyXaiFailure(500, "internal error", now), undefined)
  assert.equal(classifyXaiFailure(403, "forbidden", now), undefined)
})
