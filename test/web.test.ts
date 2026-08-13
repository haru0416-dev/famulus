/**
 * 外を読む道の検査。**通す条件ではなく、止める条件を並べる。**
 *
 * ここで見ているのは「一次資料が読めること」ではない(それは実際に外へ出て確かめた)。
 * 検査したいのは、モデルが書いた URL がこのホストの内側へ向いたときに止まるかどうか。
 * 名前解決を伴う判定は外に依存するので、ここでは**解決を要らない形の判定だけ**を対象にする。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  decodeBody,
  deniedByName,
  denyReason,
  detour,
  fetchPage,
  findIn,
  isPrivateAddress,
  isReadableType,
  renderFeed,
  toText,
} from "../src/services/Web.ts"

// 同じホストへの間隔は既定 1 秒。**ここは fetch を差し替えてあるので誰も叩いていない** —
// 待つぶんがそのままゲートの所要になるので 0 にする(src/services/Web.ts の hostIntervalMs)。
process.env.OPEN_ZERO_HOST_INTERVAL_MS = "0"
test("内側のアドレスは数値で弾く(前方一致では取り違える)", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // クラウドのメタデータ端点
    "100.72.193.4", // この VPS の Tailscale アドレス
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, `内側のはず: ${ip}`)
  }

  // 文字列の前方一致だと巻き込む外のアドレス。100.1.1.1 は CGNAT ではないし 172.32 は私設ではない。
  for (const ip of ["8.8.8.8", "100.1.1.1", "172.32.0.1", "193.4.100.72", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, `外のはず: ${ip}`)
  }
})

test("内側を指す名前は解決する前に落とす", () => {
  assert.ok(deniedByName("localhost"))
  assert.ok(deniedByName("db.localhost"))
  assert.ok(deniedByName("nas.local"))
  assert.ok(deniedByName("gitlab.internal"))
  assert.ok(deniedByName("127.0.0.1"))
  assert.equal(deniedByName("example.com"), undefined)
})

test("http と非 http は取らない", async () => {
  // https のみ。file: や data: でローカルを読ませない。
  assert.match((await denyReason("http://example.com")) ?? "", /https 以外/)
  assert.match((await denyReason("file:///etc/passwd")) ?? "", /https 以外/)
  assert.match((await denyReason("data:text/html,x")) ?? "", /https 以外/)
  assert.ok(await denyReason("これは URL ではない"))
  // 内側の判定は名前解決の前に済むので、この確認はネットワークに触らない。
  assert.match((await denyReason("https://127.0.0.1:8080/admin")) ?? "", /内側/)
  assert.match((await denyReason("https://localhost/")) ?? "", /localhost/)
})

test("HTML は本文だけにする(script の中身を資料として渡さない)", () => {
  const html = `<html><head><style>body{color:red}</style>
<script>var token="秘密"</script></head>
<body><h1>最新版</h1><p>3.22.1 が latest。</p><p>beta は 4.0.0-beta.107。</p></body></html>`
  const text = toText(html, "text/html; charset=utf-8")
  assert.ok(!text.includes("秘密"))
  assert.ok(!text.includes("color:red"))
  assert.ok(text.includes("3.22.1"))
  assert.ok(text.includes("4.0.0-beta.107"))

  // JSON は触らない。レジストリの応答をそのまま読ませるため。
  const json = '{"version":"3.22.1"}'
  assert.equal(toText(json, "application/json"), json)
})

test("日本語のページは utf-8 とは限らない(Shift_JIS / EUC-JP を宣言どおり読む)", () => {
  // 実測: 青空文庫(Shift_JIS)を utf-8 で読むと 12,000字中 7,734 字が置換文字になった。
  const sjis = Buffer.concat([
    Buffer.from('<html><head><meta charset="Shift_JIS"></head><body>', "latin1"),
    Buffer.from([0x8f, 0x91, 0x82, 0xa2, 0x82, 0xc4, 0x82, 0xa0, 0x82, 0xe9]), // 書いてある
    Buffer.from("</body></html>", "latin1"),
  ])
  const decoded = decodeBody(new Uint8Array(sjis), "text/html")
  assert.ok(decoded.includes("書いてある"), decoded)
  assert.ok(!decoded.includes("�"))

  // ヘッダの charset が meta より優先される。
  const eucBody = Buffer.from([0xc6, 0xfc, 0xcb, 0xdc]) // 日本
  assert.ok(decodeBody(new Uint8Array(eucBody), "text/html; charset=EUC-JP").includes("日本"))

  // 知らない charset 名で落ちない(utf-8 に倒す)。
  assert.equal(decodeBody(new Uint8Array(Buffer.from("abc")), "text/html; charset=x-nonsense"), "abc")
})

test("読めない形式は本文を渡さない", () => {
  // 実測: arxiv の PDF をそのまま流したら 12,000字中 4,779 字が置換文字だった。
  assert.equal(isReadableType("application/pdf"), false)
  assert.equal(isReadableType("image/png"), false)
  assert.equal(isReadableType("application/octet-stream"), false)
  assert.equal(isReadableType("text/html; charset=utf-8"), true)
  assert.equal(isReadableType("application/json"), true)
  assert.equal(isReadableType("application/rss+xml"), true)
})

test("本文の周りを落とす。ただし一番長い塊を採る", () => {
  // 実測: 最初の article を採ると GitHub は 7,028字 → 1,895字、Qiita は 8,234字 → 86字まで減った。
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
  // 実測、実サイト16件: はてブ・価格.com はどちらも `<main>`/`<article>` を1つも
  // 持たず、`<ul>` が 260 / 123 個あった。ページごと使うと窓の頭を絞り込みメニューが食う。
  // はてブ 933 → 55字目 / 価格.com 3,239 → 217字目 / 食べログ 231 → 3字目。
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

  // 入れ子の div で閉じを取り違えない。内側で閉じると後半が丸ごと落ちる。
  const nested = `<html><body><div id="wrap">${"外 ".repeat(200)}</div>
    <div id="post-body"><div class="quote">引用</div>${"中身。".repeat(200)}<div>末尾の段</div></div>
  </body></html>`
  const t2 = toText(nested, "text/html")
  assert.ok(t2.includes("引用"), "内側の div の閉じで切っていない")
  assert.ok(t2.includes("末尾の段"), "本文の最後まで残っている")

  // 閉じないまま終わるページがある。そこまでを本文として扱い、落とさない。
  const unclosed = `<html><body><div class="content">${"閉じない本文。".repeat(200)}</body></html>`
  assert.ok(toText(unclosed, "text/html").includes("閉じない本文。"))

  // **一般語だけで選ぶ。** サイト固有語を足すと、そのページでしか当たらない規則が増える。
  const specific = `<html><body><div class="hotentry">${"独自の語。".repeat(200)}</div></body></html>`
  assert.ok(toText(specific, "text/html").includes("独自の語。"), "選べなくてもページごと返せば本文は残る")
})

test("本文だけ切り出しても、どのページかは残す", () => {
  // 実測: 塊を選ぶようにしたら Wikipedia 日本語版から「日本語 - Wikipedia」が、
  // はてブから「はてなブックマーク - 人気エントリー - テクノロジー」が先頭から消えた。
  // 読み手はページを並べて読むので、見出しが無いとどれの話か取り違える。
  const html = `<html><head><title>日本語 - Wikipedia</title></head><body>
    <div class="mw-content-ltr">${"本文である。".repeat(60)}</div></body></html>`
  const text = toText(html, "text/html")
  assert.match(text, /^日本語 - Wikipedia\n\n本文である。/)

  // 既に頭に出ているなら足さない(同じ見出しが2度並ぶのを避ける)。
  const dup = `<html><head><title>こころ</title></head><body><main>${"こころ を読む。".repeat(60)}</main></body></html>`
  const t2 = toText(dup, "text/html")
  assert.ok(t2.startsWith("こころ を読む。"), `頭に重ねていない: ${t2.slice(0, 30)}`)
})

test("詰まる先には回り道を返す(実測した先だけ)", () => {
  assert.match(detour("https://www.npmjs.com/package/effect") ?? "", /registry\.npmjs\.org\/effect\/latest/)
  // X は「別を当たれ」で終わらせない。**投稿の中身は search の `x` から読める**ので、そこへ送る。
  const x = detour("https://x.com/youyuxi/status/1904855853037215958") ?? ""
  assert.match(x, /robots/, "断られている先だと言っていない")
  assert.match(x, /where: \["x"\]/, "読める道を示していない")
  assert.match(x, /from:youyuxi/, "URL に入っている書き手を活かしていない")
  // 投稿以外の URL では書き手を名乗らない(組めないものを勧めない)。
  const top = detour("https://x.com/someone") ?? ""
  assert.match(top, /where: \["x"\]/)
  assert.ok(!top.includes("from:"), `絞りを組めないのに勧めている: ${top}`)

  // 2026-08-10 の巡回で足した4件。どれも元の URL は 403 か本文ほぼ空で、feed に振ると返った。
  assert.match(
    detour("https://stackoverflow.com/questions/tagged/typescript") ?? "",
    /stackoverflow\.com\/feeds\/tag\/typescript/,
  )
  assert.match(detour("https://www.reddit.com/r/typescript/") ?? "", /reddit\.com\/r\/typescript\/\.rss/)
  assert.match(detour("https://zenn.dev/topics/typescript") ?? "", /zenn\.dev\/topics\/typescript\/feed/)
  assert.match(detour("https://qiita.com/tags/typescript") ?? "", /qiita\.com\/tags\/typescript\/feed/)

  // PDF は本文が1字も取れない(実測 2,163KB)。同じ論文が /abs に要旨 4,358字、/html に本文 41,253字。
  const pdf = detour("https://arxiv.org/pdf/1706.03762") ?? ""
  assert.match(pdf, /arxiv\.org\/abs\/1706\.03762/)
  assert.match(pdf, /arxiv\.org\/html\/1706\.03762/)
  // 拡張子付きでも同じ id に落ちる。
  assert.match(detour("https://arxiv.org/pdf/2401.00368v2.pdf") ?? "", /abs\/2401\.00368v2/)

  // 2026-08-10 の広い巡回(75件)で足した6件。どれも 200 で返るのに本文が 10〜50字しか無く、
  // 代わりの出口を実測で確かめた先だけ載せる。
  // 法令の条文: ページの HTML は 800B・本文 10字。API は同じ番号で XML 431KB(条文そのもの)。
  assert.match(
    detour("https://laws.e-gov.go.jp/law/322AC0000000049") ?? "",
    /laws\.e-gov\.go\.jp\/api\/1\/lawdata\/322AC0000000049/,
  )
  assert.match(
    detour("https://github.com/Effect-TS/effect/issues/1") ?? "",
    /api\.github\.com\/repos\/Effect-TS\/effect\/issues\/1/,
  )
  assert.match(detour("https://github.com/Effect-TS/effect/pull/42") ?? "", /api\.github\.com\/.+\/pulls\/42/)
  // Bluesky は本文 20字(「@handle on Bluesky」だけ)。公開 API は認証不要。
  assert.match(
    detour("https://bsky.app/profile/bsky.app") ?? "",
    /public\.api\.bsky\.app\/xrpc\/.+actor=bsky\.app/,
  )
  assert.match(detour("https://mastodon.social/@Gargron") ?? "", /mastodon\.social\/@Gargron\.rss/)
  assert.match(detour("https://note.com/someone") ?? "", /note\.com\/someone\/rss/)
  // YouTube は題も説明も 68万バイト目にあり、読むだけで 1.3MB 転送する。oEmbed なら 200 バイト。
  assert.match(
    detour("https://www.youtube.com/watch?v=dQw4w9WgXcQ") ?? "",
    /youtube\.com\/oembed\?url=.+dQw4w9WgXcQ/,
  )

  // **回り道の中身が古びていないか。** 前は「README は HTML に入っていない」と案内していたが、
  // それは閉じない `<script>` を落とし切れていなかった頃の誤診だった。測り直すと README は入っている
  // (Effect-TS/effect 1,131字・sindresorhus/got 6,045字・vercel/next.js 2,148字)。
  // 入っていないのはファイル一覧のほうなので、案内先もそちらに変える。
  const repo = detour("https://github.com/Effect-TS/effect") ?? ""
  assert.doesNotMatch(repo, /raw\.githubusercontent\.com/, "入っているものを「無い」と言わない")
  assert.match(repo, /README は入っている/)
  assert.match(repo, /api\.github\.com\/repos\/Effect-TS\/effect\/contents/)
  assert.match(detour("https://github.com/Effect-TS/effect/issues/1") ?? "", /題と本文は入っている/)

  // 2026-08-10、普段遣いは Zenn と GitHub だと聞いて測り直した4件。
  // ファイル一覧: /tree は 227KB に対し 499字(「There was an error while loading」)。API は 5,451字。
  assert.match(
    detour("https://github.com/Effect-TS/effect/tree/main/packages") ?? "",
    /api\.github\.com\/repos\/Effect-TS\/effect\/contents\/packages\?ref=main/,
  )
  // コード検索は API が 401(Requires authentication)。**行けない先は行けないと書く。**
  const code = detour("https://github.com/search?q=effect&type=code") ?? ""
  assert.match(code, /401|鍵が要る/)
  assert.doesNotMatch(code, /https:\/\/api\.github\.com\/search\/code/, "401 が返る先へ案内しない")
  assert.match(
    detour("https://github.com/search?q=effect") ?? "",
    /api\.github\.com\/search\/repositories\?q=effect/,
  )
  // 書き手のページ: zenn.dev/mizchi は 105字、/feed は 8,638字で 20 件。
  assert.match(detour("https://zenn.dev/mizchi") ?? "", /zenn\.dev\/mizchi\/feed/)
  assert.match(detour("https://qiita.com/mizchi") ?? "", /qiita\.com\/mizchi\/feed/)

  // 知らない先に憶測の回り道を書かない。
  assert.equal(detour("https://example.com/a"), undefined)
  // Issue 一覧(番号無し)は別物なので出さない。
  assert.equal(detour("https://github.com/Effect-TS/effect/issues"), undefined)
  assert.equal(detour("https://www.youtube.com/results?search_query=a"), undefined)
  // 記事そのものは JS ページではない。一覧だけを振り替える。
  assert.equal(detour("https://zenn.dev/someone/articles/abc123"), undefined)
  assert.equal(detour("https://qiita.com/someone/items/abc123"), undefined)
  // 質問1件は 403 ではない(一覧だけが弾かれる)。
  assert.equal(detour("https://stackoverflow.com/questions/12345/how-to"), undefined)
})

test("そっくりなホスト名を本物と取り違えない", () => {
  // ホストの判定を `endsWith("qiita.com")` で書いていたので、`evilqiita.com` も当たっていた。
  // 当たると何が起きるか: 別人のページを読んでいるのに「qiita.com/x/feed を開け」と案内し、
  // 読み手はその先を本物の記事一覧として読む。ドットまで見て判定する。
  for (const host of ["evilqiita.com", "notgithub.com", "myreddit.com", "fake-note.com", "xarxiv.org"]) {
    assert.equal(detour(`https://${host}/someone`), undefined, host)
    assert.equal(detour(`https://${host}/o/r`), undefined, host)
  }
  // 部分文字列ではなく段で見るので、正しい下位ドメインは今までどおり当たる。
  assert.match(detour("https://old.reddit.com/r/typescript/") ?? "", /reddit\.com\/r\/typescript\/\.rss/)
  assert.match(
    detour("https://ja.stackoverflow.com/questions/tagged/typescript") ?? "",
    /feeds\/tag\/typescript/,
  )
})

test("切れた script を本文として渡さない", () => {
  // 実測、YouTube の視聴ページ: 400KB で切ると `<script>` の開き13に対し閉じ12。
  // 閉じない1つの中身がそのまま本文になり、返った 12,000字はすべて `ytcfg.set({...` の JS だった。
  // 上限は 1.5MB にしたので**このページでは**起きなくなったが、それを超えるページでは今も起きる。
  const html = `<html><body><main>${"本文である。".repeat(60)}</main><script>var a = {"k":"${"x".repeat(500)}"`
  const text = toText(html, "text/html")
  assert.ok(text.includes("本文である。"))
  assert.ok(!text.includes("ytcfg") && !text.includes("xxxx"), "閉じない script の中身が残っていない")
  // style とコメントも同じ。閉じないまま切れる。
  assert.ok(!toText(`<html><body><p>本文</p><style>.a{color:red;`, "text/html").includes("color"))
  assert.ok(!toText(`<html><body><p>本文</p><!-- 途中で切れた注釈`, "text/html").includes("注釈"))
})

test("本文が組み上がらないページでも、meta の題と説明は返す", () => {
  // 実測: YouTube・ニコニコ・note・Bluesky・Mastodon は本文が 0〜50字しか無い。
  // og: と description を拾うと 67〜181字返る(ニコニコ 20 → 67 / note 36 → 181 / Bluesky 20 → 153)。
  const html = `<html><head><meta property="og:title" content="動画ランキング「総合」">
    <meta name="description" content="ニコニコ動画の「総合」動画ランキングです。">
    <meta property="og:description" content="ニコニコ動画の「総合」動画ランキングです。">
    </head><body><div id="app"></div><script>render()</script></body></html>`
  const text = toText(html, "text/html")
  assert.match(text, /動画ランキング「総合」/)
  assert.match(text, /ニコニコ動画の「総合」/)
  // 同じ文が og: と description の両方に入っているページが多い。二重に並べない。
  assert.equal(text.match(/ニコニコ動画の「総合」/g)?.length, 1)

  // **本文が取れているページでは触らない。** 拾った説明は本文の要約なので、並べると同じ話が二重になる。
  const rich = `<html><head><meta name="description" content="これは要約です">
    </head><body><main>${"本文がある。".repeat(60)}</main></body></html>`
  assert.ok(!toText(rich, "text/html").includes("これは要約です"))
})

test("空白だけの行で枠を食わない(CR・全角空白・ゼロ幅も空白として畳む)", () => {
  // 実測、実サイト8件: 返した本文に占める空白行の割合は
  // GitHub 42% / PyPI 28% / はてブ 27% / 価格.com 21%。原因は2つあった。
  //  (1) タグを剥がした跡が「空白1つの行」として残り、`\n{3,}` の畳み込みに当たらない
  //  (2)CRLF のページは行末に `\r` が残るので、そもそも空白行として見えない(価格.com は先頭27行が "\r")
  const html = `<html><body><main>\r\n<div>見出し</div>\r\n<div> </div>\r\n<div>　</div>\r\n<div>​</div>\r\n<div></div>\r\n<div>本文${"あ".repeat(300)}</div>\r\n</main></body></html>`
  const text = toText(html, "text/html")
  assert.ok(!text.includes("\r"), "CR が残っていない")
  assert.doesNotMatch(text, /\n[ \t　]*\n[ \t　]*\n/, "空行が2つ以上続かない")
  assert.match(text, /^見出し\n\n本文/, "見出しと本文の間は空行1つ")

  // 全角空白は本文の中では潰さず1つの空白にする(単語を繋げてしまわない)。
  assert.equal(toText("<html><body><p>あ　い</p></body></html>", "text/html"), "あ い")
})

test("属性の中の `>` をタグの終わりと取り違えない", () => {
  // 実測、en.wikipedia の TypeScript: infobox が wikitext を丸ごと属性に持っていて、
  // その中の `&lt;br />` の `>` でタグが閉じたと見なされた。結果、記事本文のつもりで
  // `[[Anders Hejlsberg]],<br />Luke Hoban"},"developer":{"wt":"Microsoft"}` を渡していた。
  // 直すと 35,455字 → 32,903字(-2,552)。同じ形が PyPI にもあった(-368字)。
  // 他の8サイト(MDN・はてブ・HN・食べログ・NHK・Yahoo・青空文庫・e-Gov)は1字も変わらない。
  const html = `<html><body><main>
    <span data-mw='{"designer":{"wt":"[[Microsoft]],&lt;br />[[Anders Hejlsberg]]"}}'></span>
    <p>${"ここが本文。".repeat(60)}</p>
  </main></body></html>`
  const text = toText(html, "text/html")
  assert.ok(text.includes("ここが本文。"), "本文は残る")
  assert.ok(!text.includes("Anders Hejlsberg"), "属性の中身が本文に漏れていない")
  assert.ok(!text.includes('"designer"'), "生の JSON が漏れていない")

  // 二重引用符でも同じ。
  assert.ok(!toText(`<html><body><i title="a>b">x</i></body></html>`, "text/html").includes('b">'))
  // 引用符が閉じていない壊れたタグでも、本文を巻き込んで消さない。
  assert.ok(
    toText(`<html><body><p class="foo>本文がある</p></body></html>`, "text/html").includes("本文がある"),
  )
})

test("実体参照は名前でも数値でも戻す", () => {
  // 実測、実サイト14件の窓12,000字に生で残っていたもの:
  // Hacker News の見出しに `&#x27;` `&#x2F;` が5個、価格.com の値段欄に `&yen;` が3個。
  // 直したあと同じ14件を測り直すと0個。
  const t = (h: string): string => toText(`<html><body><p>${h}</p></body></html>`, "text/html")
  assert.equal(t("Docker&#x27;s Sandboxes"), "Docker's Sandboxes")
  assert.equal(t("a&#x2F;b"), "a/b")
  assert.equal(t("&yen;128,000"), "¥128,000")
  assert.equal(t("&#12300;引用&#12301;"), "「引用」")
  assert.equal(t("A &amp; B"), "A & B")
  assert.equal(t("3 &times; 4 &ne; 11"), "3 × 4 ≠ 11")

  // 戻せないものは壊さずそのまま置く。**知らない実体を勝手に消さない**(語が繋がって別の語になる)。
  assert.equal(t("&zwnj;&notareal;x"), "&zwnj;&notareal;x")
  // 範囲外・サロゲート単独・制御文字は戻さない(String.fromCodePoint が投げるか壊れた1字になる)。
  assert.equal(t("&#1114112;"), "&#1114112;")
  assert.equal(t("&#xD800;"), "&#xD800;")
  assert.equal(t("&#0;"), "&#0;")
})

test("新着の一覧は1件ずつに割る(見出しと日付を結び直す)", () => {
  // 実測: NHK の cat0.xml を素通しでタグ剥がしすると 2,301字の帯になり、
  // どの pubDate がどの記事のものか分からなくなった。構造を残すと 1,679字。
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
  // 見出しの直後にその記事の日付が来る = 帯の中で日付が迷子にならない。
  assert.match(text, /- 台風13号 影響は長時間続く\n {2}Sat, 08 Aug 2026 21:54:30/)
  assert.match(text, /http:\/\/example\.jp\/a/)

  // channel の title を item の title で上書きしない(先頭で切って読む)。
  assert.doesNotMatch(text.split("\n")[0] ?? "", /台風/)

  // Atom も同じ形で読む。link は属性側にある。
  const atom = `<feed><title>Release notes</title><updated>2026-08-10T04:48:20Z</updated>
<entry><title>effect@4.0.0-beta.107</title><link href="https://example.com/tag/107"/><updated>2026-08-10T04:51:39Z</updated></entry></feed>`
  const at = toText(atom, "application/atom+xml")
  assert.match(at, /- effect@4\.0\.0-beta\.107/)
  assert.match(at, /https:\/\/example\.com\/tag\/107/)

  // feed でない XHTML を新着一覧として組み直さない。
  assert.equal(renderFeed("<html><body><p>ふつうのページ</p></body></html>"), undefined)
})

test("新着一覧から書き手を落とさない", () => {
  // 実測: Zenn のトピック feed は1件ごとに dc:creator を持っているのに拾っていなかった。
  // 「記事と書き手を2本挙げて」に対し、役は書き手が無いものと見て記事ページを2つ余計に開き(+60秒)、
  // それでも分からず「取れなかった」と返した。答えは渡したバイト列の中にあった。
  const rss = `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Zennの「Rust」のフィード</title>
<item><title><![CDATA[Rustのマクロの作り方]]></title><dc:creator><![CDATA[fits]]></dc:creator>
<link>https://zenn.dev/fits/articles/f765a31a2179d3</link><pubDate>Mon, 10 Aug 2026 04:05:03 GMT</pubDate></item>
</channel></rss>`
  const text = toText(rss, "application/rss+xml")
  assert.match(text, /書き手: fits/)
  // 見出しと同じ塊の中に出る(どの記事の書き手か取り違えない)。
  assert.match(text, /- Rustのマクロの作り方\n {2}書き手: fits\n/)

  // Atom は `<author><name>` の入れ子。タグを剥がして同じ形で拾う。
  const atom = `<feed><title>ある feed</title>
<entry><title>ある記事</title><author><name>Gargron</name></author><updated>2026-08-10T04:51:39Z</updated></entry></feed>`
  assert.match(toText(atom, "application/atom+xml"), /書き手: Gargron/)

  // 書き手を持たない feed で空の行を足さない。
  const bare = `<rss><channel><title>t</title><item><title>題だけ</title></item></channel></rss>`
  assert.doesNotMatch(toText(bare, "application/rss+xml"), /書き手/)
})

test("同じ URL を続けて開いたら取りに行かず「さっき開いた」と返す", async () => {
  // 実測: 1回の対話で外へ出た 18 回のうち 10 回が同じ registry のページだった。
  const originalFetch = globalThis.fetch
  let hits = 0
  globalThis.fetch = (async () => {
    hits++
    return new Response("<html><body>本文</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }) as unknown as typeof fetch
  try {
    const url = `https://example.com/memo-${Math.random().toString(36).slice(2)}`
    const t0 = 1_000_000
    const a = await fetchPage(url, { nowMs: t0 })
    const b = await fetchPage(url, { nowMs: t0 + 3_000 })
    assert.equal(hits, 1, "2回目は取りに行かない")
    assert.equal(b.text, a.text)
    assert.match(b.note ?? "", /3 秒前にも開いた/)
    assert.equal(a.note, undefined, "1回目には付けない")

    // 期限が切れたら取り直す。**古いページを永遠に返し続けない。**
    const c = await fetchPage(url, { nowMs: t0 + 6 * 60_000 })
    assert.equal(hits, 2)
    assert.equal(c.note, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("続きを読むのに取り直さない(全文を覚えて切り出す)", async () => {
  // 実測: 「effect の最新安定版と公開日」1問で外へ出た 10 回が全部
  // https://registry.npmjs.org/effect だった。12,000字に収まらない JSON を offset 違いで
  // 読み進めるたび、頭から取り直していた。
  const originalFetch = globalThis.fetch
  let hits = 0
  const body = "あ".repeat(30_000)
  globalThis.fetch = (async () => {
    hits++
    return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })
  }) as unknown as typeof fetch
  try {
    const url = `https://example.com/long-${Math.random().toString(36).slice(2)}`
    const t0 = 2_000_000
    const p1 = await fetchPage(url, { nowMs: t0 })
    assert.equal(p1.text.length, 12_000)
    assert.equal(p1.nextOffset, 12_000)
    assert.equal(p1.truncated, true)

    const p2 = await fetchPage(url, { offset: p1.nextOffset ?? 0, nowMs: t0 + 1_000 })
    assert.equal(hits, 1, "続きは取りに行かない")
    assert.equal(p2.text, body.slice(12_000, 24_000))
    assert.doesNotMatch(p2.note ?? "", /さっき|秒前/, "順に読み進めているだけなら咎めない")

    const p3 = await fetchPage(url, { offset: p2.nextOffset ?? 0, nowMs: t0 + 2_000 })
    assert.equal(hits, 1)
    assert.equal(p3.text, body.slice(24_000))
    assert.equal(p3.nextOffset, undefined)
    assert.equal(p3.truncated, false)

    // 末尾より先を求められたら、黙って空を返さず「先は無い」と言う。
    const past = await fetchPage(url, { offset: 60_000, nowMs: t0 + 3_000 })
    assert.equal(past.text, "")
    assert.match(past.note ?? "", /先は無い/)

    // 同じ範囲をもう一度求めたときだけ「さっき開いた」。
    const again = await fetchPage(url, { offset: 12_000, nowMs: t0 + 4_000 })
    assert.equal(hits, 1)
    assert.match(again.note ?? "", /3 秒前にも開いた/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("大きいページは窓で少しずつ読まず、語で当てる", () => {
  // 実測: 40万字の registry JSON を offset で 300,000→408,000 まで 12,000字刻みで
  // 10 ターン進めて空振りした(1ターンごとにモデル呼び出しが要るので約130秒)。
  const full = `${"x".repeat(50_000)}"3.22.1":"2026-07-30T04:29:21.637Z"${"y".repeat(50_000)}`
  const hit = findIn(full, "3.22.1")
  assert.equal(hit.count, 1)
  assert.match(hit.text, /1か所/)
  assert.match(hit.text, /\[49701字目\]/, "当たりの位置を返す(次にどこを読むか決められる)")
  assert.match(hit.text, /2026-07-30T04:29:21\.637Z/)
  assert.ok(hit.text.length < 12_000)

  // 無ければ 0。**無いものを窓で探し直させない**ための返り値。
  assert.equal(findIn(full, "4.0.0").count, 0)
  assert.equal(findIn(full, "4.0.0").text, "")

  // 大文字小文字は区別しない。件数は当たった数をそのまま返す。
  assert.equal(findIn("Effect EFFECT effect", "effect").count, 3)
})

test("find は取りに行かず、覚えた全文の中を探す", async () => {
  const originalFetch = globalThis.fetch
  let hits = 0
  const body = `{"time":{"3.22.0":"2026-07-13","3.22.1":"2026-07-30"},"pad":"${"z".repeat(40_000)}"}`
  globalThis.fetch = (async () => {
    hits++
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  try {
    const url = `https://example.com/reg-${Math.random().toString(36).slice(2)}`
    const t0 = 3_000_000
    const first = await fetchPage(url, { nowMs: t0 })
    // 刻み始める前に、窓で読むと何回かかるかを数字で見せる。
    assert.match(first.note ?? "", /窓\(12000字\)で頭から読むと 4 回/)
    assert.match(first.note ?? "", /`find` に語を渡す/)

    const found = await fetchPage(url, { find: "3.22.1", nowMs: t0 + 1_000 })
    assert.equal(hits, 1, "探すのに取り直さない")
    assert.match(found.text, /2026-07-30/)
    assert.equal(found.truncated, false)

    const missing = await fetchPage(url, { find: "9.9.9", nowMs: t0 + 2_000 })
    assert.equal(hits, 1)
    assert.equal(missing.text, "")
    assert.match(missing.note ?? "", /「9\.9\.9」はこのページ.*に無い/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("本文が頭 400KB より後ろにあるページも読む", async () => {
  // 実測: JS で組み立てるページは、人が読む文字を JS の後ろに置く。
  // 東京都は `<title>` まで 400KB 以上あり、上限 400KB では 38字、上限を上げると 5,962字。
  // メルカリ 32→206字、YouTube 0→426字(`<title>` が 684,015 バイト目)。
  const originalFetch = globalThis.fetch
  const filler = `<script>${"var x=1;".repeat(60_000)}</script>` // 約 480KB
  // 本文は 2,000字を超える長さにする。実際に読めた東京都は 5,962字で、
  // これより短いと「薄い」の判定に当たり、読めていることを確かめられない。
  const article = "お知らせ 令和8年の支援の取組。".repeat(200)
  const body = `<html><head>${filler}<title>都庁総合ホームページ</title></head><body><main>${article}</main></body></html>`
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch
  try {
    const p = await fetchPage(`https://example.com/heavy-${Math.random().toString(36).slice(2)}`, {
      nowMs: 3_000_000,
    })
    assert.match(p.text, /お知らせ 令和8年の支援の取組。/, "400KB の JS の後ろにある本文が読めている")
    assert.match(p.text, /都庁総合ホームページ/, "同じく後ろにある題も読めている")
    assert.doesNotMatch(p.text, /var x=1/, "JS そのものは本文に混ぜない")
    assert.equal(p.note, undefined, "読めたページに「薄い」とは言わない")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("上限で切ったときは、切ったと分かる言い方をする", async () => {
  // **切ったのか、そもそも入っていないのかを言い分ける。** 診断を間違えると、
  // 読み手は取れるはずのものを諦める。上限の数字は定数から作るので、上げたら文面も変わる。
  const originalFetch = globalThis.fetch
  const body = `<html><head><script>${"var y=2;".repeat(200_000)}</script></head><body><main>ここまで届かない</main></body></html>`
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch
  try {
    const p = await fetchPage(`https://example.com/huge-${Math.random().toString(36).slice(2)}`, {
      nowMs: 4_000_000,
    })
    assert.equal(p.text, "", "閉じない script は本文にしない")
    assert.equal(p.truncated, true, "上限で切ったページは、全部は読めていないと伝える")
    assert.match(p.note ?? "", /本文がほとんど無い/)
    assert.match(p.note ?? "", /頭 1500KB を読んだ範囲に本文が無かった/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("読めているページに「別を当たれ」と言わない", async () => {
  // 実測(86件の巡回): 一段の判定だと tenki.jp 1,719字・Yahoo 天気 1,954字・
  // JR東 運行情報 1,146字・みんかぶ 1,559字に「別の出典を当たったほうが早い」が付いた。
  // どれも目的の語は本文に入っていた。無いのと少ないのは別のことなので、言い方を分ける。
  const originalFetch = globalThis.fetch
  const shell = `<script>${"var z=3;".repeat(12_000)}</script>` // 約 96KB
  const page = (main: string) =>
    `<html><head>${shell}<title>天気</title></head><body><main>${main}</main></body></html>`
  const serve = (html: string) => {
    globalThis.fetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch
  }
  try {
    serve(page("東京地方の天気は晴れのち曇り。".repeat(80))) // 約 1,100字
    const slim = await fetchPage(`https://example.com/slim-${Math.random().toString(36).slice(2)}`, {
      nowMs: 5_000_000,
    })
    assert.match(slim.text, /東京地方の天気は晴れのち曇り。/)
    assert.match(slim.note ?? "", /読めたのは 1\d\d\d字/)
    assert.doesNotMatch(slim.note ?? "", /^本文がほとんど無い/)

    serve(page("読み込み中")) // 約 10字
    const empty = await fetchPage(`https://example.com/empty-${Math.random().toString(36).slice(2)}`, {
      nowMs: 5_001_000,
    })
    assert.match(empty.note ?? "", /本文がほとんど無い/)
    assert.match(empty.note ?? "", /別の出典を当たったほうが早い/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
