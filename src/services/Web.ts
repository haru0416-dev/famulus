/**
 * 外を読むための1本道。**読むのは公開の web だけで、内側には向けさせない。**
 *
 * コネクタ側の egress は allowlist(Governance の EGRESS_ALLOW)で足りる — 宛先が数えられるから。
 * 調査の読み取りは宛先を列挙できないので、逆に**形で拒否する**。止めたいのは外の頁ではなく、
 * このホストの内側だ: loopback・私設アドレス・link-local・CGNAT(Tailscale の 100.64/10 を含む)。
 * ufw は受信だけを見ていて送信は素通しなので、ここを塞がないとモデルの書いた URL 一本で
 * `http://127.0.0.1:8080` も `http://100.72.193.4` も読める。
 *
 * 名前解決してから判定するが、実際に繋ぐときに再解決される(DNS rebinding は塞げていない)。
 * 公開ホストに見せかけて内側へ向ける攻撃までは防げない、という限界は残す。
 */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * 1回の取得で読む上限。
 *
 * **頭だけで足りるという前提は、JS で組み立てる頁では崩れる。** 実測では、
 * 400KB で切ると本文は1文字も入らず、上限を上げると入った:
 * 東京都 38字 → 5,962字(全 860KB)、メルカリ 32字 → 206字(全 533KB)、
 * YouTube 0字 → 426字(全 1.3〜1.4MB。`<title>` が 68万バイト目にある)。
 * 頭にあるのは JS の塊で、人が読む文字はその後ろに置かれている。
 * YouTube の大きさを幅で書いたのは、取得のたびに変わるから — 2026-08-11 に続けて2回引いたら
 * 1,338,535 と 1,423,923 バイトだった。**この頁の「全 N KB」を1つの数字として引用しない。**
 *
 * 代償は転送時間。同じ頁を 400KB と 1,500KB で読み比べると
 * YouTube +644ms、メルカリ +235ms、東京都 +63ms、NHK ±0(70〜90ms)、
 * Yahoo ニュース ±0(158KB で終わるので上限に当たらない)。20秒の制限に対して払える。
 * 解析側は 1.3MB でも 17ms で、ここは問題にならない。
 */
const MAX_BYTES = 1_500_000
/** モデルに渡す上限。ここを超える資料は、そもそも1回で読む単位ではない。 */
const MAX_CHARS = 12_000
const TIMEOUT_MS = 20_000
const MAX_HOPS = 3
/** 名乗り。**素性と用途が分かる形で出す** — 相手が弾きたくなったときに弾ける名前にしておく。 */
const UA = "open-zero/0.1 (personal research agent)"

/** 内側を指すアドレスか。**判定は数値でやる** — 文字列の前方一致では 10.0.0.1 と 100.1.1.1 を取り違える。 */
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
    // IPv4 射影(::ffff:127.0.0.1)は v4 として見る。
    const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (m?.[1]) return isPrivateAddress(m[1])
    return false
  }
  return true // 解釈できないものは内側扱い(安全側)
}

/** ホスト名の形だけで弾けるもの。名前解決の前に落とす。 */
export function deniedByName(host: string): string | undefined {
  const h = host.toLowerCase()
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost"
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return `内側の名前: ${h}`
  if (isIP(h) && isPrivateAddress(h)) return `内側のアドレス: ${h}`
  return undefined
}

/** URL の origin。読めない文字列は `undefined`(比較で必ず外れる値にする)。 */
export function originOf(raw: string): string | undefined {
  try {
    return new URL(raw).origin
  } catch {
    return undefined
  }
}

/** 取得してよい URL か。駄目な理由を文字列で返す(通ってよければ undefined)。 */
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

/**
 * `class`/`id` が本文らしい塊。Readability の `okMaybeItsACandidate` から採った。
 * サイト固有の語(`hotentry` など)は入れない — 一般語だけで、測った8件は同じだけ手前に来た。
 */
const LOOKS_LIKE_BODY = /\b(?:content|article|main|body|entry|post|story)\b/i

/**
 * 開始タグの直後から、対応する終了タグまでを返す。**正規表現では入れ子を追えない**ので深さを数える。
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
    if (!c) return html.slice(from) // 閉じないまま終わる頁がある。そこまでを本文とみなす。
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
 * 本文の周りを落とす。**巡回すると読むのは頁の一部で、残りは毎回同じ飾り**。
 * 実測で NHK は「閉じる 閉じる メニュー」から始まっていた。ここを削らないと 12,000字の
 * 上限をナビゲーションが食う。塊を選ぶ順は `<main>`/`<article>` → `class`/`id` → 頁ごと。
 */
