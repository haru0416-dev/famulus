/**
 * URL をまだ知らないときの検索。相手がプログラム向けに出している API だけを使い、robots や CAPTCHA で断る入口は使わない。
 * 一般 web は自前の SearXNG 経由。X は x.com に接続せず、SearXNG で `site:x.com` の索引の要約を読む。
 * 回数制限に当たった先は解除時刻まで外す。鍵は置き場所とユーザーの同意が決まるまで入れない。
 */
import { appConfig } from "../core/config.ts"
import { localStamp } from "../core/time.ts"
import { fetchRaw } from "./Web.ts"

/** 本文は入れない。開くかどうかを決めるのに要るものだけ。 */
export interface Hit {
  readonly title: string
  readonly url: string
  readonly by?: string
  /** ISO のまま持ち、見せるときにユーザーの時計へ直す。 */
  readonly at?: string
  readonly note?: string
}

export interface SourceResult {
  readonly source: string
  readonly hits: readonly Hit[]
  readonly failed?: string
}

interface Source {
  readonly name: string
  /** 道具の説明文に出す。 */
  readonly what: string
  /** 他の先と読み方が違う先にだけ書く。道具の説明に書くだけでは結果を読むときに効かない。 */
  readonly reading?: string
  /** 配列を返すとまとめて呼んで1つの先として返す。`site:` を1媒体ずつ渡さないと当たらない先用。 */
  readonly url: (q: string, n: number) => string | readonly string[]
  /** 0件のとき絞り込みを外して一度だけ試す。絞っていない語では `undefined` を返し、同じ問いで枠を使わない。 */
  readonly broaden?: (q: string, n: number) => string | readonly string[] | undefined
  readonly parse: (body: string) => readonly Hit[]
  /** 検索式を受けない先(feed)用。取ってから語で絞る。検索できる先には書かない。 */
  readonly sift?: (q: string, hits: readonly Hit[]) => readonly Hit[]
  readonly wide: boolean
  readonly accept?: string
  /** 返せば既定から外れ、名指しされたらこの文言を返す。呼ぶたびに Config を評価する。 */
  readonly unavailable?: () => string | undefined
  /** 通らない先へは `site:` などの構文を落として渡す。 */
  readonly qualifiers?: boolean
  /** 自前サーバの origin。`Web.ts` の内側判定をここだけ免除する。問い合わせ文から組み立てない。 */
  readonly ownOrigin?: () => string
}

/**
 * API は `site:` を解さない(422 で断るか、語として読んで0件になる)。
 * 絞り込みしか書かれていなければ値のほうを語として残す。
 */
