import assert from "node:assert/strict"
import { test } from "vitest"
import { decodeBody, isReadableType, renderFeed, toText } from "../../src/services/Web.ts"

test("HTML は本文だけにする(script の中身を資料として渡さない)", () => {
  const html = `<html><head><style>body{color:red}</style>
<script>var token="秘密"</script></head>
<body><h1>最新版</h1><p>3.22.1 が latest。</p><p>beta は 4.0.0-beta.107。</p></body></html>`
  const text = toText(html, "text/html; charset=utf-8")
  assert.ok(!text.includes("秘密"))
  assert.ok(!text.includes("color:red"))
  assert.ok(text.includes("3.22.1"))
  assert.ok(text.includes("4.0.0-beta.107"))

  const json = '{"version":"3.22.1"}'
  assert.equal(toText(json, "application/json"), json)
})

test("日本語のページは utf-8 とは限らない(Shift_JIS / EUC-JP を宣言どおり読む)", () => {
  const sjis = Buffer.concat([
    Buffer.from('<html><head><meta charset="Shift_JIS"></head><body>', "latin1"),
    Buffer.from([0x8f, 0x91, 0x82, 0xa2, 0x82, 0xc4, 0x82, 0xa0, 0x82, 0xe9]), // 書いてある
    Buffer.from("</body></html>", "latin1"),
  ])
  const decoded = decodeBody(new Uint8Array(sjis), "text/html")
  assert.ok(decoded.includes("書いてある"), decoded)
  assert.ok(!decoded.includes("�"))

  const eucBody = Buffer.from([0xc6, 0xfc, 0xcb, 0xdc]) // 日本
  assert.ok(decodeBody(new Uint8Array(eucBody), "text/html; charset=EUC-JP").includes("日本"))

  assert.equal(decodeBody(new Uint8Array(Buffer.from("abc")), "text/html; charset=x-nonsense"), "abc")
})

test("読めない形式は本文を渡さない", () => {
  assert.equal(isReadableType("application/pdf"), false)
  assert.equal(isReadableType("image/png"), false)
  assert.equal(isReadableType("application/octet-stream"), false)
  assert.equal(isReadableType("text/html; charset=utf-8"), true)
  assert.equal(isReadableType("application/json"), true)
  assert.equal(isReadableType("application/rss+xml"), true)
})

test("本文の周りを落とす。ただし一番長い塊を採る", () => {
  const html = `<html><body>
    <nav>ホーム 検索 ログイン 閉じる</nav>
    <article>読み込みに失敗しました</article>
    <article>${"本文がここにある。".repeat(40)}</article>
    <footer>会社概要 プライバシー</footer>
  </body></html>`
  const text = toText(html, "text/html")
  assert.ok(text.includes("本文がここにある。"))
  assert.ok(!text.includes("読み込みに失敗しました"), "短いほうの塊を採っていない")
  assert.ok(!text.includes("会社概要"), "footer が落ちている")
  assert.ok(!text.includes("ログイン"), "nav が落ちている")
})

test("main も article も無いページは class/id で本文を選ぶ", () => {
  const noise = "絞り込み ".repeat(200)
  const html = `<html><body>
    <div class="sidebar">${noise}</div>
    <div class="entrylist-main">${"本文がここにある。".repeat(60)}</div>
    <div class="ad">広告</div>
  </body></html>`
  const text = toText(html, "text/html")
  assert.ok(text.includes("本文がここにある。"))
  assert.ok(!text.includes("絞り込み"), "本文らしくない塊は入らない")
  assert.ok(!text.includes("広告"))

  const nested = `<html><body><div id="wrap">${"外 ".repeat(200)}</div>
    <div id="post-body"><div class="quote">引用</div>${"中身。".repeat(200)}<div>末尾の段</div></div>
  </body></html>`
  const t2 = toText(nested, "text/html")
  assert.ok(t2.includes("引用"), "内側の div の閉じで切っていない")
  assert.ok(t2.includes("末尾の段"), "本文の最後まで残っている")

  const unclosed = `<html><body><div class="content">${"閉じない本文。".repeat(200)}</body></html>`
  assert.ok(toText(unclosed, "text/html").includes("閉じない本文。"))

  // 一般語だけで選ぶ。サイト固有語を足すと、そのページでしか当たらない規則が増える。
  const specific = `<html><body><div class="hotentry">${"独自の語。".repeat(200)}</div></body></html>`
  assert.ok(toText(specific, "text/html").includes("独自の語。"), "選べなくてもページごと返せば本文は残る")
})

