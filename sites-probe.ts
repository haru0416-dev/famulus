/**
 * 普段遣いで当たる先を一通り開いて、返り値の質を並べる。**通ったかどうかではなく、読めるかどうかを見る。**
 * 使い方: bun sites-probe.ts [絞り込み語]
 *   絞り込み語は分類名・サイト名・URL の一部に当たる(例: 買い物 / Amazon / kakaku)。
 *
 * `want` はその頁を開いた目的の語。**入っていなければ、200 で返っていても読めていない。**
 */
import { configureApp } from "./src/core/config.ts"
import { loadEnv } from "./src/core/env.ts"
import { fetchPage } from "./src/services/Web.ts"

loadEnv()
configureApp()

type Site = readonly [cat: string, name: string, url: string, want?: string]

const SITES: readonly Site[] = [
  // ── 報道 ──
  ["報道", "NHK(RSS)", "https://www3.nhk.or.jp/rss/news/cat0.xml"],
  ["報道", "NHK", "https://www3.nhk.or.jp/news/"],
  ["報道", "Yahoo ニュース", "https://news.yahoo.co.jp/"],
  ["報道", "朝日新聞", "https://www.asahi.com/"],
  ["報道", "日経", "https://www.nikkei.com/"],
  ["報道", "ITmedia", "https://www.itmedia.co.jp/news/"],
  ["報道", "東洋経済", "https://toyokeizai.net/"],
  ["報道", "ロイター日本", "https://jp.reuters.com/"],
  ["報道", "BBC", "https://www.bbc.com/news"],
  ["報道", "The Verge", "https://www.theverge.com/"],
  ["報道", "TechCrunch", "https://techcrunch.com/"],

  // ── 天気・災害 ──
  ["天気", "気象庁(JSON)", "https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json", "東京地方"],
  ["天気", "tenki.jp", "https://tenki.jp/forecast/3/16/4410/13101/", "天気"],
  ["天気", "Yahoo 天気", "https://weather.yahoo.co.jp/weather/jp/13/4410.html", "天気"],
  ["天気", "気象庁 地震(JSON)", "https://www.jma.go.jp/bosai/quake/data/list.json"],

  // ── 買い物 ──
  ["買い物", "Amazon.co.jp", "https://www.amazon.co.jp/s?k=keyboard", "キーボード"],
  ["買い物", "楽天市場", "https://search.rakuten.co.jp/search/mall/ノートパソコン/"],
  ["買い物", "Yahoo ショッピング", "https://shopping.yahoo.co.jp/search?p=ノートパソコン"],
  ["買い物", "価格.com", "https://kakaku.com/pc/note-pc/"],
  ["買い物", "ヨドバシ", "https://www.yodobashi.com/category/19531/"],
  ["買い物", "メルカリ", "https://jp.mercari.com/search?keyword=キーボード"],

  // ── 交通・地図・旅 ──
  ["交通", "JR東 運行情報", "https://traininfo.jreast.co.jp/train_info/kanto.aspx", "運転"],
  ["交通", "ジョルダン 乗換", "https://www.jorudan.co.jp/norikae/", "乗換"],
  ["交通", "Yahoo 路線", "https://transit.yahoo.co.jp/diainfo/area/4", "運行"],
  ["交通", "じゃらん", "https://www.jalan.net/"],
  ["交通", "ANA", "https://www.ana.co.jp/ja/jp/"],
  ["交通", "OpenStreetMap", "https://www.openstreetmap.org/"],

  // ── 行政・公共 ──
  ["行政", "e-Gov", "https://www.e-gov.go.jp/"],
  ["行政", "法令検索", "https://laws.e-gov.go.jp/law/322AC0000000049", "労働"],
  ["行政", "国税庁", "https://www.nta.go.jp/"],
  ["行政", "デジタル庁", "https://www.digital.go.jp/"],
  ["行政", "統計局", "https://www.stat.go.jp/"],
  ["行政", "東京都", "https://www.metro.tokyo.lg.jp/"],

  // ── 暮らし ──
  ["暮らし", "クックパッド", "https://cookpad.com/jp/search/カレー", "レシピ"],
  ["暮らし", "クラシル", "https://www.kurashiru.com/search?query=カレー", "カレー"],
  ["暮らし", "食べログ", "https://tabelog.com/tokyo/"],
  ["暮らし", "SUUMO", "https://suumo.jp/chintai/tokyo/", "賃貸"],
  ["暮らし", "Indeed", "https://jp.indeed.com/q-エンジニア-l-東京都-求人.html"],

  // ── 辞書・翻訳 ──
  ["辞書", "Weblio", "https://ejje.weblio.jp/content/resilience", "回復"],
  ["辞書", "コトバンク", "https://kotobank.jp/word/レジリエンス-1729175"],
  ["辞書", "Wiktionary", "https://en.wiktionary.org/wiki/resilience", "Noun"],

  // ── 金融 ──
  ["金融", "Yahoo ファイナンス", "https://finance.yahoo.co.jp/quote/998407.O", "日経平均"],
  ["金融", "日本取引所", "https://www.jpx.co.jp/"],
  ["金融", "みんかぶ 為替", "https://fx.minkabu.jp/", "ドル"],

  // ── 動画・SNS ──
  ["SNS", "YouTube 動画", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  ["SNS", "ニコニコ", "https://www.nicovideo.jp/ranking"],
  ["SNS", "X", "https://x.com/jack"],
  ["SNS", "Reddit", "https://www.reddit.com/r/typescript/"],
  ["SNS", "Hacker News", "https://news.ycombinator.com/"],
  ["SNS", "はてなブックマーク", "https://b.hatena.ne.jp/hotentry/it"],
  ["SNS", "note", "https://note.com/"],
  ["SNS", "Bluesky", "https://bsky.app/profile/bsky.app"],
  ["SNS", "Mastodon", "https://mastodon.social/@Gargron"],

  // ── 技術・学術 ──
  ["技術", "Wikipedia 日本語", "https://ja.wikipedia.org/wiki/日本語"],
  ["技術", "Wikipedia 英語", "https://en.wikipedia.org/wiki/TypeScript"],
  ["技術", "MDN", "https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/Array"],
  ["技術", "GitHub リポジトリ", "https://github.com/Effect-TS/effect"],
  ["技術", "GitHub リリース feed", "https://github.com/Effect-TS/effect/releases.atom"],
  ["技術", "GitHub raw README", "https://raw.githubusercontent.com/Effect-TS/effect/main/README.md"],
  ["技術", "GitHub Issue", "https://github.com/Effect-TS/effect/issues/1", "Effect"],
  ["技術", "npm レジストリ", "https://registry.npmjs.org/effect/latest"],
  ["技術", "npm 頁", "https://www.npmjs.com/package/effect"],
  ["技術", "PyPI", "https://pypi.org/project/requests/"],
  ["技術", "Python 公式", "https://docs.python.org/3/library/asyncio.html", "asyncio"],
  ["技術", "Node 公式", "https://nodejs.org/api/fs.html", "readFile"],
  ["技術", "Rust 公式", "https://doc.rust-lang.org/std/vec/struct.Vec.html", "Vec"],
  ["技術", "Go pkg", "https://pkg.go.dev/net/http", "Handler"],
  ["技術", "Zenn トピック", "https://zenn.dev/topics/typescript"],
  ["技術", "Qiita タグ", "https://qiita.com/tags/typescript"],
  ["技術", "Lobsters", "https://lobste.rs/"],
  ["技術", "dev.to", "https://dev.to/"],
  ["報道", "Techmeme", "https://www.techmeme.com/"],
  ["技術", "HF Daily Papers", "https://huggingface.co/papers"],

  // ── 実際に投げる頁 ──
  // **一覧ではなく、記事とファイルの頁のほうを普段は開く。** 一覧だけ測っていると、
  // 一番よく通る道を測らないまま終わる。
  ["開発", "Zenn 記事", "https://zenn.dev/nagilab/articles/firebase-auth-tenant-security-tips", "Firebase"],
  ["開発", "Qiita 記事", "https://qiita.com/UdukiRenge/items/768a9385879e1b2ca2ab", "dnd-kit"],
  ["開発", "Zenn 書き手", "https://zenn.dev/mizchi"],
  ["開発", "Qiita 書き手", "https://qiita.com/mizchi"],
  ["開発", "GH リポジトリ(短README)", "https://github.com/Effect-TS/effect", "Effect is a library"],
  ["開発", "GH リポジトリ(長README)", "https://github.com/sindresorhus/got", "got"],
  ["開発", "GH ファイル", "https://github.com/Effect-TS/effect/blob/main/packages/effect/README.md", "Effect"],
  ["開発", "GH ディレクトリ", "https://github.com/Effect-TS/effect/tree/main/packages"],
  ["開発", "GH Issue 本文", "https://github.com/Effect-TS/effect/issues/4700", "Description"],
  ["開発", "GH PR", "https://github.com/Effect-TS/effect/pull/5000", "Version Packages"],
  ["開発", "GH Discussions", "https://github.com/orgs/community/discussions/1", "feedback"],
  ["開発", "GH リリース一覧", "https://github.com/Effect-TS/effect/releases"],
  ["開発", "Gist", "https://gist.github.com/gaearon/e7d97cdf38a2907924ea12e4ebdf3c85", "useLayoutEffect"],
  ["開発", "GH コード検索", "https://github.com/search?q=effect+schema&type=code"],
  ["技術", "Stack Overflow", "https://stackoverflow.com/questions/tagged/typescript"],
  ["技術", "公式ドキュメント", "https://effect.website/docs/getting-started/introduction/"],
  ["技術", "arXiv 要旨", "https://arxiv.org/abs/1706.03762"],
  ["技術", "arXiv PDF", "https://arxiv.org/pdf/1706.03762"],
  ["技術", "青空文庫", "https://www.aozora.gr.jp/cards/000148/files/773_14560.html"],

  // ── 回り道の行き先 ──
  // **回り道は書いた時点で正しくても腐る。** 案内している先そのものを毎回開いて確かめる。
  ["回り道", "法令 API", "https://laws.e-gov.go.jp/api/1/lawdata/322AC0000000049", "労働基準法"],
  ["回り道", "GitHub Issue API", "https://api.github.com/repos/Effect-TS/effect/issues/1", "Proposals"],
  ["回り道", "Bluesky API", "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=bsky.app&limit=20", "post"],
  ["回り道", "Mastodon rss", "https://mastodon.social/@Gargron.rss", "Gargron"],
  ["回り道", "note rss", "https://note.com/note_official/rss", "note"],
  ["回り道", "YouTube oEmbed", "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json", "Rick Astley"],
  ["回り道", "SO feed", "https://stackoverflow.com/feeds/tag/typescript", "typescript"],
  ["回り道", "Reddit rss", "https://www.reddit.com/r/typescript/.rss", "typescript"],
  ["回り道", "Zenn feed", "https://zenn.dev/topics/typescript/feed", "TypeScript"],
  ["回り道", "Qiita feed", "https://qiita.com/tags/typescript/feed", "Qiita"],
  ["回り道", "npm レジストリ", "https://registry.npmjs.org/effect/latest", "effect"],
  ["回り道", "arXiv HTML", "https://arxiv.org/html/1706.03762", "Attention"],
  ["回り道", "GH contents API", "https://api.github.com/repos/Effect-TS/effect/contents/packages?ref=main", "effect"],
  ["回り道", "GH リポジトリ検索 API", "https://api.github.com/search/repositories?q=effect+typescript", "effect"],
  ["回り道", "Zenn 書き手 feed", "https://zenn.dev/mizchi/feed", "mizchi"],
  ["回り道", "Qiita 書き手 feed", "https://qiita.com/UdukiRenge/feed", "UdukiRenge"],
  ["回り道", "Lobsters rss", "https://lobste.rs/rss", "lobste.rs"],
  ["回り道", "Lobsters hottest JSON", "https://lobste.rs/hottest.json", "title"],
  ["回り道", "dev.to API", "https://dev.to/api/articles?tag=ai&top=7&per_page=5", "title"],
  ["回り道", "dev.to tag feed", "https://dev.to/feed/tag/ai", "DEV"],
  ["回り道", "Techmeme feed", "https://www.techmeme.com/feed.xml", "Techmeme"],
  ["回り道", "HF daily_papers API", "https://huggingface.co/api/daily_papers", "paper"],
  ["回り道", "はてブ hotentry rss", "https://b.hatena.ne.jp/hotentry/it.rss", "users"],
  // /search/text?q= は /q/ へ 301 するので、search の hatena と同じ正規の入口で測る。
  ["回り道", "はてブ 検索 rss", "https://b.hatena.ne.jp/q/TypeScript?mode=rss&target=text&users=10&sort=recent", "TypeScript"],
]

const filter = process.argv[2]
const targets = filter
  ? SITES.filter(([c, n, u]) => c.includes(filter) || n.includes(filter) || u.includes(filter))
  : SITES

const summary: string[] = []
for (const [cat, name, url, want] of targets) {
  const t0 = Date.now()
  try {
    const p = await fetchPage(url, { nowMs: Date.now() })
    const body = p.text.trim()
    const lines = body.split("\n")
    const blank = lines.filter((l) => l.trim() === "").length
    // 空行は重複に数えない。旧計算では空行だけで価格.comを重複96%と誤判定したため。
    const solid = lines.filter((l) => l.trim() !== "")
    const dup = solid.length - new Set(solid).size
    const bad = (body.match(/�/g) ?? []).length
    const hit = want ? (body.includes(want) ? "○" : "×") : "-"
    const head = `[${p.status}] ${Date.now() - t0}ms ${body.length}字`
    summary.push(
      `${cat.padEnd(4)} ${name.padEnd(22)} ${String(p.status).padStart(3)} ${String(body.length).padStart(6)}字 ` +
        `空${String(Math.round((blank / Math.max(lines.length, 1)) * 100)).padStart(3)}% ` +
        `重${String(Math.round((dup / Math.max(solid.length, 1)) * 100)).padStart(3)}% ${hit}${bad ? ` 化${bad}` : ""}` +
        `${p.note ? ` ※${p.note.split("\n")[0]?.slice(0, 40)}` : ""}`,
    )
    console.log(`\n── [${cat}] ${name} ${head}${p.truncated ? " 途中" : ""}${bad ? ` **化け ${bad}字**` : ""}`)
    if (want) console.log(`   目的の語「${want}」: ${hit === "○" ? `${body.indexOf(want)}字目` : "**入っていない**"}`)
    if (p.note) console.log(`   ※ ${p.note.replace(/\n/g, "\n     ")}`)
    console.log(
      body
        .slice(0, 400)
        .split("\n")
        .map((l) => `   | ${l}`)
        .join("\n") || "   | (空)",
    )
  } catch (e) {
    summary.push(`${cat.padEnd(4)} ${name.padEnd(22)} **開けない** ${(e as Error).message.slice(0, 50)}`)
    console.log(`\n── [${cat}] ${name} **開けなかった** ${(e as Error).message}`)
  }
}

console.log(`\n\n=== 一覧(${targets.length}件)===`)
for (const s of summary) console.log(s)
