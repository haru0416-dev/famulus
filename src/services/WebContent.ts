/** 取得済みのHTML・XML・feed・バイト列を、読める文字列へ変換する。 */

/**
 * `class`/`id` が本文らしい塊。Readability の `okMaybeItsACandidate` から採った。
 * サイト固有の語(`hotentry` など)は入れない — 一般語だけで同じだけ手前に来る。
 */
const LOOKS_LIKE_BODY = /\b(?:content|article|main|body|entry|post|story)\b/i

/**
 * 開始タグの直後から、対応する終了タグまでを返す。正規表現では入れ子を追えないので深さを数える。
 * `div`/`section`/`ul`/`ol` は自己終了しないので、開きと閉じを数えれば足りる。
 */
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
    if (!c) return html.slice(from) // 閉じないまま終わるページがある。そこまでを本文とみなす。
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

/**
 * 本文の周りを落とす。削らないと取得側の文字数上限をナビゲーションが食う。
 * 塊を選ぶ順は `<main>`/`<article>` → `class`/`id` → ページごと。
 */
function trimChrome(html: string): string {
  // 最初の `<main>`/`<article>` を採ると外す。GitHub や Qiita は先頭の article が
  // 読み込みエラーの差し込みで、本文はその後ろにある。長いほうを採る。
  let best = ""
  for (const m of html.matchAll(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/gi)) {
    if ((m[1]?.length ?? 0) > best.length) best = m[1] ?? ""
  }
  // 本文らしさの目安。全体の 15% にも満たない塊は「本文」ではなく部品。
  if (best.length < html.length * 0.15) {
    // `<main>`/`<article>` が無いページのほうが多い(はてブ・価格.com は1つも持たない)。
    // ページごと使うと窓の頭が絞り込みメニューで尽きるので、Readability が本文を選ぶときの
    // class/id の入口だけ借りる。
    let byName = ""
    for (const m of html.matchAll(/<(div|section|ul|ol)\b([^>]*)>/gi)) {
      if (!LOOKS_LIKE_BODY.test(m[2] ?? "")) continue
      const inner = blockAfter(html, m.index + m[0].length, m[1] ?? "div")
      if (inner.length > byName.length) byName = inner
    }
    if (byName.length > best.length) best = byName
  }
  const body = best.length >= html.length * 0.15 ? best : html
  // 常に落とす飾り。`object|embed|button|select|textarea` は Readability の常時削除リストから。
  // `figure` は入れない — 論文のページで `Figure 1` ごと本文が消える。
  return body
    .replace(
      /<(nav|header|footer|aside|form|svg|noscript|template|iframe|object|embed|button|select|textarea)\b[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<[^>]*\b(?:hidden|aria-hidden="true")[^>]*>[\s\S]{0,400}?<\/[^>]+>/gi, " ")
}

/**
 * 名前付きの実体のうち、実際に本文へ出てくるもの。全部は載せない(HTML5 の表は 2,000 以上ある)。
 * 数値の実体は下で一括して戻すので、ここに要るのは名前のものだけ。
 * 日本語のページで整形に使われる約物を足してある。
 */
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
 * 実体参照を戻す。タグを剥がすより先にやると `&lt;script&gt;` が復活するので、必ず後。
 * 数値の実体を戻さないと本文に `&#x27;` が生で残り、引用すると壊れた綴りのまま DB に載る。
 * `&amp;` は最後。先に戻すと `&amp;lt;` が `<` まで戻る。
 */
const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d{1,7});/g, (m, d: string) => codePoint(Number(d)) ?? m)
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (m, h: string) => codePoint(Number.parseInt(h, 16)) ?? m)
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,9});/g, (m, name: string) => NAMED[name.toLowerCase()] ?? m)
    .replace(/&amp;/g, "&")

/** 範囲外・サロゲート単独・制御文字は戻さない(`String.fromCodePoint` が投げるか、壊れた1字になる)。 */
function codePoint(n: number): string | undefined {
  if (!Number.isInteger(n) || n > 0x10_ff_ff) return undefined
  if (n === 9 || n === 10) return String.fromCodePoint(n)
  if (n < 32 || (n >= 0x7f && n <= 0x9f)) return undefined
  if (n >= 0xd8_00 && n <= 0xdf_ff) return undefined
  return String.fromCodePoint(n)
}

/** 要素の中身を1つ取る。属性は無視する(欲しいのは本文だけ)。 */
function pick(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml)
  if (!m?.[1]) return undefined
  const text = decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
  return text || undefined
}

/**
 * RSS / Atom は1件ずつに割って返す。そのままタグを剥がすと見出し・日付・本文が1本に繋がり、
 * どの日付がどの記事のものか消える。
 * 判定に使うのは形だけ — `<item>` か `<entry>` があれば feed 扱いにする。無ければ `undefined`。
 */
