// TZ は import より先に設定する(`time.ts` が読み込み時に確定する)。

import assert from "node:assert/strict"
import fc from "fast-check"
import { test } from "vitest"
import { withFetch } from "../helpers.ts"

process.env.FAMULUS_TZ = "Asia/Tokyo"
// `FAMULUS_TZ` は `new Date()` に効かない。SearXNG の時間帯無しの日付は素の `Date` を通るので、
// TZ も固定しないとホストの時間帯で結果が変わる。
process.env.TZ = "Asia/Tokyo"
// fetch を差し替えているので、同一ホストへの間隔(既定 1 秒)を 0 にする。
process.env.FAMULUS_HOST_INTERVAL_MS = "0"
const { configureApp } = await import("../../src/core/config.ts")
configureApp()
const { defaultSources, parseFrom, plainQuery, renderHits, repoPath, searchSources } = await import(
  "../../src/services/Search.ts"
)
const { resetAtMs } = await import("../../src/services/Web.ts")

const parse = (source: string, body: unknown) => {
  const hits = parseFrom(source, typeof body === "string" ? body : JSON.stringify(body))
  assert.ok(hits, `${source} という先が無い`)
  return hits
}

test("検索エンジン構文を落とす処理は何度通しても結果が変わらない", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("site", "inurl", "intitle", "filetype", "ext"),
      fc.stringMatching(/^[a-z0-9.-]{1,30}$/),
      fc.stringMatching(/^[a-z0-9]{1,30}$/),
      fc.stringMatching(/^[a-z0-9]{1,30}$/),
      (qualifier, value, before, after) => {
        const once = plainQuery(`${before} ${qualifier}:${value} ${after}`)
        assert.equal(once, `${before} ${after}`)
        assert.equal(plainQuery(once), once)
      },
    ),
    { numRuns: 1_000 },
  )
})

