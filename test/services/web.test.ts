import assert from "node:assert/strict"
import fc from "fast-check"
import { test, vi } from "vitest"
import { withFetch } from "../helpers.ts"

// denyReason は node:dns/promises で名前解決する。外に出ないよう差し替える。
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => (host === "example.com" ? [{ address: "93.184.216.34", family: 4 }] : []),
}))

import {
  deniedByName,
  denyReason,
  detour,
  fetchPage,
  findIn,
  isPrivateAddress,
} from "../../src/services/Web.ts"

// fetch は差し替え済みなので、同じホストへの接続間隔を待たない。
process.env.FAMULUS_HOST_INTERVAL_MS = "0"
test("内側のアドレスは数値で弾く(前方一致では取り違える)", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // クラウドの instance metadata で使われる link-local
    "100.72.193.4", // このホストの Tailscale アドレス
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, `内側のはず: ${ip}`)
  }

  // 前方一致だと巻き込む外のアドレス。100.1.1.1 は CGNAT ではなく、172.32 は私設ではない。
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

test("内側を指す名前の拒否は大文字小文字に依存しない", () => {
  fc.assert(
    fc.property(fc.stringMatching(/^[a-z0-9]{1,20}$/), fc.boolean(), (label, upper) => {
      const host = `${label}.local`
      const varied = upper ? host.toUpperCase() : host
      assert.equal(deniedByName(varied), `内側の名前: ${host}`)
    }),
    { numRuns: 500 },
  )
})

test("http と非 http は取らない", async () => {
  // file: や data: でローカルを読ませない。
  assert.match((await denyReason("http://example.com")) ?? "", /https 以外/)
  assert.match((await denyReason("file:///etc/passwd")) ?? "", /https 以外/)
  assert.match((await denyReason("data:text/html,x")) ?? "", /https 以外/)
  assert.ok(await denyReason("これは URL ではない"))
  // 内側の判定は名前解決の前に済むので、この確認はネットワークに触らない。
  assert.match((await denyReason("https://127.0.0.1:8080/admin")) ?? "", /内側/)
  assert.match((await denyReason("https://localhost/")) ?? "", /localhost/)
})

test("詰まる先には回り道を返す(実測した先だけ)", () => {
  assert.match(detour("https://www.npmjs.com/package/effect") ?? "", /registry\.npmjs\.org\/effect\/latest/)
  const x = detour("https://x.com/youyuxi/status/1904855853037215958") ?? ""
  assert.match(x, /robots/, "断られている先だと言っていない")
  assert.match(x, /where: \["x"\]/, "読める道を示していない")
  assert.match(x, /from:youyuxi/, "URL に入っている書き手を活かしていない")
  const top = detour("https://x.com/someone") ?? ""
  assert.match(top, /where: \["x"\]/)
  assert.ok(!top.includes("from:"), `絞りを組めないのに勧めている: ${top}`)

  assert.match(
    detour("https://stackoverflow.com/questions/tagged/typescript") ?? "",
    /stackoverflow\.com\/feeds\/tag\/typescript/,
  )
  assert.match(detour("https://www.reddit.com/r/typescript/") ?? "", /reddit\.com\/r\/typescript\/\.rss/)

  assert.match(detour("https://www.techmeme.com/") ?? "", /techmeme\.com\/feed\.xml/)
  assert.match(detour("https://huggingface.co/papers") ?? "", /api\/daily_papers\?limit=20/)
  // 論文1件のページは測っていないので回り道を書かない。
  assert.equal(detour("https://huggingface.co/papers/2608.14106"), undefined)
  assert.match(detour("https://zenn.dev/topics/typescript") ?? "", /zenn\.dev\/topics\/typescript\/feed/)
  assert.match(detour("https://qiita.com/tags/typescript") ?? "", /qiita\.com\/tags\/typescript\/feed/)

  const pdf = detour("https://arxiv.org/pdf/1706.03762") ?? ""
  assert.match(pdf, /arxiv\.org\/abs\/1706\.03762/)
  assert.match(pdf, /arxiv\.org\/html\/1706\.03762/)
  assert.match(detour("https://arxiv.org/pdf/2401.00368v2.pdf") ?? "", /abs\/2401\.00368v2/)

  assert.match(
    detour("https://laws.e-gov.go.jp/law/322AC0000000049") ?? "",
    /laws\.e-gov\.go\.jp\/api\/1\/lawdata\/322AC0000000049/,
  )
  assert.match(
    detour("https://github.com/Effect-TS/effect/issues/1") ?? "",
    /api\.github\.com\/repos\/Effect-TS\/effect\/issues\/1/,
  )
  assert.match(detour("https://github.com/Effect-TS/effect/pull/42") ?? "", /api\.github\.com\/.+\/pulls\/42/)
  assert.match(
    detour("https://bsky.app/profile/bsky.app") ?? "",
    /public\.api\.bsky\.app\/xrpc\/.+actor=bsky\.app/,
  )
  assert.match(detour("https://mastodon.social/@Gargron") ?? "", /mastodon\.social\/@Gargron\.rss/)
  assert.match(detour("https://note.com/someone") ?? "", /note\.com\/someone\/rss/)
  assert.match(
    detour("https://www.youtube.com/watch?v=dQw4w9WgXcQ") ?? "",
    /youtube\.com\/oembed\?url=.+dQw4w9WgXcQ/,
  )

  const repo = detour("https://github.com/Effect-TS/effect") ?? ""
  assert.doesNotMatch(repo, /raw\.githubusercontent\.com/, "入っているものを「無い」と言わない")
  assert.match(repo, /README は入っている/)
  assert.match(repo, /api\.github\.com\/repos\/Effect-TS\/effect\/contents/)
  assert.match(detour("https://github.com/Effect-TS/effect/issues/1") ?? "", /題と本文は入っている/)

  assert.match(
    detour("https://github.com/Effect-TS/effect/tree/main/packages") ?? "",
    /api\.github\.com\/repos\/Effect-TS\/effect\/contents\/packages\?ref=main/,
  )
  const code = detour("https://github.com/search?q=effect&type=code") ?? ""
  assert.match(code, /401|鍵が要る/)
  assert.doesNotMatch(code, /https:\/\/api\.github\.com\/search\/code/, "401 が返る先へ案内しない")
  assert.match(
    detour("https://github.com/search?q=effect") ?? "",
    /api\.github\.com\/search\/repositories\?q=effect/,
  )
  assert.match(detour("https://zenn.dev/mizchi") ?? "", /zenn\.dev\/mizchi\/feed/)
  assert.match(detour("https://qiita.com/mizchi") ?? "", /qiita\.com\/mizchi\/feed/)

  assert.equal(detour("https://example.com/a"), undefined)
  assert.equal(detour("https://github.com/Effect-TS/effect/issues"), undefined)
  assert.equal(detour("https://www.youtube.com/results?search_query=a"), undefined)
  assert.equal(detour("https://zenn.dev/someone/articles/abc123"), undefined)
  assert.equal(detour("https://qiita.com/someone/items/abc123"), undefined)
  assert.equal(detour("https://stackoverflow.com/questions/12345/how-to"), undefined)
})

