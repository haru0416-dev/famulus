/**
 * 公開 web を読み、このホストの内側へ向く URL を拒否する。ufw は送信を検査しないので、ここが唯一の拒否点。
 * 接続時に再解決されるので DNS rebinding は防げない。IPv6 link-local 全体と16進表記の IPv4 射影も未対応。
 */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { appConfig } from "../core/config.ts"
import { decodeBody, isReadableType, toText } from "./WebContent.ts"

export { decodeBody, isReadableType, renderFeed, toText } from "./WebContent.ts"

/** JS で組み立てるページは人が読む文字が JS の後ろにあるので、低く切ると本文が1字も入らない。 */
const MAX_BYTES = 1_500_000
const MAX_CHARS = 12_000
const TIMEOUT_MS = 20_000
const MAX_HOPS = 3
/** 相手が拒否したいときに拒否できるよう、素性と用途が分かる名乗りにする。 */
const UA = "famulus/0.1 (personal research agent)"

/** 数値で見る。文字列の前方一致では 10.0.0.1 と 100.1.1.1 を取り違える。 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT / Tailscale
    if (a >= 224) return true // multicast 以上
    return false
  }
  if (v === 6) {
    const s = ip.toLowerCase()
    if (s === "::" || s === "::1") return true
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true
    const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (m?.[1]) return isPrivateAddress(m[1])
    return false
  }
  return true // 解釈できないものは内側扱い
}

export function deniedByName(host: string): string | undefined {
  const h = host.toLowerCase()
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost"
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return `内側の名前: ${h}`
  if (isIP(h) && isPrivateAddress(h)) return `内側のアドレス: ${h}`
  return undefined
}

/** 読めない文字列は比較で必ず外れる `undefined` にする。 */
function originOf(raw: string): string | undefined {
  try {
    return new URL(raw).origin
  } catch {
    return undefined
  }
}

export async function denyReason(raw: string): Promise<string | undefined> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return `URL として読めない: ${raw.slice(0, 60)}`
  }
  if (u.protocol !== "https:") return `https 以外は取らない(${u.protocol})`
  const byName = deniedByName(u.hostname)
  if (byName) return byName
  if (isIP(u.hostname)) return undefined
  try {
    const addrs = await lookup(u.hostname, { all: true })
    if (addrs.length === 0) return `名前が解決できない: ${u.hostname}`
    const bad = addrs.find((a) => isPrivateAddress(a.address))
    if (bad) return `内側を指している: ${u.hostname} → ${bad.address}`
  } catch {
    return `名前が解決できない: ${u.hostname}`
  }
  return undefined
}

export interface FetchedPage {
  readonly url: string
  readonly status: number
  readonly text: string
  readonly truncated: boolean
  readonly nextOffset?: number
  readonly note?: string
}

/** `endsWith` だけだと `evilqiita.com` が `qiita.com` に当たる。 */
const isHost = (u: URL, domain: string): boolean => u.hostname === domain || u.hostname.endsWith(`.${domain}`)

/** 取りに行かずに断る先。robots が明文で断っていて、取っても本文が無い先だけを入れる。 */
function refusedBeforeFetch(u: URL): boolean {
  return isHost(u, "x.com") || isHost(u, "twitter.com")
}

/**
 * 取れないと分かっている先への回り道。足すときは元のページも測り直す —
 * JS の差し込みに見えるものが、こちらの読み取りの不具合であることがある。
 */
