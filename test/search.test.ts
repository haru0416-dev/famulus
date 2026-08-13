/**
 * 検索の検査。**外へ出ない。** 見ているのは「相手の応答をどう読むか」だけ。
 *
 * 実際に引けることは probe で外へ出して測った(2026-08-11: 既定の先へ同時に出して
 * 0.8〜1.3秒で 14〜16件)。ここで押さえたいのは、その測定では通らない側 —
 * **応答が欠けている・途中で切れている・想定と違う形で来たときに落ちないか**。
 *
 * フィクスチャの欄名は同日に実際に返ってきた応答から取った(npm の `updated` のように
 * 項の外側にある欄も含む)。TZ は import より先に差す(`time.ts` が読み込み時に確定する)。
 */
import assert from "node:assert/strict"
import { test } from "node:test"

process.env.OPEN_ZERO_TZ = "Asia/Tokyo"
// **`OPEN_ZERO_TZ` は `new Date()` には届かない。** 帯の付いていない日付
// (SearXNG の `publishedDate`)を読む1件は素の `Date` を通るので、走らせたホストの帯で答が変わる。
// ここまでは「たまたまこのホストが Asia/Tokyo だから通っていた」検査で、コンテナの中では 9 時間ずれた。
process.env.TZ = "Asia/Tokyo"
// 同じホストへの間隔は既定 1 秒。**ここは fetch を差し替えてあるので誰も叩いていない** —
// 待つぶんがそのままゲートの所要になるので 0 にする(src/services/Web.ts の hostIntervalMs)。
process.env.OPEN_ZERO_HOST_INTERVAL_MS = "0"
const { defaultSources, parseFrom, plainQuery, renderHits, searchWeb } = await import(
  "../src/services/Search.ts"
)
const { resetAtMs } = await import("../src/services/Web.ts")

/** 先の名前で読み取りを呼ぶ。知らない先なら検査を落とす。 */
const parse = (source: string, body: unknown) => {
  const hits = parseFrom(source, typeof body === "string" ? body : JSON.stringify(body))
  assert.ok(hits, `${source} という先が無い`)
  return hits
}

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
      // path が無い項は捨てる(URL を作れないものを一覧に出さない)。
      { title: "題だけある", liked_count: 3 },
    ],
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.url, "https://zenn.dev/haru/articles/abc123")
  assert.equal(hits[0]?.by, "haru")
  // 桁を落として読ませる。15208 をそのまま出しても比べにくい。
  assert.equal(hits[0]?.note, "♡15.2k")
})

test("qiita — 途中で切れた応答から、閉じている項だけ拾う", () => {
  // 実際に踏んだ形。本文が丸ごと入るので上限に当たって JSON が途中で終わり、
  // `JSON.parse` が丸ごと失敗して**揃っていた分まで 0 件になった**。
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
  assert.throws(() => JSON.parse(cut)) // 素直に読むと全滅する側
  const hits = parse("qiita", cut)
  assert.equal(hits.length, 3)
  assert.equal(hits[2]?.title, "記事3")
  assert.equal(hits[0]?.note, "♡21 TypeScript Effect")

  // 括弧が1つも閉じていなければ諦める(壊れた形を無理に読まない)。
  assert.equal(parse("qiita", '[{"title":"記事').length, 0)
  assert.equal(parse("qiita", "配列ですらない").length, 0)
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
      // 外部リンクの無い投稿(Ask HN など)は、議論そのものが行き先になる。
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
  assert.equal(hits[0]?.title, 'Why does "strict" fail?') // 実体参照を戻す
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
  // 週 2668万を "26680.1k" と出しても読めない。百万で1段落とす。
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
  assert.equal(hits[0]?.title, "Memory architectures for agents") // 折り返しを1行に畳む
  assert.equal(hits[0]?.by, "A One, B Two, C Three")
  assert.equal(hits[0]?.note, "長い要約が 折り返して入る。")
})

test("知らない先は undefined。名前を間違えたまま読み取りに入らない", () => {
  assert.equal(parseFrom("google", "{}"), undefined)
  assert.ok(parseFrom("GitHub", '{"items":[]}')) // 大文字小文字は問わない
})

