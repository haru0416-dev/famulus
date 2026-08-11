/**
 * 検索の口。**`fetch` は URL を1つ開く道具で、こちらは「まだ URL を知らない」ときの道具。**
 *
 * ここを足すまで、主エージェントに検索は無かった。外を探す道は `researcher`(rmod のサーバ側
 * web_search)だけで、**中で何を検索して何件見たのかは持ち主に届かない**。実測:
 * GitHub の README について訊いた回は、内容の正しい答えが返ったのに `開いた頁: 無し` のままだった。
 * 索引だけを写して答えたのか、原文を見て答えたのかが、事後に区別できない。
 *
 * ## 何を叩くか(実測、このホストから)
 *
 * 鍵が要らず、**先方が「プログラムから使ってよい」と公開している口**だけを並べた。
 * 件数・時間・転送量は1問あたり。
 *
 * | 先 | 件数 | 時間 | 転送量 | 既定 |
 * |---|---|---|---|---|
 * | SearXNG(自前) | 26〜57 | 1.3秒 | — | ○ |
 * | Zenn /api/search | 48 | 0.06秒 | 39KB | ○ |
 * | Qiita API v2 | 5 | 0.76秒 | 273KB〜 | ○ |
 * | GitHub search API | 20 | 0.74秒 | 110KB | ○ |
 * | HN (Algolia) | 20 | 0.41秒 | 45KB | ○ |
 * | Stack Exchange 2.3 | 30 | 0.32秒 | 22KB | 名指し |
 * | npm registry search | 20 | 0.72秒 | 22KB | 名指し |
 * | Wikipedia API | 20 | 0.94秒 | 21KB | 名指し |
 * | arXiv API | 5 | 0.5秒 | 小 | 名指し |
 *
 * ## 一般の web は、鍵を買わずに自前で立てた
 *
 * 一般の web を引く口は、外から買うと鍵が要る。**Bing Search API は 2025-08-11 に終了、
 * Google Custom Search JSON API は新規受付停止で 2027-01-01 終了**。残る Tavily・Brave・Serper は
 * どれも鍵の管理が要り、Brave は無料枠でもカード登録を求める。そこで `~/Project/searxng` に
 * SearXNG(2026.8.10)を立てた。**127.0.0.1:8888 に縛ってある**(Docker の `-p` は ufw を
 * 素通りするので、左に 127.0.0.1 を置かないと検索サーバが世界に公開される)。
 *
 * 実測でエンジンを選んだ。**既定の 274 エンジンのうち、このホストから件を返したのは 17**。
 * brave は 8/8 で `too many requests`、qwant・startpage は 8/8 で CAPTCHA、duckduckgo(無印)は
 * 4/8 で CAPTCHA、mojeek・yep・dogpile・fireball は access denied。返った 17 からさらに、
 * gabanza(問い自体を無視して generic な頁を返す)・fynd(無関係な製品頁が混ざる)・
 * reloado(DOI の論文しか返さない)・quark/baidu/naver(中国語・韓国語圏に寄る)を落とし、
 * **11 エンジン**にした。この構成で8問投げて**落ちた先 0、1問あたり 60〜95 件、中央値 1.71 秒**。
 * `site:zenn.dev Effect TypeScript` は 62 件が全部 zenn.dev、日本語の問いも通る。
 * 選び方と落とした理由は `~/Project/searxng/config/settings.yml` に書いてある。
 *
 * ### 普段遣いに合わせて 12 → 9 に削った
 *
 * 上の 11 は「件を返すか」で選んでいて、**普段遣いの負荷では焼き切れた**。40問を4本同時で
 * 隙間なく投げると、1問 60〜70 件が 28 秒後には 20 件まで落ちる。gmx 0/40(CAPTCHA)、
 * google cse 6/40(`too many requests`)。2分休ませても両方戻らなかった。
 * 原因は**エンジン数がそのまま外へ出る回数になる**ことで、12 並べた状態の1問(平均 15 検索)は
 * 180 リクエストになる。
 *
 * 選び直す物差しを「独自性」から **上位10件に食い込んだ回数** に変えた。呼ぶ側が読むのは上位 8 件で、
 * そこに来ない結果は在っても使われない。10問の実測(件数 / 独自 / 上位10入り)で
 * **seznam 100 / 86% / 11** — 独自性は最高なのに上位に来ず、しかも p95 3.5 秒で最も遅い。落とした。
 * gmx(CAPTCHA)と wikipedia(一般検索では 0 件。語を引く用途は別の先がある)も外して 9。
 * `outgoing.request_timeout` は 5.0 → 3.0(止まっている先を待つだけで 1問が 5 秒に張り付いていた)。
 *
 * 効果は**間合いで割れる**。4本同時で隙間なしの 40問では中央 1.64 → 1.07 秒・p90 5.01 → 2.48 秒に
 * 縮んだが、劣化そのものは残る(28問目あたりで resulthunter と privacywall が止まり 5〜6 件に落ちる)。
 * **実使用の間合い(端から端まで動かした回の実測: 15 検索 / 218 秒 = 14.5 秒に1問)で 20 問投げると
 * 劣化しない** — 件数 中央 43(最小 26)・中央 1.30 秒で、前半10問の中央 43 に対し後半10問は 47。
 * 焼き切れは**押し込んだときにだけ起きる**、というのがここまでで測れたこと。
 *
 * 落としたもの、と理由:
 *
 * - **Brave の HTML は品質が一番良かった**(20件・0.65秒・日本語も `site:` も通る)が、
 *   `robots.txt` に `Disallow: /search` と書いてある。**断られている入口は使わない。**
 *   SearXNG 経由でも brave は 8/8 で断られたので、結局この索引は入っていない。
 * - DuckDuckGo(html/lite)を直に叩くと bot 判定に落ちる。返るのは `anomaly-modal` の CAPTCHA 頁。
 *   SearXNG の `duckduckgo web` エンジン経由なら通る(2/2)。
 * - **Marginalia の公開 API は動いていない。** 8問投げて接続失敗が4問、200 で返った4問も全部 0 件。
 * - Reddit の `search.json` は 403。Ecosia は 403、Startpage・Mojeek は結果を取り出せる形で返らなかった。
 *
 * 線引きは **「相手がプログラム向けに出している口を使う」** の一本。Qiita の robots には API 配下を除く
 * 行があるが、API v2 は版付き・回数制限付き(無認証 60回/時)で公開された**プログラム向けの口そのもの**で、
 * 同じ robots で API の文書だけは許可されている。あれは検索避けであって利用の禁止ではない、と読んだ
 * — **ここは解釈で、先方の明文ではない。** Zenn の `/api/search` は文書化されていない内部の口で、
 * robots の `Disallow: /search` には(前方一致しないので)当たらない。灰色なので1検索につき1回に留める
 * (`broaden` を持たせていない)。**「1問につき1回」ではない** — 1問で 25 検索まで出た回があり、
 * Zenn へは 25 回叩いていた(実測)。回数制限は返ってこなかったが、そういう量になる。
 *
 * **X は、この線引きで全部落ちた。** 2026-08-11 に本文の取れる口を4つ測って、4つとも断られている:
 * `x.com/robots.txt` が `User-agent: * / Disallow: /`(コメントに
 * "Every bot that might possibly read and respect this file" と書いてある)、
 * `cdn.syndication.twimg.com` も `Disallow: /`(本文込みの JSON が 200 で返るのに、である)、
 * **X 公式の埋め込み API である `publish.x.com/oembed` すら robots で `Disallow: /oembed`**。
 * 残る `x.com/<user>/status/<id>` の直引きは 307 のあと JS の殻が 40KB 返るだけで本文が無い。
 * だから `x` の先は**取りに行かない** — SearXNG に `site:x.com` を投げて、
 * **検索エンジンが既に作った索引の要約を読む**。要約に本文が 143〜291 字入っていた(`x` の注)。
 * 誰かのタイムラインを時系列で流し読みする道は、これでは作れない。
 *
 * **SearXNG には、この物差しがそのまま当たらない。** 中でやっているのは Google や Bing の結果頁の
 * 読み取りで、Brave の HTML を落とした理由(断られている入口は使わない)と同じ形をしている。
 * 違うのは、断り方が robots の明文ではなく CAPTCHA と `access denied` で返ってくることで、
 * **断ってきた先(brave・qwant・startpage・mojeek 他)は結果として全部落ちた**。残ったのは
 * 通してくる先だけ、という状態になっている。これが線を守れていることになるのかは**持ち主の判断**で、
 * ここでは「断られたら引かない」までしか実装していない。
 *
 * ## 回数の上限(どちらも実際に当てた)
 *
 * - **Qiita 無認証は 60回/時。** 端から端まで1回動かしただけで使い切った(1問で 15 回叩いていた)。
 *   使い切ると、その時間帯は全部 403 で返る。窓が1時間なので、**戻るまで最大1時間** — ここだけ
 *   桁が違う。2026-08-11 に測り直したら、25 検索の1問で **46 リクエスト**を出して
 *   `rate-remaining: 0` になっていた。半分は絞りが 0 件で引き直した2回目。
 *   絞りを日本語の語にだけ掛けて、英語の語は1検索1リクエストにした(`qiita` の注)。
 * - **GitHub の検索は無認証で 10回/分。** 100秒で 17 問投げた回に 403 が1つ出た。
 *   こちらは窓が1分で回るので、待てばすぐ戻る。
 *
 * どちらも待てば戻る種類なので、当たった先は解除時刻まで叩かない(`restingUntil`)。
 * 鍵を入れれば枠は増えるが、**鍵を置く場所と持ち主の同意が先**なので今は入れていない。
 *
 * ## 「細かく広く」の作り
 *
 * - **広く**: 先を指定しなければ既定の先へ**同時に**出る。別ホストなので `pace` の1秒は互いに掛からない
 *   — 実測 0.8〜1.3秒で 14〜16件。
 * - **細かく**: `where` で先を名指しできる。npm・arXiv・Stack Overflow・Wikipedia を既定から外したのは、
 *   問いの型が決まっているときにしか当たらないから(Wikipedia は概念で引くと 8/8 外した。下の注記)。
 *
 * 返すのは題・URL・書き手・日付・数字だけ。**本文は持ってこない** — 読むかどうかは見てから決める。
 */
