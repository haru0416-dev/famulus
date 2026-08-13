/**
 * DB の入口。ユーザーが過去に喋った記録を開いて、残す価値のある分だけを DB に落とす。
 *
 * 引く先は2つ — Claude Code の作業ログ(`~/.claude/projects` の JSONL)と、
 * Claude.ai の書き出し(`.data/claude-export`)。
 *
 * どちらの入口でも、人の言葉は全体のごく一部しか占めない。残りは道具の入出力と応答の地の文。
 * 削るのは比率ではなく、何が人の判断で何が作業の残骸かの境界。
 *
 * 2段階に分けてある。
 *   1. 選別(モデルを使わない) … 道具の入出力を捨て、人の発話をそのまま残し、応答を畳む。
 *      枠を1回も使わずにここまで落とせるので、要約に渡る前に効果を確かめられる。
 *   2. 要約(scout モデル) …1会話 → 1イベント。ユーザーの判断だけを、引用付きで抜く。
 *
 * `memories.json` だけは2段目を通さない。既に要約済みのものを要約し直すと、二度均されて
 * 本人の言い回しが完全に消える。トピック別に切って、そのまま置く。
 *
 * Claude.ai の書き出しは大半の会話が uuid と日時だけの殻で、text も content も空になっている
 * (書き出し側の都合で、こちらでは復元できない)。本文の無い会話は落とす。
 *
 * 取り込み済みかどうかは `events` 自身が覚える(`kind='import'` の provenance に元の id)。
 * 別表を作らないので、DB を消さない限り二重取り込みは起きない。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import * as Effect from "effect/Effect"
import { nowIso } from "../core/time.ts"
import { Runner } from "../model/Runner.ts"
import { Db } from "./Db.ts"
import { buildFencedPrompt } from "./Governance.ts"
import { Memory } from "./Memory.ts"

/** ログの置き場。呼び出し時に読む(モジュール読み込み時に固めない) — 検査が別の場所を指せるように。 */
const root = (): string => process.env.OPEN_ZERO_TRANSCRIPT_ROOT ?? join(homedir(), ".claude", "projects")

/** Claude.ai の書き出しを展開した場所。zip のまま置かないのは、標準ライブラリだけで開けないから。 */
const exportRoot = (): string => process.env.OPEN_ZERO_EXPORT_ROOT ?? ".data/claude-export"

/**
 * 除外するディレクトリ。
 * `cache-agent-exp` はサブエージェントの実験用キャッシュ、`-tmp-` は使い捨ての作業場。
 * どちらもユーザーの判断ではなく、機械が機械に出した指示しか入っていない。
 */
const EXCLUDE = [/cache-agent-exp/, /(^|\/)-tmp-/]

/** 人が実際にキーボードで打った発話だけを選ぶ目印。補完や system 注入と区別が付く唯一の場所。 */
const TYPED = "typed"
const TYPED_MARK = `"promptSource":"${TYPED}"`

/**
 * 生ログを1本読む。人が打った跡が無ければ `undefined`。
 *
 * 含有判定は Buffer のままやる。utf8 の文字列に起こす手間は読み取り自体より重く、
 * 実測(0.63G / 295 本)で 161ms → 1,544ms になる。生ログの大半は道具の入出力で、
 * その中身をこちらは一度も読まない(docs/adr/0026)。
 */
function readTypedRaw(path: string): string | undefined {
  const buf = readFileSync(path)
  return buf.includes(TYPED_MARK) ? buf.toString("utf8") : undefined
}

/** 応答1件から残す長さの上限と下限。結論は最後に出るので、最後の1件だけ別枠で厚く取る。 */
const REPLY_HEAD = 400
const REPLY_MIN = 100
const LAST_REPLY = 1500
/** 素材全体の目安。1回の scout 呼び出しに収める量。 */
const MATERIAL_MAX = 40_000

/** 取り込み元。同じ DB に入るが、素材の性質が違うので渡す指示を変える。 */
export type SourceKind = "claude-code" | "claude-web"

