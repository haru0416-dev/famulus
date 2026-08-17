/**
 * 公開 web を読み、このホストの内側へ向く URL を拒否する経路。
 *
 * 調査の読み取りは宛先を列挙できないので、形で拒否する。IPv4 の loopback・私設・link-local・
 * CGNAT と、IPv6 の ::/::1・fc00::/7・fe80 で始まるアドレスを拒否する。
 * ufw は受信だけを見ていて送信は検査しないので、ここで止めないとモデルの書いた URL 一本で
 * `http://127.0.0.1:8080` も `http://100.72.193.4` も読める。
 *
 * 名前解決後にも判定するが、接続時には再解決されるため DNS rebinding は防げない。
 * IPv6 link-local 全体と、16進表記の IPv4 射影アドレスも現在の判定では網羅していない。
 */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { appConfig } from "../core/config.ts"
import { decodeBody, isReadableType, toText } from "./WebContent.ts"

export { decodeBody, isReadableType, renderFeed, toText } from "./WebContent.ts"

/**
 * 1回の取得で読む上限。JS で組み立てるページは頭が JS の塊で、人が読む文字はその後ろにある
 * (`<title>` が 68万バイト目にあるページがある)。低く切ると本文が1字も入らない。
 * 代償は転送時間だが、20秒の制限に対して払える。
 */
const MAX_BYTES = 1_500_000
/** モデルに渡す上限。ここを超える資料は、そもそも1回で読む単位ではない。 */
const MAX_CHARS = 12_000
const TIMEOUT_MS = 20_000
const MAX_HOPS = 3
/** 名乗り。素性と用途が分かる形で出す — 相手が拒否したくなったときに拒否できる名前にしておく。 */
const UA = "famulus/0.1 (personal research agent)"