test("そっくりなホスト名を本物と取り違えない", () => {
  // endsWith だと evilqiita.com も当たり、別人のページを本物の記事一覧として案内する。ドットまで見る。
  for (const host of ["evilqiita.com", "notgithub.com", "myreddit.com", "fake-note.com", "xarxiv.org"]) {
    assert.equal(detour(`https://${host}/someone`), undefined, host)
    assert.equal(detour(`https://${host}/o/r`), undefined, host)
  }
  assert.match(detour("https://old.reddit.com/r/typescript/") ?? "", /reddit\.com\/r\/typescript\/\.rss/)
  assert.match(
    detour("https://ja.stackoverflow.com/questions/tagged/typescript") ?? "",
    /feeds\/tag\/typescript/,
  )
})

test("同じ URL を続けて開いたら取りに行かず「さっき開いた」と返す", async () => {
  let hits = 0
  await withFetch(
    async () => {
      hits++
      return new Response("<html><body>本文</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    },
    async () => {
      const url = `https://example.com/memo-${Math.random().toString(36).slice(2)}`
      const t0 = 1_000_000
      const a = await fetchPage(url, { nowMs: t0 })
      const b = await fetchPage(url, { nowMs: t0 + 3_000 })
      assert.equal(hits, 1, "2回目は取りに行かない")
      assert.equal(b.text, a.text)
      assert.match(b.note ?? "", /3 秒前にも開いた/)
      assert.equal(a.note, undefined, "1回目には付けない")

      const c = await fetchPage(url, { nowMs: t0 + 6 * 60_000 })
      assert.equal(hits, 2)
      assert.equal(c.note, undefined)
    },
  )
})

test("続きを読むのに取り直さない(全文を覚えて切り出す)", async () => {
  let hits = 0
  const body = "あ".repeat(30_000)
  await withFetch(
    async () => {
      hits++
      return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })
    },
    async () => {
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

      const past = await fetchPage(url, { offset: 60_000, nowMs: t0 + 3_000 })
      assert.equal(past.text, "")
      assert.match(past.note ?? "", /先は無い/)

      const again = await fetchPage(url, { offset: 12_000, nowMs: t0 + 4_000 })
      assert.equal(hits, 1)
      assert.match(again.note ?? "", /3 秒前にも開いた/)
    },
  )
})

test("大きいページは固定長の範囲を順に読まず、語で検索する", () => {
  const full = `${"x".repeat(50_000)}"3.22.1":"2026-07-30T04:29:21.637Z"${"y".repeat(50_000)}`
  const hit = findIn(full, "3.22.1")
  assert.equal(hit.count, 1)
  assert.match(hit.text, /1か所/)
  assert.match(hit.text, /\[49701字目\]/, "当たりの位置を返す(次にどこを読むか決められる)")
  assert.match(hit.text, /2026-07-30T04:29:21\.637Z/)
  assert.ok(hit.text.length < 12_000)

  assert.equal(findIn(full, "4.0.0").count, 0)
  assert.equal(findIn(full, "4.0.0").text, "")

  assert.equal(findIn("Effect EFFECT effect", "effect").count, 3)
})

