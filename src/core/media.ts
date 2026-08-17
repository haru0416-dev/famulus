/**
 * 受け取った画像の置き場。DB には参照(sha256)だけを置き、実体はここに置く —
 * events を太らせない。名前は内容ハッシュなので、同じ画像を何度受けても1つに落ちる。
 * 消す判断は cleanup と DB リセットの側にあり、ここは置くことと読むことだけを持つ。
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appConfig } from "./config.ts"

export interface MediaRef {
  readonly sha: string
  readonly mediaType: string
  readonly name?: string
}

const EXT: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
}

export const isSupportedImage = (mediaType: string | undefined): mediaType is string =>
  mediaType !== undefined && mediaType in EXT

const fileFor = (sha: string, mediaType: string): string => `${sha}${EXT[mediaType] ?? ""}`

export const saveMedia = (bytes: Uint8Array, mediaType: string): MediaRef => {
  const dir = appConfig().paths.media
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const sha = createHash("sha256").update(bytes).digest("hex")
  const path = join(dir, fileFor(sha, mediaType))
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 })
  return { sha, mediaType }
}

/** 無ければ undefined — 参照だけ残って実体が消えている状態を、読む側で区別できるように。 */
export const readMedia = (ref: MediaRef): Uint8Array | undefined => {
  const path = join(appConfig().paths.media, fileFor(ref.sha, ref.mediaType))
  if (!existsSync(path)) return undefined
  return new Uint8Array(readFileSync(path))
}