export interface SessionRef {
  readonly kind: SourceKind
  /** Claude Code は sessionId、Claude.ai は会話の uuid。どちらも二重取り込みの鍵になる。 */
  readonly sessionId: string
  readonly path: string
  /** 何の話だったかの手掛かり。作業ログは作業ディレクトリ、Web は会話の題。 */
  readonly label: string
  /** 最初に人が打った時刻。会話の「いつ」はこれ。 */
  readonly at: string
  readonly turns: number
}

export interface Material {
  readonly ref: SessionRef
  readonly text: string
  /** 選別の効き目。生バイト → 残したバイト。 */
  readonly rawBytes: number
  readonly keptBytes: number
}

interface Turn {
  readonly who: "owner" | "agent"
  readonly text: string
}

/** 日時を ISO UTC に揃える。解釈不能・欠落時は取り込み時刻に落とす。 */
const iso = (s: unknown): string => {
  const d = new Date(String(s ?? ""))
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * 読んだ JSON を持っておく。`conversations.json` は全会話が1ファイルに入っていて、
 * 走査と取り込みで何度も開く。mtime が変わったら捨てるので、差分の zip を足しても読み直せる。
 */
const cache = new Map<string, { mtime: number; value: unknown }>()
function cached<T>(key: string, path: string, build: () => T): T {
  const mtime = statSync(path).mtimeMs
  const hit = cache.get(key)
  if (hit && hit.mtime === mtime) return hit.value as T
  const value = build()
  cache.set(key, { mtime, value })
  return value
}

const readJson = (path: string): unknown =>
  cached(`json:${path}`, path, () => JSON.parse(readFileSync(path, "utf8")) as unknown)

/**
 * content から地の文だけを取り出す。`tool_use` `tool_result` `thinking` は読まない。
 * assistant の地の文は文脈には使うが、ユーザーが決めたことの根拠にはしない。
 */
function plainText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b): b is { type: string; text: string } => {
      const t = (b as { type?: unknown })?.type
      return t === "text" && typeof (b as { text?: unknown }).text === "string"
    })
    .map((b) => b.text)
    .join("\n")
}

/** JSONL を1本読んで、人の発話とエージェントの地の文だけに落とす。道具の入出力はここで消える。 */
function readSession(path: string): { ref: SessionRef; turns: Turn[]; rawBytes: number } | undefined {
  // 全文パースは高いので、人が打った跡が無いファイルはここで捨てる。
  const raw = readTypedRaw(path)
  if (raw === undefined) return undefined

  const turns: Turn[] = []
  let sessionId = ""
  let cwd = ""
  let at = ""

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    // サブエージェントの往復はユーザーの判断ではない。丸ごと落とす。
    if (j.isSidechain === true) continue
    const msg = j.message as { content?: unknown } | undefined
    const text = plainText(msg?.content)

    if (j.type === "user" && j.promptSource === TYPED) {
      if (text.trim().length === 0) continue
      sessionId ||= String(j.sessionId ?? "")
      cwd ||= String(j.cwd ?? "")
      at ||= String(j.timestamp ?? nowIso())
      turns.push({ who: "owner", text })
    } else if (j.type === "assistant" && text.trim().length > 0) {
      turns.push({ who: "agent", text })
    }
  }

  if (sessionId === "" || turns.every((t) => t.who === "agent")) return undefined
  const owner = turns.filter((t) => t.who === "owner").length
  return {
    ref: { kind: "claude-code", sessionId, path, label: cwd, at: at.replace(/\.\d{3}Z$/, "Z"), turns: owner },
    turns,
    rawBytes: Buffer.byteLength(raw),
  }
}

/**
 * 走査用に `ref` だけを作る。全行を JSON にしない。
 *
 * `scan` が要るのは「どの回がまだ入っていないか」だけで、応答の地の文は一度も見ない。
 * owner の発話になり得るのは `TYPED_MARK` を含む行だけなので、そこだけ解く —
 * 実測で 223,864 行 → 1,891 行(docs/adr/0026)。数え方は `readSession` と同じ条件なので、
 * 返る `turns` は全行を解いたときと一致する。
 */
