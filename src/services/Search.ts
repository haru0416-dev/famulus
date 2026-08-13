/**
 * 検索。`fetch` は URL を1つ開く道具で、こちらは URL をまだ知らないとき。
 *
 * 叩く先は「相手がプログラム向けに出している API を使う」で選ぶ。
 * robots の `Disallow`・CAPTCHA・`access denied` で断られている入口は使わない。
 * 一般 web 検索のホスト型 API は通常 API key を要する。Bing Search API は終了済みで、
 * Google Custom Search JSON API も新規受付を終えているため、`~/Project/searxng` に SearXNG を立てて
 * 127.0.0.1:8888 に縛ってある。エンジンの選定理由は `~/Project/searxng/config/settings.yml`。
 *
 * X はこの線引きで本文の取れる API が全部落ちたので、`x` の先だけは取りに行かず、
 * SearXNG に `site:x.com` を投げて検索エンジンが既に作った索引の要約を読む。
 *
 * 回数制限のある先(Qiita 無認証 60回/時、GitHub 検索 無認証 10回/分)は、当たったら
 * 解除時刻まで叩かない(`restingUntil`)。鍵を入れれば枠は増えるが、置き場所とユーザーの
 * 同意が先なので今は入れていない。
 *
 * 先を指定しなければ `wide` の先へ同時に出る。`where` で名指しもできる。
 * 返すのは題・URL・書き手・日付と、各 API の数値や検索結果の要約。ページ本文は取得しない。
 */
import { localStamp } from "../core/time.ts"
import { fetchRaw } from "./Web.ts"

/** 1件。本文は入れない。開くかどうかを決めるのに要るものだけ。 */
export interface Hit {
  readonly title: string
  readonly url: string
  /** 書き手。分かる先だけ。 */
  readonly by?: string
  /** 日付。ISO のまま持ち、見せるときにユーザーの時計へ直す。 */
  readonly at?: string
  /** 星の数・いいね・点数・要約など、その先でしか分からない目印。 */
  readonly note?: string
}

export interface SourceResult {
  readonly source: string
  readonly hits: readonly Hit[]
  /** 引けなかったときの理由。空なら成功。 */
  readonly failed?: string
}

interface Source {
  readonly name: string
  /** 何が引ける先か。道具の説明文に出す。 */
  readonly what: string
  /**
   * 結果の読み方。件数の見出しの下に1行出す。他の先と読み方が違う先にだけ書く。
   * 読む側が判断するのは結果を見た瞬間なので、道具の説明に一度書くのでは足りない。
   */
  readonly reading?: string
  /**
   * 叩く先。複数返すと、まとめて叩いて1つの先として返す。
   * `site:` を1媒体ずつ投げないと当たらない先があるので、そこで要る(`job` を参照)。
   */
  readonly url: (q: string, n: number) => string | readonly string[]
  /**
   * 0件だったときにもう一度だけ試す形。絞り込みを外す用で、別の問いを投げるためではない。
   * `undefined` を返せば2回目を出さない。最初から絞っていない語では同じ問いをもう一度
   * 投げるだけになるので、そこで枠を使わない(`qiita` を参照)。
   */
  readonly broaden?: (q: string, n: number) => string | readonly string[] | undefined
  readonly parse: (body: string) => readonly Hit[]
  /** 既定の同時検索に入れるか。 */
  readonly wide: boolean
  readonly accept?: string
  /**
   * 今は使えない理由。返せば既定から外れ、名指しされたらこの文言をそのまま返す。
   * 呼ぶたびに評価する — 環境変数を書き換えて走らせ直す必要が無いように。
   */
  readonly unavailable?: () => string | undefined
  /** `site:` などの検索エンジン構文が通る先か。通らない先へは落として渡す。 */
  readonly qualifiers?: boolean
  /**
   * 自分で立てたサーバなら、その origin。`Web.ts` の内側判定をここだけ免除する。
   * 文字列は実装が持つ — 問い合わせ文から組み立てられる余地を作らない。
   */
  readonly ownOrigin?: () => string
}

