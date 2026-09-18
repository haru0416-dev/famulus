/**
 * Google OAuth(installed app + PKCE)の資格情報。600 権限の JSON
 * (`FAMULUS_GOOGLE_AUTH`、既定 `~/.famulus/data/google-auth.json`)に置く。
 *
 * client は共有せず、ユーザー自前の GCP プロジェクトの Desktop OAuth client を使う
 * (市場実勢: OpenClaw / Hermes とも Google は自前 client)。
 * redirect は `http://localhost:1/` — どのプロセスも listen しない port なのでブラウザは即失敗し、
 * アドレスバーに code 付き URL が残る。それを丸ごと貼って交換する(headless の VPS で完結する形)。
 *
 * refresh token は xAI と違って rotation しない。並行 refresh の競合対策は要らない。
 */
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { appConfig } from "./config.ts"

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const REDIRECT_URI = "http://localhost:1/"
/**
 * 予定の読み書きと、メールの読み取りのみ。送信・変更のスコープは持たない —
 * 外へ出る操作は famulus の承認機構の外に置かない。スコープを変えたら再ログインが要る
 * (既存トークンは旧スコープのまま。API は 403 insufficient scopes を返す)。
 */
const SCOPE = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ")

/** access の期限のこの手前で更新する。access は1時間有効なので5分の余裕で足りる。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000

export interface GoogleAuth {
  readonly access: string
  readonly refresh: string
  /** access の期限(epoch ms)。 */
  readonly expires: number
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined)

export function parseGoogleAuth(contents: string): GoogleAuth {
  let root: Record<string, unknown>
  try {
    root = JSON.parse(contents) as Record<string, unknown>
  } catch {
    throw new Error("google-auth.json を JSON として読めない")
  }
  const access = str(root.access)
  const refresh = str(root.refresh)
  const expires = typeof root.expires === "number" && Number.isFinite(root.expires) ? root.expires : undefined
  if (!access || !refresh || expires === undefined) {
    throw new Error("google-auth.json に access/refresh/expires が無い(`fam google-login` を通す)")
  }
  return { access, refresh, expires }
}

const authPath = (): string => appConfig().paths.googleAuth
const pendingPath = (path: string): string => `${path}.pending`

const client = (): { id: string; secret: string } => {
  const g = appConfig().google
  if (!g.clientId || !g.clientSecret) {
    throw new Error(
      "Google 連携が未設定(.env に FAMULUS_GOOGLE_CLIENT_ID / FAMULUS_GOOGLE_CLIENT_SECRET を置く)",
    )
  }
  return { id: g.clientId, secret: g.clientSecret }
}

export const googleConfigured = (): boolean =>
  Boolean(appConfig().google.clientId && appConfig().google.clientSecret)

export const googleLoggedIn = (path: string = authPath()): boolean => existsSync(path)

/** 一時ファイル + rename。書き込み途中のプロセス停止で資格情報を半分だけ残さない。 */
function save600(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function readGoogleAuth(path: string = authPath()): GoogleAuth {
  if (!existsSync(path)) {
    throw new Error(`${path} が無い(\`fam google-login\` を通す)`)
  }
  return parseGoogleAuth(readFileSync(path, "utf8"))
}

const b64url = (buf: Buffer): string => buf.toString("base64url")

/**
 * ログインの前半。PKCE の verifier と state を pending に置き、承認 URL を返す。
 * 後半(`googleLoginFinish`)は別プロセスでよい — CLI は1回ごとに終わるため。
 */
export function googleLoginStart(path: string = authPath()): string {
  const { id } = client()
  const verifier = b64url(randomBytes(32))
  const state = b64url(randomBytes(16))
  save600(pendingPath(path), { verifier, state })
  const query = new URLSearchParams({
    client_id: id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // consent を毎回出す — 出さないと2回目以降の承認で refresh_token が返らない。
    prompt: "consent",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
  })
  return `${AUTH_ENDPOINT}?${query.toString()}`
}

interface TokenResponse {
  readonly access_token?: string
  readonly refresh_token?: string
  readonly expires_in?: number
  readonly error?: string
  readonly error_description?: string
}

async function requestToken(fields: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  })
  const body = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok && !body.error) throw new Error(`oauth2.googleapis.com/token が ${res.status} を返した`)
  if (body.error) {
    throw new Error(`トークン交換が拒否された: ${body.error} ${body.error_description ?? ""}`.trim())
  }
  return body
}

/** 貼られたもの(失敗ページの URL 全体・クエリ・素の code のどれでも)から code と state を取る。 */
export function parsePasted(pasted: string): { code: string; state?: string } {
  const text = pasted.trim()
  if (!text.includes("code=")) return { code: text }
  const query = text.includes("?") ? (text.split("?")[1] ?? "") : text
  const params = new URLSearchParams(query)
  const code = params.get("code")
  if (!code) throw new Error("貼られた URL に code= が無い")
  const state = params.get("state")
  return { code, ...(state ? { state } : {}) }
}

/**
 * ログインの後半。ブラウザの失敗ページから貼られた URL(または code)を交換して保存する。
 */
export async function googleLoginFinish(
  pasted: string,
  nowMs: number = Date.now(),
  path: string = authPath(),
): Promise<GoogleAuth> {
  const { id, secret } = client()
  const pending = pendingPath(path)
  if (!existsSync(pending)) {
    throw new Error("ログインが始まっていない(先に引数なしの `fam google-login` を打つ)")
  }
  const saved = JSON.parse(readFileSync(pending, "utf8")) as { verifier?: string; state?: string }
  if (!saved.verifier) throw new Error("pending に verifier が無い(引数なしでやり直す)")
  const { code, state } = parsePasted(pasted)
  if (state !== undefined && state !== saved.state) {
    throw new Error("state が一致しない(別のログイン開始の URL を貼っている。引数なしでやり直す)")
  }
  const body = await requestToken({
    grant_type: "authorization_code",
    code,
    client_id: id,
    client_secret: secret,
    redirect_uri: REDIRECT_URI,
    code_verifier: saved.verifier,
  })
  if (!body.access_token || !body.refresh_token || typeof body.expires_in !== "number") {
    throw new Error("トークン応答に access/refresh/expires_in が揃っていない")
  }
  const auth: GoogleAuth = {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: nowMs + body.expires_in * 1000,
  }
  save600(path, auth)
  rmSync(pending, { force: true })
  return auth
}

/** 有効な access token を返す。期限が近ければ refresh して保存する。 */
export async function loadGoogleAccess(
  nowMs: number = Date.now(),
  path: string = authPath(),
): Promise<string> {
  const auth = readGoogleAuth(path)
  if (auth.expires - REFRESH_SKEW_MS > nowMs) return auth.access
  const { id, secret } = client()
  const body = await requestToken({
    grant_type: "refresh_token",
    refresh_token: auth.refresh,
    client_id: id,
    client_secret: secret,
  })
  if (!body.access_token || typeof body.expires_in !== "number") {
    throw new Error("refresh 応答に access/expires_in が無い")
  }
  const next: GoogleAuth = {
    access: body.access_token,
    // Google は refresh を返し直さないことが多い。返らなければ今のを使い続ける。
    refresh: body.refresh_token ?? auth.refresh,
    expires: nowMs + body.expires_in * 1000,
  }
  save600(path, next)
  return next.access
}