test("zenn — path から URL を組み、いいねを目印にする", () => {
  const hits = parse("zenn", {
    articles: [
      {
        path: "/haru/articles/abc123",
        title: "Effect で書く",
        published_at: "2026-08-10T15:52:00.000+09:00",
        liked_count: 15_208,
        user: { username: "haru" },
      },
      { title: "題だけある", liked_count: 3 },
    ],
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.url, "https://zenn.dev/haru/articles/abc123")
  assert.equal(hits[0]?.by, "haru")
  assert.equal(hits[0]?.note, "♡15.2k")
})

test("qiita — 途中で切れた応答から、閉じている項だけ拾う", () => {
  // 本文込みの応答が上限で途中で切れ、`JSON.parse` が全体で失敗して 0 件になった回帰を防ぐ。
  const item = (n: number) =>
    JSON.stringify({
      title: `記事${n}`,
      url: `https://qiita.com/haru/items/${n}`,
      created_at: "2026-08-09T12:00:00+09:00",
      likes_count: 21,
      user: { id: "haru" },
      tags: [{ name: "TypeScript" }, { name: "Effect" }],
      body: "本文がここに丸ごと入る",
    })
  const whole = `[${[1, 2, 3].map(item).join(",")}]`
  assert.equal(parse("qiita", whole).length, 3)

  const cut = `[${[1, 2, 3].map(item).join(",")},{"title":"記事4","body":"途中で切れ`
  assert.throws(() => JSON.parse(cut))
  const hits = parse("qiita", cut)
  assert.equal(hits.length, 3)
  assert.equal(hits[2]?.title, "記事3")
  assert.equal(hits[0]?.note, "♡21 TypeScript Effect")

  assert.equal(parse("qiita", '[{"title":"記事').length, 0)
  assert.equal(parse("qiita", "配列ですらない").length, 0)
})

test("hatena — RSS 1.0 を item ごとに読み、題の数値実体を解いて users を目印にする", () => {
  const item = (about: string, title: string, count: number, date: string) =>
    `<item rdf:about="${about}"><title>${title}</title><link>${about}</link>` +
    `<description>要約のことば</description><dc:date>${date}</dc:date>` +
    `<hatena:bookmarkcount>${count}</hatena:bookmarkcount></item>`
  const hits = parse(
    "hatena",
    `<?xml version="1.0" encoding="UTF-8"?><rdf:RDF><channel><title>検索</title></channel>` +
      // はてブの RSS は非 ASCII を数値実体で書く(&#x672C;&#x6587; = 本文)
      item("https://example.com/a", "&#x672C;&#x6587;で読む TypeScript", 120, "2026-08-15T13:57:53Z") +
      item("https://example.com/b", "plain title", 10, "2026-08-14T00:00:00Z") +
      `</rdf:RDF>`,
  )
  assert.equal(hits.length, 2)
  assert.equal(hits[0]?.title, "本文で読む TypeScript")
  assert.equal(hits[0]?.url, "https://example.com/a")
  assert.equal(hits[0]?.at, "2026-08-15T13:57:53Z")
  assert.match(hits[0]?.note ?? "", /120 users \/ 要約のことば/)
  assert.equal(parse("hatena", `<rdf:RDF><item rdf:about="x"><title>t</title></item></rdf:RDF>`).length, 0)
})

test("github — 星・言語・説明を1行にまとめる", () => {
  const hits = parse("github", {
    items: [
      {
        full_name: "Effect-TS/effect",
        html_url: "https://github.com/Effect-TS/effect",
        stargazers_count: 9_800,
        language: "TypeScript",
        description: "型で書く合成",
        pushed_at: "2026-08-10T15:52:00Z",
      },
      { full_name: "url の無い項" },
    ],
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.note, "★9800 / TypeScript / 型で書く合成")
})

test("hn — 元記事があるならそちらを出し、議論への道は目印に添える", () => {
  const hits = parse("hn", {
    hits: [
      {
        objectID: "111",
        title: "Show HN: agent memory",
        url: "https://example.com/post",
        points: 42,
        num_comments: 7,
        author: "someone",
        created_at: "2026-08-10T15:52:00.000Z",
      },
      { objectID: "222", title: "Ask HN: どう記憶を持たせている?", points: 3, num_comments: 1 },
    ],
  })
  assert.equal(hits[0]?.url, "https://example.com/post")
  assert.match(hits[0]?.note ?? "", /議論 https:\/\/news\.ycombinator\.com\/item\?id=111/)
  assert.equal(hits[1]?.url, "https://news.ycombinator.com/item?id=222")
  assert.doesNotMatch(hits[1]?.note ?? "", /議論/)
})

test("stackoverflow — unix 秒を ISO に直し、解決済みかを出す", () => {
  const hits = parse("stackoverflow", {
    items: [
      {
        title: "Why does &quot;strict&quot; fail?",
        link: "https://stackoverflow.com/questions/1",
        score: 12,
        is_answered: true,
        creation_date: 1_786_000_000,
        tags: ["typescript", "node.js", "effect", "esm", "余る"],
        owner: { display_name: "asker" },
      },
      { title: "答えの付いていない質問", link: "https://stackoverflow.com/questions/2", is_answered: false },
    ],
  })
  assert.equal(hits[0]?.title, 'Why does "strict" fail?')
  assert.equal(hits[0]?.at, new Date(1_786_000_000 * 1000).toISOString())
  assert.equal(hits[0]?.note, "12点 / 解決済み / typescript node.js effect esm")
  assert.match(hits[1]?.note ?? "", /未解決/)
})

test("wikipedia — 一致箇所のマーカーを落とし、curid で開ける URL にする", () => {
  const hits = parse("wikipedia", {
    query: {
      search: [
        {
          pageid: 12_345,
          title: "Rust (プログラミング言語)",
          snippet: '<span class="searchmatch">Rust</span> は&quot;安全&quot;を掲げる',
          timestamp: "2026-08-10T15:52:00Z",
        },
        { title: "pageid の無い項" },
      ],
    },
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.url, "https://ja.wikipedia.org/?curid=12345")
  assert.equal(hits[0]?.note, 'Rust は"安全"を掲げる')
})

test("npm — 版と週の落とされ方。日付は項の外側にある", () => {
  const hits = parse("npm", {
    objects: [
      {
        updated: "2026-08-10T05:49:47.264Z",
        downloads: { weekly: 26_680_112, monthly: 103_933_749 },
        package: { name: "effect", version: "3.22.1", description: "合成の道具" },
      },
    ],
  })
  assert.equal(hits[0]?.url, "https://www.npmjs.com/package/effect")
  assert.equal(hits[0]?.at, "2026-08-10T05:49:47.264Z")
  assert.equal(hits[0]?.note, "v3.22.1 / 週26.7M / 合成の道具")
})

test("arxiv — Atom を欄ごとに読む。著者は3人まで", () => {
  const hits = parse(
    "arxiv",
    `<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <id>http://arxiv.org/abs/2608.00001v1</id>
  <published>2026-08-01T00:00:00Z</published>
  <title>Memory
  architectures for agents</title>
  <summary>  長い要約が
  折り返して入る。 </summary>
  <author><name>A One</name></author>
  <author><name>B Two</name></author>
  <author><name>C Three</name></author>
  <author><name>D Four</name></author>
</entry>
<entry><title>id の無い項</title></entry>
</feed>`,
  )
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.url, "http://arxiv.org/abs/2608.00001v1")
  assert.equal(hits[0]?.title, "Memory architectures for agents")
  assert.equal(hits[0]?.by, "A One, B Two, C Three")
  assert.equal(hits[0]?.note, "長い要約が 折り返して入る。")
})

test("hfpapers — paper.id から URL を組み、▲と要旨を目印にする。著者は3人まで", () => {
  const hits = parse("hfpapers", [
    {
      title: "外側の題(使わない)",
      paper: {
        id: "2608.14106",
        title: "Attention Is Enough",
        summary: "We revisit  attention.\nIt works.",
        upvotes: 42,
        publishedAt: "2026-08-14T00:00:00Z",
        authors: [{ name: "A One" }, { name: "B Two" }, { name: "C Three" }, { name: "D Four" }],
      },
    },
    { paper: { id: "9999.00000" } },
  ])
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.url, "https://huggingface.co/papers/2608.14106")
  assert.equal(hits[0]?.title, "Attention Is Enough")
  assert.equal(hits[0]?.by, "A One, B Two, C Three")
  assert.equal(hits[0]?.at, "2026-08-14T00:00:00Z")
  assert.match(hits[0]?.note ?? "", /▲42 \/ We revisit attention\. It works\./)
})

test("知らない先は undefined。名前を間違えたまま読み取りに入らない", () => {
  assert.equal(parseFrom("google", "{}"), undefined)
  assert.ok(parseFrom("GitHub", '{"items":[]}'))
})

test("使えない先は既定から外れる", () => {
  const saved = process.env.FAMULUS_SEARXNG
  try {
    delete process.env.FAMULUS_SEARXNG
    configureApp()
    const on = defaultSources()
    assert.ok(on.includes("web"), "既定の在り処があるのに web が既定に入らない")
    assert.ok(on.includes("zenn") && on.includes("github"))
    assert.ok(!on.includes("wikipedia"))
    assert.ok(!on.includes("arxiv"))

    process.env.FAMULUS_SEARXNG = "  "
    configureApp()
    assert.ok(!defaultSources().includes("web"), "空にしたのに web が既定に残っている")
  } finally {
    if (saved === undefined) delete process.env.FAMULUS_SEARXNG
    else process.env.FAMULUS_SEARXNG = saved
    configureApp()
  }
})

test("SearXNG の応答を読む — 索引の数と要約が入る", () => {
  const body = JSON.stringify({
    query: "Effect TS Layer",
    results: [
      {
        url: "https://zenn.dev/bitkey_dev/articles/f71789db6e40c6",
        title: "Effect-TSでDIがしたい！ - Zenn",
        content: "Layer を使って依存を組み立てる話。",
        engines: ["resulthunter", "zapmeta", "privacywall"],
        publishedDate: "2025-03-04T00:00:00",
        score: 3.5,
      },
      { url: "https://effect.website/", title: "Effect", content: "", engines: ["seznam"] },
      { url: "https://example.com/x", engines: ["gmx"] },
      { title: "URL が無い", engines: ["gmx"] },
    ],
  })
  const hits = parseFrom("web", body)
  assert.equal(hits?.length, 2)
  assert.equal(hits?.[0]?.note, "3索引 / Layer を使って依存を組み立てる話。")
  assert.equal(hits?.[1]?.note, "1索引")
  assert.equal(hits?.[1]?.at, undefined)
  // SearXNG の日付は時間帯が付かない。ユーザーの時刻として読み、表示する日を元の文字列と一致させる
  // (UTC として読むと夕方以降の記事が翌日にずれる)。
  assert.equal(hits?.[0]?.at, "2025-03-03T15:00:00.000Z")
  assert.equal(renderHits([{ source: "web", hits: hits ?? [] }]).includes("2025-03-04"), true)
})

test("SearXNG の読めない日付は捨てる", () => {
  // 日付欄に日付でない値を入れる先がある。そのまま持つと localStamp が崩れる。
  const body = JSON.stringify({
    results: [{ url: "https://a.example/1", title: "壊れた日付", publishedDate: "近日", engines: ["bing"] }],
  })
  assert.equal(parseFrom("web", body)?.[0]?.at, undefined)
})

test("空の問いと知らない先は、外へ出る前に返る", async () => {
  assert.deepEqual(await searchSources("   "), [])
  const r = await searchSources("test", { where: ["google", "bing"] })
  assert.equal(r.length, 1)
  assert.equal(r[0]?.hits.length, 0)
  assert.match(r[0]?.failed ?? "", /そういう先は無い/)
  assert.match(r[0]?.failed ?? "", /zenn/)
})

test("検索エンジンの構文は落として渡す", () => {
  // GitHub は site: 付きの問いを 422 で断る。
  assert.equal(plainQuery('site:zenn.dev/articles "Effect" "LLM"'), '"Effect" "LLM"')
  assert.equal(plainQuery("Effect TS site:github.com/Effect-TS inurl:examples"), "Effect TS")
  assert.equal(plainQuery("filetype:pdf agent memory"), "agent memory")
  assert.equal(plainQuery("site:effect.website/docs"), "effect.website/docs")
  // `::` を含む語(Rust)を巻き込まない。
  assert.equal(plainQuery("SQLite FTS5 trigram"), "SQLite FTS5 trigram")
  assert.equal(plainQuery("std::vec::Vec の使い方"), "std::vec::Vec の使い方")
})

test("いつまで待てばいいかを見出しから拾う", () => {
  const now = 1_786_390_000_000
  // Qiita は epoch 秒で `rate-reset` を返す。
  assert.equal(resetAtMs(new Headers({ "rate-reset": "1786393192" }), now), 1_786_393_192_000)
  assert.equal(resetAtMs(new Headers({ "x-ratelimit-reset": "1786393192" }), now), 1_786_393_192_000)
  assert.equal(resetAtMs(new Headers({ "retry-after": "60" }), now), now + 60_000)
  assert.equal(
    resetAtMs(new Headers({ "retry-after": "Tue, 11 Aug 2026 00:00:00 GMT" }), now),
    Date.parse("2026-08-11T00:00:00Z"),
  )
  // 過ぎた時刻・ms 単位の値・24時間より先は使わない。
  assert.equal(resetAtMs(new Headers({ "rate-reset": "1786380000" }), now), undefined)
  assert.equal(resetAtMs(new Headers({ "rate-reset": "1786393192000" }), now), undefined)
  assert.equal(resetAtMs(new Headers({}), now), undefined)
})

// 以下の2つは順番に依存する。回数制限に当たった記録はプロセスに残るので、
// 絞り込みを外す側を先に置く(逆にすると qiita が制限中で引けない)。
async function qiitaCalls(term: string, body: (url: string) => string): Promise<readonly string[]> {
  const called: string[] = []
  return await withFetch(
    async (input: unknown) => {
      const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input)
      called.push(url)
      return new Response(body(url), { status: 200, headers: { "content-type": "application/json" } })
    },
    async () => {
      await searchSources(term, { where: ["qiita"] })
      return called
    },
  )
}

