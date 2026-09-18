/** events を大きくしないよう、DB には sha256 の参照だけを置き画像本体はファイルに置く。 */
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

/** 参照だけ残って実体が消えている状態を呼び出し側で区別できるよう undefined を返す。 */
export const readMedia = (ref: MediaRef): Uint8Array | undefined => {
  const path = join(appConfig().paths.media, fileFor(ref.sha, ref.mediaType))
  if (!existsSync(path)) return undefined
  return new Uint8Array(readFileSync(path))
}