function readSessionRef(path: string): SessionRef | undefined {
  const raw = readTypedRaw(path)
  if (raw === undefined) return undefined

  let sessionId = ""
  let cwd = ""
  let at = ""
  let owner = 0
  for (const line of raw.split("\n")) {
    if (!line.includes(TYPED_MARK)) continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.isSidechain === true || j.type !== "user" || j.promptSource !== TYPED) continue
    if (plainText((j.message as { content?: unknown } | undefined)?.content).trim().length === 0) continue
    sessionId ||= String(j.sessionId ?? "")
    cwd ||= String(j.cwd ?? "")
    at ||= String(j.timestamp ?? nowIso())
    owner += 1
  }

  if (sessionId === "" || owner === 0) return undefined
  return {
    kind: "claude-code",
    sessionId,
    path,
    label: cwd,
    at: at.replace(/\.\d{3}Z$/, "Z"),
    turns: owner,
  }
}

interface Read {
  readonly ref: SessionRef
  readonly turns: Turn[]
  readonly rawBytes: number
}

/**
 * `conversations.json` を読む。1ファイルに全会話が入っているので、走査も取り込みもここを通る。
 *
 * 本文の落ちた殻(text も content も空)は捨てる。DB に空の会話を並べても、
 * 「その日に何か喋った」以上のことは言えず、検索の邪魔にしかならない。
 */
function readWebChats(): Read[] {
  const path = join(exportRoot(), "conversations.json")
  if (!existsSync(path)) return []
  return cached(`chats:${path}`, path, () => buildWebChats(path))
}

function buildWebChats(path: string): Read[] {
  const list = readJson(path)
  if (!Array.isArray(list)) return []

  const out: Read[] = []
  for (const c of list as Record<string, unknown>[]) {
    const uuid = String(c.uuid ?? "")
    if (uuid === "") continue
    const msgs = Array.isArray(c.chat_messages) ? (c.chat_messages as Record<string, unknown>[]) : []
    const turns: Turn[] = []
    let owner = 0
    let bytes = 0
    for (const m of msgs) {
      // `text` に入っている回と content ブロック側に入っている回が混ざる。両方見る。
      const direct = typeof m.text === "string" ? m.text : ""
      const text = [direct, plainText(m.content)].filter((s) => s.trim().length > 0).join("\n")
      bytes += Buffer.byteLength(JSON.stringify(m))
      if (text.trim().length === 0) continue
      if (m.sender === "human") {
        owner += 1
        turns.push({ who: "owner", text })
      } else {
        turns.push({ who: "agent", text })
      }
    }
    if (owner === 0) continue
    out.push({
      ref: {
        kind: "claude-web",
        sessionId: uuid,
        path,
        label: String(c.name ?? "").trim() || "(無題)",
        at: iso(c.created_at),
        turns: owner,
      },
      turns,
      rawBytes: bytes,
    })
  }
  return out
}

/**
 * `design_chats/` を読む。1会話1ファイルで、本文は `content.content` に一段深く入っている。
 *
 * `attachments` は読まない。中身は「このプロジェクトは Design Components を使う…」という
 * 仕組み側が毎回差し込む定型文で、ユーザーが打った文字ではない。量だけは多い。
 */
function readWebDesign(): Read[] {
  const dir = join(exportRoot(), "design_chats")
  if (!existsSync(dir)) return []
  const out: Read[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue
    const r = readDesignFile(join(dir, f))
    if (r) out.push(r)
  }
  return out
}

function readDesignFile(path: string): Read | undefined {
  if (!existsSync(path)) return undefined
  return cached(`design:${path}`, path, () => buildDesignFile(path))
}