export function plainQuery(q: string): string {
  const stripped = q.replace(/\b(?:site|inurl|intitle|filetype|ext):\S+/gi, " ")
  const left = stripped.replace(/\s+/g, " ").trim()
  return (
    left ||
    q
      .replace(/\b(?:site|inurl|intitle|filetype|ext):/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

/** 形にならない語もそのまま渡す。API の 404 のほうが、こちらで黙って落とすより読める。 */
export const repoPath = (q: string): string => {
  const m = q
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .match(/^([\w.-]+)\/([\w.-]+)/)
  return m ? `${m[1]}/${m[2]}` : encodeURIComponent(q.trim())
}

/** 空にすると SearXNG を使う先が既定から外れる。 */
const searxngBase = (): string => appConfig().web.searxngBase ?? ""

const enc = encodeURIComponent
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const short = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const rows = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : []
const strs = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []
/** 途中で切れた JSON の配列から閉じている項だけを拾う。Qiita は本文を丸ごと返すので読み取り上限で末尾が欠ける。 */
function partialArray(body: string): readonly Record<string, unknown>[] {
  try {
    return rows(JSON.parse(body))
  } catch {
    /* 下で拾い直す */
  }
  const start = body.indexOf("[")
  if (start < 0) return []
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (esc) {
      esc = false
      continue
    }
    if (inStr) {
      if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === "{" || c === "[") depth++
    else if (c === "}" || c === "]") {
      depth--
      // 深さ 1(配列の直下)に戻った位置が1件の終わり。
      if (depth === 1) end = i + 1
    }
  }
  if (end < 0) return []
  try {
    return rows(JSON.parse(`${body.slice(start, end)}]`))
  } catch {
    return []
  }
}

/** 語の途中では切らない。半端な語尾では当たらない。 */
function clip(q: string, max: number): string {
  const chars = [...q]
  if (chars.length <= max) return q
  const cut = chars.slice(0, max).join("")
  const sp = cut.lastIndexOf(" ")
  return (sp > max / 2 ? cut.slice(0, sp) : cut).trim()
}

/** 片仮名だけの語も日本語として拾う。ローマ字の日本語は見ない。 */
const hasJa = (q: string): boolean => /[぀-ヿ㐀-鿿]/u.test(q)

/** 個別の募集ページが索引に入っている媒体だけ。 */
const JOB_SITES = [
  "crowdworks.jp/public/jobs",
  "lancers.jp/work/detail",
  "www.wantedly.com/projects",
] as const
/** `site:` を守らない索引が無関係なページを混ぜるので、募集ページの形だけ残す。 */
const JOB_PATHS: Record<string, RegExp> = {
  "crowdworks.jp": /^\/public\/jobs\/(\d+)$/,
  "lancers.jp": /^\/work\/detail\/(\d+)$/,
  "wantedly.com": /^\/projects\/(\d+)$/,
}

/** 索引が投稿ではなくログイン前の画面を拾ったときの要約。投稿の中身ではない。 */
const X_SHELL =
  /JavaScript is (?:disabled|not available)|The latest posts from|Something went wrong|site owner hides|Log in to X/i

/** 人の絞りは `site:x.com/名前` で掛ける。`from:` や `@` を語として渡すより本人以外が混ざらない。 */
function xQuery(q: string): string {
  const m = /(?:^|\s)(?:from:|@)([A-Za-z0-9_]{1,15})(?=\s|$)/.exec(q)
  const rest = m ? q.replace(m[0], " ").replace(/\s+/g, " ").trim() : q
  return `site:x.com${m ? `/${m[1]}` : ""} ${rest}`.trim()
}

/** `web` 宛ての `site:x.com` を `x` 用の語に直す。他の `site:` もあるなら X に寄せない。 */
function toXTerm(q: string): string | undefined {
  const m = /(?:^|\s)site:(?:www\.)?(?:x|twitter)\.com(?:\/([A-Za-z0-9_]{1,15}))?(?=\s|$)/i.exec(q)
  if (!m) return undefined
  const rest = q.replace(m[0], " ").replace(/\s+/g, " ").trim()
  if (/\bsite:/i.test(rest)) return undefined
  return m[1] ? `from:${m[1]} ${rest}`.trim() : rest
}

/**
 * 「Show HN」はタグで絞るので語から落とす。語に残すと順位がその2語に引かれる。
 * 語がそれだけなら空文字(Algolia は語なしでもタグで点数順の上位を返す)。
 */
function toShowHnTerm(q: string): string | undefined {
  const m = /(?:^|\s)["'“”]?show[\s._-]?hn\s*:?["'“”]?(?=\s|$)/i.exec(q)
  if (!m) return undefined
  // Algolia は `site:` を語として読む。
  return plainQuery(q.replace(m[0], " "))
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {}
const plain = (s: string): string =>
  s
    .replace(/<[^>]+>/g, "")
    // 数値実体を先に解く。`&amp;` を先に解くと `&amp;#x672C;` が二重に解ける。
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => {
      const c = Number.parseInt(h, 16)
      return c <= 0x10ffff ? String.fromCodePoint(c) : m
    })
    .replace(/&#(\d{1,7});/g, (m, d) => (Number(d) <= 0x10ffff ? String.fromCodePoint(Number(d)) : m))
    .replace(
      /&(?:amp|lt|gt|quot|#39);/g,
      (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m] ?? m,
    )
    .replace(/\s+/g, " ")
    .trim()

/** `content` が `undefined` を返せばその要約を落とす。 */
const searxngHits = (b: string, content?: (c: string) => string | undefined): readonly Hit[] =>
  rows(obj(JSON.parse(b)).results).flatMap((r) => {
    const url = str(r.url)
    const title = str(r.title)
    if (!url || !title) return []
    // 複数の索引が拾ったページを、1つだけが返した結果と区別する。
    const n = strs(r.engines).length
    const raw = str(r.content)
    const c = raw === undefined ? undefined : (content?.(raw) ?? (content ? undefined : raw))
    const note = [n > 0 ? `${n}索引` : "", c ? plain(c).slice(0, 140) : ""].filter(Boolean).join(" / ")
    // 読めない日付は捨てる(`localStamp` に渡すと崩れる)。
    const at = str(r.publishedDate)
    return [
      {
        title: plain(title),
        url,
        ...(at && !Number.isNaN(Date.parse(at)) ? { at: new Date(at).toISOString() } : {}),
        ...(note ? { note } : {}),
      },
    ]
  })

const hnHits = (b: string): readonly Hit[] =>
  rows(obj(JSON.parse(b)).hits).flatMap((r) => {
    const id = str(r.objectID)
    const title = str(r.title)
    if (!id || !title) return []
    const pts = num(r.points)
    const cmt = num(r.num_comments)
    const link = str(r.url)
    const note = [
      pts !== undefined ? `${pts}点` : "",
      cmt !== undefined ? `コメント${cmt}` : "",
      link ? `議論 https://news.ycombinator.com/item?id=${id}` : "",
    ]
      .filter(Boolean)
      .join(" / ")
    return [
      {
        title,
        url: link ?? `https://news.ycombinator.com/item?id=${id}`,
        ...(str(r.author) ? { by: str(r.author) as string } : {}),
        ...(str(r.created_at) ? { at: str(r.created_at) as string } : {}),
        ...(note ? { note } : {}),
      },
    ]
  })

/** `plain` のタグ除去が `<![CDATA[` を消すので先に解く。 */
const unCdata = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")

/** feed の中身は XML 実体で二重にエスケープされているので、解く → タグを落とす → もう一段解く。 */
const atomText = (s: string): string => plain(plain(unCdata(s)).replace(/<[^>]+>/g, " "))

/** XML パーサは持たないので、要る欄だけを正規表現で抜く。 */
const phHits = (b: string): readonly Hit[] =>
  [...b.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)].flatMap((m) => {
    const e = m[1] ?? ""
    const title = atomText(/<title[^>]*>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? "")
    const url = /<link[^>]*href="([^"]+)"/.exec(e)?.[1]
    if (!title || !url) return []
    const at = /<published>([^<]+)<\/published>/.exec(e)?.[1] ?? /<updated>([^<]+)<\/updated>/.exec(e)?.[1]
    const by = atomText(/<name>([\s\S]*?)<\/name>/.exec(e)?.[1] ?? "")
    // 末尾の「Discussion | Link」は feed が全項に付ける文字列で、中身ではない。
    const note = atomText(/<content[^>]*>([\s\S]*?)<\/content>/.exec(e)?.[1] ?? "")
      .replace(/\s*Discussion\s*\|\s*Link\s*$/i, "")
      .slice(0, 160)
    return [
      {
        title,
        url,
        ...(by ? { by } : {}),
        ...(at ? { at } : {}),
        ...(note ? { note } : {}),
      },
    ]
  })

const SOURCES: readonly Source[] = [
  {
    name: "web",
    what: "一般の web(自前の SearXNG が 9 の索引をまとめて引く)。上の先で当たらない話題はここ",
    // 一般の web を引ける唯一の先。
    wide: true,
    qualifiers: true,
    ownOrigin: searxngBase,
    unavailable: () =>
      searxngBase() ? undefined : "FAMULUS_SEARXNG が空にされている(SearXNG を使わない設定)",
    // 件数の指定が無いので `perSource` で切る。
    url: (q) => `${searxngBase()}/search?q=${enc(q)}&format=json`,
    parse: searxngHits,
  },
  {
    name: "x",
    what: "X(旧 Twitter)の投稿。作者本人の発表や、記事にならない短い話。**要約が投稿の本文そのもの**。語に `from:名前` を混ぜるとその人の投稿だけになる",
    // 道具の説明の「要約を事実として書かない」を当てると取れている投稿本文を捨てるので、結果にも書く。
    reading:
      "**ここの要約は投稿の本文そのもの**(索引が写した逐語の断片)で、ページの紹介文ではない。" +
      "そのまま引用してよい。ただし**頭からとは限らず、途中から始まって切れている**ので、" +
      "引くときは断片だと書く。x.com は開けない(robots)ので、全文はこれ以上取れない。",
    // x.com は robots で全面拒否なので接続しない。検索エンジンの索引を SearXNG 経由で読む。
    wide: false,
    ownOrigin: searxngBase,
    unavailable: () =>
      searxngBase() ? undefined : "FAMULUS_SEARXNG が空にされている(SearXNG を使わない設定)",
    // 呼び出し元の `site:` は `plainQuery` が落とすので、`xQuery` が付ける `site:` と競合しない。
    url: (q) => `${searxngBase()}/search?q=${enc(xQuery(q))}&format=json`,
    // `site:x.com` を守らない索引が混ざるので投稿の永久リンクだけ残す。
    // ログイン前の画面の要約は、題に中身が残ることがあるので項ごとではなく要約だけ外す。
    parse: (b) => {
      const seen = new Set<string>()
      return searxngHits(b, (c) => (X_SHELL.test(c) ? undefined : c)).flatMap((h) => {
        let u: URL
        try {
          u = new URL(h.url)
        } catch {
          return []
        }
        if (!/^(?:www\.)?(?:x|twitter)\.com$/.test(u.hostname)) return []
        const id = /\/status\/(\d+)/.exec(u.pathname)?.[1]
        if (!id) return []
        // 同じ投稿が別の URL で出ることがあるので id で見る。
        if (seen.has(id)) return []
        seen.add(id)
        // 題が「〜 on X」で要約も無いなら、x.com は開かないので残しても使えない。
        if (!h.note?.includes(" / ") && /\bon X$/.test(h.title)) return []
        return [h]
      })
    },
  },
  {
    name: "wikipedia",
    what: "日本語版 Wikipedia。**語そのものを引くとき**に名指しで使う",
    // 全文一致なので、概念で引くと語が出るだけの記事が並ぶ。既定に入れない。
    wide: false,
    url: (q, n) =>
      `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(q)}&srlimit=${n}&format=json`,
    parse: (b) =>
      rows(obj(obj(JSON.parse(b)).query).search).flatMap((r) => {
        const id = num(r.pageid)
        const title = str(r.title)
        if (id === undefined || !title) return []
        const s = str(r.snippet)
        return [
          {
            title,
            url: `https://ja.wikipedia.org/?curid=${id}`,
            ...(str(r.timestamp) ? { at: str(r.timestamp) as string } : {}),
            ...(s ? { note: plain(s).slice(0, 160) } : {}),
          },
        ]
      }),
  },
  {
    name: "zenn",
    what: "Zenn の記事(日本語の技術記事)",
    wide: true,
    // 101 文字目から 400 が返る(バイト数ではなく文字数)。
    url: (q) => `https://zenn.dev/api/search?q=${enc(clip(q, 100))}&source=articles&order=alltime`,
    parse: (b) =>
      rows(obj(JSON.parse(b)).articles).flatMap((r) => {
        const path = str(r.path)
        const title = str(r.title)
        if (!path || !title) return []
        const liked = num(r.liked_count)
        return [
          {
            title,
            url: `https://zenn.dev${path}`,
            ...(str(obj(r.user).username) ? { by: str(obj(r.user).username) as string } : {}),
            ...(str(r.published_at) ? { at: str(r.published_at) as string } : {}),
            ...(liked !== undefined ? { note: `♡${short(liked)}` } : {}),
          },
        ]
      }),
  },
  {
    name: "qiita",
    what: "Qiita の記事(日本語の技術記事)",
    wide: true,
    // `per_page` を上げると本文込みで取得上限を超え、JSON が途中で切れる。
    // 並びを新着順から変えられないので `stocks:>10` で絞る。1時間 60回の枠があるので、
    // 絞りと 0件時の引き直しは日本語を含む語にだけ掛ける(ASCII の語はまず当たらない)。
    url: (q, n) =>
      `https://qiita.com/api/v2/items?query=${enc(hasJa(q) ? `${q} stocks:>10` : q)}&per_page=${Math.min(n, 5)}`,
    broaden: (q, n) =>
      hasJa(q) ? `https://qiita.com/api/v2/items?query=${enc(q)}&per_page=${Math.min(n, 5)}` : undefined,
    parse: (b) =>
      partialArray(b).flatMap((r) => {
        const url = str(r.url)
        const title = str(r.title)
        if (!url || !title) return []
        const likes = num(r.likes_count)
        const tags = rows(r.tags)
          .map((t) => str(t.name))
          .filter(Boolean)
          .slice(0, 4)
        const note = [likes !== undefined ? `♡${short(likes)}` : "", tags.join(" ")].filter(Boolean).join(" ")
        return [
          {
            title,
            url,
            ...(str(obj(r.user).id) ? { by: str(obj(r.user).id) as string } : {}),
            ...(str(r.created_at) ? { at: str(r.created_at) as string } : {}),
            ...(note ? { note } : {}),
          },
        ]
      }),
  },
  {
    name: "hatena",
    what: "はてなブックマーク(日本語圏でいま読まれている記事を媒体横断で)。10 users 以上を新しい順",
    wide: true,
    // users=10 を外すと当日の 1 user が並ぶ。
    url: (q) => `https://b.hatena.ne.jp/q/${enc(q)}?mode=rss&target=text&users=10&sort=recent`,
    accept: "application/rdf+xml,application/xml;q=0.9,*/*;q=0.5",
    parse: (b) =>
      [...b.matchAll(/<item[ >][\s\S]*?<\/item>/g)].flatMap((m) => {
        const e = m[0]
        const one = (tag: string) =>
          plain(e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "")
        const url = e.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim()
        const title = one("title")
        if (!url || !title) return []
        const users = e.match(/<hatena:bookmarkcount>(\d+)<\/hatena:bookmarkcount>/)?.[1]
        const desc = one("description")
        const note = [users ? `${users} users` : "", desc.slice(0, 120)].filter(Boolean).join(" / ")
        return [
          {
            title,
            url,
            ...(one("dc:date") ? { at: one("dc:date") } : {}),
            ...(note ? { note } : {}),
          },
        ]
      }),
  },
  {
    name: "github",
    what: "GitHub のリポジトリ。実装を探すとき",
    wide: true,
    url: (q, n) => `https://api.github.com/search/repositories?q=${enc(q)}&per_page=${n}`,
    accept: "application/vnd.github+json",
    parse: (b) =>
      rows(obj(JSON.parse(b)).items).flatMap((r) => {
        const url = str(r.html_url)
        const name = str(r.full_name)
        if (!url || !name) return []
        const stars = num(r.stargazers_count)
        const note = [stars !== undefined ? `★${short(stars)}` : "", str(r.language), str(r.description)]
          .filter(Boolean)
          .join(" / ")
        return [
          {
            title: name,
            url,
            ...(str(r.pushed_at) ? { at: str(r.pushed_at) as string } : {}),
            ...(note ? { note } : {}),
          },
        ]
      }),
  },
  {
    name: "hn",
    what: "Hacker News。英語圏の議論と、そこから辿れる元記事",
    wide: true,
    url: (q, n) => `https://hn.algolia.com/api/v1/search?query=${enc(q)}&hitsPerPage=${n}`,
    parse: hnHits,
  },
  {
    name: "showhn",
    what: "Show HN。**個人が作って出した物**そのもの。記事ではなく動く物を探すとき",
    // 新着順(`search_by_date`)にすると語がほとんど当たらなくなるので関連順。
    wide: false,
    url: (q, n) => `https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=show_hn&hitsPerPage=${n}`,
    parse: hnHits,
  },
  {
    name: "ph",
    what:
      "Product Hunt の新着(フロントページの feed)。**商業プロダクトのローンチ**を探すとき名指しで。" +
      "検索式は無く、**直近の掲載ぶんを語で絞るだけ** — 0件は「無い」ではなく feed の窓の外かもしれない",
    // 公式 GraphQL API はトークンが要るので feed を使う。
    wide: false,
    accept: "application/atom+xml,application/xml,*/*;q=0.5",
    url: () => "https://www.producthunt.com/feed",
    parse: phHits,
    sift: (q, hits) => {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
      return hits.filter((h) => {
        const hay = `${h.title} ${h.note ?? ""}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
    },
  },
  {
    name: "job",
    what:
      "副業・業務委託の募集。クラウドソーシング(クラウドワークス・ランサーズ)と Wantedly の" +
      "**募集ページそのもの**。語には職種や技術を入れる(「React 週2 リモート」など)",
    reading:
      "**募集の終わったものが混ざる。**索引を読んでいるため。媒体ごとに新しい順で並べてあり、" +
      "**上に出たものほど生きている**が、上でも4件に1件は終わっている。" +
      "**報酬・掲載日・応募期限は募集ページを開けば載っている。**勧める前に開いて、期限と中身を確かめる。",
    // 媒体ごとに問い合わせる。`(site:a OR site:b)` だと索引が絞り込みを無視する。
    // `time_range` は付けない。語の一致より強く効き、技術も職種も違う募集が上位に来る。
    wide: false,
    ownOrigin: searxngBase,
    unavailable: () =>
      searxngBase() ? undefined : "FAMULUS_SEARXNG が空にされている(SearXNG を使わない設定)",
    url: (q) => JOB_SITES.map((s) => `${searxngBase()}/search?q=${enc(`site:${s} ${q}`)}&format=json`),
    parse: (b) => {
      // 募集 ID を掲載時刻の代わりに使う。媒体をまたいでは比べられないので媒体ごとに並べる。
      const 束 = new Map<string, { hit: Hit; id: number }[]>()
      for (const h of searxngHits(b)) {
        const u = new URL(h.url)
        const host = u.hostname.replace(/^(?:www|en-jp)\./, "")
        const m = JOB_PATHS[host]?.exec(u.pathname)
        if (!m) continue
        // 題が URL のままの項は語と無関係に返り、ID が大きいので先頭に来る。
        if (h.title.replace(/^https?:\/\/(?:www\.)?/, "") === h.url.replace(/^https?:\/\/(?:www\.)?/, ""))
          continue
        const 列 = 束.get(host) ?? []
        列.push({ hit: h, id: Number(m[1]) })
        束.set(host, 列)
      }
      return [...束.values()].flatMap((列) => 列.sort((a, b2) => b2.id - a.id).map((x) => x.hit))
    },
  },
  {
    name: "npm",
    what: "npm のパッケージ。版・公開日・落とされ方",
    wide: false,
    url: (q, n) => `https://registry.npmjs.org/-/v1/search?text=${enc(q)}&size=${n}`,
    parse: (b) =>
      rows(obj(JSON.parse(b)).objects).flatMap((r) => {
        const p = obj(r.package)
        const name = str(p.name)
        if (!name) return []
        const weekly = num(obj(r.downloads).weekly)
        const note = [
          str(p.version) ? `v${str(p.version)}` : "",
          weekly !== undefined ? `週${short(weekly)}` : "",
          str(p.description),
        ]
          .filter(Boolean)
          .join(" / ")
        return [
          {
            title: name,
            url: `https://www.npmjs.com/package/${name}`,
            ...(str(r.updated) ? { at: str(r.updated) as string } : {}),
            ...(note ? { note } : {}),
          },
        ]
      }),
  },
  {
    name: "stackoverflow",
    what: "Stack Overflow の質問。答えが付いているかも返る",
    wide: false,
    url: (q, n) =>
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${enc(q)}&site=stackoverflow&pagesize=${n}`,
    parse: (b) =>
      rows(obj(JSON.parse(b)).items).flatMap((r) => {
        const url = str(r.link)
        const title = str(r.title)
        if (!url || !title) return []
        const score = num(r.score)
        const created = num(r.creation_date)
        const note = [
          score !== undefined ? `${score}点` : "",
          r.is_answered === true ? "解決済み" : "未解決",
          strs(r.tags).slice(0, 4).join(" "),
        ]
          .filter(Boolean)
          .join(" / ")
        return [
          {
            title: plain(title),
            url,
            ...(str(obj(r.owner).display_name) ? { by: str(obj(r.owner).display_name) as string } : {}),
            // Stack Exchange は unix 秒。
            ...(created !== undefined ? { at: new Date(created * 1000).toISOString() } : {}),
            ...(note ? { note } : {}),
          },
        ]
      }),
  },
  {
    name: "arxiv",
    what: "arXiv の論文。査読前の原稿",
    wide: false,
    url: (q, n) => `https://export.arxiv.org/api/query?search_query=all:${enc(q)}&max_results=${n}`,
    accept: "application/atom+xml,application/xml;q=0.9",
    // `toText` の feed 整形は通さない。著者が複数で要約が長いので欄ごとに取る。
    parse: (b) =>
      [...b.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap((m) => {
        const e = m[1] ?? ""
        const one = (tag: string) =>
          plain(e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "")
        const id = e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim()
        const title = one("title")
        if (!id || !title) return []
        const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((a) => plain(a[1] ?? "")).slice(0, 3)
        const summary = one("summary")
        return [
          {
            title,
            url: id,
            ...(authors.length ? { by: authors.join(", ") } : {}),
            ...(one("published") ? { at: one("published") } : {}),
            ...(summary ? { note: summary.slice(0, 160) } : {}),
          },
        ]
      }),
  },
  {
    name: "hfpapers",
    what:
      "Hugging Face Daily Papers(AI 論文の日次選抜)。arxiv の全量と違って**読まれている論文**だけが返る。" +
      "語は英語。今日の選抜そのものは https://huggingface.co/api/daily_papers?limit=20 を fetch で開く",
    wide: false,
    // 1件が大きい(著者の配列を丸ごと含む)ので limit は小さく保つ。
    url: (q, n) => `https://huggingface.co/api/papers/search?q=${enc(q)}&limit=${Math.min(n, 8)}`,
    parse: (b) =>
      rows(JSON.parse(b)).flatMap((r) => {
        const p = obj(r.paper)
        const id = str(p.id)
        const title = str(p.title) ?? str(r.title)
        if (!id || !title) return []
        const up = num(p.upvotes)
        const authors = rows(p.authors)
          .map((a) => str(a.name))
          .filter(Boolean)
          .slice(0, 3)
        const summary = str(p.summary)?.replace(/\s+/g, " ")
        const note = [up !== undefined ? `▲${up}` : "", summary?.slice(0, 140) ?? ""]
          .filter(Boolean)
          .join(" / ")
        return [
          {
            title: plain(title),
            url: `https://huggingface.co/papers/${id}`,
            ...(authors.length ? { by: authors.join(", ") } : {}),
            ...(str(p.publishedAt) ? { at: str(p.publishedAt) as string } : {}),
            ...(note ? { note } : {}),
          },
        ]
      }),
  },
  {
    name: "docs",
    what:
      "ライブラリの最新ドキュメント索引(Context7)。**学習時の知識が古い恐れのある API を使う前に引く**。" +
      "語はライブラリ名(「vercel ai sdk」「valibot」)",
    reading:
      "返るのは索引で、実体は URL を `fetch` で開く(最新ソースから起こした llms.txt)。" +
      "公式が llms.txt を出している場合(`https://<docsドメイン>/llms.txt`)はそちらが一次。",
    wide: false,
    // 鍵が必須になったら unavailable に理由を書いて外す。
    url: (q) => `https://context7.com/api/v1/search?query=${enc(q)}`,
    parse: (b) =>
      rows(obj(JSON.parse(b)).results)
        .slice(0, 8)
        .flatMap((r) => {
          const id = str(r.id)
          const title = str(r.title)
          if (!id || !title) return []
          return [
            {
              title: `${title}(${id})`,
              // tokens を大きくすると fetch の取得上限に当たる。
              url: `https://context7.com${id}/llms.txt?tokens=3000`,
              ...(str(r.lastUpdateDate) ? { at: str(r.lastUpdateDate) as string } : {}),
              ...(str(r.description) ? { note: (str(r.description) as string).slice(0, 120) } : {}),
            },
          ]
        }),
  },
  {
    name: "release",
    what: "GitHub リポジトリの公式リリース。**語は `owner/repo` をそのまま渡す**(「oven-sh/bun」)",
    reading: "一次情報。note は本文の先頭だけ — 全文はURLを開く。追跡系の watch はここから始める。",
    wide: false,
    url: (q, n) => `https://api.github.com/repos/${repoPath(q)}/releases?per_page=${Math.min(n, 10)}`,
    accept: "application/vnd.github+json",
    parse: (b) =>
      rows(JSON.parse(b)).flatMap((r) => {
        const url = str(r.html_url)
        const tag = str(r.tag_name)
        if (!url || !tag) return []
        const name = str(r.name)
        const flags = [r.prerelease === true ? "prerelease" : "", r.draft === true ? "draft" : ""]
          .filter(Boolean)
          .join(",")
        const body = str(r.body)?.replace(/\s+/g, " ").slice(0, 140)
        return [
          {
            title: name && name !== tag ? `${tag} ${name}` : tag,
            url,
            ...(str(r.published_at) ? { at: str(r.published_at) as string } : {}),
            ...(flags || body ? { note: [flags, body].filter(Boolean).join(" / ") } : {}),
          },
        ]
      }),
  },
  {
    name: "advisory",
    what: "GitHub リポジトリの security advisory。**語は `owner/repo` をそのまま渡す**",
    reading: "公式の脆弱性公表。二次記事の数字ではなくここを引く(CVE・深刻度・公表日が一次)。",
    wide: false,
    url: (q, n) =>
      `https://api.github.com/repos/${repoPath(q)}/security-advisories?per_page=${Math.min(n, 10)}`,
    accept: "application/vnd.github+json",
    parse: (b) =>
      rows(JSON.parse(b)).flatMap((r) => {
        const url = str(r.html_url)
        const summary = str(r.summary)
        if (!url || !summary) return []
        const note = [str(r.severity), str(r.cve_id)].filter(Boolean).join(" / ")
        return [
          {
            title: summary,
            url,
            ...(str(r.published_at) ? { at: str(r.published_at) as string } : {}),
            ...(note ? { note } : {}),
          },
        ]
      }),
  },
]

const X_SOURCE = SOURCES.find((s) => s.name === "x")
const SHOWHN_SOURCE = SOURCES.find((s) => s.name === "showhn")
const JOB_SOURCE = SOURCES.find((s) => s.name === "job")
/** 「副業」だけでは税の話でも出るので、探す側の語と並べる。どれか1つで `job` も出す。 */
const JOB_WORDS =
  /副業|複業|業務委託|準委任|フリーランス|案件|求人|募集|稼働|freelance|side ?job|contract work/i

/**
 * `job` に渡す前に落とす媒体名と媒体選びの語。モデルがこれを語に混ぜ、そのまま引くと無関係な募集が返る。
 * 道具の説明文では直らなかった。
 */
const JOB_NOISE =
  /^(?:offers\??|workship|goworkship|findy|freelance|レバテック(?:フリーランス)?|levtech|itプロパートナーズ|シューマツワーカー|youtrust|anycrew|複業クラウド|lotsful|sokudan|flexy|クラウドワークス|ランサーズ|crowdworks|lancers|wantedly|ココナラ|coconala|エージェント|サービス|サイト|公式|手数料|審査|登録|スカウト|案件紹介|評判|口コミ|比較|おすすめ|まとめ|とは|\d{4}年?)$/i

/** 技術名か職種が1つも残らなければ `job` は出さない。「副業」だけで引くと無関係な募集が返る。 */
const JOB_SKILL =
  /react|vue|next|nuxt|svelte|angular|typescript|javascript|node|python|go|rust|php|ruby|java|swift|kotlin|flutter|unity|aws|gcp|sql|フロントエンド|バックエンド|インフラ|デザイン|ライティング|動画編集|エンジニア|開発|制作|コーディング|翻訳|データ入力/i

function toJobTerm(q: string): string | undefined {
  const kept = plainQuery(q)
    .split(/\s+/)
    .filter((w) => w && !JOB_NOISE.test(w))
  if (!kept.some((w) => JOB_SKILL.test(w))) return undefined
  return kept.join(" ")
}

/** 道具の説明文を実装から作るために出す。 */
export const SOURCE_MENU: readonly { name: string; what: string; wide: boolean }[] = SOURCES.map((s) => ({
  name: s.name,
  what: s.what,
  wide: s.wide,
}))

/** 呼ぶたびに Config を見る。道具の説明文もここから作るので、説明と実際の接続先が一致する。 */
export const defaultSources = (): readonly string[] =>
  SOURCES.filter((s) => s.wide && !s.unavailable?.()).map((s) => s.name)

/** 保存した応答で読み取りを検査するため。 */
export function parseFrom(source: string, body: string): readonly Hit[] | undefined {
  return SOURCES.find((s) => s.name === source.toLowerCase())?.parse(body)
}

/** 全部の結果が揃うまで待つ。遅い1本は失敗と同じなので、1ページを読む制限より短くする。 */
const SOURCE_TIMEOUT_MS = 8_000

/** 先の名前 → 解除時刻(ms)。プロセス内だけの記録だが、枠は時間で戻るので足りる。 */
const restingUntil = new Map<string, number>()

/** 同じ 403 でも一時的な上限と拒否を分ける。 */
const RATE_LIMITED = /rate.?limit|too many requests|回数制限/i

function whyFailed(status: number, body: string, until: number | undefined): string {
  let said: string | undefined
  try {
    said = str(obj(JSON.parse(body)).message)
  } catch {
    /* JSON で理由を書かない先もある */
  }
  const when = until ? `${localStamp(new Date(until).toISOString())} まで` : "しばらく"
  if (status === 429 || (status === 403 && RATE_LIMITED.test(body))) {
    return `回数制限に当たった(${when}引けない)`
  }
  return `HTTP ${status}${said ? ` — ${said}` : ""}`
}

export interface SearchOptions {
  /** 省略すると既定の先へ同時に出る。 */
  readonly where?: readonly string[]
  readonly perSource?: number
}

/** 先が1つ失敗しても他は返し、失敗した先は理由付きで並べる。別ホストなので `pace` の間隔は互いに掛からない。 */
export async function searchSources(
  query: string,
  opts: SearchOptions = {},
): Promise<readonly SourceResult[]> {
  const q = query.trim()
  if (!q) return []
  const perSource = Math.min(Math.max(opts.perSource ?? 8, 1), 20)
  const names = opts.where?.length ? opts.where : defaultSources()
  // 説明に足してもモデルは `where: ["x"]` ではなく `web` に `site:x.com` と書くので、それを `x` で受ける。
  const xTerm = toXTerm(q)
  // 同じく `hn` に「Show HN」と書かれたら `showhn` で受ける。
  const showTerm = toShowHnTerm(q)
  const picked = names.flatMap((n) => {
    const s = SOURCES.find((x) => x.name === n.toLowerCase())
    if (!s) return []
    if (s.name === "web" && xTerm !== undefined && X_SOURCE) return [X_SOURCE]
    if (s.name === "hn" && showTerm !== undefined && SHOWHN_SOURCE) return [SHOWHN_SOURCE]
    return [s]
  })
  // 仕事を探す語なら `web` に加えて `job` も出す(置き換えない)。`web` は募集ではなく SEO 記事を返す。
  const jobTerm = toJobTerm(q)
  if (
    JOB_WORDS.test(q) &&
    jobTerm !== undefined &&
    JOB_SOURCE &&
    picked.some((s) => s.name === "web") &&
    !picked.includes(JOB_SOURCE)
  )
    picked.push(JOB_SOURCE)
  const unknown = names.filter((n) => !SOURCES.some((x) => x.name === n.toLowerCase()))

  const found = await Promise.all(
    picked.map(async (s): Promise<SourceResult> => {
      const why = s.unavailable?.()
      if (why) return { source: s.name, hits: [], failed: why }
      const resting = restingUntil.get(s.name)
      if (resting !== undefined && resting > Date.now()) {
        return {
          source: s.name,
          hits: [],
          failed: `回数制限中(${localStamp(new Date(resting).toISOString())} まで引けない)`,
        }
      }
      // 検索エンジンの構文は解する先にだけ渡す。回してきた先には直した語を渡す。
      const term =
        s === X_SOURCE && xTerm !== undefined
          ? xTerm
          : s === SHOWHN_SOURCE && showTerm !== undefined
            ? showTerm
            : s === JOB_SOURCE && jobTerm !== undefined
              ? jobTerm
              : s.qualifiers
                ? q
                : plainQuery(q)
      const one = async (url: string) => {
        const res = await fetchRaw(url, {
          accept: s.accept ?? "application/json,*/*;q=0.5",
          timeoutMs: SOURCE_TIMEOUT_MS,
          ...(s.ownOrigin ? { allowOrigin: s.ownOrigin() } : {}),
        })
        if (res.status >= 400) {
          if (res.status === 429 || (res.status === 403 && RATE_LIMITED.test(res.body))) {
            // 解除時刻を言ってこない先は10分置く。
            restingUntil.set(s.name, res.resetAtMs ?? Date.now() + 10 * 60_000)
          }
          throw new Error(whyFailed(res.status, res.body, res.resetAtMs))
        }
        if (!res.body) throw new Error(`空の応答(HTTP ${res.status})`)
        try {
          const parsed = s.parse(res.body)
          return (s.sift ? s.sift(term, parsed) : parsed).slice(0, perSource)
        } catch (e) {
          // 形が変わった先を0件として流さない。
          throw new Error(`応答を読めなかった: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      /** 1つでも読めれば返す。全部失敗したときだけ例外にする。 */
      const call = async (u: string | readonly string[]) => {
        if (typeof u === "string") return one(u)
        const rs = await Promise.allSettled(u.map(one))
        const ok = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
        if (ok.length === 0)
          throw new Error(rs.map((r) => String((r as PromiseRejectedResult).reason)).join(" / "))
        // 先頭から詰めると最初の先だけで埋まるので、先ごとに1件ずつ取る。
        const merged: Hit[] = []
        const seen = new Set<string>()
        for (let i = 0; merged.length < perSource && ok.some((h) => i < h.length); i++) {
          for (const hits of ok) {
            const h = hits[i]
            if (!h || seen.has(h.url) || merged.length >= perSource) continue
            seen.add(h.url)
            merged.push(h)
          }
        }
        return merged
      }
      try {
        let hits = await call(s.url(term, perSource))
        if (hits.length === 0) {
          const wider = s.broaden?.(term, perSource)
          if (wider) hits = await call(wider)
        }
        return { source: s.name, hits }
      } catch (e) {
        return { source: s.name, hits: [], failed: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
  return unknown.length
    ? [
        ...found,
        {
          source: unknown.join("/"),
          hits: [],
          failed: `そういう先は無い。使えるのは ${SOURCES.map((s) => s.name).join("・")}`,
        },
      ]
    : found
}

/**
 * 先ごとに分けたまま出す。混ぜるとどの索引が拾ったかが消える。
 * 日付はユーザーの時計で出す。UTC のままだと夜中の記事が前日として読まれる。
 */
export function renderHits(results: readonly SourceResult[]): string {
  const seen = new Map<string, string>()
  const out: string[] = []
  for (const r of results) {
    if (r.failed) {
      out.push(`## ${r.source} — 引けなかった(${r.failed})`)
      continue
    }
    if (r.hits.length === 0) {
      out.push(`## ${r.source} — 0件`)
      continue
    }
    out.push(`## ${r.source}(${r.hits.length}件)`)
    const how = SOURCES.find((s) => s.name === r.source)?.reading
    if (how) out.push(`  ${how}`)
    for (const h of r.hits) {
      const dup = seen.get(h.url)
      if (dup) {
        out.push(`- ${h.title} — ${dup} にも同じものが出た`)
        continue
      }
      seen.set(h.url, r.source)
      const meta = [h.by, h.at ? localStamp(h.at, false) : undefined].filter(Boolean).join(" / ")
      out.push(`- ${h.title}`)
      out.push(`  ${h.url}`)
      if (meta) out.push(`  ${meta}`)
      if (h.note) out.push(`  ${h.note}`)
    }
  }
  return out.join("\n")
}
