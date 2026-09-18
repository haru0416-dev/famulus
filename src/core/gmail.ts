/** scope は gmail.readonly のみ。本文は未検証の外部データなので DB に書かず、道具の返り値だけで返す。 */
import { loadGoogleAccess } from "./google-auth.ts"
import { localStamp } from "./time.ts"

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

const BODY_MAX = 4_000

export interface MailHead {
  readonly id: string
  readonly from: string
  readonly subject: string
  readonly at?: string
  readonly snippet: string
}

async function call(path: string): Promise<unknown> {
  const access = await loadGoogleAccess()
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${access}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Gmail API が ${res.status} を返した: ${body.slice(0, 200)}`)
  }
  return res.json()
}

interface ApiMessage {
  readonly id?: string
  readonly snippet?: string
  readonly internalDate?: string
  readonly payload?: ApiPart
}

interface ApiPart {
  readonly mimeType?: string
  readonly headers?: { readonly name?: string; readonly value?: string }[]
  readonly body?: { readonly data?: string }
  readonly parts?: ApiPart[]
}

const header = (m: ApiMessage, name: string): string =>
  m.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""

const toHead = (m: ApiMessage): MailHead | undefined =>
  m.id
    ? {
        id: m.id,
        from: header(m, "From"),
        subject: header(m, "Subject") || "(件名なし)",
        ...(m.internalDate ? { at: new Date(Number(m.internalDate)).toISOString() } : {}),
        snippet: m.snippet ?? "",
      }
    : undefined

export async function searchMail(query: string, max: number): Promise<MailHead[]> {
  const q = new URLSearchParams({ q: query, maxResults: String(max) })
  const list = (await call(`/messages?${q.toString()}`)) as { messages?: { id?: string }[] }
  const heads: MailHead[] = []
  for (const { id } of list.messages ?? []) {
    if (!id) continue
    const m = (await call(
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
    )) as ApiMessage
    const head = toHead(m)
    if (head) heads.push(head)
  }
  return heads
}

export const renderMailHeads = (heads: readonly MailHead[]): string =>
  heads.length === 0
    ? "該当なし"
    : heads
        .map(
          (h) =>
            `- [${h.at ? localStamp(h.at) : "日時不明"}] ${h.subject}\n  差出人 ${h.from} / id ${h.id}\n  ${h.snippet}`,
        )
        .join("\n")

export function extractBody(part: ApiPart | undefined): string {
  if (!part) return ""
  const decode = (data: string): string => Buffer.from(data, "base64url").toString("utf8")
  const walk = (p: ApiPart, want: string): string => {
    if (p.mimeType === want && p.body?.data) return decode(p.body.data)
    for (const child of p.parts ?? []) {
      const found = walk(child, want)
      if (found) return found
    }
    return ""
  }
  const plain = walk(part, "text/plain")
  if (plain) return plain
  const html = walk(part, "text/html")
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export async function readMail(id: string): Promise<{ head: MailHead; body: string }> {
  const m = (await call(`/messages/${encodeURIComponent(id)}?format=full`)) as ApiMessage
  const head = toHead(m)
  if (!head) throw new Error(`メールが読めない: ${id}`)
  const full = extractBody(m.payload)
  const body = full.length > BODY_MAX ? `${full.slice(0, BODY_MAX)}…(${full.length}字あるうちの先頭)` : full
  return { head, body }
}