/**
 * 検索エンジンの構文を落とす。API は `site:` を解さない — GitHub は不正な絞り込みとして
 * 422 で断り、Zenn と HN はただの語として読むので 0 件になる。先を絞るなら `where` で名指しする。
 *
 * 絞り込みしか書かれていなかったときは、値のほうを語として残す(戻り値は空文字にならない)。
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

/**
 * 自前の SearXNG の在り処。既定は `~/Project/searxng/docker-compose.yml` が縛っている先。
 * 空にすると `web` の先が既定から外れる(コンテナを落として使わない日のため)。
 */
const searxngBase = (): string => (process.env.OPEN_ZERO_SEARXNG ?? "http://127.0.0.1:8888").trim()

const enc = encodeURIComponent
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
/** 桁を落として読みやすくする(15208 → 15.2k、26680112 → 26.7M)。 */
const short = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const rows = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : []
/** 文字列の配列(Stack Exchange のタグのように、素の文字列で来る欄)。 */
const strs = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []
/**
 * 途中で切れた JSON の配列から、閉じている項だけを拾う。
 *
 * Qiita の API は記事本文を丸ごと返すので、読み取り上限に当たって末尾が欠けることがある。
 * `JSON.parse` はそこで丸ごと失敗し、揃っている手前の項まで道連れになる。
 * 括弧の深さを数えて、閉じたところまでを配列に組み直す(文字列の中の括弧は数えない)。
 * 1件も閉じていなければ空配列を返す。例外は投げない。
 */
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
      // 深さ 1(= 配列の直下)に戻った位置が、1件ぶんの終わり。
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

/**
 * 語を上限まで切る。語の途中では切らず、空白があればそこまでで止める。
 * 半端な語尾(`migrat`)を投げても当たらないので、1語まるごと落とす。
 */
function clip(q: string, max: number): string {
  const chars = [...q]
  if (chars.length <= max) return q
  const cut = chars.slice(0, max).join("")
  const sp = cut.lastIndexOf(" ")
  return (sp > max / 2 ? cut.slice(0, sp) : cut).trim()
}

/**
 * 検索語に日本語(かな・漢字)が混ざっているか。日本語の先に絞りを掛けるかの判断に使う。
 * 片仮名だけの語(「ランタイム」)も日本語として拾う。ローマ字表記の日本語は拾えないが、
 * 検索語としてはまず出てこない形なので見ない。
 */
const hasJa = (q: string): boolean => /[぀-ヿ㐀-鿿]/u.test(q)

/** 副業の募集を引く先。個別の募集ページが索引に入っている媒体だけ(`job` の注)。 */
const JOB_SITES = [
  "crowdworks.jp/public/jobs",
  "lancers.jp/work/detail",
  "www.wantedly.com/projects",
] as const
/** 募集ページだけを残す形。`site:` を守らない索引が react.dev などを混ぜてくるので、こちらで落とす。 */
const JOB_PATHS: Record<string, RegExp> = {
  "crowdworks.jp": /^\/public\/jobs\/(\d+)$/,
  "lancers.jp": /^\/work\/detail\/(\d+)$/,
  "wantedly.com": /^\/projects\/(\d+)$/,
}

/**
 * 索引が投稿ではなくログイン前の画面を拾ったときに要約へ出る文言。
 * ここに当たった要約は投稿の中身ではないので落とす。
 */
const X_SHELL =
  /JavaScript is (?:disabled|not available)|The latest posts from|Something went wrong|site owner hides|Log in to X/i

/**
 * X を引く語を組む。`from:名前` か `@名前` が混ざっていたらその人の投稿だけに絞る。
 * 絞りは `site:x.com/名前` の形で掛ける — `from:` や `@` を語として渡すより本人以外が混ざらない。
 */
function xQuery(q: string): string {
  const m = /(?:^|\s)(?:from:|@)([A-Za-z0-9_]{1,15})(?=\s|$)/.exec(q)
  const rest = m ? q.replace(m[0], " ").replace(/\s+/g, " ").trim() : q
  return `site:x.com${m ? `/${m[1]}` : ""} ${rest}`.trim()
}