function trimChrome(html: string): string {
  // **最初の `<main>`/`<article>` を採ると外す。** 実測: GitHub は先頭の article が
  // "There was an error while loading." の差し込みで、README(本文)はその後ろにあった
  // (7,028字 → 1,895字に痩せた)。Qiita も同じ形で 8,234字 → 86字。長いほうを採る。
  let best = ""
  for (const m of html.matchAll(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/gi)) {
    if ((m[1]?.length ?? 0) > best.length) best = m[1] ?? ""
  }
  // 本文らしさの目安。全体の 15% にも満たない塊は「本文」ではなく部品。
  if (best.length < html.length * 0.15) {
    // **`<main>`/`<article>` が無い頁のほうが多い。** 実測(実サイト16件):
    // はてブ・価格.com はどちらも1つも持っていない(`<ul>` が 260 / 123 個)。頁ごと使うと
    // 窓の頭が絞り込みメニューで尽きた。Readability は class/id に点を付けて本文を選ぶので、
    // その入口だけ借りる。一般語のみで測った差(目的の語が本文の何字目に出るか):
    //   はてブ 933 → 55 / 価格.com 3,239 → 217(製品名)・2,143 → 403 / 食べログ 231 → 3
    //   Wikipedia英 341 → 300 / PyPI 97 → 74 / GitHub 632 → 592
    // 残り9件は1字も動かず、**消えた語も後ろへ下がった語も無かった**。
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
  // **`figure` は入れない** — 足すと arXiv の HTML から `Figure 1` ごと消えた(41,267 → 36,622字)。
  return body
    .replace(
      /<(nav|header|footer|aside|form|svg|noscript|template|iframe|object|embed|button|select|textarea)\b[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<[^>]*\b(?:hidden|aria-hidden="true")[^>]*>[\s\S]{0,400}?<\/[^>]+>/gi, " ")
}

/**
 * 名前付きの実体のうち、実際に本文へ出てくるもの。全部は載せない(HTML5 の表は 2,000 以上ある)。
 * 実測(実サイト14件の窓12,000字)で残っていたのは `&yen;` `&#x27;` `&#x2F;` の3種だけ。
 * 数値の実体は下で一括して戻すので、ここに要るのは名前のものに限る。日本語の頁で使われる約物を足した。
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
 *
 * **数値の実体を戻さないと本文に `&#x27;` が生で残る。** 実測: Hacker News の
 * 見出しに `&#x27;`(アポストロフィ)と `&#x2F;`(スラッシュ)が5個、価格.com の値段欄に `&yen;` が3個。
 * 読み手はそれを文字として読むので、引用すると壊れた綴りのまま台帳に載る。
 *
 * `&amp;` は最後。先に戻すと `&amp;lt;` が `<` まで戻ってしまう。
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
 * RSS / Atom は**1件ずつに割って返す**。
 *
 * 素通しでタグを剥がすと見出し・日付・本文が1本の帯になって、どの日付がどの記事のものか消える
 * (実測: NHK の cat0.xml が 2,301字の帯で、`lastBuildDate` も記事の `pubDate` も文中に埋もれた)。
 * 巡回で最初に効くのが新着の並びなので、ここだけは構造を残す。
 * 判定に使うのは形だけ — `<item>` か `<entry>` があれば feed 扱いにする。
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
    // **書き手を落とさない。** 実測: Zenn のトピック feed は1件ごとに
    // `<dc:creator>fits</dc:creator>` を持っているのに、ここで拾っていなかった。
    // 「記事と書き手を2本」と頼んだら、役は書き手が無いものと見て記事頁を2つ余計に開き(+60秒)、
    // それでも分からず「取れなかった」と返した。**答えは渡したバイト列の中に入っていた。**
    // Atom は `<author><name>X</name></author>` で、pick はタグを剥がすので同じ形で拾える。
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
 * HTML を読める文にする。整形ではなく**減量**が目的。
 *
 * **測ったが直さなかったもの**(2026-08-10 の巡回、実サイト11件)。同じ調査を繰り返さないための記録:
 *
 * - **同じ行の繰り返し**が本文に占める割合は NHK 20% / 食べログ 17% / PyPI 15%。
 *   カルーセルやレスポンシブの重複 DOM が出所。窓を食うのは事実だが、落とすには
 *   「直前 N 行以内の既出を消す」ような窓付きの除去が要り、表の繰り返し(同じラベルが
 *   正当に並ぶ)まで巻き込む。**間違った中身を渡す欠陥ではない**ので、枠の無駄として残した。
 * - **短い行が延々続く塊**は e-Gov 31% / PyPI 29%。これはナビの残骸ではなく**その頁の中身**だった
 *   (e-Gov のトップは実際にリンク集、PyPI は分類の一覧)。畳むと情報が消えるので触らない。
 * - **価格.com の値段は `読込中...`** で、HTML に数字が入っていない。代わりに開ける先を知らないので
 *   回り道も書けない。JS で後から入る値は、この道からは取れない。
 */
export function toText(raw: string, contentType: string): string {
  if (!/html|xml/i.test(contentType)) return raw
  // **改行と空白の種類を先に揃える。** CRLF の頁は行末に `\r` が残り、それだけの行が
  // 「空白だけの行」の畳み込みに当たらない(実測: 価格.com は先頭 27 行が `"\r"` だった)。
  // 全角空白・NBSP・ゼロ幅も同じ理由で潰す — 日本語の頁では整形にこれらが使われる。
  const html = raw.replace(/\r\n?/g, "\n").replace(/[ 　​﻿]/g, " ")
  // feed かどうかは**根の要素で決める**。`xml` を含む種別なら何でも、にすると
  // XHTML の頁に `<item>` が1つあるだけで新着一覧として組み直してしまう。
  if (/rss|atom/i.test(contentType) || /<(rss|feed)\b/i.test(html.slice(0, 1_000))) {
    const feed = renderFeed(html)
    if (feed) return feed
  }
  const body = decodeEntities(
    trimChrome(html)
      // **閉じが無ければ末尾まで落とす。** 上限で切ると最後の `<script>` が閉じないまま終わる。
      // 実測(YouTube の視聴頁を 400KB で切ったとき): 開き 13 に対し閉じ 12。
      // 閉じない1つの中身がそのまま本文になり、返った 12,000字はすべて
      // `ytcfg.set({"CLIENT_CANARY_STATE":...` の JS で、題も説明も1字も入っていなかった。
      // 読み手はそれを頁の中身として読む。**上限を 1.5MB にした今も、それを超える頁では同じことが起きる。**
      .replace(/<script[\s\S]*?(?:<\/script>|$)/gi, " ")
      .replace(/<style[\s\S]*?(?:<\/style>|$)/gi, " ")
      .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // **属性値の中の `>` をタグの終わりと取り違えない。** 実測(en.wikipedia の
      // TypeScript): infobox が `data-mw='{"designer":{"wt":"[[Microsoft]],&lt;br />..."}}'` を
      // 属性に持っていて、`<[^>]+>` はその `&lt;br />` の `>` で閉じたと見なす。結果、
      // `[[Anders Hejlsberg]],<br />Luke Hoban"},"developer":{"wt":"Microsoft"}` から始まる
      // wikitext の生 JSON が 700字ぶん本文に混ざった。読み手はそれを記事本文として読む。
      // 引用符で囲まれた塊を1つの単位として飛ばす。分岐は先頭文字で決まるので後戻りしない。
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g, " ")
      // 引用符が閉じていない壊れたタグは上で剥がれない。取りこぼしをここで掃除する。
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    // **行頭・行末の空白を先に落とす。** これが無いと、タグを剥がした跡が空白1つだけの行として残り、
    // `\n{3,}` の畳み込みに当たらない。実測(実サイト8件): 返した本文に占める空白行の割合は
    // GitHub 42% / PyPI 28% / はてブ 27% / 価格.com 21%。12,000字の枠のそれだけが空白で埋まっていた。
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  // **本文だけを切り出すと、どの頁を読んでいるのかが消える。** 実測:
  // 本文の塊を選ぶようにした結果、日本語版 Wikipedia は「日本語 - Wikipedia」が、
  // はてブは「はてなブックマーク - 人気エントリー - テクノロジー」が先頭から落ちた。
  // 読み手は複数の頁を並べて読むので、見出しが無いとどれの話か取り違える。頭に戻す。
  const title = pick(html, "title")
  const headed = title && !body.slice(0, 200).includes(title) ? `${title}\n\n${body}` : body
  // **本文が組み上がらない頁でも、`<meta>` には題と説明が入っている。** 実測:
  // YouTube の視聴頁は `<title>` すら HTML に無く(JS が後から入れる)、返せる文字が 0 だった。
  // og: と description を拾うと題・投稿者・説明が 250字ほど返る。ニコニコ・note・Bluesky も同じ形。
  // **本文が取れている頁では触らない** — 拾った説明は本文の要約で、並べると同じ話が二重になる。
  return headed.length >= 300 ? headed : [metaSummary(html), headed].filter(Boolean).join("\n\n").trim()
}

/** `<meta>` の題と説明。属性の並びは頁ごとに違うので、タグを取ってから中を見る。 */
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
    // 同じ文が og: と twitter: に両方入っている頁が多い。先に採ったものと重なるなら足さない。
    if (v && !out.some((o) => o.includes(v) || v.includes(o))) out.push(v)
  }
  return out.join("\n\n")
}