function buildDesignFile(path: string): Read | undefined {
  let j: Record<string, unknown>
  try {
    j = readJson(path) as Record<string, unknown>
  } catch {
    return undefined
  }
  const msgs = Array.isArray(j.messages) ? (j.messages as Record<string, unknown>[]) : []
  const turns: Turn[] = []
  let owner = 0
  for (const m of msgs) {
    const inner = (m.content ?? {}) as Record<string, unknown>
    const text = typeof inner.content === "string" ? inner.content : plainText(inner.content)
    if (text.trim().length === 0) continue
    if (m.role === "user") {
      owner += 1
      turns.push({ who: "owner", text })
    } else {
      turns.push({ who: "agent", text })
    }
  }
  if (owner === 0) return undefined

  const project = ((j.project ?? {}) as Record<string, unknown>).name
  const title = String(j.title ?? "").trim() || "(無題)"
  return {
    ref: {
      kind: "claude-web",
      sessionId: String(j.uuid ?? path.replace(/^.*\/|\.json$/g, "")),
      path,
      label: project ? `${project} / ${title}` : title,
      at: iso(j.created_at),
      turns: owner,
    },
    turns,
    rawBytes: statSync(path).size,
  }
}

/**
 * 1件だけ読み直す。ここを全体走査にしてはいけない。
 * `material` は取り込みのたびに呼ばれるので、毎回すべての生ログを読み直すと入口が使い物にならなくなる。
 */
function readOne(ref: SessionRef): Read | undefined {
  if (ref.kind === "claude-code") return readSession(ref.path)
  if (ref.path.endsWith("conversations.json")) {
    return readWebChats().find((r) => r.ref.sessionId === ref.sessionId)
  }
  return readDesignFile(ref.path)
}

/**
 * 素材にする。ユーザーの発話は1文字も削らない — 短いので削る意味がなく、削れば原文が消える。
 *
 * 上限に当たったとき、素材全体の真ん中を落とすやり方は取らない。
 * 一番長い会話は一番よく喋った会話、つまりユーザーの言葉が一番多い回で、
 * そこを真ん中から切ると、削る価値の高い順とちょうど逆のものが消える。
 * 削るのは常に応答側の地の文だけにして、割り当てを詰める形で収める。
 */
function compress(turns: readonly Turn[]): string {
  // 1往復 = ユーザーの発話1件 + それに続く応答すべて。残すのはその最後の1件だけ。
  //
  // JSONL の "assistant" は道具を呼ぶたびに1件増えるので、1回の依頼に応答が数十件並ぶ。
  // 途中のものは経過報告で、何を決めたかは次にユーザーが口を開く直前に書かれている。
  // 途中を薄く広く残すより、答えの1件を厚く残すほうが同じ量で情報が多い。
  const folded: Turn[] = []
  for (const t of turns) {
    if (t.who === "owner") {
      folded.push(t)
    } else if (folded.length > 0 && folded[folded.length - 1]?.who === "agent") {
      folded[folded.length - 1] = t // 直前の途中経過を答えで置き換える
    } else {
      folded.push(t)
    }
  }

  const ownerChars = folded.reduce((n, t) => (t.who === "owner" ? n + t.text.length + 8 : n), 0)
  const replies = folded.filter((t) => t.who === "agent").length

  // 残りを応答で山分けする。最後の1件は結論なので先に別枠で取っておく。
  const left = MATERIAL_MAX - ownerChars - LAST_REPLY
  const cap =
    replies <= 1 ? REPLY_HEAD : Math.max(REPLY_MIN, Math.min(REPLY_HEAD, Math.floor(left / (replies - 1))))

  return folded
    .map((t, i) => {
      if (t.who === "owner") return `owner: ${t.text}`
      const c = i === folded.length - 1 ? LAST_REPLY : cap
      return `agent: ${t.text.length > c ? `${t.text.slice(0, c)}…` : t.text}`
    })
    .join("\n")
}

/** 引用(`said`)を必須にした項目。これが DB に入る最小単位。 */
const QUOTED = (what: string, said: string) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["what", "said"],
    properties: {
      what: { type: "string", description: what },
      said: { type: "string", description: said },
    },
  }) as const

const SAID = "根拠になった owner: 行からの**そのままの引用**(20〜60文字)。引けないなら項目ごと落とす"