export function detour(url: string): string | undefined {
  const u = new URL(url)
  const seg = u.pathname.split("/").filter(Boolean)

  if (isHost(u, "github.com")) return githubDetour(u, seg)

  if (isHost(u, "zenn.dev")) {
    // 記事のページは素で読めるので振り替えない。
    if (seg[0] === "topics" && seg[1] && seg.length === 2)
      return `一覧は JS で組み立てるので HTML には無い。https://zenn.dev/topics/${seg[1]}/feed を開く`
    if (seg[0] && seg.length === 1)
      return `記事一覧は JS で組み立てる。https://zenn.dev/${seg[0]}/feed を開く`
    return undefined
  }
  if (isHost(u, "qiita.com")) {
    // 記事のページは素で読めるので振り替えない。
    if (seg[0] === "tags" && seg[1] && seg.length === 2)
      return `一覧は JS で組み立てるので HTML には無い。https://qiita.com/tags/${seg[1]}/feed を開く`
    if (seg[0] && seg.length === 1)
      return `記事一覧は JS で組み立てる。https://qiita.com/${seg[0]}/feed を開く`
    return undefined
  }

  if (isHost(u, "npmjs.com")) {
    // www.npmjs.com は Cloudflare の待機ページで 403。レジストリは通る。
    const pkg = /^\/package\/(.+)$/.exec(u.pathname)?.[1]
    return `npmjs.com は 403 で拒否される。https://registry.npmjs.org/${pkg ?? "<パッケージ名>"}/latest を開く`
  }
  if (isHost(u, "x.com") || isHost(u, "twitter.com")) {
    // 投稿の中身は search の `x` から読む(索引の要約で、X には接続しない)。
    const who = /^\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(u.pathname)?.[1]
    // 「取れない」だけだと読み手がそこで諦めるので、行き先まで言う。
    return (
      "robots で断られていて、開いても本文を含まないクライアント描画用 HTML しか返らない。**ただし投稿の本文は search で読める** — " +
      `\`where: ["x"]\` で引くと、要約に投稿の文字そのものが入る` +
      (who ? `。この人に絞るなら語に \`from:${who}\`` : "")
    )
  }
  if (isHost(u, "stackoverflow.com") && seg[0] === "questions" && seg[1] === "tagged") {
    // 質問一覧だけが 403。質問1件のページは通るので振り替えない。
    return `質問一覧の HTML は 403 で拒否される。https://stackoverflow.com/feeds/tag/${seg[2]} を開く`
  }
  if (isHost(u, "reddit.com") && seg[0] === "r" && seg[1]) {
    // old.reddit.com も `.json` も 403。
    return `HTML も .json も 403 で拒否される。https://www.reddit.com/r/${seg[1]}/.rss を開く`
  }
  if (isHost(u, "techmeme.com") && seg.length === 0) {
    return `一覧は 6 万字あり頭から 6 回かかる。https://www.techmeme.com/feed.xml を開く(同じ見出しが 9 千字で返る)`
  }
  if (isHost(u, "huggingface.co") && seg[0] === "papers" && seg.length === 1) {
    return `一覧は JS で組み立てるので HTML には無い。https://huggingface.co/api/daily_papers?limit=20 を開く(今日の選抜)。語で引くなら search の hfpapers`
  }
  if (isHost(u, "youtube.com") && u.pathname === "/watch" && u.searchParams.get("v")) {
    const id = u.searchParams.get("v") ?? ""
    return `題と説明は 68万バイト目にあり、読むのに 1.3MB 要る。https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}&format=json を開く(題と投稿者が 200 バイトで返る)`
  }
  if (isHost(u, "laws.e-gov.go.jp") && seg[0] === "law" && seg[1]) {
    return `条文は JS で差し込むので HTML には無い。https://laws.e-gov.go.jp/api/1/lawdata/${seg[1]} を開く(XML で条文が返る)`
  }
  if (isHost(u, "bsky.app") && seg[0] === "profile" && seg[1]) {
    return `投稿は HTML に入っていない。https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${seg[1]}&limit=20 を開く`
  }
  if (isHost(u, "note.com") && seg[0] && seg.length === 1) {
    // rss があるのは書き手のページだけ。
    return `記事は JS で組み立てる。書き手のページなら https://note.com/${seg[0]}/rss を開く`
  }
  if (isHost(u, "mastodon.social") && seg[0]?.startsWith("@") && seg.length === 1) {
    return `投稿は JS で組み立てる。https://${u.hostname}/${seg[0]}.rss を開く`
  }
  if (isHost(u, "arxiv.org") && seg[0] === "pdf" && seg[1]) {
    const id = seg[1].replace(/\.pdf$/i, "")
    return `要旨なら https://arxiv.org/abs/${id}、本文なら https://arxiv.org/html/${id} を開く`
  }
  return undefined
}