/**
 * `web` 宛ての語が X を狙っているかを見て、狙っているなら `x` へ渡す形に直す。
 * `site:x.com/youyuxi Vite` → `from:youyuxi Vite`。狙っていなければ `undefined`。
 *
 * 見るのは `site:x.com` だけ。`site:` が2つ書いてあるなら(`site:x.com OR site:zenn.dev`)
 * X に寄せるのは行き過ぎなので、そのまま `web` に流す。
 */
function toXTerm(q: string): string | undefined {
  const m = /(?:^|\s)site:(?:www\.)?(?:x|twitter)\.com(?:\/([A-Za-z0-9_]{1,15}))?(?=\s|$)/i.exec(q)
  if (!m) return undefined
  const rest = q.replace(m[0], " ").replace(/\s+/g, " ").trim()
  if (/\bsite:/i.test(rest)) return undefined
  return m[1] ? `from:${m[1]} ${rest}`.trim() : rest
}

/**
 * `hn` 宛ての語に「Show HN」と書いてあるなら、その2語を落として `showhn` へ渡す。
 * 狙っていなければ `undefined`。語が「Show HN」だけだったときは空文字を返す
 * (Algolia は語なし+`tags=show_hn` で点数順の上位を返すので、それで成り立つ)。
 *
 * 語ではなくタグで絞るために落とす。「Show HN」を語として残すと近接ランキングがその2語に
 * 引かれて、題が話題語で始まるだけの新しい項が上に来る。残りの語の引用符は外さない
 * (Algolia は句として読む)が、`Show HN` を括っている引用符は前後とも含めて拾う。
 */