import { localStamp } from "../core/time.ts"
import { fetchRaw } from "./Web.ts"

/** 1件。**本文は入れない。** 開くかどうかを決めるのに要るものだけ。 */
export interface Hit {
  readonly title: string
  readonly url: string
  /** 書き手。分かる先だけ。 */
  readonly by?: string
  /** 日付。ISO のまま持ち、見せるときに持ち主の時計へ直す。 */
  readonly at?: string
  /** 星の数・いいね・点数・要約など、**その先でしか分からない目印**。 */
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
   * 結果の読み方。件数の見出しの下に1行出す。**他の先と読み方が違う先にだけ書く。**
   * 道具の説明に一度書くのでは足りない — 読む側が判断するのは結果を見た瞬間で、そこに要る。
   */
  readonly reading?: string
  /**
   * 叩く口。**複数返すと、まとめて叩いて1つの先として返す。**
   * `site:` を1媒体ずつ投げないと当たらない先があるので、そこで要る(`job` を参照)。
   */
  readonly url: (q: string, n: number) => string | readonly string[]
  /**
   * 0件だったときにもう一度だけ試す形。**絞り込みを外す用**で、別の問いを投げるためではない。
   * `undefined` を返せば2回目を出さない — **最初から絞っていない語では、同じ問いをもう一度
   * 投げることになるだけ**なので、そこで枠を使わない(`qiita` を参照)。
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
   * 自分で立てた口なら、その origin。`Web.ts` の内側判定をここだけ免除する。
   * **文字列は実装が持つ** — 問い合わせ文から組み立てられる余地を作らない。
   */
  readonly ownOrigin?: () => string
}