/**
 * 読める形式か。**PDF や画像を文字として渡さない。**
 * 実測: arxiv の PDF をそのまま流したら `%PDF-1.5 %` から始まる 12,000字が入り、
 * うち 4,779 字が置換文字だった。中身は何も伝わらないのに文脈だけ焼ける。
 */
export function isReadableType(contentType: string): boolean {
  const t = contentType.toLowerCase().split(";")[0]?.trim() ?? ""
  if (t.startsWith("text/")) return true
  return /^application\/(json|xml|xhtml\+xml|.*\+json|.*\+xml|javascript)$/.test(t)
}

/**
 * バイト列を文字にする。**日本語の頁は utf-8 とは限らない。**
 * 実測: 青空文庫(Shift_JIS)を utf-8 で読んだら 12,000字中 7,734 字が置換文字になった。
 * 優先順は Content-Type の charset → HTML の meta 宣言 → utf-8。
 *
 * **末尾が文字の途中で切れていたら、その分は捨てる。** 上限の打ち切りはバイト数で入れるので、
 * 日本語の頁では 3 バイト文字の 1〜2 バイト目で終わることがある。実測:
 * クックパッドと食べログで置換文字が 1 個ずつ本文に残った。`stream: true` で復号すると、
 * 復号器は不完全な列を出力せずに持ち越すので、そのまま捨てられる。
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
      return new TextDecoder(enc, { fatal: false }).decode(buf, { stream: true })
    } catch {
      // 知らない名前の charset。次の候補へ落とす。
    }
  }
  return Buffer.from(buf).toString("utf8")
}

export interface FetchedPage {
  readonly url: string
  readonly status: number
  readonly text: string
  readonly truncated: boolean
  /** 切れた場合、続きを読むための次の offset。無ければ undefined。 */
  readonly nextOffset?: number
  /** 本文が薄いなど、読み手に伝えるべき事情。 */
  readonly note?: string
}

