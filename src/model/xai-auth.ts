/**
 * SuperGrok OAuth の資格情報。device-code flow(RFC 8628)で取得し、600 権限の JSON(`FAMULUS_XAI_AUTH`)に置く。
 * client_id は device flow の公開クライアントで secret は無い。console.x.ai の API キー(従量課金)とは別物。
 * refresh token は rotation するので、拒否されたらファイルを読み直し、別プロセスが先に更新していた場合だけ1回やり直す。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { appConfig } from "../core/config.ts"
import { ModelCallError } from "./models.ts"

const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access"
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token"
const DEVICE_ENDPOINT = "https://auth.x.ai/oauth2/device/code"

/** access は数時間有効なので5分の余裕で足りる。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000

export interface XaiAuth {
  readonly access: string
  readonly refresh: string
  /** epoch ms。 */
  readonly expires: number
  readonly email?: string
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined)

export function parseXaiAuth(contents: string): XaiAuth {
  let root: Record<string, unknown>
  try {
    root = JSON.parse(contents) as Record<string, unknown>
  } catch {
    throw new ModelCallError("xai-auth.json を JSON として読めない")
  }
  const access = str(root.access)
  const refresh = str(root.refresh)
  const expires = typeof root.expires === "number" && Number.isFinite(root.expires) ? root.expires : undefined
  if (!access || !refresh || expires === undefined) {
    throw new ModelCallError("xai-auth.json に access/refresh/expires が無い(`fam grok-login` を通す)")
  }
  const email = str(root.email)
  return { access, refresh, expires, ...(email ? { email } : {}) }
}

export const needsRefresh = (auth: XaiAuth, nowMs: number): boolean => auth.expires - REFRESH_SKEW_MS <= nowMs

const authPath = (): string => appConfig().paths.xaiAuth

/** 一時ファイル + rename。書き込み途中のプロセス停止で資格情報を半分だけ残さない。 */
export function saveXaiAuth(auth: XaiAuth, path: string = authPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function readXaiAuth(path: string = authPath()): XaiAuth {
  if (!existsSync(path)) {
    throw new ModelCallError(`${path} が無い(\`fam grok-login\` を通す)`)
  }
  return parseXaiAuth(readFileSync(path, "utf8"))
}

interface TokenResponse {
  readonly access_token?: string
  readonly refresh_token?: string
  readonly expires_in?: number
  readonly error?: string
  readonly error_description?: string
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
})

async function requestToken(fields: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, form(fields))
  const body = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok && !body.error) {
    throw new ModelCallError(`auth.x.ai/token が ${res.status} を返した`)
  }
  return body
}

const toAuth = (body: TokenResponse, nowMs: number, email?: string): XaiAuth => {
  if (!body.access_token || !body.refresh_token || typeof body.expires_in !== "number") {
    throw new ModelCallError(
      `トークン応答に access/refresh/expires_in が揃っていない: ${body.error ?? "欄が欠けている"}`,
    )
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: nowMs + body.expires_in * 1000,
    ...(email ? { email } : {}),
  }
}

async function refreshOnce(refresh: string, nowMs: number, email?: string): Promise<XaiAuth> {
  const body = await requestToken({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: XAI_OAUTH_CLIENT_ID,
  })
  if (body.error) {
    throw new ModelCallError(`refresh が拒否された: ${body.error} ${body.error_description ?? ""}`.trim())
  }
  return toAuth(body, nowMs, email)
}

/** 同じ refresh のまま拒否されたら本当に失効しているので、再ログインを求める。 */
export async function loadXaiAccess(nowMs: number = Date.now(), path: string = authPath()): Promise<string> {
  const auth = readXaiAuth(path)
  if (!needsRefresh(auth, nowMs)) return auth.access
  try {
    const next = await refreshOnce(auth.refresh, nowMs, auth.email)
    saveXaiAuth(next, path)
    return next.access
  } catch (e) {
    const current = readXaiAuth(path)
    if (current.refresh !== auth.refresh) {
      if (!needsRefresh(current, nowMs)) return current.access
      const next = await refreshOnce(current.refresh, nowMs, current.email)
      saveXaiAuth(next, path)
      return next.access
    }
    throw e
  }
}

interface DeviceCodeResponse {
  readonly device_code?: string
  readonly user_code?: string
  readonly verification_uri?: string
  readonly verification_uri_complete?: string
  readonly interval?: number
  readonly expires_in?: number
}

/** VPS にブラウザは要らない。`onPrompt` に渡る URL とコードを手元のブラウザで開いて承認する。 */
export async function xaiDeviceLogin(
  onPrompt: (verificationUri: string, userCode: string) => void,
  path: string = authPath(),
): Promise<XaiAuth> {
  const res = await fetch(DEVICE_ENDPOINT, form({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }))
  if (!res.ok) throw new ModelCallError(`auth.x.ai/device/code が ${res.status} を返した`)
  const device = (await res.json()) as DeviceCodeResponse
  if (!device.device_code || !device.user_code) {
    throw new ModelCallError("device code 応答に device_code/user_code が無い")
  }
  onPrompt(
    device.verification_uri_complete ?? device.verification_uri ?? "https://auth.x.ai",
    device.user_code,
  )

  let intervalMs = Math.max(device.interval ?? 5, 1) * 1000
  const deadline = Date.now() + (device.expires_in ?? 600) * 1000
  for (;;) {
    if (Date.now() > deadline) throw new ModelCallError("承認待ちが期限切れになった(もう一度やり直す)")
    await new Promise((r) => setTimeout(r, intervalMs))
    const body = await requestToken({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: XAI_OAUTH_CLIENT_ID,
    })
    if (body.error === "authorization_pending") continue
    if (body.error === "slow_down") {
      intervalMs += 5000
      continue
    }
    if (body.error) {
      throw new ModelCallError(`ログインが拒否された: ${body.error} ${body.error_description ?? ""}`.trim())
    }
    const auth = toAuth(body, Date.now())
    saveXaiAuth(auth, path)
    return auth
  }
}