test("使えない先は既定から外れる", () => {
  const saved = process.env.OPEN_ZERO_SEARXNG
  try {
    delete process.env.OPEN_ZERO_SEARXNG
    const on = defaultSources()
    assert.ok(on.includes("web"), "既定の在り処があるのに web が既定に入らない")
    assert.ok(on.includes("zenn") && on.includes("github"))
    // 既定に入れない先(問いの型が決まっているときだけ当たる)は、設定に関わらず出ない。
    assert.ok(!on.includes("wikipedia"))
    assert.ok(!on.includes("arxiv"))

    // 空にすると SearXNG を使わない設定になる(容器を落としている日)。
    process.env.OPEN_ZERO_SEARXNG = "  "
    assert.ok(!defaultSources().includes("web"), "空にしたのに web が既定に残っている")
  } finally {
    if (saved === undefined) delete process.env.OPEN_ZERO_SEARXNG
    else process.env.OPEN_ZERO_SEARXNG = saved
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
      // 日付を出さない索引が混ざる。1つだけが拾ったページも、そう分かる形で出す。
      { url: "https://effect.website/", title: "Effect", content: "", engines: ["seznam"] },
      // 題か URL が欠けた項は落とす(並べても開けない)。
      { url: "https://example.com/x", engines: ["gmx"] },
      { title: "URL が無い", engines: ["gmx"] },
    ],
  })
  const hits = parseFrom("web", body)
  assert.equal(hits?.length, 2)
  assert.equal(hits?.[0]?.note, "3索引 / Layer を使って依存を組み立てる話。")
  assert.equal(hits?.[1]?.note, "1索引")
  assert.equal(hits?.[1]?.at, undefined)
  // **SearXNG の日付には時間帯が付かない。** `Z` も `+09:00` も無い `2025-03-04T00:00:00` が来る。
  // これをユーザーの時刻として読むと 2025-03-03T15:00Z になり、ユーザーの時計へ戻すと元の日に戻る。
  // UTC として読むと逆に、夕方以降の記事が翌日としてずれる。**見せる日を文字列と一致させる**ほうを取る。
  assert.equal(hits?.[0]?.at, "2025-03-03T15:00:00.000Z")
  assert.equal(renderHits([{ source: "web", hits: hits ?? [] }]).includes("2025-03-04"), true)
})

test("SearXNG の読めない日付は捨てる", () => {
  // 日付の欄はあるのに中身が形になっていない先がある。そのまま持つと localStamp が崩れる。
  const body = JSON.stringify({
    results: [{ url: "https://a.example/1", title: "壊れた日付", publishedDate: "近日", engines: ["bing"] }],
  })
  assert.equal(parseFrom("web", body)?.[0]?.at, undefined)
})

test("空の問いと知らない先は、外へ出る前に返る", async () => {
  assert.deepEqual(await searchWeb("   "), [])
  // 名指しした先が全部知らない名前なら、叩く相手がいないので通信は起きない。
  const r = await searchWeb("test", { where: ["google", "bing"] })
  assert.equal(r.length, 1)
  assert.equal(r[0]?.hits.length, 0)
  assert.match(r[0]?.failed ?? "", /そういう先は無い/)
  assert.match(r[0]?.failed ?? "", /zenn/) // 使える名前を並べて返す
})

test("検索エンジンの構文は落として渡す", () => {
  // 端から端まで動かした回にモデルが実際に書いた形。GitHub はこれを 422 で断った。
  assert.equal(plainQuery('site:zenn.dev/articles "Effect" "LLM"'), '"Effect" "LLM"')
  assert.equal(plainQuery("Effect TS site:github.com/Effect-TS inurl:examples"), "Effect TS")
  assert.equal(plainQuery("filetype:pdf agent memory"), "agent memory")
  // 絞り込みしか書かれていなければ、値を語として残す(問いを空にしない)。
  assert.equal(plainQuery("site:effect.website/docs"), "effect.website/docs")
  // 普通の問いは触らない。コロンの付く語(Rust の `::`)を巻き込まない。
  assert.equal(plainQuery("SQLite FTS5 trigram"), "SQLite FTS5 trigram")
  assert.equal(plainQuery("std::vec::Vec の使い方"), "std::vec::Vec の使い方")
})