test("zenn — 長すぎる語は 100 文字で切る(101 文字だと 400 が返る)", async () => {
  const called: string[] = []
  await withFetch(
    async (input: unknown) => {
      called.push(typeof input === "string" ? input : String((input as { url?: string }).url ?? input))
      return new Response('{"articles":[]}', { status: 200, headers: { "content-type": "application/json" } })
    },
    async () => {
      const long =
        "vite plugin environment api migration hotupdate handlehotupdate breaking change guide ".repeat(3)
      await searchSources(long, { where: ["zenn"] })
      const sent = decodeURIComponent(new URL(called[0] ?? "https://x/").searchParams.get("q") ?? "")
      assert.ok([...sent].length <= 100, `100 文字を越えている: ${[...sent].length}`)
      // 語の途中では切らない(半端な語尾では当たらない)。
      assert.ok(long.startsWith(sent), "元の語の頭から切っていない")
      assert.equal(long[sent.length], " ", `語の途中で切れている: …${sent.slice(-12)}`)

      // 数えるのはバイトではなく文字。
      called.length = 0
      await searchSources("あ".repeat(100), { where: ["zenn"] })
      const ja = decodeURIComponent(new URL(called[0] ?? "https://x/").searchParams.get("q") ?? "")
      assert.equal([...ja].length, 100, "全角100文字は通る(実測で 200)")
    },
  )
})