function githubDetour(u: URL, seg: readonly string[]): string | undefined {
  const [owner, repo, kind, ref] = seg
  if (seg[0] === "search") {
    const q = u.searchParams.get("q") ?? ""
    return u.searchParams.get("type") === "code"
      ? "コード検索の結果は JS で差し込み、API は鍵が要る(401)。このページからは取れないので別の探し方にする"
      : `結果は JS で差し込む。https://api.github.com/search/repositories?q=${encodeURIComponent(q)} を開く`
  }
  if (!owner || !repo) return undefined
  if (seg.length === 2) {
    return `README は入っている(このページで読めている)。無いのはファイル一覧 — 要るなら https://api.github.com/repos/${owner}/${repo}/contents を開く`
  }
  if ((kind === "issues" || kind === "pull") && ref) {
    const api = kind === "pull" ? "pulls" : "issues"
    return `題と本文は入っている。飾りを外して本文だけ読むなら https://api.github.com/repos/${owner}/${repo}/${api}/${ref} を開く`
  }
  if (kind === "tree" && ref) {
    const path = seg.slice(4).join("/")
    return `ファイル一覧は JS で差し込むので HTML には無い。https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref} を開く`
  }
  return undefined
}

/**
 * 同じホストへの間隔。記録はプロセス内だけで、再起動でリセットされる。
 * Config で縮められるのは fetch を stub した検査のため。外へ出る既定は動かさない。
 */
const hostIntervalMs = (): number => appConfig().web.hostIntervalMs
const lastHit = new Map<string, number>()
async function pace(host: string): Promise<void> {
  const prev = lastHit.get(host)
  const now = Date.now()
  const wait = prev === undefined ? 0 : prev + hostIntervalMs() - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastHit.set(host, Date.now())
}

/**
 * 開いたページの全文を保持し、続き読みは取り直さずに切り出す。
 * 「さっき開いた」は同じ offset の再要求にだけ付ける。順に読み進める呼び出しには付けない。
 */
const MEMO_TTL_MS = 5 * 60_000
const MEMO_MAX = 40
interface CachedDoc {
  readonly url: string
  readonly status: number
  readonly full: string
  readonly cut: boolean
  readonly note?: string
}
const docs = new Map<string, { at: number; doc: CachedDoc }>()
/** 繰り返しの検出だけに使う。 */
const served = new Map<string, number>()

function recallDoc(url: string, nowMs: number): CachedDoc | undefined {
  const hit = docs.get(url)
  if (!hit) return undefined
  if (nowMs - hit.at > MEMO_TTL_MS) {
    docs.delete(url)
    return undefined
  }
  return hit.doc
}

function rememberDoc(url: string, doc: CachedDoc, nowMs: number): void {
  docs.set(url, { at: nowMs, doc })
  // Map は挿入順を保つので先頭が最古。
  while (docs.size > MEMO_MAX) {
    const oldest = docs.keys().next().value
    if (oldest === undefined) break
    docs.delete(oldest)
  }
}

function repeatAgoSec(key: string, nowMs: number): number | undefined {
  const prev = served.get(key)
  served.set(key, nowMs)
  while (served.size > MEMO_MAX * 4) {
    const oldest = served.keys().next().value
    if (oldest === undefined) break
    served.delete(oldest)
  }
  if (prev === undefined || nowMs - prev > MEMO_TTL_MS) return undefined
  return Math.round((nowMs - prev) / 1000)
}