/**
 * 抽出させる形。散文で返させると DB に入れる段で結局こちらが読み解くことになる。
 *
 * どの項目にも `said`(ユーザーの発話からの引用)を必須にしてある。
 * 引用を求めないと、素材の量で勝る応答側の地の文に引きずられて
 * 「REST API が完全動作することを確認」のような作業報告が「決定」として返る。
 * それは誰の判断でもない。引用を要求すれば、ユーザーの言葉に根拠が無い項目は書けなくなる。
 *
 * `preferences` と `corrections` にも同じ引用を要求する。「ユーザーはこういうやり方を好む」は
 * 本人像そのもので、自由記述だとモデルが読み取った印象と本人が言ったことの区別が付かない。
 * DB に入った後ではどちらだったかを復元できない — 代わりを務めるなら、そこは常に本人の言葉に戻せること。
 */
const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "decisions", "preferences", "corrections"],
  properties: {
    topic: { type: "string", description: "ユーザーがこの回で何をしようとしていたか。一行。" },
    decisions: {
      type: "array",
      description: "ユーザーが選んだ・却下した・方針を定めたこと。相手側の成果報告は入れない。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["what", "why", "said"],
        properties: {
          what: { type: "string", description: "ユーザーが何を決めたか" },
          why: { type: "string", description: "なぜそう決めたか。ログから読み取れなければ「不明」" },
          said: { type: "string", description: SAID },
        },
      },
    },
    preferences: {
      type: "array",
      description: "ユーザーのやり方・好みとして次回も効くもの。この回限りの指示は入れない。",
      items: QUOTED("ユーザーのやり方・好み", SAID),
    },
    corrections: {
      type: "array",
      description: "ユーザーが明示的に否定・訂正したこと。",
      items: QUOTED("ユーザーが否定・訂正したこと", SAID),
    },
  },
} as const

interface Quoted {
  what: string
  said: string
}

interface Digest {
  topic: string
  decisions: { what: string; why: string; said: string }[]
  preferences: Quoted[]
  corrections: Quoted[]
}

/**
 * 引用の無い項目を落とす。スキーマの `required` は空文字を止めない。
 *
 * 指示で頼むだけにすると、素材から引けなかった回に空の `said` を付けて形だけ通してくる。
 * 「引用できないものは残さない」を守るのはここ(モデルが提案し、こちら側が決定的に弾く)。
 */
const quoted = <T extends { said?: unknown }>(xs: readonly T[] | undefined): T[] =>
  (xs ?? []).filter((x) => typeof x.said === "string" && x.said.trim() !== "")

/**
 * 日本語の割合。0 に近いものは、日本語で探しても当たらない。
 *
 * 索引は trigram で、語の意味は見ていない。`job-searching` と書かれた行は「転職」では引けない。
 * ユーザーは日本語で探すので、英語のまま置いた覚え書きは DB にあっても無いのと同じになる。
 */
function japaneseRatio(s: string): number {
  if (s.length === 0) return 1
  return (s.match(/[ぁ-んァ-ヶ一-龥]/g)?.length ?? 0) / s.length
}
const JP_MIN = 0.05

/**
 * 英語の覚え書きに足す、日本語の見出し。訳文でも要約でもない。
 * 本文はそのまま残したうえで、日本語の検索語から辿り着くための行を1本増やすだけ。
 */
const HEADER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["line", "words"],
  properties: {
    line: { type: "string", description: "この覚え書きが何についてのものか。日本語1文、20〜60文字。" },
    words: {
      type: "array",
      description: "本文に書かれている事柄を日本語で表す語。5〜12語。本文に無いことは足さない。",
      items: { type: "string" },
    },
  },
} as const

const HEADER_INSTRUCTION = `これはユーザー(Haru)についての覚え書きで、英語で書かれています。

**訳す必要はありません。要約もしません。** 本文はそのまま DB に残ります。
必要なのは、**日本語で探したときにこの覚え書きが見つかる**ようにするための見出しだけです。

- line には、この覚え書きが何についてのものかを日本語1文で書いてください。
- words には、本文に書かれている事柄を日本語で表す語を並べてください。
  英語の語に対応する日本語を選ぶ、ということです(例: job-searching → 転職)。
  **本文に書かれていないことは足さないでください。**`