/**
 * ホスト名の一致。**`endsWith` だけで書くと `evilqiita.com` が `qiita.com` に当たる。**
 * 前は3通りの書き方(完全一致・`endsWith`・`/(^|\.)x$/`)が混ざっていたので、ここに寄せた。
 */
const isHost = (u: URL, domain: string): boolean => u.hostname === domain || u.hostname.endsWith(`.${domain}`)

/**
 * 取れなかったときの回り道。**実測で詰まった先だけ**を書く。
 * 一般化した規則ではなく、測って分かった件の覚え書き。根拠の数字は各分岐に置く。
 *
 * **回り道は書いた時点で正しくても腐る。** 実際、GitHub の2件は「本文が JS で差し込まれる」と
 * 書いたあとで、その診断自体がこちらの不具合(閉じない `<script>`)の見間違いだったと分かった。
 * 直したら本文は HTML に入っていた。行き先だけでなく**元の頁も**測り直すこと。
 */
/**
 * **取りに行かずに断る先。** robots が明文で断っていて、なおかつ取っても本文が無いことを
 * 実測した先だけを入れる。「取れないから」だけなら普通の `detour`(取ってから言う)で足りる —
 * ここに入れるのは、**確かめに行くこと自体をしない**という判断が要る先。
 */
export function refusedBeforeFetch(u: URL): boolean {
  return isHost(u, "x.com") || isHost(u, "twitter.com")
}