/** arrayBuffer() は使わない。数十MBの PDF を丸ごとメモリに載せる。 */
async function readCapped(res: Response): Promise<{ buf: Uint8Array; cut: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) return { buf: new Uint8Array(0), cut: false }
  const parts: Uint8Array[] = []
  let size = 0
  let cut = false
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    size += value.byteLength
    if (size >= MAX_BYTES) {
      cut = true
      await reader.cancel().catch(() => {})
      break
    }
  }
  // 最後のチャンクは上限をまたぐ。繋いでから切り直すと上限分を二度確保するので、上限ちょうどの配列へ写す。
  const total = Math.min(size, MAX_BYTES)
  const buf = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    if (at >= total) break
    buf.set(at + p.byteLength <= total ? p : p.subarray(0, total - at), at)
    at += p.byteLength
  }
  return { buf, cut }
}

/**
 * 200 なのに中身が薄いページへの断り書き。黙って空を返すと読み手は「そう書いてある」と受け取る。
 * 疑うのは script のある HTML だけ。HTML の大きさでなく返した字数で見る(JS の転送ページは HTML ごと小さい)。
 * 無い(empty)と少ない(slim)を分ける。読めたページに「別の出典を当たれ」を付けない。
 */
function thinNote(p: {
  url: string
  raw: string
  ctype: string
  text: string
  bytes: number
  cut: boolean
}): string | undefined {
  if (!/html/i.test(p.ctype) || !/<script\b/i.test(p.raw)) return undefined
  const chars = p.text.trim().length
  const empty = chars < 300
  const slim = !empty && chars < 2_000 && p.bytes > 50_000
  if (!empty && !slim) return undefined
  const kb = Math.round(p.bytes / 1024)
  const d = detour(p.url)
  if (slim) {
    // 回り道があればそれに言わせる。固定文だと detour の文と食い違う。
    return (
      `読めたのは ${chars}字(HTML ${kb}KB)。**これで足りているならそれでいい。** ` +
      (d ??
        "載っているはずのものが見当たらないなら、残りは JS で後から入る部分 — 別の出典を当たったほうが早い")
    )
  }
  // 上限で切ったのか、そもそも入っていないのかを分ける。診断を誤ると読み手が取れるものを諦める。
  const why =
    d ??
    (p.cut
      ? `頭 ${Math.round(MAX_BYTES / 1000)}KB を読んだ範囲に本文が無かった — 先に JS が並ぶページだと思う`
      : "JS で組み立てるページだと思う — 別の出典を当たったほうが早い")
  return `本文がほとんど無い(HTML ${kb}KB に対し ${chars}字)。${why}`
}

/** 当たりの前後だけを返す。大きなページを `MAX_CHARS` 刻みで読むと1刻みごとにモデル呼び出しが要る。 */
const FIND_MAX = 6
const FIND_PAD = 300
export function findIn(full: string, needle: string): { text: string; count: number } {
  const hay = full.toLowerCase()
  const nee = needle.toLowerCase()
  const at: number[] = []
  for (let i = hay.indexOf(nee); i >= 0; i = hay.indexOf(nee, i + Math.max(1, nee.length))) {
    at.push(i)
    if (at.length >= 200) break
  }
  if (at.length === 0) return { text: "", count: 0 }
  const shown = at.slice(0, FIND_MAX)
  const head =
    `「${needle}」は全 ${full.length}字の中に ${at.length}${at.length >= 200 ? "か所以上" : "か所"}。` +
    (shown.length < at.length ? `先頭 ${shown.length} 件の` : "") +
    `前後 ${FIND_PAD}字を見せる。`
  const parts = shown.map((i) => {
    const from = Math.max(0, i - FIND_PAD)
    return `[${from}字目]\n${full.slice(from, Math.min(full.length, i + needle.length + FIND_PAD))}`
  })
  return { text: [head, ...parts].join("\n\n").slice(0, MAX_CHARS), count: at.length }
}