test("全文検索は大文字小文字を問わず、重ならない一致を同じ件数で数える", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom("ab", "AB", "aB", "Ab"), { maxLength: 199 }), (matches) => {
      const full = matches.length === 0 ? "xyz" : matches.join("!")
      const hit = findIn(full, "ab")
      assert.equal(hit.count, matches.length)
      assert.equal(hit.text === "", matches.length === 0)
      assert.ok(hit.text.length <= 12_000)
    }),
    { numRuns: 500 },
  )
})

test("find は取りに行かず、覚えた全文の中を探す", async () => {
  let hits = 0
  const body = `{"time":{"3.22.0":"2026-07-13","3.22.1":"2026-07-30"},"pad":"${"z".repeat(40_000)}"}`
  await withFetch(
    async () => {
      hits++
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    },
    async () => {
      const url = `https://example.com/reg-${Math.random().toString(36).slice(2)}`
      const t0 = 3_000_000
      const first = await fetchPage(url, { nowMs: t0 })
      assert.match(first.note ?? "", /12000字ずつ頭から読むと 4 回/)
      assert.match(first.note ?? "", /`find` に語を渡す/)

      const found = await fetchPage(url, { find: "3.22.1", nowMs: t0 + 1_000 })
      assert.equal(hits, 1, "探すのに取り直さない")
      assert.match(found.text, /2026-07-30/)
      assert.equal(found.truncated, false)

      const missing = await fetchPage(url, { find: "9.9.9", nowMs: t0 + 2_000 })
      assert.equal(hits, 1)
      assert.equal(missing.text, "")
      assert.match(missing.note ?? "", /「9\.9\.9」はこのページ.*に無い/)
    },
  )
})

test("本文が頭 400KB より後ろにあるページも読む", async () => {
  const filler = `<script>${"var x=1;".repeat(60_000)}</script>` // 約 480KB
  // 本文は 2,000字を超える長さにする。短いと「薄い」の判定に当たり、読めたことを確かめられない。
  const article = "お知らせ 令和8年の支援の取組。".repeat(200)
  const body = `<html><head>${filler}<title>都庁総合ホームページ</title></head><body><main>${article}</main></body></html>`
  await withFetch(
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    async () => {
      const p = await fetchPage(`https://example.com/heavy-${Math.random().toString(36).slice(2)}`, {
        nowMs: 3_000_000,
      })
      assert.match(p.text, /お知らせ 令和8年の支援の取組。/, "400KB の JS の後ろにある本文が読めている")
      assert.match(p.text, /都庁総合ホームページ/, "同じく後ろにある題も読めている")
      assert.doesNotMatch(p.text, /var x=1/, "JS そのものは本文に混ぜない")
      assert.equal(p.note, undefined, "読めたページに「薄い」とは言わない")
    },
  )
})

test("上限で切ったときは、切ったと分かる言い方をする", async () => {
  // 期待する文面の上限の数字は定数から作られるので、定数を上げたらここも変わる。
  const body = `<html><head><script>${"var y=2;".repeat(200_000)}</script></head><body><main>ここまで届かない</main></body></html>`
  await withFetch(
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    async () => {
      const p = await fetchPage(`https://example.com/huge-${Math.random().toString(36).slice(2)}`, {
        nowMs: 4_000_000,
      })
      assert.equal(p.text, "", "閉じない script は本文にしない")
      assert.equal(p.truncated, true, "上限で切ったページは、全部は読めていないと伝える")
      assert.match(p.note ?? "", /本文がほとんど無い/)
      assert.match(p.note ?? "", /頭 1500KB を読んだ範囲に本文が無かった/)
    },
  )
})

test("読めているページに「別を当たれ」と言わない", async () => {
  const shell = `<script>${"var z=3;".repeat(12_000)}</script>` // 約 96KB
  const page = (main: string) =>
    `<html><head>${shell}<title>天気</title></head><body><main>${main}</main></body></html>`
  let html = ""
  const serve = (h: string) => {
    html = h
  }
  await withFetch(
    async () =>
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    async () => {
      serve(page("東京地方の天気は晴れのち曇り。".repeat(80))) // 約 1,100字
      const slim = await fetchPage(`https://example.com/slim-${Math.random().toString(36).slice(2)}`, {
        nowMs: 5_000_000,
      })
      assert.match(slim.text, /東京地方の天気は晴れのち曇り。/)
      assert.match(slim.note ?? "", /読めたのは 1\d\d\d字/)
      assert.doesNotMatch(slim.note ?? "", /^本文がほとんど無い/)

      serve(page("読み込み中"))
      const empty = await fetchPage(`https://example.com/empty-${Math.random().toString(36).slice(2)}`, {
        nowMs: 5_001_000,
      })
      assert.match(empty.note ?? "", /本文がほとんど無い/)
      assert.match(empty.note ?? "", /別の出典を当たったほうが早い/)
    },
  )
})