test("本文だけ切り出しても、どのページかは残す", () => {
  // 読み手はページを並べて読むので、題が無いとどのページの話か取り違える。
  const html = `<html><head><title>日本語 - Wikipedia</title></head><body>
    <div class="mw-content-ltr">${"本文である。".repeat(60)}</div></body></html>`
  const text = toText(html, "text/html")
  assert.match(text, /^日本語 - Wikipedia\n\n本文である。/)

  const dup = `<html><head><title>こころ</title></head><body><main>${"こころ を読む。".repeat(60)}</main></body></html>`
  const t2 = toText(dup, "text/html")
  assert.ok(t2.startsWith("こころ を読む。"), `頭に重ねていない: ${t2.slice(0, 30)}`)
})

test("切れた script を本文として渡さない", () => {
  const html = `<html><body><main>${"本文である。".repeat(60)}</main><script>var a = {"k":"${"x".repeat(500)}"`
  const text = toText(html, "text/html")
  assert.ok(text.includes("本文である。"))
  assert.ok(!text.includes("ytcfg") && !text.includes("xxxx"), "閉じない script の中身が残っていない")
  assert.ok(!toText(`<html><body><p>本文</p><style>.a{color:red;`, "text/html").includes("color"))
  assert.ok(!toText(`<html><body><p>本文</p><!-- 途中で切れた注釈`, "text/html").includes("注釈"))
})

test("本文が組み上がらないページでも、meta の題と説明は返す", () => {
  const html = `<html><head><meta property="og:title" content="動画ランキング「総合」">
    <meta name="description" content="ニコニコ動画の「総合」動画ランキングです。">
    <meta property="og:description" content="ニコニコ動画の「総合」動画ランキングです。">
    </head><body><div id="app"></div><script>render()</script></body></html>`
  const text = toText(html, "text/html")
  assert.match(text, /動画ランキング「総合」/)
  assert.match(text, /ニコニコ動画の「総合」/)
  assert.equal(text.match(/ニコニコ動画の「総合」/g)?.length, 1)

  // 説明は本文の要約なので、本文が取れているときに並べると同じ話が二重になる。
  const rich = `<html><head><meta name="description" content="これは要約です">
    </head><body><main>${"本文がある。".repeat(60)}</main></body></html>`
  assert.ok(!toText(rich, "text/html").includes("これは要約です"))
})

test("空白だけの行で枠を食わない(CR・全角空白・ゼロ幅も空白として畳む)", () => {
  // タグを剥がした跡の空白1文字の行と、CRLF の行末に残る `\r` は、空白行として扱われずに残る。
  const html = `<html><body><main>\r\n<div>見出し</div>\r\n<div> </div>\r\n<div>　</div>\r\n<div>​</div>\r\n<div></div>\r\n<div>本文${"あ".repeat(300)}</div>\r\n</main></body></html>`
  const text = toText(html, "text/html")
  assert.ok(!text.includes("\r"), "CR が残っていない")
  assert.doesNotMatch(text, /\n[ \t　]*\n[ \t　]*\n/, "空行が2つ以上続かない")
  assert.match(text, /^見出し\n\n本文/, "見出しと本文の間は空行1つ")

  // 全角空白は本文の中では潰さず1つの空白にする(単語を繋げてしまわない)。
  assert.equal(toText("<html><body><p>あ　い</p></body></html>", "text/html"), "あ い")
})

test("属性の中の `>` をタグの終わりと取り違えない", () => {
  const html = `<html><body><main>
    <span data-mw='{"designer":{"wt":"[[Microsoft]],&lt;br />[[Anders Hejlsberg]]"}}'></span>
    <p>${"ここが本文。".repeat(60)}</p>
  </main></body></html>`
  const text = toText(html, "text/html")
  assert.ok(text.includes("ここが本文。"), "本文は残る")
  assert.ok(!text.includes("Anders Hejlsberg"), "属性の中身が本文に漏れていない")
  assert.ok(!text.includes('"designer"'), "生の JSON が漏れていない")

  assert.ok(!toText(`<html><body><i title="a>b">x</i></body></html>`, "text/html").includes('b">'))
  assert.ok(
    toText(`<html><body><p class="foo>本文がある</p></body></html>`, "text/html").includes("本文がある"),
  )
})