/** 引用を要求する部分は両方に効くので、下の2つで共有する。 */
const RULES = `- 素材のうち \`owner:\` の行だけがユーザーの言葉です。\`agent:\` の行は文脈にすぎません。
- **decisions・preferences・corrections のどの項目にも、根拠になった \`owner:\` 行からの引用を
  said に入れてください。** 引用はユーザーが実際に打った文字をそのまま写すもので、
  整えたり言い換えたりしないでください。
  **引用できないものは、ユーザーのことではありません。** その項目ごと落としてください。
- preferences は**次回も効くもの**だけ。「今回はこうして」は入れない。
- corrections はユーザーが明示的に否定・訂正したもの。
- 該当が無い項目は空配列で返してください。**無理に埋めない。** 全部空でも構いません。`

const INSTRUCTION: Record<SourceKind, string> = {
  "claude-code": `これはユーザー(Haru)と、あるコーディングエージェントの作業ログ1回ぶんです。

**取り出すのはユーザーの判断だけです。** 何が作られたか・何が直ったか・テストが通ったかは要りません。
それは既にコードと git に残っていて、ここに写しても二重になるだけです。ここにしか残らないのは
**ユーザーが何を選び、何を却下し、どういう理由でそうしたか**です。
\`agent:\` の行にある成果・完了報告・確認結果は**ユーザーの判断ではありません**。

${RULES}`,

  "claude-web": `これはユーザー(Haru)と Claude の会話1回ぶんです(Web 版)。
相談・調べもの・設計の議論・雑談が混ざります。

**取り出すのはユーザーのことだけです。** Claude が説明した内容・調べた事実・並べた選択肢は要りません。
それは調べ直せます。ここにしか残らないのは**ユーザーが何を望み、何に困り、何を選び、何を却下したか**です。
\`agent:\` の行にある説明・提案・結論は**ユーザーの考えではありません**。

- 調べものの回では、答えの中身ではなく**なぜそれを調べていたか**を topic に書いてください。
${RULES}`,
}

/**
 * DB に入れる1行にする。FTS に載るのはこの文字列。
 * 引用も索引に入れる — ユーザー自身の言い回しで引けるようにするため。
 * 要約は言葉を均してしまうので、原文の語が残っていないと本人の検索語に当たらない。
 */
function render(d: Digest, ref: SessionRef): string {
  const parts = [d.topic]
  for (const x of d.decisions) parts.push(`決定: ${x.what} — ${x.why}${x.said ? `(「${x.said}」)` : ""}`)
  for (const x of d.preferences) parts.push(`好み: ${x.what}(「${x.said}」)`)
  for (const x of d.corrections) parts.push(`訂正: ${x.what}(「${x.said}」)`)
  parts.push(`(${ref.label})`)
  return parts.join("\n")
}

/** 記憶ファイルの前置き(frontmatter)を落とす。ただし description だけは検索の取っ掛かりとして残す。 */
function stripFrontmatter(body: string): string {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (!m) return body.trim()
  const desc = /^description:\s*(.+)$/m.exec(m[1] ?? "")?.[1]?.trim()
  const rest = body.slice(m[0].length).trim()
  return desc ? `${desc}\n${rest}` : rest
}

/** `**見出し**` で区切られた散文を節に割る。1節1イベントにして、検索の粒度を揃える。 */
function sections(text: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = []
  let title = ""
  let buf: string[] = []
  const flush = () => {
    const body = buf.join("\n").trim()
    if (title !== "" && body !== "") out.push({ title, body })
    buf = []
  }
  for (const line of text.split("\n")) {
    const h = /^\*\*(.+?)\*\*\s*$/.exec(line)
    if (h) {
      flush()
      title = h[1] ?? ""
    } else {
      buf.push(line)
    }
  }
  flush()
  return out
}

