/** 取得済みの HTML・XML・feed・バイト列を読める文字列へ変換する。 */

/** 本文を含む要素の class/id。サイト固有の語は入れない。 */
const LOOKS_LIKE_BODY = /\b(?:content|article|main|body|entry|post|story)\b/i

/** 正規表現では入れ子を追えないので、開きと閉じの深さを数える。 */
function blockAfter(html: string, from: number, tag: string): string {
  const open = new RegExp(`<${tag}\\b`, "gi")
  const close = new RegExp(`</${tag}>`, "gi")
  let depth = 1
  let i = from
  while (depth > 0 && i < html.length) {
    open.lastIndex = i
    close.lastIndex = i
    const o = open.exec(html)
    const c = close.exec(html)
    if (!c) return html.slice(from) // 閉じないまま終わるページがある。
    if (o && o.index < c.index) {
      depth++
      i = o.index + 1
    } else {
      depth--
      if (depth === 0) return html.slice(from, c.index)
      i = c.index + 1
    }
  }
  return html.slice(from)
}

/** 本文の周りを落とす。削らないと取得の文字数上限をナビゲーションが使い切る。 */
function trimChrome(html: string): string {
  // 先頭の article が読み込みエラーの差し込みで本文が後ろにあるページがあるので、最初ではなく最長を採る。
  let best = ""
  for (const m of html.matchAll(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/gi)) {
    if ((m[1]?.length ?? 0) > best.length) best = m[1] ?? ""
  }
  if (best.length < html.length * 0.15) {
    // main/article が無いページ。ページごと使うと窓の先頭が絞り込みメニューで埋まる。
    let byName = ""
    for (const m of html.matchAll(/<(div|section|ul|ol)\b([^>]*)>/gi)) {
      if (!LOOKS_LIKE_BODY.test(m[2] ?? "")) continue
      const inner = blockAfter(html, m.index + m[0].length, m[1] ?? "div")
      if (inner.length > byName.length) byName = inner
    }
    if (byName.length > best.length) best = byName
  }
  const body = best.length >= html.length * 0.15 ? best : html
  // figure は入れない。論文のページで図の説明ごと本文が消える。
  return body
    .replace(
      /<(nav|header|footer|aside|form|svg|noscript|template|iframe|object|embed|button|select|textarea)\b[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<[^>]*\b(?:hidden|aria-hidden="true")[^>]*>[\s\S]{0,400}?<\/[^>]+>/gi, " ")
}

/** 本文に実際に出る名前付き実体だけ。数値の実体は decodeEntities が戻す。 */
const NAMED: Readonly<Record<string, string>> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  yen: "¥",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "・",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  times: "×",
  minus: "−",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  bull: "•",
  euro: "€",
  pound: "£",
  cent: "¢",
  sect: "§",
  para: "¶",
  larr: "←",
  rarr: "→",
  ne: "≠",
  le: "≤",
  ge: "≥",
}

/**
 * タグを剥がした後に呼ぶ。先だと `&lt;script&gt;` がタグとして復活する。
 * `&amp;` は最後。先に戻すと `&amp;lt;` が `<` まで戻る。
 */
const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d{1,7});/g, (m, d: string) => codePoint(Number(d)) ?? m)
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (m, h: string) => codePoint(Number.parseInt(h, 16)) ?? m)
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,9});/g, (m, name: string) => NAMED[name.toLowerCase()] ?? m)
    .replace(/&amp;/g, "&")

/** 範囲外・サロゲート単独・制御文字は戻さない。 */
function codePoint(n: number): string | undefined {
  if (!Number.isInteger(n) || n > 0x10_ff_ff) return undefined
  if (n === 9 || n === 10) return String.fromCodePoint(n)
  if (n < 32 || (n >= 0x7f && n <= 0x9f)) return undefined
  if (n >= 0xd8_00 && n <= 0xdf_ff) return undefined
  return String.fromCodePoint(n)
}

function pick(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml)
  if (!m?.[1]) return undefined
  const text = decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
  return text || undefined
}