test("hatena と hfpapers — 送る URL の形(正規の入口・下限・limit)", async () => {
  const called: string[] = []
  await withFetch(
    async (input: unknown) => {
      called.push(typeof input === "string" ? input : String((input as { url?: string }).url ?? input))
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    },
    async () => {
      await searchSources("Claude Code", { where: ["hatena", "hfpapers"], perSource: 4 })
      const hatena = called.find((u) => u.includes("b.hatena.ne.jp"))
      const hf = called.find((u) => u.includes("huggingface.co"))
      // /search/text は 301 で往復が増えるので /q/ を直に呼ぶ。users=10 が下限。
      assert.match(hatena ?? "", /b\.hatena\.ne\.jp\/q\/Claude%20Code\?mode=rss/)
      assert.match(hatena ?? "", /users=10/)
      assert.match(hf ?? "", /api\/papers\/search\?q=Claude%20Code&limit=4/)
    },
  )
})

test("日本語の語は、0件なら絞りを外してもう一度だけ引く(狭い話題を落とさない)", async () => {
  const called = await qiitaCalls("SQLite の全文検索を日本語で", (url) =>
    url.includes("stocks")
      ? "[]"
      : JSON.stringify([{ title: "狭い話題の記事", url: "https://qiita.com/haru/items/9" }]),
  )
  assert.equal(called.length, 2, "0件のときだけ2回目を引く")
  assert.ok(called[0]?.includes("stocks"))
  assert.ok(!called[1]?.includes("stocks"))
})

test("日本語が入っていない語は、絞らず1回だけ引く(枠を倍に使わない)", async () => {
  // 英語の識別子では `stocks:>10` がほぼ 0 件で、引き直しが Qiita の回数制限を使い切った。
  const called = await qiitaCalls("files.includes --locked", () => "[]")
  assert.equal(called.length, 1, "0件でも2回目を出さない")
  assert.ok(!called[0]?.includes("stocks"), "最初から絞らない")
})

test("回数制限に当たった先は、解けるまで叩かない", async () => {
  // 理由が「HTTP 403」だけだと、待てば戻るのか拒否されたのかが読む側に分からない。
  let calls = 0
  const resetEpoch = Math.floor(Date.now() / 1000) + 1800
  await withFetch(
    async () => {
      calls++
      return new Response('{"message":"Rate limit exceeded","type":"rate_limit_exceeded"}', {
        status: 403,
        headers: { "content-type": "application/json", "rate-reset": String(resetEpoch) },
      })
    },
    async () => {
      const first = await searchSources("Effect", { where: ["qiita"] })
      assert.equal(calls, 1)
      assert.match(first[0]?.failed ?? "", /回数制限に当たった/)
      assert.match(first[0]?.failed ?? "", /\d{4}-\d{2}-\d{2} \d{2}:\d{2} まで/)

      const second = await searchSources("別の語", { where: ["qiita"] })
      assert.equal(calls, 1, "休んでいる間は外へ出ない")
      assert.match(second[0]?.failed ?? "", /回数制限中/)
    },
  )
})