export class Intake extends Effect.Service<Intake>()("Intake", {
  effect: Effect.gen(function* () {
    const db = yield* Db
    const mem = yield* Memory

    /**
     * 取り込み済みの id。provenance の先頭 ref に入れてある。
     *
     * 抹消された行は済んだことにしない。要約が的外れだったとき、取り直す手段が無いと
     * 入口の間違いが DB に固定される。`redact` すれば同じ会話がまた候補に戻る
     * — 抹消が「これは無かったことにして、もう一度取れ」の意味になる。
     */
    const ingestedIds = Effect.gen(function* () {
      const rows = yield* db.all(
        `SELECT json_extract(provenance, '$[0].ref')AS ref FROM events
          WHERE kind = 'import' AND content IS NOT NULL`,
      )
      return new Set(rows.map((r) => String((r as { ref: unknown }).ref)))
    })

    /** 作業ログのファイル一覧。除外規則を通したものだけ。 */
    const files = Effect.sync(() => {
      const out: string[] = []
      let dirs: string[]
      try {
        dirs = readdirSync(root())
      } catch {
        return out
      }
      for (const d of dirs) {
        if (EXCLUDE.some((re) => re.test(d))) continue
        const dir = join(root(), d)
        try {
          if (!statSync(dir).isDirectory()) continue
          for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) out.push(join(dir, f))
        } catch {
          // 消えた・読めないディレクトリは黙って飛ばす。入口が壊れても tick は止めない。
        }
      }
      return out
    })

    /**
     * まだ取り込んでいない会話を古い順に返す。
     * 新しい順にしないのは、判断の履歴は順番に読めないと理由が繋がらないから。
     *
     * 済んだ回は、開く前に外す。Claude Code の作業ログはファイル名が sessionId なので、
     * 中を読まなくても取り込み済みかどうかが分かる。読み終えてから `sessionId` で外す形だと、
     * 生ログの大半を占める「もう入っている回」を毎回開き直すことになる —
     * 実測で 295 本 0.63G のうち 81 本が済みで、その 81 本がほぼ全部の量だった(docs/adr/0026)。
     * 名前が sessionId と違うファイルは済みの集合に当たらないので、これまで通り開いて読む。
     */
    const scan = (limit = 20) =>
      Effect.gen(function* () {
        const done = yield* ingestedIds
        const refs: SessionRef[] = []
        for (const p of yield* files) {
          if (done.has(basename(p, ".jsonl"))) continue
          try {
            const r = readSessionRef(p)
            if (r && !done.has(r.sessionId)) refs.push(r)
          } catch {
            // 読めない1本で残り全部を落とさない。
          }
        }
        try {
          for (const r of [...readWebChats(), ...readWebDesign()]) {
            if (!done.has(r.ref.sessionId)) refs.push(r.ref)
          }
        } catch {
          // 書き出しが無い・壊れているだけなら、作業ログ側は通す。
        }
        return refs.sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit)
      })

    /** 選別だけ。モデルを呼ばないので、効き目を枠ゼロで測れる。 */
    const material = (ref: SessionRef) =>
      Effect.sync(() => {
        let found: Read | undefined
        try {
          found = readOne(ref)
        } catch {
          return undefined
        }
        if (!found) return undefined
        const text = compress(found.turns)
        const m: Material = {
          ref: found.ref,
          text,
          rawBytes: found.rawBytes,
          keptBytes: Buffer.byteLength(text),
        }
        return m
      })

    /**
     * 1会話を1イベントにする。
     *
     * 素材は境界マーカーで囲って渡す。会話ログには web もファイルも通り抜けてきているので、
     * ユーザーの指示と同じ平面に置かない。
     * 書き出すイベントも `taint` を立てる — 由来が信用できない材料から起こした要約だから。
     */
    const ingest = (ref: SessionRef) =>
      Effect.gen(function* () {
        const m = yield* material(ref)
        if (!m) return undefined
        const runner = yield* Runner
        const out = yield* runner.run({
          role: "scout",
          kind: "intake",
          prompt: buildFencedPrompt(INSTRUCTION[m.ref.kind], [
            { source: "transcript", label: m.ref.sessionId.slice(0, 8), content: m.text },
          ]),
          schema: DIGEST_SCHEMA,
        })
        const d = (out.structured ?? {}) as Partial<Digest>
        // 引用の無い項目はここで落ちる。指示ではなくコードが弾く(quoted のコメント参照)。
        const digest: Digest = {
          topic: d.topic ?? "",
          decisions: quoted(d.decisions),
          preferences: quoted(d.preferences),
          corrections: quoted(d.corrections),
        }
        const text = render(digest, m.ref)
        const id = yield* mem.remember({
          kind: "import",
          source: "system",
          taint: true,
          content: { session: m.ref.sessionId, from: m.ref.label, turns: m.ref.turns, ...digest },
          text,
          // ここが二重取り込みの歯止め。別表を持たずに events 自身に覚えさせる。
          provenance: [{ kind: m.ref.kind, ref: m.ref.sessionId, at: m.ref.at }],
          at: m.ref.at,
        })
        return { id, ref: m.ref, digest, material: m }
      })

    /**
     * `memories.json` を DB に移す。本文は要約しない。
     *
     * これは会話ログではなく、Claude.ai 側が作ったユーザーの像そのもの(トピック別の記憶と散文の要約)。
     * 要約済みのものをもう一度要約させると本人の言い回しが二度均されて消えるので、そのまま置く。
     *
     * 例外は英語で書かれたものだけ。索引は trigram で語の意味を見ないので、
     * `job-searching` と書かれた行は「転職」では引けない。ユーザーは日本語で探すから、
     * 英語のまま置いた覚え書きは DB にあっても無いのと同じになる。
     * そこにだけ、日本語の見出しを1行足す(本文は消さない。訳文で置き換えない)。
     *
     * `taint` は全部に立てる。書いたのはユーザーではないので、DB に載っていることを
     * 本人について検証された事実として扱わない。
     */
    const ingestMemories = Effect.gen(function* () {
      const path = join(exportRoot(), "memories.json")
      if (!existsSync(path)) return { added: 0, skipped: 0 }
      let list: unknown
      try {
        list = readJson(path)
      } catch {
        return { added: 0, skipped: 0 }
      }
      const first = (Array.isArray(list) ? list[0] : list) as Record<string, unknown> | undefined
      if (!first) return { added: 0, skipped: 0 }

      const done = yield* ingestedIds
      const items: { ref: string; label: string; body: string; at: string }[] = []

      const fs = Array.isArray(first.memory_files) ? (first.memory_files as Record<string, unknown>[]) : []
      for (const f of fs) {
        const p = String(f.path ?? "")
        const body = stripFrontmatter(String(f.content ?? ""))
        if (p === "" || body === "") continue
        items.push({ ref: `memory:${p}`, label: p, body, at: iso(f.updated_at) })
      }
      for (const s of sections(String(first.conversations_memory ?? ""))) {
        items.push({ ref: `memory:${s.title}`, label: s.title, body: s.body, at: iso(undefined) })
      }

      const runner = yield* Runner
      let added = 0
      let skipped = 0
      for (const it of items) {
        if (done.has(it.ref)) {
          skipped += 1
          continue
        }
        // 見出しは付けられなければ無しで通す。索引が作れないことは取り込まない理由にならない。
        const head =
          japaneseRatio(it.body) >= JP_MIN
            ? undefined
            : yield* runner
                .run({
                  role: "scout",
                  kind: "intake",
                  prompt: buildFencedPrompt(HEADER_INSTRUCTION, [
                    { source: "memory", label: it.label, content: it.body },
                  ]),
                  schema: HEADER_SCHEMA,
                })
                .pipe(
                  Effect.map((out) => out.structured as { line?: string; words?: string[] } | undefined),
                  Effect.orElseSucceed(() => undefined),
                )
        const line = head?.line ?? ""
        const words = (head?.words ?? []).join(" ")
        const index = [line, words].filter((s) => s !== "").join("\n")
        yield* mem.remember({
          kind: "import",
          source: "system",
          taint: true,
          content: { memory: it.label, body: it.body, ...(index === "" ? {} : { index: { line, words } }) },
          // 本文は最後に置いてそのまま残す。見出しは引くための足がかりにすぎない。
          text: [`記憶(${it.label})`, index, it.body].filter((s) => s !== "").join("\n"),
          provenance: [{ kind: "claude-web-memory", ref: it.ref, at: it.at }],
          at: it.at,
        })
        added += 1
      }
      return { added, skipped }
    })

    return { scan, material, ingest, ingestMemories, ingestedIds } as const
  }),
  dependencies: [Memory.Default],
}) {}