/** RSS / Atom を1件ずつに分ける。まとめて剥がすと、どの日付がどの記事のものか分からなくなる。 */
export function renderFeed(xml: string): string | undefined {
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
  if (items.length === 0) return undefined
  // item の中の同名タグを拾わないよう、最初の item より前だけを見る。
  const head = xml.slice(0, items[0]?.index ?? 0)
  const lines: string[] = []
  const title = pick(head, "title")
  const updated = pick(head, "lastBuildDate") ?? pick(head, "updated") ?? pick(head, "pubDate")
  if (title) lines.push(title)
  if (updated) lines.push(`更新: ${updated}`)
  lines.push(`${items.length} 件`)
  for (const [, , body = ""] of items) {
    const t = pick(body, "title") ?? "(見出し無し)"
    const at = pick(body, "pubDate") ?? pick(body, "updated") ?? pick(body, "published")
    const link = pick(body, "link") ?? /<link\b[^>]*href=["']([^"']+)/i.exec(body)?.[1]
    const desc = pick(body, "description") ?? pick(body, "summary")
    // 書き手が無いと、読み手が確かめに記事ページを余計に開く。
    const by = pick(body, "dc:creator") ?? pick(body, "author") ?? pick(body, "creator")
    lines.push("")
    lines.push(`- ${t}`)
    if (by) lines.push(`  書き手: ${by}`)
    if (at) lines.push(`  ${at}`)
    if (link) lines.push(`  ${link}`)
    if (desc) lines.push(`  ${desc.slice(0, 300)}`)
  }
  return lines.join("\n")
}

/**
 * HTML を読める文にする。重複 DOM や短い行の連続は削らない — 表の行やリンク集まで消える。
 */
export function toText(raw: string, contentType: string): string {
  if (!/html|xml/i.test(contentType)) return raw
  // `\r`・全角空白・NBSP・ゼロ幅が残ると、空白だけの行が下の除去に当たらない。
  const html = raw.replace(/\r\n?/g, "\n").replace(/[ 　​﻿]/g, " ")
  // 根の要素で決める。`xml` を含む種別で判定すると、`<item>` を1つ持つ XHTML まで feed 扱いになる。
  if (/rss|atom/i.test(contentType) || /<(rss|feed)\b/i.test(html.slice(0, 1_000))) {
    const feed = renderFeed(html)
    if (feed) return feed
  }
  const body = decodeEntities(
    trimChrome(html)
      // 閉じが無ければ末尾まで落とす。取得上限で切れると最後の `<script>` が閉じない。
      .replace(/<script[\s\S]*?(?:<\/script>|$)/gi, " ")
      .replace(/<style[\s\S]*?(?:<\/style>|$)/gi, " ")
      .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // 属性値の中の `>` をタグの終わりと取り違えないよう、引用符で囲まれた範囲を1単位として飛ばす。
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g, " ")
      // 引用符が閉じていない壊れたタグの取りこぼし。
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    // 先に落とさないと、空白1つだけの行が `\n{3,}` に当たらない。
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  // trimChrome が本文の要素を選ぶと題が落ちる。複数ページを並べて読むとき取り違えないよう頭に戻す。
  const title = pick(html, "title")
  const headed = title && !body.slice(0, 200).includes(title) ? `${title}\n\n${body}` : body
  // `<title>` まで JS で入るページは `<meta>` にしか題と説明が無い。
  // 本文が取れていれば足さない — 同じ話が二重になる。
  return headed.length >= 300 ? headed : [metaSummary(html), headed].filter(Boolean).join("\n\n").trim()
}

/** `<meta>` の題と説明。属性の並びはページごとに違うので、タグを取ってから中を見る。 */
function metaSummary(html: string): string {
  const found = new Map<string, string>()
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0]
    const key = /\b(?:name|property)=["']?([\w:.-]+)/i.exec(tag)?.[1]?.toLowerCase()
    const val = /\bcontent=["']([^"']*)["']/i.exec(tag)?.[1]
    if (!key || !val) continue
    if (/^(?:og:title|og:description|og:site_name|description|twitter:title|twitter:description)$/.test(key))
      found.set(key, decodeEntities(val).replace(/\s+/g, " ").trim())
  }
  const out: string[] = []
  for (const k of [
    "og:title",
    "twitter:title",
    "og:site_name",
    "description",
    "og:description",
    "twitter:description",
  ]) {
    const v = found.get(k)
    // og: と twitter: に同じ文が入っていることが多い。
    if (v && !out.some((o) => o.includes(v) || v.includes(o))) out.push(v)
  }
  return out.join("\n\n")
}

/** PDF や画像は文字として渡さない。中身が伝わらず文脈だけ使う。 */
export function isReadableType(contentType: string): boolean {
  const t = contentType.toLowerCase().split(";")[0]?.trim() ?? ""
  if (t.startsWith("text/")) return true
  return /^application\/(json|xml|xhtml\+xml|.*\+json|.*\+xml|javascript)$/.test(t)
}

/**
 * charset は Content-Type → meta 宣言 → utf-8 の順。取得上限はバイト数で切るので、
 * 末尾の途中で切れた文字は `stream: true` で出力させずに捨てる。
 */
export function decodeBody(buf: Uint8Array, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  const head = Buffer.from(buf.slice(0, 2048)).toString("latin1")
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1]
  for (const enc of [fromHeader, fromMeta, "utf-8"]) {
    if (!enc) continue
    try {
      // 名前はページ由来で未知のことがある。例外を catch で受けるため型を外す。
      return new TextDecoder(enc as never, { fatal: false }).decode(buf, { stream: true })
    } catch {
      // 知らない charset。次の候補へ。
    }
  }
  return Buffer.from(buf).toString("utf8")
}