export function detour(url: string): string | undefined {
  const u = new URL(url)
  const seg = u.pathname.split("/").filter(Boolean)

  if (isHost(u, "github.com")) return githubDetour(u, seg)

  if (isHost(u, "zenn.dev")) {
    // **記事の頁(zenn.dev/x/articles/y)は素で読める**ので触らない(実測: 2,316字)。
    // 詰まるのは一覧のほう。トピック 79字 → /feed 8,376字(20件)、書き手 105字 → /feed 8,638字。
    if (seg[0] === "topics" && seg[1] && seg.length === 2)
      return `一覧は JS で組み立てるので HTML には無い。https://zenn.dev/topics/${seg[1]}/feed を開く`
    if (seg[0] && seg.length === 1)
      return `記事一覧は JS で組み立てる。https://zenn.dev/${seg[0]}/feed を開く`
    return undefined
  }
  if (isHost(u, "qiita.com")) {
    // 記事の頁は 11,999字で素に読める。タグ一覧は 1,679字だが記事名が1つも無く、タグの説明文だけ。
    // 書き手の頁(514字)も投稿数は出るが記事名が出ない。どちらも /feed に記事名と日付がある。
    if (seg[0] === "tags" && seg[1] && seg.length === 2)
      return `一覧は JS で組み立てるので HTML には無い。https://qiita.com/tags/${seg[1]}/feed を開く`
    if (seg[0] && seg.length === 1)
      return `記事一覧は JS で組み立てる。https://qiita.com/${seg[0]}/feed を開く`
    return undefined
  }

  if (isHost(u, "npmjs.com")) {
    // 実測: www.npmjs.com は 403(Cloudflare の待機頁)。レジストリは素で返る。
    const pkg = /^\/package\/(.+)$/.exec(u.pathname)?.[1]
    return `npmjs.com は 403 で弾かれる。https://registry.npmjs.org/${pkg ?? "<パッケージ名>"}/latest を開く`
  }
  if (isHost(u, "x.com") || isHost(u, "twitter.com")) {
    // **取りに行く前に断る**(`refusedBeforeFetch`)。理由は2つあって、どちらも実測。
    // 1) 取れない: `/status/` を直に引くと 307 のあと JS の殻が 40KB 返るだけで本文が無い。
    // 2) 断られている: `x.com/robots.txt` が `User-agent: * / Disallow: /` で、
    //    本文の取れる口も全部同じ — `cdn.syndication.twimg.com`(本文込みの JSON が 200 で返る)も
    //    `Disallow: /`、**X 公式の埋め込み API である `publish.x.com/oembed` も `Disallow: /oembed`**。
    // 投稿の中身は `search` の `x` から読む。あれは索引の要約で、X を叩いていない。
    const who = /^\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(u.pathname)?.[1]
    // **「取れない」で終わらせない。** 実測で、そう書いた回に外を見る役は
    // 「X の本文は取れなかった」と結論して、search に出ていた投稿本文を使わずに終えた。
    // 本文は search の `x` に出ている、と行き先まで言う。
    return (
      "robots で断られていて、開いても JS の殻しか返らない。**ただし投稿の本文は search で読める** — " +
      `\`where: ["x"]\` で引くと、要約に投稿の文字そのものが入る` +
      (who ? `。この人に絞るなら語に \`from:${who}\`` : "")
    )
  }
  if (isHost(u, "stackoverflow.com") && seg[0] === "questions" && seg[1] === "tagged") {
    // 実測: 質問一覧は 403、feed は 12,000字。質問1件の頁は 403 にならないので振り替えない。
    return `質問一覧の HTML は 403 で弾かれる。https://stackoverflow.com/feeds/tag/${seg[2]} を開く`
  }
  if (isHost(u, "reddit.com") && seg[0] === "r" && seg[1]) {
    // old.reddit.com と `.json` も試したが、どちらも 403 だった。.rss は 4,789字(25件)返る。
    return `HTML も .json も 403 で弾かれる。https://www.reddit.com/r/${seg[1]}/.rss を開く`
  }
  if (isHost(u, "youtube.com") && u.pathname === "/watch" && u.searchParams.get("v")) {
    // 実測: 視聴頁は 1.3〜1.4MB あり、`<title>` も `<meta>` も 68万バイト目にある。
    // 上限を 1.5MB にした今は題と説明が返る(426字)が、そのために 1.3MB 以上転送している。
    // 題と投稿者だけが要るなら oEmbed が 200 バイトで同じことを答える。
    const id = u.searchParams.get("v") ?? ""
    return `題と説明は 68万バイト目にあり、読むのに 1.3MB 要る。https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}&format=json を開く(題と投稿者が 200 バイトで返る)`
  }
  if (isHost(u, "laws.e-gov.go.jp") && seg[0] === "law" && seg[1]) {
    // 実測: 頁の HTML は 800B で本文は「e-Gov 法令検索」の 10字だけ。API は同じ法令番号で
    // XML 431KB(条文そのもの)を返す。行政の条文はここからしか取れない。
    return `条文は JS で差し込むので HTML には無い。https://laws.e-gov.go.jp/api/1/lawdata/${seg[1]} を開く(XML で条文が返る)`
  }
  if (isHost(u, "bsky.app") && seg[0] === "profile" && seg[1]) {
    // 実測: HTML は 19KB で本文 20字(「@handle on Bluesky」だけ)。公開 API は認証不要で投稿が返る。
    return `投稿は HTML に入っていない。https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${seg[1]}&limit=20 を開く`
  }
  if (isHost(u, "note.com") && seg[0] && seg.length === 1) {
    // 実測: note のトップも書き手の頁も本文 36字。書き手の頁には rss がある(トップには無い)。
    return `記事は JS で組み立てる。書き手の頁なら https://note.com/${seg[0]}/rss を開く`
  }
  if (isHost(u, "mastodon.social") && seg[0]?.startsWith("@") && seg.length === 1) {
    // 実測: HTML は 55KB で本文 50字。`.rss` を足すと投稿本文が 22KB 返る。
    return `投稿は JS で組み立てる。https://${u.hostname}/${seg[0]}.rss を開く`
  }
  if (isHost(u, "arxiv.org") && seg[0] === "pdf" && seg[1]) {
    // 実測: /pdf/1706.03762 は application/pdf 2,163KB で1字も読めない。
    // 同じ論文が /abs で 4,358字(要旨)、/html で 41,253字(本文)返る。
    const id = seg[1].replace(/\.pdf$/i, "")
    return `要旨なら https://arxiv.org/abs/${id}、本文なら https://arxiv.org/html/${id} を開く`
  }
  return undefined
}