test("見せる形 — 先ごとに分け、同じ URL は最初の1つだけ残す", () => {
  const text = renderHits([
    {
      source: "zenn",
      hits: [
        { title: "同じページ", url: "https://example.com/a", by: "haru", at: "2026-08-10T15:52:00Z" },
        { title: "別のページ", url: "https://example.com/b", note: "♡7" },
      ],
    },
    { source: "hn", hits: [{ title: "同じページ", url: "https://example.com/a" }] },
    { source: "qiita", hits: [] },
    { source: "web", hits: [], failed: "BRAVE_API_KEY が無いので引けない" },
  ])
  assert.match(text, /## zenn\(2件\)/)
  // 日付はユーザーの時計。UTC のまま出すと夜中の記事が前日として読まれる。
  assert.match(text, /haru \/ 2026-08-11/)
  assert.match(text, /## hn\(1件\)/)
  assert.match(text, /- 同じページ — zenn にも同じものが出た/)
  assert.equal(text.split("https://example.com/a").length - 1, 1)
  assert.match(text, /## qiita — 0件/)
  assert.match(text, /## web — 引けなかった\(BRAVE_API_KEY が無いので引けない\)/)
})

async function urlsFor(source: string, term: string, body: string): Promise<readonly string[]> {
  const called: string[] = []
  return await withFetch(
    async (input: unknown) => {
      called.push(typeof input === "string" ? input : String((input as { url?: string }).url ?? input))
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    },
    async () => {
      await searchSources(term, { where: [source] })
      return called
    },
  )
}

test("x — site:x.com は実装が付ける。呼ぶ側が書いた site: と競合させない", async () => {
  // X 本体は robots で全部断られているので、取りに行くのは SearXNG だけ。
  const called = await urlsFor("x", 'site:zenn.dev "Effect" schema', '{"results":[]}')
  assert.equal(called.length, 1)
  const q = new URL(called[0] ?? "http://x/").searchParams.get("q") ?? ""
  assert.ok(q.startsWith("site:x.com "), `site:x.com で始まっていない: ${q}`)
  // 呼ぶ側の site: が残ると site: が2つになり 0 件になる。
  assert.ok(!q.includes("zenn.dev"), `別の site: が残っている: ${q}`)
  assert.ok(q.includes("schema"), `語が消えている: ${q}`)
  // 自前のサーバなので、外向きの制限を免除する origin が付く。
  assert.ok(called[0]?.startsWith("http://127.0.0.1:8888/"), `SearXNG 以外へ出た: ${called[0]}`)
})

test("x — from:名前 と @名前 は、その人の投稿だけに絞る", async () => {
  // `site:x.com/名前` の形が本人の投稿を最も外さないので、どちらの書き方もその形に直す。
  for (const term of ["from:youyuxi Environment API", "@youyuxi Environment API"]) {
    const called = await urlsFor("x", term, '{"results":[]}')
    const q = new URL(called[0] ?? "http://x/").searchParams.get("q") ?? ""
    assert.equal(q, "site:x.com/youyuxi Environment API", `${term} → ${q}`)
  }
  const only = await urlsFor("x", "from:patak_dev", '{"results":[]}')
  assert.equal(new URL(only[0] ?? "http://x/").searchParams.get("q"), "site:x.com/patak_dev")
  // 前が空白でない `@` はメールアドレスとして扱う。
  const mail = await urlsFor("x", "haru@example.com の障害", '{"results":[]}')
  assert.equal(new URL(mail[0] ?? "http://x/").searchParams.get("q"), "site:x.com haru@example.com の障害")
})

test("x — 投稿の本文は SearXNG の要約から来る(こちらは x.com を叩かない)", () => {
  const hits = parse("x", {
    results: [
      {
        url: "https://x.com/EffectTS_/status/2071913655281635437",
        title: "Effect v4 Beta kept moving in June.",
        content: "Effect | TypeScript for the AI Era (@EffectTS_). 115 likes 4 replies. Adaptive rate l",
        engines: ["bing", "resulthunter"],
      },
    ],
  })
  assert.equal(hits[0]?.url, "https://x.com/EffectTS_/status/2071913655281635437")
  assert.match(hits[0]?.note ?? "", /2索引/)
  assert.match(hits[0]?.note ?? "", /115 likes 4 replies/)
})

test("x の結果には読み方を添える(要約を捨てさせない)", () => {
  // この注記が無いと、モデルは要約を原文でないとして捨てた。
  const text = renderHits([
    { source: "x", hits: [{ title: "投稿", url: "https://x.com/haru/status/1", note: "2索引 / 本文" }] },
    { source: "hn", hits: [{ title: "記事", url: "https://example.com/a" }] },
  ])
  const x = text.slice(text.indexOf("## x"), text.indexOf("## hn"))
  assert.match(x, /要約は投稿の本文そのもの/)
  assert.match(x, /断片/, "頭から全部ではないことを言っていない")
  assert.ok(!text.slice(text.indexOf("## hn")).includes("要約は投稿の本文"), "hn にまで出ている")
})

test("web に site:x.com と書かれたら x の先で受ける", async () => {
  // モデルは `where: ["x"]` ではなく `web` に `site:x.com/...` と書いてくるので、その書き方を受ける。
  const called = await urlsFor("web", "site:x.com/youyuxi Environment API", '{"results":[]}')
  assert.equal(called.length, 1, "外向きの回数は増やさない")
  assert.equal(new URL(called[0] ?? "http://x/").searchParams.get("q"), "site:x.com/youyuxi Environment API")
  const plain = await urlsFor("web", "site:x.com Effect schema", '{"results":[]}')
  assert.equal(new URL(plain[0] ?? "http://x/").searchParams.get("q"), "site:x.com Effect schema")
})

test("web に site: が2つあるときは回さない(X に寄せるのは行き過ぎ)", async () => {
  const called = await urlsFor("web", "site:x.com site:zenn.dev Effect", '{"results":[]}')
  assert.equal(new URL(called[0] ?? "http://x/").searchParams.get("q"), "site:x.com site:zenn.dev Effect")
})

test("回した先は x として返る(どこから来たかを読む側に見せる)", async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          results: [
            { url: "https://x.com/youyuxi/status/9", title: "投稿", content: "中身", engines: ["bing"] },
            { url: "https://vite.dev/guide/", title: "site: を守らなかった索引の結果" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const r = await searchSources("site:x.com Vite", { where: ["web"] })
      assert.equal(r[0]?.source, "x", "web のまま返している")
      // 頼んだのが site:x.com なら vite.dev は結果として誤りなので落ちる。
      assert.deepEqual(
        r[0]?.hits.map((h) => h.url),
        ["https://x.com/youyuxi/status/9"],
      )
    },
  )
})

test("x — 投稿でない項は落とす(site:x.com を守らない索引が混ざる)", () => {
  const hits = parse("x", {
    results: [
      { url: "https://x.com/youyuxi/status/1904855853037215958", title: "残る", content: "本文" },
      { url: "https://twitter.com/EffectTS_/status/1848719287013544194", title: "残る(旧ドメイン)" },
      { url: "https://vite.dev/guide/", title: "落ちる — 別のドメイン" },
      { url: "https://en.wikipedia.org/wiki/Vite", title: "落ちる — 別のドメイン" },
      { url: "https://x.com/?lang=ja", title: "落ちる — 入口のページ" },
      { url: "https://developer.x.com/", title: "落ちる — 別のホスト" },
      { url: "https://x.com/YandR_CBS", title: "落ちる — 個人ページ" },
      { url: "https://x.com/i/trending/2032170876888850542", title: "落ちる — 永久リンクではない" },
      { url: "https://x.com.evil.test/haru/status/1", title: "落ちる — 別のホスト" },
    ],
  })
  assert.deepEqual(
    hits.map((h) => h.title),
    ["残る", "残る(旧ドメイン)"],
  )
})

test("x — 殻を拾った要約は外す。ただし題に中身が残っているなら項は残す", () => {
  // 要約がログイン前の画面の文言になっている項がある。
  const hits = parse("x", {
    results: [
      {
        url: "https://x.com/mizchi/status/1",
        title: 'mizchi on X: "TypeScript でオレオレ Result 型を使うのをやめた',
        content: "We’ve detected that JavaScript is disabled in this browser.",
        engines: ["bing"],
      },
      // 題も名乗りだけの項は、要約を外すと何も残らないので落とす。
      {
        url: "https://x.com/mizchi/status/2",
        title: "mizchi on X",
        content: "JavaScript is not available · We’ve detected that",
        engines: ["bing"],
      },
      // 同じ id の投稿は URL が違っても1つにまとめる。
      { url: "https://x.com/youyuxi/status/3", title: "本物", content: "中身", engines: ["bing"] },
      { url: "https://x.com/evanyou/status/3?lang=ca", title: "同じ投稿", content: "中身", engines: ["a"] },
    ],
  })
  assert.equal(hits.length, 2)
  assert.match(hits[0]?.title ?? "", /オレオレ Result 型/)
  assert.equal(hits[0]?.note, "1索引")
  assert.ok(!(hits[0]?.note ?? "").includes("JavaScript"), "定型文が残っている")
  assert.equal(hits[1]?.url, "https://x.com/youyuxi/status/3")
})

test("showhn — hn と同じ API に tags=show_hn を足すだけ(枠も鍵も増やさない)", async () => {
  const called = await urlsFor("showhn", "AI agent", '{"hits":[]}')
  assert.equal(called.length, 1)
  const u = new URL(called[0] ?? "http://x/")
  assert.equal(u.host, "hn.algolia.com")
  assert.equal(u.searchParams.get("tags"), "show_hn")
  // `search_by_date` にすると語が効かなくなる。
  assert.equal(u.pathname, "/api/v1/search")
})

test("showhn — 読み取りは hn と同じ。元記事を出し、議論への道を添える", () => {
  const body = {
    hits: [
      {
        objectID: "44821001",
        title: "Show HN: Pi-Yahe: Yet Another Herdr Extension",
        url: "https://github.com/marv1nnnnn/pi-yahe",
        author: "marv1nnnnn",
        points: 1,
        num_comments: 0,
        created_at: "2026-08-11T10:01:00.000Z",
      },
    ],
  }
  const a = parse("showhn", body)
  const b = parse("hn", body)
  assert.deepEqual(a, b, "hn と読み取りが分かれている")
  assert.equal(a[0]?.url, "https://github.com/marv1nnnnn/pi-yahe")
  assert.match(a[0]?.note ?? "", /議論 https:\/\/news\.ycombinator\.com\/item\?id=44821001/)
})

test("hn に「Show HN」と書かれたら showhn の先で受ける", async () => {
  // モデルは `where: ["showhn"]` ではなく `hn` に「Show HN」を書いてくる。
  const 書き方: readonly [string, string][] = [
    ["Show HN AI agent", "AI agent"],
    ["show hn: AI agent", "AI agent"],
    ["AI agent show-hn", "AI agent"],
    // Algolia は引用符を句として読むので外さない。
    ['Show HN "AI agent"', '"AI agent"'],
  ]
  for (const [q, want] of 書き方) {
    const called = await urlsFor("hn", q, '{"hits":[]}')
    const u = new URL(called[0] ?? "http://x/")
    assert.equal(u.searchParams.get("tags"), "show_hn", `タグで絞っていない: ${q}`)
    // 「Show HN」を語として残すと近接ランキングがそこに寄るので落とす。
    assert.equal(u.searchParams.get("query"), want, `語を直していない: ${q}`)
  }
})

test("引用符ごと括られていても、文の途中でも受ける", async () => {
  // `site:` は `plainQuery` が落とすので語には残らない。
  const q = 'site:news.ycombinator.com/item "Show HN" "agent" "2026-08"'
  const u = new URL((await urlsFor("hn", q, '{"hits":[]}'))[0] ?? "http://x/")
  assert.equal(u.searchParams.get("tags"), "show_hn", "文中の引用符付きを取り逃した")
  // Algolia は引用符を句として読むので外さない。
  assert.equal(u.searchParams.get("query"), '"agent" "2026-08"')
})

test("showhn を名指ししたときも、語の「Show HN」は落とす", async () => {
  const called = await urlsFor("showhn", "Show HN rust", '{"hits":[]}')
  assert.equal(new URL(called[0] ?? "http://x/").searchParams.get("query"), "rust")
})

test("語が「Show HN」だけなら、語なしで引く(点数順の上位が返る)", async () => {
  const called = await urlsFor("hn", "Show HN", '{"hits":[]}')
  const u = new URL(called[0] ?? "http://x/")
  assert.equal(u.searchParams.get("tags"), "show_hn")
  assert.equal(u.searchParams.get("query"), "")
})

test("Show HN と書いていない hn は、そのまま hn で引く", async () => {
  for (const q of ["show me HN", "hn show", "showhnall"]) {
    const u = new URL((await urlsFor("hn", q, '{"hits":[]}'))[0] ?? "http://x/")
    assert.equal(u.searchParams.get("tags"), null, `関係ない語で回した: ${q}`)
  }
})

test("回した先は showhn として返る(どこから来たかを読む側に見せる)", async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          hits: [{ objectID: "1", title: "Show HN: Alacritty", url: "https://a/", points: 1170 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const r = await searchSources("Show HN terminal", { where: ["hn"] })
      assert.equal(r[0]?.source, "showhn", "hn のまま返している")
    },
  )
})

test("仕事を探す語なら、web と並べて job も出す(置き換えない)", async () => {
  const called: string[] = []
  await withFetch(
    async (input: unknown) => {
      called.push(String(input))
      return new Response('{"results":[]}', { status: 200, headers: { "content-type": "application/json" } })
    },
    async () => {
      const r = await searchSources("React 副業 週2", { where: ["web"] })
      assert.deepEqual(
        r.map((x) => x.source),
        ["web", "job"],
        "web を落としたか、job を足していない",
      )
      // 媒体選び(web)と募集そのもの(job)は別の問いなので両方出す。
      assert.ok(
        called.some((u) => !u.includes("site%3Acrowdworks")),
        "web の API を叩いていない",
      )
    },
  )
})

test("仕事と関係ない語では job を足さない", async () => {
  await withFetch(
    async () =>
      new Response('{"results":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const r = await searchSources("React Server Components", { where: ["web"] })
      assert.deepEqual(
        r.map((x) => x.source),
        ["web"],
      )
    },
  )
})

test("job — 媒体ごとに問い合わせを分けて引く", async () => {
  const called = await urlsFor("job", "React 週2", '{"results":[]}')
  // `(site:a OR site:b)` は索引が無視するので1媒体ずつ渡す。
  const qs = called.map((u) => new URL(u).searchParams)
  assert.deepEqual(
    qs.map((p) => (p.get("q") ?? "").replace(/ React 週2$/, "")),
    ["site:crowdworks.jp/public/jobs", "site:lancers.jp/work/detail", "site:www.wantedly.com/projects"],
  )
})

test("job — 期間で絞らない(絞ると語が当たらなくなる)", async () => {
  // 期間で絞ると上位が語と無関係な募集になり、絞らないほうが当たりが多かった。
  const called = await urlsFor("job", "React", '{"results":[]}')
  assert.equal(called.length, 3, `0件でも引き直さない: ${called.length}回`)
  assert.ok(
    called.every((u) => !new URL(u).searchParams.has("time_range")),
    "期間で絞っている",
  )
})

test("job — 募集ページだけ残して、媒体ごとに新しい順に並べる", () => {
  const hits = parse("job", {
    results: [
      { url: "https://crowdworks.jp/public/jobs/13300000", title: "古いほう", content: "本文" },
      { url: "https://react.dev/", title: "site: を守らなかった索引の結果", content: "本文" },
      { url: "https://crowdworks.jp/public/jobs/13372848", title: "新しいほう", content: "本文" },
      {
        url: "https://crowdworks.jp/public/jobs/13372848/apply",
        title: "募集ページではない",
        content: "本文",
      },
      { url: "https://www.wantedly.com/projects/2526090", title: "別の媒体", content: "本文" },
      { url: "https://crowdworks.jp/public/jobs.rss", title: "一覧", content: "本文" },
    ],
  })
  assert.deepEqual(
    hits.map((h) => h.title),
    ["新しいほう", "古いほう", "別の媒体"],
  )
})

test("job — 題が URL のままの項は落とす(索引が題を取れていない)", () => {
  const hits = parse("job", {
    results: [
      {
        url: "https://crowdworks.jp/public/jobs/13368677",
        title: "crowdworks.jp/public/jobs/13368677",
        content: "提案一覧",
      },
      { url: "https://crowdworks.jp/public/jobs/13360000", title: "React の募集", content: "本文" },
    ],
  })
  assert.deepEqual(
    hits.map((h) => h.title),
    ["React の募集"],
  )
})

test("job — 媒体名と調査語は落としてから引く", async () => {
  const called = await urlsFor("job", "ITプロパートナーズ React 週1 リモート 案件 公式", '{"results":[]}')
  assert.deepEqual(
    called.map((u) => new URL(u).searchParams.get("q")),
    [
      "site:crowdworks.jp/public/jobs React 週1 リモート 案件",
      "site:lancers.jp/work/detail React 週1 リモート 案件",
      "site:www.wantedly.com/projects React 週1 リモート 案件",
    ],
  )
})

test("媒体を調べているだけの語では job を出さない", async () => {
  // 媒体名と調査語を落とすと「副業」だけが残り、技術も職種も無いので job を引かない。
  await withFetch(
    async () =>
      new Response('{"results":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const r = await searchSources("Offers 手数料 審査 スカウト 応募 公式 副業", { where: ["web"] })
      assert.deepEqual(
        r.map((x) => x.source),
        ["web"],
      )
    },
  )
})

test("job — 媒体をまたいで ID を比べない(桁が違うだけで順が壊れる)", () => {
  const hits = parse("job", {
    results: [
      { url: "https://www.wantedly.com/projects/2526090", title: "Wantedly の新しいの", content: "本文" },
      { url: "https://crowdworks.jp/public/jobs/13372848", title: "cw の新しいの", content: "本文" },
      { url: "https://www.wantedly.com/projects/1115396", title: "Wantedly の古いの", content: "本文" },
    ],
  })
  // Wantedly の ID(7桁)は cw の ID(8桁)より必ず小さい。媒体をまたいで比べると媒体で分かれる。
  assert.deepEqual(
    hits.map((h) => h.title),
    ["Wantedly の新しいの", "Wantedly の古いの", "cw の新しいの"],
  )
})

test("x と showhn と job は既定に入れない(1問あたりの外向きを増やさない)", () => {
  const d = defaultSources()
  assert.ok(!d.includes("x"), "x が既定に入っている")
  assert.ok(!d.includes("showhn"), "showhn が既定に入っている")
  assert.ok(!d.includes("job"), "job が既定に入っている")
  assert.ok(parseFrom("x", '{"results":[]}'), "x を名指しで呼べない")
  assert.ok(parseFrom("showhn", '{"hits":[]}'), "showhn を名指しで呼べない")
  assert.ok(parseFrom("job", '{"results":[]}'), "job を名指しで呼べない")
})

test("docs は Context7 の索引を llms.txt の URL に起こす", () => {
  const hits = parse("docs", {
    results: [
      {
        id: "/vercel/ai",
        title: "Vercel AI SDK",
        description: "The AI Toolkit for TypeScript.",
        lastUpdateDate: "2026-08-15T08:56:29.790Z",
      },
      { id: "", title: "壊れた行は落とす" },
    ],
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.title, "Vercel AI SDK(/vercel/ai)")
  assert.equal(hits[0]?.url, "https://context7.com/vercel/ai/llms.txt?tokens=3000")
  assert.equal(hits[0]?.at, "2026-08-15T08:56:29.790Z")
})

test("release はタグ・公表日・本文の先頭を返す", () => {
  const hits = parse("release", [
    {
      tag_name: "bun-v1.3.14",
      name: "Bun v1.3.14",
      html_url: "https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14",
      published_at: "2026-05-13T03:48:28Z",
      prerelease: false,
      draft: false,
      body: "改行を\n含む\n本文",
    },
    { tag_name: "", html_url: "" },
  ])
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.title, "bun-v1.3.14 Bun v1.3.14")
  assert.equal(hits[0]?.at, "2026-05-13T03:48:28Z")
  assert.ok(hits[0]?.note?.includes("改行を 含む 本文"))
})

test("advisory は severity と CVE を note に返す", () => {
  const hits = parse("advisory", [
    {
      summary: "XSS in dev server",
      html_url: "https://github.com/vitejs/vite/security/advisories/GHSA-x",
      severity: "high",
      cve_id: "CVE-2026-0001",
      published_at: "2026-07-01T00:00:00Z",
    },
  ])
  assert.equal(hits[0]?.title, "XSS in dev server")
  assert.equal(hits[0]?.note, "high / CVE-2026-0001")
})

// 形にならない語は encode して API の 404 に任せる。
test("repoPath は owner/repo を語からも URL からも取り出す", () => {
  assert.equal(repoPath("oven-sh/bun"), "oven-sh/bun")
  assert.equal(repoPath("https://github.com/openclaw/openclaw/releases"), "openclaw/openclaw")
  assert.equal(repoPath(" NousResearch/hermes-agent "), "NousResearch/hermes-agent")
  assert.equal(repoPath("bun とは"), encodeURIComponent("bun とは"))
})

const PH_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title><![CDATA[Agently]]></title>
    <link href="https://www.producthunt.com/posts/agently"/>
    <published>2026-08-18T00:10:00Z</published>
    <author><name>maker_a</name></author>
    <content type="html">&lt;p&gt;AI teammates for your &amp;quot;ops&amp;quot; work&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Sleepy</title>
    <link href="https://www.producthunt.com/posts/sleepy"/>
    <updated>2026-08-18T01:00:00Z</updated>
    <author><name>maker_b</name></author>
    <content type="html">&lt;p&gt;Track your naps&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>壊れた項目</title>
  </entry>
</feed>`

test("ph — feed を取ってから語で絞る。検索式は URL に載らない", async () => {
  const called: string[] = []
  const r = await withFetch(
    async (input: unknown) => {
      called.push(String(input))
      return new Response(PH_FEED, { status: 200, headers: { "content-type": "application/atom+xml" } })
    },
    async () => await searchSources("AI ops", { where: ["ph"] }),
  )
  assert.equal(called[0], "https://www.producthunt.com/feed")
  const ph = r.find((x) => x.source === "ph")
  assert.equal(ph?.failed, undefined)
  assert.deepEqual(
    ph?.hits.map((h) => h.title),
    ["Agently"],
  )
  const hit = ph?.hits[0]
  assert.equal(hit?.url, "https://www.producthunt.com/posts/agently")
  assert.equal(hit?.by, "maker_a")
  assert.equal(hit?.at, "2026-08-18T00:10:00Z")
  assert.equal(hit?.note, 'AI teammates for your "ops" work')
})

test("ph — 絞って0件は成功の0件として返る(失敗にしない)", async () => {
  const r = await withFetch(
    async () => new Response(PH_FEED, { status: 200, headers: { "content-type": "application/atom+xml" } }),
    async () => await searchSources("存在しない語", { where: ["ph"] }),
  )
  const ph = r.find((x) => x.source === "ph")
  assert.equal(ph?.failed, undefined)
  assert.deepEqual(ph?.hits, [])
})