test("いつまで待てばいいかを見出しから拾う", () => {
  const now = 1_786_390_000_000
  // Qiita は epoch 秒で `rate-reset` を返す(2026-08-11 に実際に受けた形)。
  assert.equal(resetAtMs(new Headers({ "rate-reset": "1786393192" }), now), 1_786_393_192_000)
  assert.equal(resetAtMs(new Headers({ "x-ratelimit-reset": "1786393192" }), now), 1_786_393_192_000)
  // retry-after は秒数でも日付でも来る。
  assert.equal(resetAtMs(new Headers({ "retry-after": "60" }), now), now + 60_000)
  assert.equal(
    resetAtMs(new Headers({ "retry-after": "Tue, 11 Aug 2026 00:00:00 GMT" }), now),
    Date.parse("2026-08-11T00:00:00Z"),
  )
  // 過ぎた時刻や、桁の違う値(ms で寄越す先)は使わない。24時間より先も見ない。
  assert.equal(resetAtMs(new Headers({ "rate-reset": "1786380000" }), now), undefined)
  assert.equal(resetAtMs(new Headers({ "rate-reset": "1786393192000" }), now), undefined)
  assert.equal(resetAtMs(new Headers({}), now), undefined)
})

/**
 * ここから下の2つは順番に依存する。**回数制限に当たった記録は過程に残る**ので、
 * 絞り込みを外す側を先に置く(逆にすると qiita が休んでいて引けない)。
 */
/** qiita を1回叩き、投げた URL を全部返す。 */
async function qiitaCalls(term: string, body: (url: string) => string): Promise<readonly string[]> {
  const original = globalThis.fetch
  const called: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input)
    called.push(url)
    return new Response(body(url), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  try {
    await searchWeb(term, { where: ["qiita"] })
    return called
  } finally {
    globalThis.fetch = original
  }
}