/** 内側を指すアドレスか。数値で見る — 文字列の前方一致では 10.0.0.1 と 100.1.1.1 を取り違える。 */
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
    // ドット区切りで書かれた IPv4 射影アドレスは v4 として見る。
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
function originOf(raw: string): string | undefined {
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
 * ホスト名の一致。`endsWith` だけで書くと `evilqiita.com` が `qiita.com` に当たる。
 */
const isHost = (u: URL, domain: string): boolean => u.hostname === domain || u.hostname.endsWith(`.${domain}`)

/**
 * 取りに行かずに断る先。robots が明文で断っていて、なおかつ取っても本文が無い先だけ。
 * 「取れないから」だけなら普通の `detour`(取ってから言う)で足りる。
 * ここに入れるのは、確かめに行くこと自体をしないと決めた先。
 */
function refusedBeforeFetch(u: URL): boolean {
  return isHost(u, "x.com") || isHost(u, "twitter.com")
}

/**
 * 取れなかったときの回り道。詰まると分かっている先だけを書く(一般化した規則ではない)。
 * 当たらなければ `undefined` — 呼ぶ側は普通に取りに行く。
 *
 * 書いた時点で正しくても古くなる。「本文が JS で差し込まれる」に見えるものが、
 * こちらの読み取りの不具合であることがある。足すときは行き先だけでなく元のページも測り直す。
 */
export function detour(url: string): string | undefined {
  const u = new URL(url)
  const seg = u.pathname.split("/").filter(Boolean)

  if (isHost(u, "github.com")) return githubDetour(u, seg)

  if (isHost(u, "zenn.dev")) {
    // 記事のページ(zenn.dev/x/articles/y)は素で読めるので触らない。詰まるのは一覧のほう。
    if (seg[0] === "topics" && seg[1] && seg.length === 2)
      return `一覧は JS で組み立てるので HTML には無い。https://zenn.dev/topics/${seg[1]}/feed を開く`
    if (seg[0] && seg.length === 1)
      return `記事一覧は JS で組み立てる。https://zenn.dev/${seg[0]}/feed を開く`
    return undefined
  }
  if (isHost(u, "qiita.com")) {
    // 記事のページは素で読める。タグ一覧と書き手のページは記事名が1つも入らないので /feed へ回す。
    if (seg[0] === "tags" && seg[1] && seg.length === 2)
      return `一覧は JS で組み立てるので HTML には無い。https://qiita.com/tags/${seg[1]}/feed を開く`
    if (seg[0] && seg.length === 1)
      return `記事一覧は JS で組み立てる。https://qiita.com/${seg[0]}/feed を開く`
    return undefined
  }

  if (isHost(u, "npmjs.com")) {
    // www.npmjs.com は Cloudflare の待機ページで 403。レジストリは素で返る。
    const pkg = /^\/package\/(.+)$/.exec(u.pathname)?.[1]
    return `npmjs.com は 403 で拒否される。https://registry.npmjs.org/${pkg ?? "<パッケージ名>"}/latest を開く`
  }
  if (isHost(u, "x.com") || isHost(u, "twitter.com")) {
    // 取りに行く前に断る(`refusedBeforeFetch`)。理由は2つ。直に引いても本文を含まないクライアント描画用 HTML しか返らず、
    // かつ `x.com/robots.txt` が `Disallow: /` で本文の取れる API も全部断られている。
    // 投稿の中身は `search` の `x` から読む(索引の要約で、X には接続していない)。
    const who = /^\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(u.pathname)?.[1]
    // 「取れない」で終わらせると読み手はそこで諦めて、search に出ている投稿本文を
    // 使わずに終える。行き先まで言う。
    return (
      "robots で断られていて、開いても本文を含まないクライアント描画用 HTML しか返らない。**ただし投稿の本文は search で読める** — " +
      `\`where: ["x"]\` で引くと、要約に投稿の文字そのものが入る` +
      (who ? `。この人に絞るなら語に \`from:${who}\`` : "")
    )
  }
  if (isHost(u, "stackoverflow.com") && seg[0] === "questions" && seg[1] === "tagged") {
    // 質問一覧だけが 403。質問1件のページは通るので振り替えない。
    return `質問一覧の HTML は 403 で拒否される。https://stackoverflow.com/feeds/tag/${seg[2]} を開く`
  }
  if (isHost(u, "reddit.com") && seg[0] === "r" && seg[1]) {
    // old.reddit.com も `.json` も 403。通るのは `.rss` だけ。
    return `HTML も .json も 403 で拒否される。https://www.reddit.com/r/${seg[1]}/.rss を開く`
  }
  if (isHost(u, "youtube.com") && u.pathname === "/watch" && u.searchParams.get("v")) {
    // 視聴ページは題や説明までの転送量が大きい。題と投稿者だけなら oEmbed の応答で足りる。
    const id = u.searchParams.get("v") ?? ""
    return `題と説明は 68万バイト目にあり、読むのに 1.3MB 要る。https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}&format=json を開く(題と投稿者が 200 バイトで返る)`
  }
  if (isHost(u, "laws.e-gov.go.jp") && seg[0] === "law" && seg[1]) {
    // ページの HTML には題しか入っていない。条文は API の XML からしか取れない。
    return `条文は JS で差し込むので HTML には無い。https://laws.e-gov.go.jp/api/1/lawdata/${seg[1]} を開く(XML で条文が返る)`
  }
  if (isHost(u, "bsky.app") && seg[0] === "profile" && seg[1]) {
    // HTML にはハンドル名しか入っていない。公開 API は認証不要で投稿が返る。
    return `投稿は HTML に入っていない。https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${seg[1]}&limit=20 を開く`
  }
  if (isHost(u, "note.com") && seg[0] && seg.length === 1) {
    // トップも書き手のページも本文が組み上がらない。rss があるのは書き手のページだけ。
    return `記事は JS で組み立てる。書き手のページなら https://note.com/${seg[0]}/rss を開く`
  }
  if (isHost(u, "mastodon.social") && seg[0]?.startsWith("@") && seg.length === 1) {
    // HTML からは投稿が取れない。`.rss` を足すと投稿本文が返る。
    return `投稿は JS で組み立てる。https://${u.hostname}/${seg[0]}.rss を開く`
  }
  if (isHost(u, "arxiv.org") && seg[0] === "pdf" && seg[1]) {
    // /pdf は application/pdf なので1字も読めない。同じ論文が /abs と /html にある。
    const id = seg[1].replace(/\.pdf$/i, "")
    return `要旨なら https://arxiv.org/abs/${id}、本文なら https://arxiv.org/html/${id} を開く`
  }
  return undefined
}

/** GitHub は行き先が4種あるので分ける。呼ぶ前にホストの判定は済んでいる。 */
function githubDetour(u: URL, seg: readonly string[]): string | undefined {
  const [owner, repo, kind, ref] = seg
  if (seg[0] === "search") {
    // 検索結果は HTML に1件も入っていない。リポジトリ検索の API は鍵無しで通るが、
    // コード検索の API は 401(認証が要る)。
    const q = u.searchParams.get("q") ?? ""
    return u.searchParams.get("type") === "code"
      ? "コード検索の結果は JS で差し込み、API は鍵が要る(401)。このページからは取れないので別の探し方にする"
      : `結果は JS で差し込む。https://api.github.com/search/repositories?q=${encodeURIComponent(q)} を開く`
  }
  if (!owner || !repo) return undefined
  if (seg.length === 2) {
    // README は HTML に入っている。入っていないのはファイル一覧のほうで、
    // ページには枠だけが残ってファイル名が1つも出ない。
    return `README は入っている(このページで読めている)。無いのはファイル一覧 — 要るなら https://api.github.com/repos/${owner}/${repo}/contents を開く`
  }
  if ((kind === "issues" || kind === "pull") && ref) {
    // 題も本文も HTML に入っている。ただし星やフォークの数が本文より先に並ぶので、
    // 本文だけ要るなら API のほうが短い。
    const api = kind === "pull" ? "pulls" : "issues"
    return `題と本文は入っている。飾りを外して本文だけ読むなら https://api.github.com/repos/${owner}/${repo}/${api}/${ref} を開く`
  }
  if (kind === "tree" && ref) {
    // ファイル一覧は HTML に1つも入らず、読み込みエラーの文言だけが返る。
    const path = seg.slice(4).join("/")
    return `ファイル一覧は JS で差し込むので HTML には無い。https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref} を開く`
  }
  return undefined
}

/**
 * 同じホストを続けて叩かない。プロセス内にしか残らないので、再起動でリセットされる
 * (それで困る規模では回さない)。
 *
 * Configで縮められるのは検査のため。相手を差し替えた検査(fetch を stub したもの)は
 * 誰にも迷惑を掛けないのに、同じホストへ4回出す1件で 4 秒待つ。外へ出る既定は動かさない。
 */
const hostIntervalMs = (): number => appConfig().web.hostIntervalMs
const lastHit = new Map<string, number>()
async function pace(host: string): Promise<void> {
  const prev = lastHit.get(host)
  const now = Date.now()
  const wait = prev === undefined ? 0 : prev + hostIntervalMs() - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastHit.set(host, Date.now())
}

/**
 * 一度開いたページについて、取得上限まで組み立てた本文を覚えておく。
 * `MAX_CHARS` に収まらない資料は続きを読むたびに頭から取り直すことになる。
 * 保持した本文から切り出せば、続きを読むたびに頭から取り直さずに済む。
 *
 * 同じ `offset` をもう一度求められたときだけ「さっき開いた」と書いて返す。続き読みには付けない —
 * 付ける相手は同じところを回っている呼び出しで、順に読み進めている呼び出しではない。
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

/** 上限に達したらそこで受信を止める。arrayBuffer() だと数十MBの PDF を丸ごとメモリに載せる。 */
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
  // 最後の塊は上限をまたぐので、`size` は上限を少し超える。繋いでから切り直すと 1.5MB を二度取る
  // ので、配列を上限ちょうどで作り、またいだ分は写す前に落とす。
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
 * 200 で返ってきたのに中身が薄いページへの断り書き。読めているページには付けない(`undefined` を返す)。
 *
 * 黙って空を返すと、読み手は「そう書いてある」と受け取る。正体はたいてい 404 ではなく
 * JS で組み立てるページ。
 *
 * 判定を三段に分けてある:
 *
 * - HTML の大きさだけで測ると、小さいページで何も取れない回を見逃す(JS の転送ページは HTML ごと小さい)。
 *   返した字数そのものでも引っかける。
 * - 疑う相手は script のある HTML だけ。JSON の API は 200 バイトで正しく答えるし、
 *   素の HTML が短いのは単に短いページで、疑う理由が無い。
 * - 無いのと少ないのを言い分ける。一段で判定すると、本文が取れているページにまで
 *   「別の出典を当たれ」が付く。読めたページに諦めろと言う害は、読めないページを黙って返すのと変わらない。
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
    // 回り道があるときは、回り道に言わせる。後半を固定文にすると
    // 「残りは JS で後から入る部分 — README は入っている」のように、自分で自分を打ち消した。
    return (
      `読めたのは ${chars}字(HTML ${kb}KB)。**これで足りているならそれでいい。** ` +
      (d ??
        "載っているはずのものが見当たらないなら、残りは JS で後から入る部分 — 別の出典を当たったほうが早い")
    )
  }
  // 切ったのか、そもそも入っていないのかも言い分ける。上限で切ったページで取れないのは
  // 「JS で組み立てる」ではなく「読んだ範囲に本文が無かった」。診断を間違えると、
  // 読み手は取れるはずのものを諦める。
  const why =
    d ??
    (p.cut
      ? `頭 ${Math.round(MAX_BYTES / 1000)}KB を読んだ範囲に本文が無かった — 先に JS が並ぶページだと思う`
      : "JS で組み立てるページだと思う — 別の出典を当たったほうが早い")
  return `本文がほとんど無い(HTML ${kb}KB に対し ${chars}字)。${why}`
}