test("実体参照は名前でも数値でも戻す", () => {
  const t = (h: string): string => toText(`<html><body><p>${h}</p></body></html>`, "text/html")
  assert.equal(t("Docker&#x27;s Sandboxes"), "Docker's Sandboxes")
  assert.equal(t("a&#x2F;b"), "a/b")
  assert.equal(t("&yen;128,000"), "¥128,000")
  assert.equal(t("&#12300;引用&#12301;"), "「引用」")
  assert.equal(t("A &amp; B"), "A & B")
  assert.equal(t("3 &times; 4 &ne; 11"), "3 × 4 ≠ 11")

  // 知らない実体は消さない。消すと前後の語が繋がって別の語になる。
  assert.equal(t("&zwnj;&notareal;x"), "&zwnj;&notareal;x")
  // 範囲外・サロゲート単独・制御文字は戻さない(String.fromCodePoint が例外を出すか壊れた1字になる)。
  assert.equal(t("&#1114112;"), "&#1114112;")
  assert.equal(t("&#xD800;"), "&#xD800;")
  assert.equal(t("&#0;"), "&#0;")
})

test("新着の一覧は1件ずつに割る(見出しと日付を結び直す)", () => {
  const rss = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
<title>NHKニュース</title>
<lastBuildDate>Sat, 08 Aug 2026 23:17:48 +0900</lastBuildDate>
<item>
  <title>台風13号 影響は長時間続く</title>
  <link>http://example.jp/a</link>
  <pubDate>Sat, 08 Aug 2026 21:54:30 +0900</pubDate>
  <description>沖縄・奄美では風や雨の影響が長時間続いている。</description>
</item>
<item><title>2件目</title><pubDate>Sat, 08 Aug 2026 23:17:32 +0900</pubDate></item>
</channel></rss>`
  const text = toText(rss, "application/xml")
  assert.match(text, /^NHKニュース/)
  assert.match(text, /更新: Sat, 08 Aug 2026 23:17:48/)
  assert.match(text, /2 件/)
  assert.match(text, /- 台風13号 影響は長時間続く\n {2}Sat, 08 Aug 2026 21:54:30/)
  assert.match(text, /http:\/\/example\.jp\/a/)
  assert.doesNotMatch(text.split("\n")[0] ?? "", /台風/)

  const atom = `<feed><title>Release notes</title><updated>2026-08-10T04:48:20Z</updated>
<entry><title>effect@4.0.0-beta.107</title><link href="https://example.com/tag/107"/><updated>2026-08-10T04:51:39Z</updated></entry></feed>`
  const at = toText(atom, "application/atom+xml")
  assert.match(at, /- effect@4\.0\.0-beta\.107/)
  assert.match(at, /https:\/\/example\.com\/tag\/107/)

  assert.equal(renderFeed("<html><body><p>ふつうのページ</p></body></html>"), undefined)
})

test("新着一覧から書き手を落とさない", () => {
  const rss = `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Zennの「Rust」のフィード</title>
<item><title><![CDATA[Rustのマクロの作り方]]></title><dc:creator><![CDATA[fits]]></dc:creator>
<link>https://zenn.dev/fits/articles/f765a31a2179d3</link><pubDate>Mon, 10 Aug 2026 04:05:03 GMT</pubDate></item>
</channel></rss>`
  const text = toText(rss, "application/rss+xml")
  assert.match(text, /書き手: fits/)
  assert.match(text, /- Rustのマクロの作り方\n {2}書き手: fits\n/)

  const atom = `<feed><title>ある feed</title>
<entry><title>ある記事</title><author><name>Gargron</name></author><updated>2026-08-10T04:51:39Z</updated></entry></feed>`
  assert.match(toText(atom, "application/atom+xml"), /書き手: Gargron/)

  const bare = `<rss><channel><title>t</title><item><title>題だけ</title></item></channel></rss>`
  assert.doesNotMatch(toText(bare, "application/rss+xml"), /書き手/)
})