function slice(doc: CachedDoc, offset: number, agoSec: number | undefined): FetchedPage {
  const text = doc.full.slice(offset, offset + MAX_CHARS)
  const more = doc.full.length > offset + MAX_CHARS
  const notes: string[] = []
  if (doc.note) notes.push(doc.note)
  if (offset > 0 && text.length === 0)
    notes.push(`このページは全 ${doc.full.length}字で、${offset}字目より先は無い。続きを探すなら別の出典へ。`)
  // 回数を数字で見せると、offset を刻む前に find へ移れる。
  if (more && doc.full.length > MAX_CHARS * 3)
    notes.push(
      `このページは全 ${doc.full.length}字。${MAX_CHARS}字ずつ頭から読むと ${Math.ceil(doc.full.length / MAX_CHARS)} 回かかる。` +
        `探すものが決まっているなら offset を刻まず \`find\` に語を渡す(当たった箇所の前後だけ返る)。`,
    )
  if (agoSec !== undefined)
    notes.push(
      `ここは ${agoSec} 秒前にも開いた。**同じものを返している**(取り直していない)。取り直しても中身は変わらない — 別の出典か別の問いに移る。`,
    )
  return {
    url: doc.url,
    status: doc.status,
    text,
    truncated: doc.cut || more,
    ...(more ? { nextOffset: offset + MAX_CHARS } : {}),
    ...(notes.length ? { note: notes.join("\n") } : {}),
  }
}

function search(doc: CachedDoc, needle: string): FetchedPage {
  const hit = findIn(doc.full, needle)
  const notes = [doc.note].filter((s): s is string => Boolean(s))
  if (hit.count === 0)
    notes.push(
      `「${needle}」はこのページ(全 ${doc.full.length}字)に無い。綴りを変えるか、別のページへ。**読み取り範囲を変えて探し直さない。**`,
    )
  return {
    url: doc.url,
    status: doc.status,
    text: hit.text,
    truncated: false,
    ...(notes.length ? { note: notes.join("\n") } : {}),
  }
}

export interface FetchOptions {
  readonly offset?: number
  /** 渡すと offset は無視する。 */
  readonly find?: string
  /** 検査で時計を差し替えるため。 */
  readonly nowMs?: number
}

export async function fetchPage(raw: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const { offset = 0, find, nowMs = Date.now() } = opts
  const key = find ? `${raw}\nfind:${find}` : `${raw}\n${offset}`
  const seen = recallDoc(raw, nowMs)
  const doc = seen ?? (await fetchFresh(raw))
  if (!seen) rememberDoc(raw, doc, nowMs)
  const ago = repeatAgoSec(key, nowMs)
  return find ? search(doc, find) : slice(doc, offset, seen ? ago : undefined)
}

/** 転送は自分で追い、各転送先を内側判定に通す。 */
async function fetchFresh(raw: string): Promise<CachedDoc> {
  if (refusedBeforeFetch(new URL(raw)))
    return { url: raw, status: 0, full: "", cut: false, note: detour(raw) ?? "" }
  let url = raw
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const deny = await denyReason(url)
    if (deny) throw new Error(`取得しない: ${deny}`)
    await pace(new URL(url).hostname)

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: ctl.signal,
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
          "accept-language": "ja,en;q=0.8",
        },
      })
    } finally {
      clearTimeout(timer)
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc) return { url, status: res.status, full: "", cut: false }
      url = new URL(loc, url).toString()
      continue
    }

    const ctype = res.headers.get("content-type") ?? ""
    if (!isReadableType(ctype)) {
      await res.body?.cancel().catch(() => {})
      const len = res.headers.get("content-length")
      // 読めない形式にも回り道がある(arXiv の PDF など)。
      const d = detour(url)
      return {
        url,
        status: res.status,
        full: "",
        cut: false,
        note:
          `この形式は文字として読めない(${ctype || "種別不明"}${len ? `、${Math.round(Number(len) / 1024)}KB` : ""})` +
          (d ? ` — ${d}` : ""),
      }
    }
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => {})
      const d = detour(url)
      return {
        url,
        status: res.status,
        full: "",
        cut: false,
        note: `HTTP ${res.status} で読めなかった${d ? ` — ${d}` : ""}`,
      }
    }

    const { buf, cut } = await readCapped(res)
    const raw = decodeBody(buf, ctype)
    const full = toText(raw, ctype)
    const note = thinNote({ url, raw, ctype, text: full, bytes: buf.byteLength, cut })
    return { url, status: res.status, full, cut, ...(note ? { note } : {}) }
  }
  throw new Error(`転送が多すぎる(${MAX_HOPS} 回で打ち切り)`)
}