/** GitHub は行き先が4種あるので分ける。呼ぶ前にホストの判定は済んでいる。 */
function githubDetour(u: URL, seg: readonly string[]): string | undefined {
  const [owner, repo, kind, ref] = seg
  if (seg[0] === "search") {
    // 実測: 検索結果の HTML は 164KB に対し 456字で、当たりが1件も入っていない。
    // リポジトリ検索の API は鍵無しで 200 が返るが、**コード検索の API は 401**(Requires authentication)。
    const q = u.searchParams.get("q") ?? ""
    return u.searchParams.get("type") === "code"
      ? "コード検索の結果は JS で差し込み、API は鍵が要る(401)。この頁からは取れないので別の探し方にする"
      : `結果は JS で差し込む。https://api.github.com/search/repositories?q=${encodeURIComponent(q)} を開く`
  }
  if (!owner || !repo) return undefined
  if (seg.length === 2) {
    // **「README は HTML に入っていない」と書いていたのは、こちらの不具合を見ての誤診だった。**
    // 閉じない `<script>` を末尾まで落とすようにした後で測り直すと、README は入っていた
    // (実測: Effect-TS/effect 1,131字・sindresorhus/got 6,045字・vercel/next.js 2,148字。
    // どれも raw の README と同じ中身)。入っていないのはファイル一覧のほうで、頁には
    // 「Folders and files / Name Last commit message」の枠だけが残り、ファイル名が1つも無い。
    return `README は入っている(この頁で読めている)。無いのはファイル一覧 — 要るなら https://api.github.com/repos/${owner}/${repo}/contents を開く`
  }
  if ((kind === "issues" || kind === "pull") && ref) {
    // これも誤診だった。実測、issue #4700: HTML に「Description / 投稿者 / opened on /
    // Summary」と本文が入っている(1,920字)。ただし星の数やフォークの数が本文より先に並ぶので、
    // 本文だけ要るなら API のほうが短い。
    const api = kind === "pull" ? "pulls" : "issues"
    return `題と本文は入っている。飾りを外して本文だけ読むなら https://api.github.com/repos/${owner}/${repo}/${api}/${ref} を開く`
  }
  if (kind === "tree" && ref) {
    // 実測: /tree/main/packages は 227KB の HTML に対し 499字で、中身は
    // 「There was an error while loading」。ファイル名は1つも入っていない。API は 5,451字で全部返す。
    const path = seg.slice(4).join("/")
    return `ファイル一覧は JS で差し込むので HTML には無い。https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref} を開く`
  }
  return undefined
}

/**
 * 同じホストを続けて叩かない。**巡回するなら足音を揃える**、が礼儀の最低限。
 * プロセス内だけの記憶なので、再起動でリセットされる(それで困る規模では回さない)。
 */
const HOST_INTERVAL_MS = 1_000
const lastHit = new Map<string, number>()
async function pace(host: string): Promise<void> {
  const prev = lastHit.get(host)
  const now = Date.now()
  const wait = prev === undefined ? 0 : prev + HOST_INTERVAL_MS - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastHit.set(host, Date.now())
}

/**
 * 一度開いた頁を、**全文のまま**覚えておく。速さのためではなく、同じものを取りに行かないため。
 *
 * 実測(「effect の最新安定版と公開日」を1問投げた1回の対話):
 * 外へ出た 10 回が**全部 `https://registry.npmjs.org/effect`** だった。この JSON は 12,000字に
 * 収まらないので、続きを読むたびに頭から取り直していた(`offset` 違いは別の取得だった)。
 * 全文を持てば、続きを読むのは切り出すだけで済む。
 *
 * 同じ `offset` をもう一度求められたときだけ「さっき開いた」と書いて返す。**続き読みは咎めない** —
 * 咎める相手は同じところを回っている呼び出しであって、順に読み進めている呼び出しではない。
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
/** どの (URL, offset) を既に渡したか。繰り返しの検出だけに使う。 */
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
  // 古い順に捨てる。Map は挿入順を保つので先頭が最古。
  while (docs.size > MEMO_MAX) {
    const oldest = docs.keys().next().value
    if (oldest === undefined) break
    docs.delete(oldest)
  }
}

/** この (URL, offset) を前にも渡したか。渡していれば何秒前かを返す。 */
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