/**
 * 検索エンジンの構文を落とす。**API は `site:` を解さない。**
 *
 * 実測(端から端まで動かした回): モデルは web 検索の癖で `site:zenn.dev/articles "Effect"`
 * のように書く。GitHub はこれを不正な絞り込みとして **422 で断り**(9回中9回)、Zenn と HN は
 * ただの語として読むので巻き添えで 0 件になる。**語だけ渡す。** `site:` で先を絞りたいときは
 * `where` で名指しする側が正しい道で、道具の説明にもそう書いてある。
 */
export function plainQuery(q: string): string {
  const stripped = q.replace(/\b(?:site|inurl|intitle|filetype|ext):\S+/gi, " ")
  const left = stripped.replace(/\s+/g, " ").trim()
  // 絞り込みしか書かれていなかったときは、値のほうを語として残す(問いを空にしない)。
  return (
    left ||
    q
      .replace(/\b(?:site|inurl|intitle|filetype|ext):/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

/**
 * 自前の SearXNG の在り処。既定は `~/Project/searxng/docker-compose.yml` が縛っている口。
 * **空にすると `web` の先が既定から外れる** — 容器を落として使わない日のための逃げ道。
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
 * 途中で切れた JSON の配列から、**閉じている項だけ**を拾う。
 *
 * Qiita の API は記事本文を丸ごと返すので、1件で 100KB を超えることがある。実測:
 * `per_page=10` の1問が 1,357,106 文字目で読み取り上限に当たり、`JSON.parse` が丸ごと失敗して
 * **10件すべてが 0 件になった**。中身は 9 件ぶん揃っていたのに、最後の1件が切れただけで全部落ちる。
 * 括弧の深さを数えて、閉じたところまでを配列に組み直す(文字列の中の括弧は数えない)。
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
 * 語を上限まで切る。**語の途中では切らない** — 空白があればそこまでで止める。
 * 半端な語尾(`migrat`)を投げても当たらないので、1語まるごと落とすほうを取る。
 */
function clip(q: string, max: number): string {
  const chars = [...q]
  if (chars.length <= max) return q
  const cut = chars.slice(0, max).join("")
  const sp = cut.lastIndexOf(" ")
  return (sp > max / 2 ? cut.slice(0, sp) : cut).trim()
}

/**
 * 検索語に日本語(かな・漢字)が混ざっているか。**日本語の先に絞りを掛けるかの判断に使う。**
 * カタカナ語だけの片仮名(「ランタイム」)も日本語として拾う。ローマ字表記の日本語は拾えないが、
 * 検索語としてはまず出てこない形なので見ない。
 */
const hasJa = (q: string): boolean => /[぀-ヿ㐀-鿿]/u.test(q)

/**
 * X を引く語を組む。`from:名前` か `@名前` が混ざっていたら**その人の投稿だけ**に絞る。
 *
 * 実測(`Environment API` を付けて SearXNG に投げた4通り):
 * `site:x.com/youyuxi` が 12件で**12件とも本人**、`site:x.com from:youyuxi` は 30件中 15件が投稿で
 * 15件とも本人、`site:x.com @youyuxi` は 31件中 14件が投稿でうち本人は 11件。
 * **URL の path に入れる形が一番外さない**ので、それに直す。
 *
 * 端から端まで動かした回に、モデルは `site:x.com/youyuxi ...` と自分で書いていた。
 * ただし `web` の先へ投げていたので、`site:` を無視する索引の結果が混ざっていた。
 * 書き方は合っていたので、**その書き方をこちらで受ける。**
 */
/**
 * 索引が投稿ではなく**ログイン前の画面**を拾ったときに要約へ出る文言。実物から取った。
 * ここに当たった要約は、投稿の中身ではないので出さない。
 */
/** 副業の募集を引く先。**個別の募集頁が索引に入っている媒体だけ**(`job` の注)。 */
const JOB_SITES = [
  "crowdworks.jp/public/jobs",
  "lancers.jp/work/detail",
  "www.wantedly.com/projects",
] as const
/** 募集頁だけを残す形。`site:` を守らない索引が react.dev などを混ぜてくるので、こちらで落とす。 */
const JOB_PATHS: Record<string, RegExp> = {
  "crowdworks.jp": /^\/public\/jobs\/(\d+)$/,
  "lancers.jp": /^\/work\/detail\/(\d+)$/,
  "wantedly.com": /^\/projects\/(\d+)$/,
}

const X_SHELL =
  /JavaScript is (?:disabled|not available)|The latest posts from|Something went wrong|site owner hides|Log in to X/i

function xQuery(q: string): string {
  const m = /(?:^|\s)(?:from:|@)([A-Za-z0-9_]{1,15})(?=\s|$)/.exec(q)
  const rest = m ? q.replace(m[0], " ").replace(/\s+/g, " ").trim() : q
  return `site:x.com${m ? `/${m[1]}` : ""} ${rest}`.trim()
}

/**
 * `web` 宛ての語が X を狙っているかを見て、狙っているなら `x` へ渡す形に直す。
 * `site:x.com/youyuxi Vite` → `from:youyuxi Vite`。狙っていなければ `undefined`。
 *
 * **`site:x.com` だけを見て、他の `site:` は見ない。** 2つ書いてあるなら
 * (`site:x.com OR site:zenn.dev` のような書き方)X に寄せるのは行き過ぎなので、そのまま `web` に流す。
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
 * **引用符ごと括られる。** 最初に書いた版は行頭の引用符しか見ていなくて、端から端まで動かしたら
 * 784秒のランで 4 回すり抜けた(実測)。モデルが書いていたのは
 * `site:news.ycombinator.com/item "Show HN" "agent" "2026-08"` — **文の途中で、括られている**。
 * だから前後の引用符を含めて拾う。**残りの語の引用符は外さない**(Algolia は句として読む)。
 *
 * **混ざり方では差が出なかった。** 8題×上位10件を測って、
 * `hn` に `query=Show HN <話題>` と書いた側も Show HN 純度 73/73 で、タグと同じだった。
 * 差が出たのは**中身**のほう — 上位8件の重なりが 0〜6/8、点数の中央値は 126 対 345 で、
 * 8題中7題でタグ側が上。語に「Show HN」を混ぜると近接ランキングがその2語に引かれて、
 * 題が話題語で始まる項が上に来る(19/64 対 4/64)。Alacritty(1170点)が落ちて
 * 「Rust Web Framework」が1位になる、という形で効いていた。
 */
function toShowHnTerm(q: string): string | undefined {
  const m = /(?:^|\s)["'“”]?show[\s._-]?hn\s*:?["'“”]?(?=\s|$)/i.exec(q)
  if (!m) return undefined
  // Algolia は `site:` を語として読むだけなので、他の先と同じく落としてから渡す。
  return plainQuery(q.replace(m[0], " ")).replace(/\s+/g, " ").trim()
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {}
/** 検索結果の要約に混ざる印を落とす(Wikipedia の `<span class="searchmatch">` など)。 */
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
 * SearXNG の応答を読む。`web` と `x` で共有する — 同じ口を叩いているので、形も同じ。
 *
 * `content` を渡すと要約に手を入れられる。`undefined` を返せばその要約を落とす
 * (索引の要約が中身になっていないことがある — `x` を参照)。
 */
const searxngHits = (b: string, content?: (c: string) => string | undefined): readonly Hit[] =>
  rows(obj(JSON.parse(b)).results).flatMap((r) => {
    const url = str(r.url)
    const title = str(r.title)
    if (!url || !title) return []
    // **いくつの索引が同じ頁を拾ったか**を出す。SearXNG が並べ替えに使っている根拠そのもので、
    // 「1つの索引だけが出してきた頁」と「9 中 5 つが揃って出した頁」を読む側が見分けられる。
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
    // 唯一「一般の web」を引ける先で、他の先が全部専門の索引なので、既定に必ず入れる。
    // 実測(索引を 9 に削ったあと): 6問で 26〜57 件、中央値 1.41 秒。
    // **同時に 4本出しても劣化しない**(24問を4本同時×6波・間40秒で、前半中央 35 → 後半 33)。
    wide: true,
    // 検索エンジンの構文が通る唯一の先。実測: `site:zenn.dev Effect TypeScript` の 62 件が
    // 全部 zenn.dev だった。**ここだけは `site:` を落とさずにそのまま渡す。**
    qualifiers: true,
    ownOrigin: searxngBase,
    unavailable: () =>
      searxngBase() ? undefined : "OPEN_ZERO_SEARXNG が空にされている(SearXNG を使わない設定)",
    // 件数の指定は無い。1頁ぶん(60〜100件)返るので `perSource` で切る。
    url: (q) => `${searxngBase()}/search?q=${enc(q)}&format=json`,
    parse: searxngHits,
  },
  {
    name: "x",
    what: "X(旧 Twitter)の投稿。作者本人の発表や、記事にならない短い話。**要約が投稿の本文そのもの**。語に `from:名前` を混ぜるとその人の投稿だけになる",
    // **他の先と読み方が逆になるので、結果の側にも書く。**
    // 実測(端から端まで4回目): この注が無かった回、外を見る役は
    // 「検索の索引に出た要約はあるが、それは原文じゃないので引用として使わない」と判断して、
    // 取れていた投稿本文を捨てた。道具の説明にある「要約を事実として書かない」が、
    // **ここでは逆に働く** — X の要約は頁の紹介文ではなく、投稿の文字そのものだから。
    reading:
      "**ここの要約は投稿の本文そのもの**(索引が写した逐語の断片)で、頁の紹介文ではない。" +
      "そのまま引用してよい。ただし**頭からとは限らず、途中から始まって切れている** — " +
      "実測では原文「The cool thing about building Void is that…」に対し要約は2段落目から始まっていた" +
      "(2投稿で確認。X 自身の出力と突き合わせた)。引くときは断片だと書く。" +
      "x.com は開けない(robots)ので、全文はこれ以上取れない。",
    // **X 本体は叩かない。** `x.com/robots.txt` は `User-agent: * / Disallow: /` で、
    // 本文が取れる口も全部断られている(実測):
    //   - `cdn.syndication.twimg.com/tweet-result?id=` … 本文込みで 200 が返るが robots は `Disallow: /`
    //   - `publish.x.com/oembed` … X 公式の埋め込み API なのに robots に `Disallow: /oembed`
    //   - `x.com/<user>/status/<id>` を直に引く … 307 のあと JS の殻だけ(40KB、本文なし)
    //   - `syndication.twitter.com/srv/timeline-profile/screen-name/<name>` … 429
    // **断られている入口は使わない**(この節の線引き)ので、どれも採らない。
    //
    // 代わりに **既に索引された結果を読む**。取りに行ったのは検索エンジンで、こちらは
    // SearXNG に問い合わせるだけ。実測: `site:x.com vite environment api` で
    // 35 件中 23 件、`site:x.com Effect TS schema` で 46 件中 28 件が `/status/` の URL。
    // **要約に投稿の本文が 143〜291 字入る**(いいね数・返信数・日付ごと)。
    //   例: 「Effect v4 Beta kept moving in June. This month's recap covers: → Adaptive rate l…」
    //       (`115 likes 4 replies` 付き)
    // 時系列で追う(誰かのタイムラインを流し読みする)ことはできない。**語で引く先。**
    wide: false,
    ownOrigin: searxngBase,
    unavailable: () =>
      searxngBase() ? undefined : "OPEN_ZERO_SEARXNG が空にされている(SearXNG を使わない設定)",
    // `site:` は**こちらが付ける**(`xQuery`)。呼ぶ側が書いた `site:` は `plainQuery` が落としてから
    // 来るので(`qualifiers` を立てていない)、`site:zenn.dev` と競合して 0 件になることがない。
    url: (q) => `${searxngBase()}/search?q=${enc(xQuery(q))}&format=json`,
    // **`site:x.com` を守らない索引が混ざる。** 6問 268 件を数えたら 113 件(42%)が投稿ではなく、
    // その中に vite.dev・github.com・en.wikipedia.org・vite.js.cn が入っていた(実測)。
    // 残りは developer.x.com の案内頁や、投稿の無い個人頁(`x.com/YandR_CBS`)。
    // **枠を食うだけなので、投稿の永久リンクだけ残す。** これで 6問の 268 → 155 件が全部投稿になる。
    //
    // 要約のほうにも殻が混ざる。索引が投稿ではなくログイン前の画面を拾った回で、
    // 「We've detected that JavaScript is disabled in this browser」がそのまま要約になる。
    // 8問 162 件のうち 28 件(17%)、`site:x.com/mizchi` の1問では 29 件中 12 件がこれだった。
    // **項ごと落とさない** — 題のほうには中身が残っていることがある
    // (`mizchi on X: "TypeScript でオレオレ Result 型使…`)。要約だけ外して、題は出す。
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
        // 同じ投稿が別の URL で二重に出ることがある(`?lang=ca` 付きや、旧い口座名のまま索引された物)。
        // 実測では 8問で 2 件だけだが、**投稿は id で1つに決まる**ので id で見る。
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
    // **既定から外した。** 全文一致なので、概念で引くと本文にその語が出るだけの記事が並ぶ。
    // 実測「AIエージェント 記憶 設計」で返った8件は、チャットボット以外の7件が
    // 勇者警察ジェイデッカー・S.H.I.E.L.D.・恋愛フロップスといったフィクションの記事だった。
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
    // **語は 100 文字まで。** 101 文字で 400 が返る(実測、境目は 100/101 でちょうど。
    // 全角100文字=300バイトが通って全角101文字が落ちるので、**バイト数ではなく文字数**)。
    // 端から端まで動かした回に、モデルが投げた長い語で1回落ちた。切らないと落ちるだけなので切る。
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
    // **`per_page` を上げない。** 本文が丸ごと入るので 10 件で 848KB、20 件で 3.3MB になる
    // (実測)。読む上限 1.5MB を超えると JSON の途中で切れる。5 件に抑えたうえで、
    // それでも切れたときのために `partialArray` で閉じている項だけ拾う。
    //
    // **並びは新着順で、変えられない。** `sort=rel` を付けても返りは1文字も変わらなかった
    // (同じ問いで完全一致)。そのままだと当日投稿の ♡0 ばかりが5件並ぶ。
    // 代わりに検索語の側で `stocks:>10` と絞る — これは Qiita の検索構文で、効く。
    // 実測: 「AIエージェント」が ♡0/0/0 → ♡17/10/27、「Effect TypeScript」が ♡0/0/0 → ♡7/21/23。
    // ただし**狭い話題は丸ごと消える**(「SQLite FTS5 trigram」は 5件 → 0件)ので、
    // 0件のときだけ絞りを外してもう一度引く(`broaden`)。
    //
    // **その絞りを、日本語が入っている語にだけ掛ける。** ここは1時間 60回の硬い枠を持つ唯一の先で、
    // 2回引くと1問で使い切る。実測(Biome v2 の移行を訊いた端から端まで1回):
    // 25 検索で Qiita へ 46 リクエスト、直後の `rate-remaining` が **0**。内訳は絞り付き 25 回と、
    // **そのうち 21 回が 0 件で、絞りを外して引き直した 21 回**。ASCII だけの語(`files.includes`、
    // `--locked` のような英語の識別子)で `stocks:>10` が当たらないのは、Qiita の記事が日本語で
    // 書かれていて、ストック数の多い記事ほど一般的な話題に寄るから。
    // 日本語が入っていない語では最初から絞らず、`broaden` も出さない。**1検索 1リクエストになる。**
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
    // `hn` と同じ Algolia の口に `tags=show_hn` を足すだけ。**追加の枠も鍵も要らない。**
    // 実測: `tags=show_hn` 全体で 11,327 件、`(story,show_hn)` で 480,546 件。
    // 語を付けた `search` で「AI agent」7,175 件・「rust」7,457 件。
    //
    // **新着順(`search_by_date`)は採らなかった。** 同じ `tags=show_hn` で並べ替えだけ変えると、
    // 語がほとんど効かなくなる — 「rust」で返った上位4件が全部 2026-08-11 の投稿で、
    // Minecraft の seed ツールと「6:18am now going to sleep as MVP is made GN」だった(点数 2)。
    // 関連順なら Alacritty 1170点・Warp 946点が出る。**問いに答える先としては関連順。**
    // 新着を流し読みする道は塞がっているのではなく、**この道具が語で引く形しか持っていない**。
    wide: false,
    url: (q, n) => `https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=show_hn&hitsPerPage=${n}`,
    parse: hnHits,
  },
  {
    name: "job",
    what:
      "副業・業務委託の募集。クラウドソーシング(クラウドワークス・ランサーズ)と Wantedly の" +
      "**募集頁そのもの**。語には職種や技術を入れる(「React 週2 リモート」など)",
    reading:
      "**募集の終わったものが混ざる。**索引を読んでいるため — 実測(2026-08-11、4問×3媒体、" +
      "募集頁175件)で受付中は、新しい順の上半分が 64/88、下半分が 46/87。**上に出たものほど生きている**が、" +
      "上でも4件に1件は終わっている。**報酬・掲載日・応募期限は募集頁を開けば載っている**" +
      "(クラウドワークスは全部、ランサーズは要件まで)。勧める前に開いて、期限と中身を確かめる。媒体ごとに新しい順。",
    // **口を媒体ごとに分けている。** `(site:a OR site:b)` は索引が潰す(実測:
    // 2媒体の OR で 26件中 6件、1媒体ずつなら 30件中 20件)。`Source.url` が配列を返せるのはこのため。
    //
    // 媒体を3つに絞った根拠(同日、`site:` で引いて個別頁が索引にあるか):
    // Wantedly 44件中33件、クラウドワークス・ランサーズも個別頁が返る。
    // **落とした先**: Findy Freelance(30件中0件 — 案件は login の内側)、
    // ココナラ(22件中2件、しかも分類頁)、Offers(34件中1件、残りは記事)。
    //
    // **期間で絞らない。撤回した判断。** 最初は `time_range=week` を付けていた。
    // 「受付中と語の当たりを両方満たす件数で週が勝つ(20件 対 8件)」と書いていたが、
    // **あれは `JOB_PATHS` で募集頁に絞る前の生の結果を数えていた** — react.dev や
    // W3Schools や媒体の索引頁が「期限切れでない」側に入っていて、絞りなし側の数を押し下げていた。
    //
    // 募集頁だけにしてから測り直した(3問×3媒体×上位10件、
    // **募集頁であり・語が題か本文に当たり・開いたら受付中**の3つを満たす件数):
    // 週 2件、月 11件、年 0件、**絞りなし 23件**。週で絞ると
    // 「React フロントエンド 週1 リモート」でクラウドワークスの上位10件が
    // 経理サポート・OCR校正・物流事務になり、React が1件も残らなかった。
    // 端から端まで動かした側でも同じことが起きていて、募集は1件も答えに出なかった。
    //
    // 絞りを外したので `broaden` も要らない。**再試行が消えて SearXNG への回数が半分になる** —
    // 週で絞ると 0件になりやすく、そのたび `broaden` がもう3回叩いていた。
    wide: false,
    ownOrigin: searxngBase,
    unavailable: () =>
      searxngBase() ? undefined : "OPEN_ZERO_SEARXNG が空にされている(SearXNG を使わない設定)",
    url: (q) => JOB_SITES.map((s) => `${searxngBase()}/search?q=${enc(`site:${s} ${q}`)}&format=json`),
    parse: (b) => {
      // 媒体ごとに新しい順。ID が時刻の代わりになる(実測15件で単調に増えていた)。
      // 媒体をまたいで ID を比べても意味が無いので、先ごとに束ねてから並べ替える。
      //
      // **期間で絞るのをやめたので、鮮度を保つのはこの並べ替えだけ。**それで足りるかを測った
      // (4問×3媒体、募集頁175件を開いて受付中か見た): 新しい順の上半分 64/88、
      // 下半分 46/87。効きはこの程度で、上に出ても4件に1件は終わっている。だから `reading` で
      // 「勧める前に開いて確かめる」と言ってある。
      const 束 = new Map<string, { hit: Hit; id: number }[]>()
      for (const h of searxngHits(b)) {
        const u = new URL(h.url)
        const host = u.hostname.replace(/^(?:www|en-jp)\./, "")
        const m = JOB_PATHS[host]?.exec(u.pathname)
        if (!m) continue
        // **題が URL のままの項は落とす。**索引が題を取れていない頁で、実測(
        // 4問×12件)で 48件中 11件。しかも中身が語と無関係だった — 同じ4本の URL が
        // React でも TypeScript でも Vue でも返り、要約は「提案一覧」やロゴ制作の依頼だった。
        // 語で当たったのではなく索引の常連として出ている。ID が大きいので先頭に来てしまう。
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
    // Atom を素で読む。**`toText` の feed 整形には通さない** — 著者が複数あり、要約が長いので、
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
 * 仕事を探している語。**「副業」だけでは足りない** — 税や確定申告の話でも出る語なので、
 * 探す側の語(案件・募集・稼働・業務委託)と並べて、どれか1つでも入っていたら `job` も出す。
 * 外れたときの損は SearXNG への3回で、当たらなかった先は 0件として並ぶだけ。
 */
const JOB_WORDS =
  /副業|複業|業務委託|準委任|フリーランス|案件|求人|募集|稼働|freelance|side ?job|contract work/i

/**
 * `job` に渡す前に落とす語。**媒体の名前と、媒体を選ぶときの語。**
 *
 * モデルは「副業を探したい」を**媒体選びの調査**として解く。端から端まで2回動かして
 * (560秒/847秒)、`job` に届いた語は全部この形だった —
 * 「ITプロパートナーズ React 週1 リモート 案件」「Offers 手数料 審査 スカウト 応募 公式」。
 * クラウドワークスの索引に「ITプロパートナーズ」は入っていないので、この語で引くと
 * 経理サポートや OCR 校正が返る。**2回とも募集は1件も答えに出なかった。**
 *
 * 説明文で直そうとしたが直らなかったので、こちらで落とす。
 */
const JOB_NOISE =
  /^(?:offers\??|workship|goworkship|findy|freelance|レバテック(?:フリーランス)?|levtech|itプロパートナーズ|シューマツワーカー|youtrust|anycrew|複業クラウド|lotsful|sokudan|flexy|クラウドワークス|ランサーズ|crowdworks|lancers|wantedly|ココナラ|coconala|エージェント|サービス|サイト|公式|手数料|審査|登録|スカウト|案件紹介|評判|口コミ|比較|おすすめ|まとめ|とは|\d{4}年?)$/i

/**
 * 募集を引くに足る語。**技術名か職種が1つも残らなかったら `job` は出さない。**
 * 「Offers 手数料 審査 スカウト 応募 公式 副業」から媒体名と調査語を落とすと「副業」だけになる。
 * それで引くと媒体をまたいで無関係な募集が返るので、そのときは黙って引かない。
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
 * 先を指定しなかったときに出る先。**使えない先は最初から混ぜない** —
 * 毎回「SearXNG が無い」と1行返しても、読む側にできることは無い。
 *
 * 呼ぶたびに環境変数を見る(定数にしない)。道具の説明文もここから作るので、
 * **説明に並ぶ先と実際に叩く先が食い違わない**。
 */
export const defaultSources = (): readonly string[] =>
  SOURCES.filter((s) => s.wide && !s.unavailable?.()).map((s) => s.name)

/**
 * 先ごとの読み取りだけを取り出す。**検査から呼ぶための口** — 外へ出ずに、
 * 保存しておいた応答で読み取りを確かめられるようにしてある。知らない先なら `undefined`。
 */
export function parseFrom(source: string, body: string): readonly Hit[] | undefined {
  return SOURCES.find((s) => s.name === source.toLowerCase())?.parse(body)
}

/**
 * 同時に出すときの1本あたりの制限。1頁を読む 20 秒より短くしてある。
 * 実測: marginalia は速い日で 0.8 秒、返らない日は無反応のまま。
 * 揃うのを待つ側にとっては、遅い1本は落ちたのと同じ。
 */
const SOURCE_TIMEOUT_MS = 8_000

/**
 * 回数制限に当たった先を、解けるまで叩かない。**先の名前 → いつまで休むか(ms)**。
 *
 * 実測: 端から端まで1回動かしただけで Qiita の 1問 15 回を使い、無認証の枠
 * (60回/時)を使い切った。以後その時間帯は全部 403 で返る。**待てば戻る先を、
 * 待たずに叩き続けても枠が減るだけ**なので、相手が言ってきた解除時刻まで黙って外す。
 * 過程に持つので、走らせ直せば消える。それでよい — 枠は時間で戻る。
 */
const restingUntil = new Map<string, number>()

/** 一時的な上限か、断られたのか。**同じ 403 でも意味が違う** ので言い分けにする。 */
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
 * 検索する。**先が1つ落ちても他は返す** — 落ちた先は理由付きで並べる。
 *
 * 相手ごとに `Promise.all` で同時に出す。別ホストなので `pace` の1秒は互いに掛からない
 * (実測: 7先を同時に出して 0.9秒。順に出すと合計 4.5秒だった)。
 */
export async function searchWeb(query: string, opts: SearchOptions = {}): Promise<readonly SourceResult[]> {
  const q = query.trim()
  if (!q) return []
  const perSource = Math.min(Math.max(opts.perSource ?? 8, 1), 20)
  const names = opts.where?.length ? opts.where : defaultSources()
  // `web` に `site:x.com` と書かれたら、`x` の先で受ける。
  //
  // **これは道具の説明で直せなかった。** 端から端まで2回動かした実測:
  // `where: ["x"]` と書くよう説明文に足した後でも、モデルは 12 回とも
  // `web` に `site:x.com/youyuxi ...` と書いてきた。説明を強めるより、**その書き方を受ける**。
  // 同じ SearXNG を叩くので外向きの回数は変わらず、変わるのは読み取りだけ —
  // `site:` を守らない索引の結果(実測 42%)と、殻を拾った要約(同 17%)が落ちる。
  // 頼んだのが `site:x.com` なら vite.dev が返るのは**どのみち間違い**なので、絞る側に倒す。
  const xTerm = toXTerm(q)
  // `hn` に「Show HN」と書かれたら、`showhn` の先で受ける。同じ理由 — 端から端まで動かすと
  // モデルは `where: ["showhn"]` ではなく `hn` に `query=Show HN AI agent` と書いてきた(実測、
  // 673秒のランで `tags=show_hn` は 0 回)。**ただし X と同型ではなかった**:
  // X で受け直した根拠は混ざり物(42% と 17%)だったが、こちらの混ざり方は同じ 73/73 で差が無い。
  // 受け直す根拠は `toShowHnTerm` に書いた順位のほう。
  const showTerm = toShowHnTerm(q)
  const picked = names.flatMap((n) => {
    const s = SOURCES.find((x) => x.name === n.toLowerCase())
    if (!s) return []
    if (s.name === "web" && xTerm !== undefined && X_SOURCE) return [X_SOURCE]
    if (s.name === "hn" && showTerm !== undefined && SHOWHN_SOURCE) return [SHOWHN_SOURCE]
    return [s]
  })
  // 仕事を探す語が入っていたら、`web` と**並べて** `job` も出す。
  //
  // **ここだけ置き換えではなく追加。** X と Show HN は「同じ問いを、より当たる口へ回す」だったが、
  // こちらは問いが2つに割れる — 端から端まで動かした実測(847秒、外向き281回)で、モデルは
  // 「副業を探したい」を**媒体選びの調査**として解き、SOKUDAN・Workship・ITプロパートナーズの
  // 手数料と単価相場を比べて答えた。その答えは要る。**ただし募集そのものは1件も出てこなかった。**
  // `web` に「React 副業 案件」と書いても募集頁は返らない(実測 4問63件中0件、全部 SEO 記事)ので、
  // 片方を捨てるのではなく両方出す。増えるのは SearXNG への3回。
  //
  // **語はそのまま渡さない**(`toJobTerm`)。モデルが書くのは媒体調査の語なので、
  // 媒体名と調査語を落としてから渡す。技術も職種も残らなければ出さない。
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
       * 口が複数あるときは同時に叩いて混ぜる。**1つでも読めれば返す** —
       * 3媒体のうち1つが落ちたときに、残り2つを道連れにしない。全部落ちたときだけ理由を投げる。
       */
      const call = async (u: string | readonly string[]) => {
        if (typeof u === "string") return one(u)
        const rs = await Promise.allSettled(u.map(one))
        const ok = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
        if (ok.length === 0)
          throw new Error(rs.map((r) => String((r as PromiseRejectedResult).reason)).join(" / "))
        // **口ごとに1件ずつ取る。** 先頭から詰めると、最初の口だけで枠が埋まる。
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
 * 読ませる形にする。**先ごとに分けたまま出す** — 混ぜて並べ直すと、
 * どの索引が拾ったのかが消えて「web にそう書いてある」に見えてしまう。
 *
 * 同じ URL が複数の先に出たときは最初の1つだけ残し、残りは先の名前を添えるだけにする
 * (別々の索引が同じ頁を拾ったことは、それ自体が目印になる)。
 * 日付は **持ち主の時計**(`localStamp`)。UTC のまま出すと夜中の記事が前日として読まれる。
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