test("zenn — 長すぎる語は 100 文字で切る(101 文字だと 400 が返る)", async () => {
  const original = globalThis.fetch
  const called: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    called.push(typeof input === "string" ? input : String((input as { url?: string }).url ?? input))
    return new Response('{"articles":[]}', { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  try {
    // 実測で落ちたのはこの形 — モデルが語を並べて 100 文字を越えた。
    const long =
      "vite plugin environment api migration hotupdate handlehotupdate breaking change guide ".repeat(3)
    await searchWeb(long, { where: ["zenn"] })
    const sent = decodeURIComponent(new URL(called[0] ?? "https://x/").searchParams.get("q") ?? "")
    assert.ok([...sent].length <= 100, `100 文字を越えている: ${[...sent].length}`)
    // 語の途中では切らない。半端な語尾(`environm`)を投げても当たらないので、
    // **元の語の頭からの並びで、次が空白になる位置**で止まっていることを見る。
    assert.ok(long.startsWith(sent), "元の語の頭から切っていない")
    assert.equal(long[sent.length], " ", `語の途中で切れている: …${sent.slice(-12)}`)

    // 全角でも数えるのは文字。300 バイトあっても 100 文字なら切らない。
    called.length = 0
    await searchWeb("あ".repeat(100), { where: ["zenn"] })
    const ja = decodeURIComponent(new URL(called[0] ?? "https://x/").searchParams.get("q") ?? "")
    assert.equal([...ja].length, 100, "全角100文字は通る(実測で 200)")
  } finally {
    globalThis.fetch = original
  }
})

test("日本語の語は、0件なら絞りを外してもう一度だけ引く(狭い話題を落とさない)", async () => {
  // 絞り込み付きは 0 件で、外したほうに1件ある形。実測「SQLite FTS5 trigram」がこれだった。
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
  // 実測: 英語の識別子で引く回は `stocks:>10` が 25回中 21回 0件を返し、
  // そのたびに引き直して 1問 46 リクエスト → `rate-remaining: 0`。絞る意味が無い語では絞らない。
  const called = await qiitaCalls("files.includes --locked", () => "[]")
  assert.equal(called.length, 1, "0件でも2回目を出さない")
  assert.ok(!called[0]?.includes("stocks"), "最初から絞らない")
})

test("回数制限に当たった先は、解けるまで叩かない", async () => {
  // 実測: 端から端まで1回動かしただけで Qiita の無認証枠 60回/時を使い切り、
  // 以後その時間帯は全部 403 で返った。理由が「HTTP 403」だけだと、待てば戻るのか
  // 弾かれたのかが読む側に分からない。
  const original = globalThis.fetch
  let calls = 0
  const resetEpoch = Math.floor(Date.now() / 1000) + 1800
  globalThis.fetch = (async () => {
    calls++
    return new Response('{"message":"Rate limit exceeded","type":"rate_limit_exceeded"}', {
      status: 403,
      headers: { "content-type": "application/json", "rate-reset": String(resetEpoch) },
    })
  }) as unknown as typeof fetch
  try {
    const first = await searchWeb("Effect", { where: ["qiita"] })
    assert.equal(calls, 1)
    assert.match(first[0]?.failed ?? "", /回数制限に当たった/)
    // 解除時刻はユーザーの時計で見せる。
    assert.match(first[0]?.failed ?? "", /\d{4}-\d{2}-\d{2} \d{2}:\d{2} まで/)

    const second = await searchWeb("別の語", { where: ["qiita"] })
    assert.equal(calls, 1, "休んでいる間は外へ出ない")
    assert.match(second[0]?.failed ?? "", /回数制限中/)
  } finally {
    globalThis.fetch = original
  }
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
  // 重なった項は URL を繰り返さない(1回だけ出る)。
  assert.equal(text.split("https://example.com/a").length - 1, 1)
  assert.match(text, /## qiita — 0件/)
  assert.match(text, /## web — 引けなかった\(BRAVE_API_KEY が無いので引けない\)/)
})

/** 先を1つ名指しで叩き、投げた URL を全部返す。応答は同じ本文を返す。 */
async function urlsFor(source: string, term: string, body: string): Promise<readonly string[]> {
  const original = globalThis.fetch
  const called: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    called.push(typeof input === "string" ? input : String((input as { url?: string }).url ?? input))
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  try {
    await searchWeb(term, { where: [source] })
    return called
  } finally {
    globalThis.fetch = original
  }
}

test("x — site:x.com は実装が付ける。呼ぶ側が書いた site: と競合させない", async () => {
  // X 本体は robots で全部断られている(`x.com`・`cdn.syndication.twimg.com`・
  // `publish.x.com/oembed` の3つとも 2026-08-11 に確認)。**取りに行くのは SearXNG だけ。**
  const called = await urlsFor("x", 'site:zenn.dev "Effect" schema', '{"results":[]}')
  assert.equal(called.length, 1)
  const q = new URL(called[0] ?? "http://x/").searchParams.get("q") ?? ""
  assert.ok(q.startsWith("site:x.com "), `site:x.com で始まっていない: ${q}`)
  // 呼ぶ側の `site:zenn.dev` は落ちている。残ると 2つの site: で 0 件になる。
  assert.ok(!q.includes("zenn.dev"), `別の site: が残っている: ${q}`)
  assert.ok(q.includes("schema"), `語が消えている: ${q}`)
  // 自前のサーバなので、外向きの制限を免除する origin が付いている。
  assert.ok(called[0]?.startsWith("http://127.0.0.1:8888/"), `SearXNG 以外へ出た: ${called[0]}`)
})

test("x — from:名前 と @名前 は、その人の投稿だけに絞る", async () => {
  // 実測: `site:x.com/youyuxi` は 12件が 12件とも本人。`site:x.com from:youyuxi` は
  // 30件中 15件が投稿でそれは全部本人、`site:x.com @youyuxi` は 31件中 14件のうち本人が 11件。
  // **path に入れる形が一番外さない**ので、どちらの書き方も path に直す。
  for (const term of ["from:youyuxi Environment API", "@youyuxi Environment API"]) {
    const called = await urlsFor("x", term, '{"results":[]}')
    const q = new URL(called[0] ?? "http://x/").searchParams.get("q") ?? ""
    assert.equal(q, "site:x.com/youyuxi Environment API", `${term} → ${q}`)
  }
  // 名前だけを渡したときも組める(語が空になっても壊さない)。
  const only = await urlsFor("x", "from:patak_dev", '{"results":[]}')
  assert.equal(new URL(only[0] ?? "http://x/").searchParams.get("q"), "site:x.com/patak_dev")
  // メールアドレスの `@` を口座名と取り違えない(前が空白でないので当たらない)。
  const mail = await urlsFor("x", "haru@example.com の障害", '{"results":[]}')
  assert.equal(new URL(mail[0] ?? "http://x/").searchParams.get("q"), "site:x.com haru@example.com の障害")
})

test("x — 投稿の本文は SearXNG の要約から来る(こちらは x.com を叩かない)", () => {
  // 欄名と値は 2026-08-11 に `site:x.com Effect TS schema` が実際に返した形から取った。
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
  // いくつの索引が拾ったか、と本文。**本文が要約に入ることがこの先の値打ち**なので、落とさない。
  assert.match(hits[0]?.note ?? "", /2索引/)
  assert.match(hits[0]?.note ?? "", /115 likes 4 replies/)
})

test("x の結果には読み方を添える(要約を捨てさせない)", () => {
  // 実測(端から端まで4回目): この一行が無かった回、外を見る役は
  // 「索引に出た要約はあるが、それは原文じゃないので引用として使わない」と書いて、
  // **取れていた投稿本文を捨てた**。道具の説明の「要約を事実として書かない」が逆に働いた。
  const text = renderHits([
    { source: "x", hits: [{ title: "投稿", url: "https://x.com/haru/status/1", note: "2索引 / 本文" }] },
    { source: "hn", hits: [{ title: "記事", url: "https://example.com/a" }] },
  ])
  const x = text.slice(text.indexOf("## x"), text.indexOf("## hn"))
  assert.match(x, /要約は投稿の本文そのもの/)
  assert.match(x, /断片/, "頭から全部ではないことを言っていない")
  // 読み方が要らない先には出さない。
  assert.ok(!text.slice(text.indexOf("## hn")).includes("要約は投稿の本文"), "hn にまで出ている")
})

test("web に site:x.com と書かれたら x の先で受ける", async () => {
  // 実測(端から端まで2回): 道具の説明に `where: ["x"]` と書いた後でも、
  // モデルは 12 回とも `web` に `site:x.com/youyuxi ...` と書いてきた。**書き方のほうを受ける。**
  const called = await urlsFor("web", "site:x.com/youyuxi Environment API", '{"results":[]}')
  assert.equal(called.length, 1, "外向きの回数は増やさない")
  assert.equal(new URL(called[0] ?? "http://x/").searchParams.get("q"), "site:x.com/youyuxi Environment API")
  // 名前無しの `site:x.com` でも回る。
  const plain = await urlsFor("web", "site:x.com Effect schema", '{"results":[]}')
  assert.equal(new URL(plain[0] ?? "http://x/").searchParams.get("q"), "site:x.com Effect schema")
})

test("web に site: が2つあるときは回さない(X に寄せるのは行き過ぎ)", async () => {
  const called = await urlsFor("web", "site:x.com site:zenn.dev Effect", '{"results":[]}')
  // `web` のまま。語も落とさずそのまま渡る(`qualifiers: true`)。
  assert.equal(new URL(called[0] ?? "http://x/").searchParams.get("q"), "site:x.com site:zenn.dev Effect")
})

test("回した先は x として返る(どこから来たかを読む側に見せる)", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [
          { url: "https://x.com/youyuxi/status/9", title: "投稿", content: "中身", engines: ["bing"] },
          { url: "https://vite.dev/guide/", title: "site: を守らなかった索引の結果" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch
  try {
    const r = await searchWeb("site:x.com Vite", { where: ["web"] })
    assert.equal(r[0]?.source, "x", "web のまま返している")
    // **回した値打ちはここ** — 頼んだのが site:x.com なら vite.dev はどのみち間違い。
    assert.deepEqual(
      r[0]?.hits.map((h) => h.url),
      ["https://x.com/youyuxi/status/9"],
    )
  } finally {
    globalThis.fetch = original
  }
})

test("x — 投稿でない項は落とす(site:x.com を守らない索引が混ざる)", () => {
  // 実測: 6問 268 件のうち 113 件が投稿でなかった。**混ざっていた実物**を並べる。
  const hits = parse("x", {
    results: [
      { url: "https://x.com/youyuxi/status/1904855853037215958", title: "残る", content: "本文" },
      { url: "https://twitter.com/EffectTS_/status/1848719287013544194", title: "残る(旧ドメイン)" },
      // 索引が `site:` を無視して返した、x.com ですらないページ。
      { url: "https://vite.dev/guide/", title: "落ちる — 別のドメイン" },
      { url: "https://en.wikipedia.org/wiki/Vite", title: "落ちる — 別のドメイン" },
      // x.com だが投稿の永久リンクではない。説明が無いか、案内ページ。
      { url: "https://x.com/?lang=ja", title: "落ちる — 入口のページ" },
      { url: "https://developer.x.com/", title: "落ちる — 別のホスト" },
      { url: "https://x.com/YandR_CBS", title: "落ちる — 個人ページ" },
      { url: "https://x.com/i/trending/2032170876888850542", title: "落ちる — 永久リンクではない" },
      // ホスト名を装った URL を通さない。
      { url: "https://x.com.evil.test/haru/status/1", title: "落ちる — 別のホスト" },
    ],
  })
  assert.deepEqual(
    hits.map((h) => h.title),
    ["残る", "残る(旧ドメイン)"],
  )
})

test("x — 殻を拾った要約は外す。ただし題に中身が残っているなら項は残す", () => {
  // 実測: 8問 162 件のうち 28 件(17%)の要約がログイン前の画面の文言だった。
  // `site:x.com/mizchi TypeScript` の1問では 29 件中 12 件。
  const hits = parse("x", {
    results: [
      {
        url: "https://x.com/mizchi/status/1",
        title: 'mizchi on X: "TypeScript でオレオレ Result 型を使うのをやめた',
        content: "We’ve detected that JavaScript is disabled in this browser.",
        engines: ["bing"],
      },
      // 題も名乗りだけ。要約を外すと何も残らないので落とす(x.com は開きに行かない)。
      {
        url: "https://x.com/mizchi/status/2",
        title: "mizchi on X",
        content: "JavaScript is not available · We’ve detected that",
        engines: ["bing"],
      },
      // 同じ投稿が別の URL で来る回。id で1つに畳む。
      { url: "https://x.com/youyuxi/status/3", title: "本物", content: "中身", engines: ["bing"] },
      { url: "https://x.com/evanyou/status/3?lang=ca", title: "同じ投稿", content: "中身", engines: ["a"] },
    ],
  })
  assert.equal(hits.length, 2)
  // 題は残り、定型文は目印から消えている。索引の数は残す。
  assert.match(hits[0]?.title ?? "", /オレオレ Result 型/)
  assert.equal(hits[0]?.note, "1索引")
  assert.ok(!(hits[0]?.note ?? "").includes("JavaScript"), "定型文が残っている")
  // 二重に出た投稿は最初の1つだけ。
  assert.equal(hits[1]?.url, "https://x.com/youyuxi/status/3")
})

test("showhn — hn と同じ API に tags=show_hn を足すだけ(枠も鍵も増やさない)", async () => {
  const called = await urlsFor("showhn", "AI agent", '{"hits":[]}')
  assert.equal(called.length, 1)
  const u = new URL(called[0] ?? "http://x/")
  assert.equal(u.host, "hn.algolia.com")
  assert.equal(u.searchParams.get("tags"), "show_hn")
  // 新着順の API ではない。`search_by_date` にすると語が効かなくなる(`showhn` の注)。
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
  // 端から端まで動かすと、モデルは `where: ["showhn"]` ではなく
  // `hn` に `query=Show HN AI agent` と書いてきた(673秒のランで `tags=show_hn` は 0 回)。
  const 書き方: readonly [string, string][] = [
    ["Show HN AI agent", "AI agent"],
    ["show hn: AI agent", "AI agent"],
    ["AI agent show-hn", "AI agent"],
    // 残りの語の引用符は外さない — Algolia は句として読む。
    ['Show HN "AI agent"', '"AI agent"'],
  ]
  for (const [q, want] of 書き方) {
    const called = await urlsFor("hn", q, '{"hits":[]}')
    const u = new URL(called[0] ?? "http://x/")
    assert.equal(u.searchParams.get("tags"), "show_hn", `タグで絞っていない: ${q}`)
    // **2語は落とす。** 語として残すと近接ランキングがそこに引かれる(`toShowHnTerm` の注)。
    assert.equal(u.searchParams.get("query"), want, `語を直していない: ${q}`)
  }
})

test("引用符ごと括られていても、文の途中でも受ける", async () => {
  // すり抜けた実物(784秒のラン、4回)。`site:` は `plainQuery` が落とすので語には残らない。
  const q = 'site:news.ycombinator.com/item "Show HN" "agent" "2026-08"'
  const u = new URL((await urlsFor("hn", q, '{"hits":[]}'))[0] ?? "http://x/")
  assert.equal(u.searchParams.get("tags"), "show_hn", "文中の引用符付きを取り逃した")
  // 残りの語の引用符は外さない — Algolia は句として読む。
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
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        hits: [{ objectID: "1", title: "Show HN: Alacritty", url: "https://a/", points: 1170 }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch
  try {
    const r = await searchWeb("Show HN terminal", { where: ["hn"] })
    assert.equal(r[0]?.source, "showhn", "hn のまま返している")
  } finally {
    globalThis.fetch = original
  }
})

test("仕事を探す語なら、web と並べて job も出す(置き換えない)", async () => {
  const original = globalThis.fetch
  const called: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    called.push(String(input))
    return new Response('{"results":[]}', { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  try {
    const r = await searchWeb("React 副業 週2", { where: ["web"] })
    assert.deepEqual(
      r.map((x) => x.source),
      ["web", "job"],
      "web を落としたか、job を足していない",
    )
    // 媒体選びの調査(web)と募集そのもの(job)は別の問い。両方要る。
    assert.ok(
      called.some((u) => !u.includes("site%3Acrowdworks")),
      "web の API を叩いていない",
    )
  } finally {
    globalThis.fetch = original
  }
})

test("仕事と関係ない語では job を足さない", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"results":[]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
  try {
    const r = await searchWeb("React Server Components", { where: ["web"] })
    assert.deepEqual(
      r.map((x) => x.source),
      ["web"],
    )
  } finally {
    globalThis.fetch = original
  }
})

test("job — 媒体ごとに問い合わせを分けて引く", async () => {
  const called = await urlsFor("job", "React 週2", '{"results":[]}')
  // 1媒体ずつ投げる。`(site:a OR site:b)` は索引が潰す(`job` の注)。
  const qs = called.map((u) => new URL(u).searchParams)
  assert.deepEqual(
    qs.map((p) => (p.get("q") ?? "").replace(/ React 週2$/, "")),
    ["site:crowdworks.jp/public/jobs", "site:lancers.jp/work/detail", "site:www.wantedly.com/projects"],
  )
})

test("job — 期間で絞らない(絞ると語が当たらなくなる)", async () => {
  // 週で絞ると「React フロントエンド 週1 リモート」の上位が経理・OCR校正になり、
  // 募集ページかつ語が当たりかつ受付中は 2件 対 23件で絞りなしが上だった(`job` の注)。
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
  // 「Offers 手数料 審査 スカウト 応募 公式 副業」から媒体名と調査語を落とすと「副業」だけ残る。
  // 技術も職種も無いので、引いても無関係な募集が返るだけ。
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('{"results":[]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
  try {
    const r = await searchWeb("Offers 手数料 審査 スカウト 応募 公式 副業", { where: ["web"] })
    assert.deepEqual(
      r.map((x) => x.source),
      ["web"],
    )
  } finally {
    globalThis.fetch = original
  }
})

test("job — 媒体をまたいで ID を比べない(桁が違うだけで順が壊れる)", () => {
  const hits = parse("job", {
    results: [
      { url: "https://www.wantedly.com/projects/2526090", title: "Wantedly の新しいの", content: "本文" },
      { url: "https://crowdworks.jp/public/jobs/13372848", title: "cw の新しいの", content: "本文" },
      { url: "https://www.wantedly.com/projects/1115396", title: "Wantedly の古いの", content: "本文" },
    ],
  })
  // Wantedly の ID(7桁)は cw の ID(8桁)より必ず小さい。混ぜて並べると媒体で分かれてしまう。
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
  // 名指しでは引ける。
  assert.ok(parseFrom("x", '{"results":[]}'), "x を名指しで呼べない")
  assert.ok(parseFrom("showhn", '{"hits":[]}'), "showhn を名指しで呼べない")
  assert.ok(parseFrom("job", '{"results":[]}'), "job を名指しで呼べない")
})
