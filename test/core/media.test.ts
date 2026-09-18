import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { configureApp } from "../../src/core/config.ts"
import { isSupportedImage, readMedia, saveMedia } from "../../src/core/media.ts"

const withTempData = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const saved = process.env.FAMULUS_DATA
  const dir = mkdtempSync(join(tmpdir(), "media-test-"))
  try {
    process.env.FAMULUS_DATA = dir
    configureApp()
    await fn(dir)
  } finally {
    if (saved === undefined) delete process.env.FAMULUS_DATA
    else process.env.FAMULUS_DATA = saved
    configureApp()
    rmSync(dir, { recursive: true, force: true })
  }
}

test("同じ内容は同じ sha に落ち、読み戻せる", async () => {
  await withTempData(async (dir) => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const a = saveMedia(bytes, "image/png")
    const b = saveMedia(bytes, "image/png")
    assert.equal(a.sha, b.sha)
    assert.ok(existsSync(join(dir, "media", `${a.sha}.png`)))
    assert.deepEqual([...(readMedia(a) ?? [])], [1, 2, 3, 4, 5])
  })
})

test("実体が消えた参照は undefined — 参照切れを黙って空画像にしない", async () => {
  await withTempData(async () => {
    assert.equal(readMedia({ sha: "0".repeat(64), mediaType: "image/png" }), undefined)
  })
})

test("画像として受けるのは既知の型だけ", () => {
  assert.ok(isSupportedImage("image/png"))
  assert.ok(isSupportedImage("image/jpeg"))
  assert.ok(!isSupportedImage("application/pdf"))
  assert.ok(!isSupportedImage(undefined))
})