export function renderFeed(xml: string): string | undefined {
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
  if (items.length === 0) return undefined
  // channel のヘッダは最初の item より前にある。item の中の同名タグを拾わないよう先頭で切る。
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
    // Atom の link は href 属性。RSS は要素の中身。
    const link = pick(body, "link") ?? /<link\b[^>]*href=["']([^"']+)/i.exec(body)?.[1]
    const desc = pick(body, "description") ?? pick(body, "summary")
    // 書き手を拾わないと、読み手は書き手が無いものと見て記事ページを余計に開く。
    // RSS は `<dc:creator>`、Atom は `<author><name>`。pick はタグを剥がすので同じ形で拾える。
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
 * HTML を読める文にする。整形ではなく量を減らすのが目的。
 *
 * ここで止めているのは、これ以上削ると中身を消すから:
 * 重複 DOM の繰り返しを落とすには窓付きの除去が要り、正当に並ぶ表の行まで巻き込む。
 * 短い行の連続はナビの残骸ではなく、リンク集や分類一覧というページの中身であることが多い。
 * どちらもコンテキスト容量を使うだけで、間違った中身を渡す欠陥ではない。
 * JS で後から入る値(`読込中...` のまま届く値段など)は、この道からは取れない。
 */
export function toText(raw: string, contentType: string): string {
  if (!/html|xml/i.test(contentType)) return raw
  // 改行と空白の種類を先に揃える。CRLF のページは行末に `\r` が残り、それだけの行が
  // 「空白だけの行」の畳み込みに当たらない。全角空白・NBSP・ゼロ幅も同じ理由で潰す
  // — 日本語のページでは整形にこれらが使われる。
  const html = raw.replace(/\r\n?/g, "\n").replace(/[ 　​﻿]/g, " ")
  // feed かどうかは根の要素で決める。`xml` を含む種別なら何でも、にすると
  // XHTML のページに `<item>` が1つあるだけで新着一覧として組み直してしまう。
  if (/rss|atom/i.test(contentType) || /<(rss|feed)\b/i.test(html.slice(0, 1_000))) {
    const feed = renderFeed(html)
    if (feed) return feed
  }
  const body = decodeEntities(
    trimChrome(html)
      // 閉じが無ければ末尾まで落とす。`Web.ts` の取得上限で切ると最後の `<script>` が
      // 閉じないまま終わり、その中身が丸ごと本文になる。
      // 上限を上げても、それを超えるページでは同じことが起きる。
      .replace(/<script[\s\S]*?(?:<\/script>|$)/gi, " ")
      .replace(/<style[\s\S]*?(?:<\/style>|$)/gi, " ")
      .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // 属性値の中の `>` をタグの終わりと取り違えない。Wikipedia の infobox のように
      // 属性に生の JSON を持つページでは、単純な `<[^>]+>` が属性の途中で閉じたと見なして
      // その JSON が本文に混ざる。引用符で囲まれた塊を1つの単位として飛ばす。
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g, " ")
      // 引用符が閉じていない壊れたタグは上で剥がれない。取りこぼしをここで掃除する。
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    // 行頭・行末の空白を先に落とす。これが無いと、タグを剥がした跡が空白1つだけの行として残り、
    // `\n{3,}` の畳み込みに当たらない。取得側の文字数枠がその空白で埋まる。
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  // `trimChrome` が塊を選ぶとページの題は本文の外なので落ちる。読み手は複数のページを並べて
  // 読むので、見出しが無いとどれの話か取り違える。頭に戻す。
  const title = pick(html, "title")
  const headed = title && !body.slice(0, 200).includes(title) ? `${title}\n\n${body}` : body
  // 本文が組み上がらないページでも `<meta>` には題と説明が入っている(YouTube・ニコニコ・
  // note・Bluesky は `<title>` すら JS が後から入れるので、ここが無いと返る文字が 0 になる)。
  // 本文が取れているページでは触らない — 拾った説明は本文の要約で、並べると同じ話が二重になる。
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
    // 同じ文が og: と twitter: に両方入っているページが多い。先に採ったものと重なるなら足さない。
    if (v && !out.some((o) => o.includes(v) || v.includes(o))) out.push(v)
  }
  return out.join("\n\n")
}

/** 読める形式か。PDF や画像を文字として渡さない — 中身は何も伝わらないのに文脈だけ食う。 */
export function isReadableType(contentType: string): boolean {
  const t = contentType.toLowerCase().split(";")[0]?.trim() ?? ""
  if (t.startsWith("text/")) return true
  return /^application\/(json|xml|xhtml\+xml|.*\+json|.*\+xml|javascript)$/.test(t)
}

/**
 * バイト列を文字にする。日本語のページは utf-8 とは限らない(Shift_JIS のページを utf-8 で読むと
 * 本文の大半が置換文字になる)。優先順は Content-Type の charset → HTML の meta 宣言 → utf-8。
 *
 * 末尾が文字の途中で切れていたら、その分は捨てる。取得上限の打ち切りはバイト数で入るので、
 * 日本語のページでは 3 バイト文字の途中で終わることがある。`stream: true` で復号すると、
 * 復号コンテナは不完全な列を出力せずに持ち越すので、そのまま捨てられる。
 */
export function decodeBody(buf: Uint8Array, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  // meta の宣言は先頭にあるので、探すのは頭の 2KB だけでいい(全部 latin1 に起こす必要は無い)。
  const head = Buffer.from(buf.slice(0, 2048)).toString("latin1")
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1]
  for (const enc of [fromHeader, fromMeta, "utf-8"]) {
    if (!enc) continue
    try {
      // 名前はページから拾った文字列で、既知の一覧に入っているとは限らない。
      // 型は既知の名前しか許さないので、投げさせて下の catch で落とすために外す。
      return new TextDecoder(enc as never, { fatal: false }).decode(buf, { stream: true })
    } catch {
      // 知らない名前の charset。次の候補へ落とす。
    }
  }
  return Buffer.from(buf).toString("utf8")
}