function toShowHnTerm(q: string): string | undefined {
  const m = /(?:^|\s)["'“”]?show[\s._-]?hn\s*:?["'“”]?(?=\s|$)/i.exec(q)
  if (!m) return undefined
  // Algolia は `site:` を語として読むだけなので、他の先と同じく落としてから渡す。
  return plainQuery(q.replace(m[0], " ")).replace(/\s+/g, " ").trim()
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {}
/** 検索結果の要約に混ざるマーカーを落とす(Wikipedia の `<span class="searchmatch">` など)。 */
const plain = (s: string): string =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(
      /&(?:amp|lt|gt|quot|#39);/g,
      (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m] ?? m,
    )
    .replace(/\s+/g, " ")
    .trim()

/**
 * SearXNG の応答を読む。`web` と `x` で共有する — 同じ API を叩いているので、形も同じ。
 *
 * `content` を渡すと要約に手を入れられる。`undefined` を返せばその要約を落とす
 * (索引の要約が中身になっていないことがある — `x` を参照)。
 */
const searxngHits = (b: string, content?: (c: string) => string | undefined): readonly Hit[] =>
  rows(obj(JSON.parse(b)).results).flatMap((r) => {
    const url = str(r.url)
    const title = str(r.title)
    if (!url || !title) return []
    // 複数の索引が同じページを拾ったことを出し、1つだけが返した結果と区別できるようにする。
    const n = strs(r.engines).length
    const raw = str(r.content)
    const c = raw === undefined ? undefined : (content?.(raw) ?? (content ? undefined : raw))
    const note = [n > 0 ? `${n}索引` : "", c ? plain(c).slice(0, 140) : ""].filter(Boolean).join(" / ")
    // 日付を出す先と出さない先が混ざる。読めない値は捨てる(`localStamp` に渡すと崩れる)。
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

/** Algolia の HN 応答を読む。`hn` と `showhn` で共有する。 */
const hnHits = (b: string): readonly Hit[] =>
  rows(obj(JSON.parse(b)).hits).flatMap((r) => {
    const id = str(r.objectID)
    const title = str(r.title)
    if (!id || !title) return []
    const pts = num(r.points)
    const cmt = num(r.num_comments)
    // 元記事があるならそちらを出す。議論そのものへの道は note に添える。
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

const SOURCES: readonly Source[] = [
  {
    name: "web",
    what: "一般の web(自前の SearXNG が 9 の索引をまとめて引く)。上の先で当たらない話題はここ",
    // 唯一「一般の web」を引ける先で、他が全部専門の索引なので、既定に必ず入れる。
    wide: true,
    // 検索エンジンの構文が通る唯一の先。ここだけは `site:` を落とさずにそのまま渡す。
    qualifiers: true,
    ownOrigin: searxngBase,
    unavailable: () =>
      searxngBase() ? undefined : "OPEN_ZERO_SEARXNG が空にされている(SearXNG を使わない設定)",
    // 件数の指定は無い。1ページぶん(60〜100件)返るので `perSource` で切る。
    url: (q) => `${searxngBase()}/search?q=${enc(q)}&format=json`,
    parse: searxngHits,
  },
  {
    name: "x",
    what: "X(旧 Twitter)の投稿。作者本人の発表や、記事にならない短い話。**要約が投稿の本文そのもの**。語に `from:名前` を混ぜるとその人の投稿だけになる",
    // 他の先と読み方が逆になるので、結果の側にも書く。道具の説明にある
    // 「要約を事実として書かない」を当てると、取れている投稿本文を捨てることになる。
    reading:
      "**ここの要約は投稿の本文そのもの**(索引が写した逐語の断片)で、ページの紹介文ではない。" +
      "そのまま引用してよい。ただし**頭からとは限らず、途中から始まって切れている**ので、" +
      "引くときは断片だと書く。x.com は開けない(robots)ので、全文はこれ以上取れない。",
    // X 本体は叩かない。`x.com/robots.txt` が `User-agent: * / Disallow: /` で、
    // 本文の取れる API(`cdn.syndication.twimg.com`・`publish.x.com/oembed`)も robots で断られている。
    // 代わりに既に索引された結果を読む — 取りに行ったのは検索エンジンで、こちらは
    // SearXNG に問い合わせるだけ。時系列で追う道は作れないので、語で引く先になる。
    wide: false,
    ownOrigin: searxngBase,
    unavailable: () =>
      searxngBase() ? undefined : "OPEN_ZERO_SEARXNG が空にされている(SearXNG を使わない設定)",
    // `site:` はこちらが付ける(`xQuery`)。呼ぶ側が書いた `site:` は `plainQuery` が落としてから
    // 来るので(`qualifiers` を立てていない)、`site:zenn.dev` と競合して 0 件になることがない。
    url: (q) => `${searxngBase()}/search?q=${enc(xQuery(q))}&format=json`,
    // `site:x.com` を守らない索引が混ざる(vite.dev や wikipedia が返る)ので、
    // 投稿の永久リンクだけ残す。要約にログイン前の画面が混ざったときは項ごと落とさず、
    // 要約だけ外して題は出す(題のほうに中身が残っていることがある)。
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
        // 同じ投稿が別の URL で二重に出ることがある(`?lang=ca` 付きや、旧い名前のまま索引された物)。
        // 投稿は id で1つに決まるので id で見る。
        if (seen.has(id)) return []
        seen.add(id)
        // 題まで「mizchi on X」で終わっていて要約も落ちたなら、残しても開く先が無い
        // (x.com は取りに行かない — `Web.ts` の `refusedBeforeFetch`)。
        if (!h.note?.includes(" / ") && /\bon X$/.test(h.title)) return []
        return [h]
      })
    },
  },
  {
    name: "wikipedia",
    what: "日本語版 Wikipedia。**語そのものを引くとき**に名指しで使う",
    // 既定から外した。全文一致なので、概念で引くと本文にその語が出るだけの記事が並ぶ。
    // 語を1つ渡せば当たる先なので、混ぜるのではなく名指しで呼ぶ。
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
    // 語は 100 文字まで。101 文字目から 400 が返る(バイト数ではなく文字数)。
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
    // `per_page` を上げない。本文が丸ごと入るので、10 件で読む上限 1.5MB を超えて JSON が途中で切れる。
    // 5 件に抑えたうえで、切れたときは `partialArray` で閉じている項だけ拾う。
    //
    // 並びは新着順で変えられない(`sort=rel` は無視される)。そのままだと当日投稿の ♡0 が並ぶので、
    // 検索語の側で `stocks:>10` と絞る。ただし狭い話題は丸ごと消えるので、0件のときだけ外して引き直す。
    //
    // その絞りは日本語が入っている語にだけ掛ける。ここは1時間 60回の硬い枠を持つ唯一の先で、
    // 0件→引き直しが続くと1問で使い切る。Qiita の記事は日本語なので、ASCII だけの語
    // (英語の識別子)は `stocks:>10` とまず当たらない。
    // 日本語が入っていない語では最初から絞らず、`broaden` も出さない(1検索 1リクエスト)。
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
    // `hn` と同じ Algolia の API に `tags=show_hn` を足すだけ。追加の枠も鍵も要らない。
    //
    // 新着順(`search_by_date`)は採らない。並べ替えを変えると語がほとんど当たらなくなり、
    // その日の投稿が点数に関係なく上に来る。この道具は語で引く形しか持っていないので関連順。
    wide: false,
    url: (q, n) => `https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=show_hn&hitsPerPage=${n}`,
    parse: hnHits,
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
    // 問い合わせを媒体ごとに分ける。`(site:a OR site:b)` と書くと索引が潰して募集ページがほとんど返らない。
    // `Source.url` が配列を返せるのはこのため。媒体が3つなのは、`site:` で引いて
    // 個別の募集ページが索引に入っているものだけ残した結果(Findy Freelance は案件が login の内側、
    // ココナラと Offers は分類ページと記事しか出てこない)。
    //
    // 期間では絞らない。`time_range` を付けると期間の条件が語の一致より強く働いて、
    // 技術も職種も違う募集が上位を埋める。新しい順は `parse` の並べ替えだけで作る。
    wide: false,
    ownOrigin: searxngBase,
    unavailable: () =>
      searxngBase() ? undefined : "OPEN_ZERO_SEARXNG が空にされている(SearXNG を使わない設定)",
    url: (q) => JOB_SITES.map((s) => `${searxngBase()}/search?q=${enc(`site:${s} ${q}`)}&format=json`),
    parse: (b) => {
      // 媒体ごとに新しい順。募集 ID が掲載時刻の代わりになる。
      // 媒体をまたいで ID を比べても意味が無いので、先ごとに束ねてから並べ替える。
      // 募集が生きているかまでは分からない(`reading` で開かせている)。
      const 束 = new Map<string, { hit: Hit; id: number }[]>()
      for (const h of searxngHits(b)) {
        const u = new URL(h.url)
        const host = u.hostname.replace(/^(?:www|en-jp)\./, "")
        const m = JOB_PATHS[host]?.exec(u.pathname)
        if (!m) continue
        // 題が URL のままの項は落とす。索引が題を取れていないページで、語とは無関係に
        // 同じ URL が返ってくる。ID が大きいので放っておくと先頭に来る。
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
            // Stack Exchange は unix 秒。ここで ISO に揃える。
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
    // Atom を素で読む。`toText` の feed 整形には通さない — 著者が複数あり要約が長いので、
    // ここで欄ごとに取ったほうが落ちない。
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
]

/** 他の先から回す行き先。名前で引き直さずに済むよう、一度だけ取っておく。 */
const X_SOURCE = SOURCES.find((s) => s.name === "x")
const SHOWHN_SOURCE = SOURCES.find((s) => s.name === "showhn")
const JOB_SOURCE = SOURCES.find((s) => s.name === "job")
/**
 * 仕事を探している語。「副業」は税や確定申告の話でも出るので足りない。
 * 探す側の語(案件・募集・稼働・業務委託)と並べて、どれか1つでも入っていたら `job` も出す。
 * 外れたときの損は SearXNG への3回だけ。
 */
const JOB_WORDS =
  /副業|複業|業務委託|準委任|フリーランス|案件|求人|募集|稼働|freelance|side ?job|contract work/i

/**
 * `job` に渡す前に落とす語。媒体の名前と、媒体を選ぶときの語。
 *
 * モデルは「副業を探したい」を媒体選びの調査として解くので、`job` に届く語は
 * 「ITプロパートナーズ React 週1 リモート 案件」の形になる。クラウドワークスの索引に
 * 「ITプロパートナーズ」は入っていないから、そのまま引くと無関係な募集が返る。
 * 道具の説明文では直らなかったので、こちらで落とす。
 */
const JOB_NOISE =
  /^(?:offers\??|workship|goworkship|findy|freelance|レバテック(?:フリーランス)?|levtech|itプロパートナーズ|シューマツワーカー|youtrust|anycrew|複業クラウド|lotsful|sokudan|flexy|クラウドワークス|ランサーズ|crowdworks|lancers|wantedly|ココナラ|coconala|エージェント|サービス|サイト|公式|手数料|審査|登録|スカウト|案件紹介|評判|口コミ|比較|おすすめ|まとめ|とは|\d{4}年?)$/i

/**
 * 募集を引くに足る語。技術名か職種が1つも残らなかったら `job` は出さない。
 * 「Offers 手数料 審査 スカウト 応募 公式 副業」から媒体名と調査語を落とすと「副業」だけになり、
 * それで引くと媒体をまたいで無関係な募集が返る。
 */
const JOB_SKILL =
  /react|vue|next|nuxt|svelte|angular|typescript|javascript|node|python|go|rust|php|ruby|java|swift|kotlin|flutter|unity|aws|gcp|sql|フロントエンド|バックエンド|インフラ|デザイン|ライティング|動画編集|エンジニア|開発|制作|コーディング|翻訳|データ入力/i

/**
 * `job` 用に語を削る。媒体名と調査語を落として、技術か職種が残っていたらそれを返す。
 * 残らなければ `undefined` — そのときは `job` を出さない。
 */
function toJobTerm(q: string): string | undefined {
  const kept = plainQuery(q)
    .split(/\s+/)
    .filter((w) => w && !JOB_NOISE.test(w))
  if (!kept.some((w) => JOB_SKILL.test(w))) return undefined
  return kept.join(" ")
}

/** 先の名前と、そこで何が引けるか。道具の説明文を実装から作るために出す。 */
export const SOURCE_MENU: readonly { name: string; what: string; wide: boolean }[] = SOURCES.map((s) => ({
  name: s.name,
  what: s.what,
  wide: s.wide,
}))

/**
 * 先を指定しなかったときに出る先。使えない先は最初から混ぜない。
 * 呼ぶたびに環境変数を見る(定数にしない)。道具の説明文もここから作るので、
 * 説明に並ぶ先と実際に叩く先が食い違わない。
 */
export const defaultSources = (): readonly string[] =>
  SOURCES.filter((s) => s.wide && !s.unavailable?.()).map((s) => s.name)

/**
 * 先ごとの読み取りだけを取り出す。検査から呼ぶための関数で、外へ出ずに保存しておいた応答で
 * 読み取りを確かめられる。知らない先なら `undefined`。
 */
export function parseFrom(source: string, body: string): readonly Hit[] | undefined {
  return SOURCES.find((s) => s.name === source.toLowerCase())?.parse(body)
}

/**
 * 同時に出すときの1本あたりの制限。1ページを読む 20 秒より短くしてある —
 * 揃うのを待つ側にとって、遅い1本は落ちたのと同じだから。
 */
const SOURCE_TIMEOUT_MS = 8_000

/**
 * 回数制限に当たった先を、解けるまで叩かない。先の名前 → いつまで休むか(ms)。
 * 待たずに叩き続けても枠が減るだけなので、相手が言ってきた解除時刻まで外す。
 * プロセスの中に持つので走らせ直せば消えるが、枠は時間で戻るのでそれでよい。
 */
const restingUntil = new Map<string, number>()

/** 一時的な上限か、断られたのか。同じ 403 でも意味が違うので言い分けにする。 */
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
  /** 叩く先。省略すると既定の先へ同時に出る。 */
  readonly where?: readonly string[]
  /** 1つの先から取る件数。 */
  readonly perSource?: number
}

/**
 * 検索する。先が1つ落ちても他は返し、落ちた先は理由付きで並べる。
 * 相手ごとに `Promise.all` で同時に出す(別ホストなので `pace` の1秒は互いに掛からない)。
 * 語が空なら空配列。知らない先を名指しされたら、それも1つの `failed` として返す。
 */
export async function searchWeb(query: string, opts: SearchOptions = {}): Promise<readonly SourceResult[]> {
  const q = query.trim()
  if (!q) return []
  const perSource = Math.min(Math.max(opts.perSource ?? 8, 1), 20)
  const names = opts.where?.length ? opts.where : defaultSources()
  // `web` に `site:x.com` と書かれたら、`x` の先で受ける。
  // `where: ["x"]` と書くよう説明に足してもモデルは `web` に `site:x.com/名前 ...` と書いてくるので、
  // 説明を強めるのではなくその書き方を受ける。同じ SearXNG を叩くので外向きの回数は変わらず、
  // 変わるのは読み取りだけ(`site:` を守らない索引の結果と、ログイン前の画面を拾った要約が落ちる)。
  const xTerm = toXTerm(q)
  // `hn` に「Show HN」と書かれたら、`showhn` の先で受ける。同じ理由で、モデルは
  // `where: ["showhn"]` ではなく `hn` に `query=Show HN ...` と書いてくる。
  // 受け直す得は `toShowHnTerm` に書いた順位のほう。
  const showTerm = toShowHnTerm(q)
  const picked = names.flatMap((n) => {
    const s = SOURCES.find((x) => x.name === n.toLowerCase())
    if (!s) return []
    if (s.name === "web" && xTerm !== undefined && X_SOURCE) return [X_SOURCE]
    if (s.name === "hn" && showTerm !== undefined && SHOWHN_SOURCE) return [SHOWHN_SOURCE]
    return [s]
  })
  // 仕事を探す語が入っていたら、`web` と並べて `job` も出す。ここだけ置き換えではなく追加。
  // X と Show HN は同じ問いをより当たる先へ回すが、こちらは問いが2つに割れる —
  // 媒体選びと相場の調査(`web` が答える)と、募集そのもの探し。
  // `web` に「React 副業 案件」と書いても返るのは SEO 記事だけなので、両方出す。
  // 増えるのは SearXNG への3回。
  //
  // 語はそのまま渡さない(`toJobTerm`)。媒体名と調査語を落として、
  // 技術も職種も残らなければ `job` は出さない。
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
      // 検索エンジンの構文は、それを解する先にだけ渡す。
      // 回してきた分は語を直してから引く — `site:x.com/名前` は `from:名前` に、
      // `Show HN` の2語は落とす(タグで絞る先に語としても渡すと、順位がその2語に引かれる)。
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
            // 解除時刻を言ってこない先は、10分置いてから試す。
            restingUntil.set(s.name, res.resetAtMs ?? Date.now() + 10 * 60_000)
          }
          throw new Error(whyFailed(res.status, res.body, res.resetAtMs))
        }
        if (!res.body) throw new Error(`空の応答(HTTP ${res.status})`)
        try {
          return s.parse(res.body).slice(0, perSource)
        } catch (e) {
          // 形が変わった先を「0件」で流さない。読めなかったことを見えるようにする。
          throw new Error(`応答を読めなかった: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      /**
       * 先が複数あるときは同時に叩いて混ぜる。1つでも読めれば返す
       * (3媒体のうち1つが落ちても残り2つは出す)。全部落ちたときだけ理由を投げる。
       */
      const call = async (u: string | readonly string[]) => {
        if (typeof u === "string") return one(u)
        const rs = await Promise.allSettled(u.map(one))
        const ok = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
        if (ok.length === 0)
          throw new Error(rs.map((r) => String((r as PromiseRejectedResult).reason)).join(" / "))
        // 先ごとに1件ずつ取る。先頭から詰めると、最初の先だけで枠が埋まる。
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
          // 広げ方が無い語では2回目を出さない(`Source.broaden` の注)。
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
 * 読ませる形にする。先ごとに分けたまま出す — 混ぜて並べ直すと、
 * どの索引が拾ったのかが消えて「web にそう書いてある」に見える。
 *
 * 同じ URL が複数の先に出たときは最初の1つだけ残し、残りは先の名前を添えるだけにする
 * (別々の索引が同じページを拾ったこと自体が目印になる)。
 * 日付はユーザーの時計(`localStamp`)。UTC のまま出すと夜中の記事が前日として読まれる。
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
    // 読み方が他と違う先は、結果のすぐ上でそう言う(`Source.reading`)。
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