/**
 * fetchRaw はタグを剥がさず切りもしないバイト列を返す(Search.ts 用)。`redirect: "follow"` にしない —
 * 宛先が定数でも転送先は相手が決める。断られたときの本文も返す(上限か拒否かは本文にしか無い)。
 * 同時に何本も出す呼び出し元は `timeoutMs` を短くする。返らない1本が全体を待たせる。
 */
export interface RawOptions {
  readonly accept: string
  readonly timeoutMs?: number
  /** 先ごとの見出しは呼び出し元が組み立てる。 */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * この origin だけ内側判定と間隔を免除する(自前の SearXNG 用)。Search.ts に定数で書いた origin 以外を渡さない。
   * 前方一致にしない(`:8888.example.com` まで免除される)。転送先には免除が掛からない。
   */
  readonly allowOrigin?: string
}

export interface RawResult {
  readonly status: number
  readonly body: string
  /** 相手が見出しで教えてきたときだけ入る。 */
  readonly resetAtMs?: number
}

export function resetAtMs(h: Headers, nowMs = Date.now()): number | undefined {
  const retry = h.get("retry-after")
  if (retry) {
    const secs = Number(retry)
    if (Number.isFinite(secs)) return nowMs + secs * 1000
    const at = Date.parse(retry)
    if (!Number.isNaN(at)) return at
  }
  for (const name of ["rate-reset", "x-ratelimit-reset"]) {
    const epoch = Number(h.get(name))
    // epoch 秒。ms で返す先があるので上限も見る。
    if (Number.isFinite(epoch) && epoch * 1000 > nowMs && epoch * 1000 < nowMs + 86_400_000) {
      return epoch * 1000
    }
  }
  return undefined
}

export async function fetchRaw(raw: string, opts: RawOptions): Promise<RawResult> {
  const { accept, timeoutMs = TIMEOUT_MS, headers = {}, allowOrigin } = opts
  let url = raw
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const mine = allowOrigin !== undefined && originOf(url) === allowOrigin
    if (!mine) {
      const deny = await denyReason(url)
      if (deny) throw new Error(`取得しない: ${deny}`)
      await pace(new URL(url).hostname)
    }

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: ctl.signal,
        headers: { "user-agent": UA, accept, "accept-language": "ja,en;q=0.8", ...headers },
      })
    } finally {
      clearTimeout(timer)
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc) return { status: res.status, body: "" }
      url = new URL(loc, url).toString()
      continue
    }
    const { buf } = await readCapped(res)
    const body = decodeBody(buf, res.headers.get("content-type") ?? "")
    if (res.status >= 400) {
      const at = resetAtMs(res.headers)
      // 長い HTML を返す先があるので頭だけ渡す。
      return { status: res.status, body: body.slice(0, 400), ...(at ? { resetAtMs: at } : {}) }
    }
    return { status: res.status, body }
  }
  throw new Error(`転送が多すぎる(${MAX_HOPS} 回で打ち切り)`)
}