/**
 * 全文から語を探して、当たりの前後だけを返す。
 *
 * 読み取り範囲を順に進めるだけでは大きなページの目的箇所に届かない。40万字の JSON を `MAX_CHARS` 刻みで読むと
 * 十数ターン掛かり、1ターンごとにモデル呼び出しが要る。語で当てて前後だけ返す道を別に置く。
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

/** 覚えた全文から、求められた範囲を切り出す。ここでは外に出ない。 */
function slice(doc: CachedDoc, offset: number, agoSec: number | undefined): FetchedPage {
  const text = doc.full.slice(offset, offset + MAX_CHARS)
  const more = doc.full.length > offset + MAX_CHARS
  const notes: string[] = []
  if (doc.note) notes.push(doc.note)
  if (offset > 0 && text.length === 0)
    notes.push(`このページは全 ${doc.full.length}字で、${offset}字目より先は無い。続きを探すなら別の出典へ。`)
  // 大きいページを固定長の範囲で少しずつ読ませない。回数を数字で見せておくと、offset を刻む前に find へ行ける。
  if (more && doc.full.length > MAX_CHARS * 3)
    notes.push(
      `このページは全 ${doc.full.length}字。${MAX_CHARS}字ずつ頭から読むと ${Math.ceil(doc.full.length / MAX_CHARS)} 回かかる。` +
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

/** 覚えた全文の中を探す。外には出ない(ページは既に手元にある)。 */
function search(doc: CachedDoc, needle: string): FetchedPage {
  const hit = findIn(doc.full, needle)
  const notes = [doc.note].filter((s): s is string => Boolean(s))
  if (hit.count === 0)
    notes.push(
      `「${needle}」はこのページ(全 ${doc.full.length}字)に無い。綴りを変えるか、別のページへ。**読み取り範囲を変えて探し直さない。**`,
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
  /** 期限切れの振る舞いを時計を進めずに検査するための差し込み先。 */
  readonly nowMs?: number
}

/**
 * 1ページ読む。同じ URL は取り直さない(memo の項を参照)。
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
 * 実際に取りに行く。転送は自分で追い、各転送先を内側判定に通す。
 * 取得上限まで組み立てた本文を返し、12,000字の範囲へ切るのは呼び出し側(`slice`)。
 */
async function fetchFresh(raw: string): Promise<CachedDoc> {
  // 断られていると分かっている先へは、確かめに行かない。`detour` は普通は取ってから
  // (4xx・読めない形式・本文が薄い)出すが、ここだけは出る前に出す。
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
 * 本文を組み立てずに、返ってきたバイト列をそのまま返す。検索(Search.ts)が使う。
 *
 * `fetchPage` と分けたのは、あちらが「人に読ませる1ページ」を作る道具だから — `toText` が
 * タグを剥がし、`slice` が 12,000字で切る。JSON を欄ごとに読む側にはどちらも邪魔になる。
 * 間隔(`pace`)・上限(`readCapped`)・転送の検査は同じものを通す。内側への転送を
 * 転送先を検査せずに開かないため、`redirect: "follow"` にはしない(宛先が定数でも、転送先は相手が決める)。
 *
 * `timeoutMs` の既定は 1ページぶんの 20 秒。同時に何本も出す側は短くする —
 * 揃うのを待つ形では、返らない1本が全体を制限いっぱいまで引き延ばす。
 *
 * 断られたときの本文も返す(`fetchPage` は捨てる)。API は理由を本文に書く —
 * Qiita の 403 は `{"message":"Rate limit exceeded"}` で、これが読めないと
 * 「一時的に上限」と「拒否された」の区別が付かない。
 */
export interface RawOptions {
  readonly accept: string
  readonly timeoutMs?: number
  /** 鍵などの追加見出し。呼ぶ側が組み立てる — ここには先ごとの事情を持ち込まない。 */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * この origin ちょうど1つだけ、内側判定と間隔の制限を免除する。
   * 自分で立てたサーバを呼ぶためだけの例外(現状は SearXNG の `http://127.0.0.1:8888`)。
   *
   * 冒頭の防御はそのまま残す。モデルが書いた URL は `fetchPage` を通り、こちらには来ない
   * — 免除できるのは `Search.ts` の中に先として書いてある origin だけで、
   * 問い合わせ文から組み立てられる余地は無い。前方一致ではなく origin の完全一致で見る
   * (`http://127.0.0.1:8888` の免除が `http://127.0.0.1:8888.example.com` に伸びない)。
   * 転送された先には掛からない — 次の周では `url` の origin が変わるので、また拒否される。
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
    // 自分で立てたサーバかどうか。ここだけ内側判定と間隔待ちを飛ばす(RawOptions.allowOrigin を参照)。
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