/** 上限に達したら**そこで受信を止める**。arrayBuffer() だと数十MBの PDF を丸ごとメモリに載せる。 */
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
  // 最後の塊は上限をまたぐので、`size` は上限を少し超える。**繋いでから切り直すと 1.5MB を二度取る**
  // ので、器を上限ちょうどで作り、またいだ分は写す前に落とす。
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
 * 200 で返ってきたのに中身が薄い頁への断り書き。読めている頁には付けない(`undefined` を返す)。
 *
 * **黙って空を返すと、読み手は「そう書いてある」と受け取る。** 404 ではなく JS で組み立てる頁、
 * というのがたいていの正体。
 *
 * 判定を三段に分けた理由は、どれも実測で外したから:
 *
 * - **HTML の大きさだけで測ると、小さい頁の空振りを見逃す。** 実測: ジョルダンの乗換
 *   48字(JS の転送頁)、e-Gov 法令検索 10字、Bluesky 20字。どれも HTML が 50KB に届かないまま
 *   200 で空同然に返っていた。**返した字数そのもの**でも引っかける。
 * - **疑う相手は script のある HTML だけ。** JSON の API は 200 バイトで正しく答えるし、
 *   素の HTML が短いのは単に短い頁で、疑う理由が無い。
 * - **無いのと少ないのを言い分ける。** 一段の判定だと(86件)tenki.jp 1,719字・
 *   Yahoo 天気 1,954字・JR東 運行情報 1,146字・みんかぶ 1,559字に「別の出典を当たったほうが早い」が
 *   付いた。どれも目的の語(天気・運転・ドル)は本文に入っていた。
 *   **読めた頁に諦めろと言うのは、読めない頁を黙って返すのと同じくらい悪い。**
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
    // **回り道があるときは、回り道に言わせる。** 後半を固定文にすると
    // 「残りは JS で後から入る部分 — README は入っている」のように、自分で自分を打ち消した。
    return (
      `読めたのは ${chars}字(HTML ${kb}KB)。**これで足りているならそれでいい。** ` +
      (d ??
        "載っているはずのものが見当たらないなら、残りは JS で後から入る部分 — 別の出典を当たったほうが早い")
    )
  }
  // **切ったのか、そもそも入っていないのかも言い分ける。** 上限で切った頁の空振りは
  // 「JS で組み立てる」ではなく「読んだ範囲に本文が無かった」。診断を間違えると、
  // 読み手は取れるはずのものを諦める。
  const why =
    d ??
    (p.cut
      ? `頭 ${Math.round(MAX_BYTES / 1000)}KB を読んだ範囲に本文が無かった — 先に JS が並ぶ頁だと思う`
      : "JS で組み立てる頁だと思う — 別の出典を当たったほうが早い")
  return `本文がほとんど無い(HTML ${kb}KB に対し ${chars}字)。${why}`
}

/**
 * 全文から語を探して、当たりの前後だけを返す。
 *
 * 実測(「effect の最新安定版と公開日」1問):`registry.npmjs.org/effect` は 40万字あり、
 * 役が offset を 300,000 → 408,000 まで 12,000字刻みで**10ターン**進めた。1ターンごとにモデル呼び出しが
 * 要るので、この10回だけで約130秒。窓で舐めるのは大きな頁に対して手段が足りていない。
 */
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

/** 覚えた全文から、求められた範囲を切り出す。**ここでは外に出ない。** */
function slice(doc: CachedDoc, offset: number, agoSec: number | undefined): FetchedPage {
  const text = doc.full.slice(offset, offset + MAX_CHARS)
  const more = doc.full.length > offset + MAX_CHARS
  const notes: string[] = []
  if (doc.note) notes.push(doc.note)
  if (offset > 0 && text.length === 0)
    notes.push(`この頁は全 ${doc.full.length}字で、${offset}字目より先は無い。続きを探すなら別の出典へ。`)
  // **大きい頁は窓で舐めさせない。** ここで回数を数字で見せておくと、offset を刻む前に find へ行ける。
  if (more && doc.full.length > MAX_CHARS * 3)
    notes.push(
      `この頁は全 ${doc.full.length}字。窓(${MAX_CHARS}字)で頭から読むと ${Math.ceil(doc.full.length / MAX_CHARS)} 回かかる。` +
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

/** 覚えた全文の中を探す。**外には出ない**(頁は既に手元にある)。 */
function search(doc: CachedDoc, needle: string): FetchedPage {
  const hit = findIn(doc.full, needle)
  const notes = [doc.note].filter((s): s is string => Boolean(s))
  if (hit.count === 0)
    notes.push(
      `「${needle}」はこの頁(全 ${doc.full.length}字)に無い。綴りを変えるか、別の頁へ。**無いものを窓で探し直さない。**`,
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
  /** 頭から順に読むときの開始位置。 */
  readonly offset?: number
  /** 探す語。渡すと offset は見ず、当たった箇所の前後だけを返す。 */
  readonly find?: string
  /** 期限切れの振る舞いを時計を進めずに検査するための差し込み口。 */
  readonly nowMs?: number
}

/**
 * 1頁読む。**同じ URL は取り直さない**(memo の項を参照)。
 * 続きを読むのも中を探すのも、覚えた全文の上でやる — 2回目以降は外に出ない。
 */
export async function fetchPage(raw: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const { offset = 0, find, nowMs = Date.now() } = opts
  const key = find ? `${raw}\nfind:${find}` : `${raw}\n${offset}`
  const seen = recallDoc(raw, nowMs)
  const doc = seen ?? (await fetchFresh(raw))
  if (!seen) rememberDoc(raw, doc, nowMs)
  const ago = repeatAgoSec(key, nowMs)
  return find ? search(doc, find) : slice(doc, offset, seen ? ago : undefined)
}

/**
 * 実際に取りに行く。**転送は自分で追う** — follow に任せると、公開ホストから内側への転送を検査できない。
 * 切らずに全文を返す。どこを読むかを決めるのは呼び出し側(`slice`)。
 */
async function fetchFresh(raw: string): Promise<CachedDoc> {
  // **断られていると分かっている先へは、確かめに行かない。** `detour` は普通は取ってから
  // (4xx・読めない形式・本文が薄い)出すが、ここだけは出る前に出す。実測で
  // 端から端まで動かした回に x.com を3回叩いて 307 と JS の殻を受け取り、2秒を捨てていた。
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
      // 読めない形式にも回り道があることがある(arXiv の PDF には HTML 版がある)。
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
 * 本文を組み立てずに、**返ってきたバイト列をそのまま**返す。検索の口(Search.ts)が使う。
 *
 * `fetchPage` と分けたのは、あちらが「人に読ませる1頁」を作る道具だから — `toText` が
 * タグを剥がし、`slice` が 12,000字で切る。JSON を欄ごとに読む側にはどちらも邪魔になる。
 * 足音(`pace`)・上限(`readCapped`)・転送の検査は同じものを通す。**内側への転送を
 * 素通りさせないため、`redirect: "follow"` にはしない**(宛先が定数でも、転送先は相手が決める)。
 *
 * `timeoutMs` の既定は 1頁ぶんの 20 秒。**同時に何本も出す側は短くする** — 実測:
 * 6先へ同時に出したうち marginalia が返らず、20 秒の制限に当たるまで全体が待った。
 * 残り5先は 0.9 秒で揃っていたので、遅い1本のために 22 倍待ったことになる。
 *
 * **断られたときの本文も返す**(`fetchPage` は捨てる)。API は理由を本文に書く —
 * Qiita の 403 は `{"message":"Rate limit exceeded"}` で、これが読めないと
 * 「一時的に上限」と「弾かれた」の区別が付かない。
 */
export interface RawOptions {
  readonly accept: string
  readonly timeoutMs?: number
  /** 鍵などの追加見出し。**呼ぶ側が組み立てる** — ここには先ごとの事情を持ち込まない。 */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * この origin ちょうど1つだけ、内側判定と足音の間隔を免除する。
   * **自分で立てた口を呼ぶためだけの穴**(現状は SearXNG の `http://127.0.0.1:8888`)。
   *
   * 冒頭の防御はそのまま残す。モデルが書いた URL は `fetchPage` を通り、こちらには来ない
   * — 免除できるのは `Search.ts` の中に**先として書いてある** origin だけで、
   * 問い合わせ文から組み立てられる余地は無い。前方一致ではなく origin の完全一致で見る
   * (`http://127.0.0.1:8888` の免除が `http://127.0.0.1:8888.example.com` に伸びない)。
   * 転送された先には掛からない — 次の周では `url` の origin が変わるので、また弾かれる。
   */
  readonly allowOrigin?: string
}

export interface RawResult {
  readonly status: number
  readonly body: string
  /** 回数制限が解ける時刻(ms)。相手が見出しで教えてきたときだけ入る。 */
  readonly resetAtMs?: number
}

/**
 * 「いつまで待てばいいか」を見出しから拾う。名前は先ごとに違う —
 * Qiita は `rate-reset`(epoch 秒)、GitHub は `x-ratelimit-reset`、汎用は `retry-after`。
 */
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
    // epoch 秒。過去や桁違いの値は無視する(ms で寄越す先があるので上限も見る)。
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
    // 自分で立てた口かどうか。ここだけ内側判定と足音を飛ばす(RawOptions.allowOrigin を参照)。
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
      // 断り文は短い。長い HTML を返してくる先もあるので、読む側に渡すのは頭だけ。
      return { status: res.status, body: body.slice(0, 400), ...(at ? { resetAtMs: at } : {}) }
    }
    return { status: res.status, body }
  }
  throw new Error(`転送が多すぎる(${MAX_HOPS} 回で打ち切り)`)
}
