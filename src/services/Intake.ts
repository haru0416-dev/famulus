/**
 * Claude Code の作業ログと Claude.ai の書き出しから、ユーザーの判断だけを DB に取り込む。
 * モデルを使わない選別の後に scout が1会話を1イベントへ要約する。`memories.json` は再要約しない。
 * 取り込み済みかは `kind='import'` の provenance の id で判定し、別表は持たない。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as v from "valibot"
import { appConfig } from "../core/config.ts"
import { nowIso } from "../core/time.ts"
import { Runner } from "../model/Runner.ts"
import { rs } from "../model/schema.ts"
import { Db } from "./Db.ts"
import { buildFencedPrompt } from "./Governance.ts"
import { Memory } from "./Memory.ts"

/** 検査が別の場所を指せるよう、モジュール読み込み時ではなく呼び出し時に読む。 */
const root = (): string => appConfig().paths.transcriptRoot

/** zip のまま置かないのは、標準ライブラリだけで開けないから。 */
const exportRoot = (): string => appConfig().paths.exportRoot

/** サブエージェントの実験用キャッシュと使い捨て workspace。ユーザーの発話が入っていない。 */
const EXCLUDE = [/cache-agent-exp/, /(^|\/)-tmp-/]

/** 人が打った発話を補完や system 注入と区別できるのはこの目印だけ。 */
const TYPED = "typed"
const TYPED_MARK = `"promptSource":"${TYPED}"`

/** 含有判定は Buffer のまま行う。utf8 への変換は読み取り自体より重い。 */
function readTypedRaw(path: string): string | undefined {
  const buf = readFileSync(path)
  return buf.includes(TYPED_MARK) ? buf.toString("utf8") : undefined
}

/** 結論は最後に出るので、最後の応答だけ多く割り当てる。 */
const REPLY_HEAD = 400
const REPLY_MIN = 100
const LAST_REPLY = 1500
/** 1回の scout 呼び出しに収める量。 */
const MATERIAL_MAX = 40_000

/** 素材の性質が違うので渡す指示を変える。 */
export type SourceKind = "claude-code" | "claude-web"

export interface SessionRef {
  readonly kind: SourceKind
  /** 二重取り込みの判定に使う。 */
  readonly sessionId: string
  readonly path: string
  readonly label: string
  readonly at: string
  readonly turns: number
}

export interface Material {
  readonly ref: SessionRef
  readonly text: string
  /** `said` の照合元。発話単位で持ち、発話をまたぐ文字列は根拠にしない。 */
  readonly ownerTurns: readonly string[]
  readonly rawBytes: number
  readonly keptBytes: number
}

interface Turn {
  readonly who: "owner" | "agent"
  readonly text: string
}

/** 解釈できない・欠けた日時は取り込み時刻にする。 */
const iso = (s: unknown): string => {
  const d = new Date(String(s ?? ""))
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** `conversations.json` は走査と取り込みで何度も開く。mtime が変われば読み直す。 */
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

const parseRecord = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line)
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

interface TypedOwnerRecord {
  readonly text: string
  readonly sessionId: unknown
  readonly cwd: unknown
  readonly timestamp: unknown
}

function typedOwnerFromRecord(record: Record<string, unknown>): TypedOwnerRecord | undefined {
  if (record.isSidechain === true || record.type !== "user" || record.promptSource !== TYPED) return undefined
  const text = plainText((record.message as { content?: unknown } | undefined)?.content)
  if (text.trim().length === 0) return undefined
  return {
    text,
    sessionId: record.sessionId,
    cwd: record.cwd,
    timestamp: record.timestamp,
  }
}

function readSession(path: string): { ref: SessionRef; turns: Turn[]; rawBytes: number } | undefined {
  // 全文パースは高いので、人が打った跡が無いファイルは先に捨てる。
  const raw = readTypedRaw(path)
  if (raw === undefined) return undefined

  const turns: Turn[] = []
  let sessionId = ""
  let cwd = ""
  let at = ""

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue
    const record = parseRecord(line)
    if (!record) continue
    const owner = typedOwnerFromRecord(record)
    if (owner) {
      sessionId ||= String(owner.sessionId ?? "")
      cwd ||= String(owner.cwd ?? "")
      at ||= String(owner.timestamp ?? nowIso())
      turns.push({ who: "owner", text: owner.text })
    } else if (record.isSidechain !== true && record.type === "assistant") {
      const text = plainText((record.message as { content?: unknown } | undefined)?.content)
      if (text.trim().length === 0) continue
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

/** 走査用。`TYPED_MARK` を含む行だけ解く。条件は `readSession` と同じなので `turns` は一致する。 */
function readSessionRef(path: string): SessionRef | undefined {
  const raw = readTypedRaw(path)
  if (raw === undefined) return undefined

  let sessionId = ""
  let cwd = ""
  let at = ""
  let owner = 0
  for (const line of raw.split("\n")) {
    if (!line.includes(TYPED_MARK)) continue
    const parsed = parseRecord(line)
    const typedOwner = parsed && typedOwnerFromRecord(parsed)
    if (!typedOwner) continue
    sessionId ||= String(typedOwner.sessionId ?? "")
    cwd ||= String(typedOwner.cwd ?? "")
    at ||= String(typedOwner.timestamp ?? nowIso())
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

/** text も content も空の会話は捨てる(書き出しの大半がこれで、こちらでは復元できない)。 */
function readWebChats(): Read[] {
  const path = join(exportRoot(), "conversations.json")
  if (!existsSync(path)) return []
  return cached(`chats:${path}`, path, () => buildWebChats(path))
}

function buildWebChats(path: string): Read[] {
  // `readJson` を使うと同じ parse 結果を `chats:` と `json:` の2エントリで持つ
  const list = JSON.parse(readFileSync(path, "utf8")) as unknown
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
      // `text` に入る回と content ブロックに入る回が混ざる。
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

/** `attachments` は読まない。毎回差し込まれる定型文で、ユーザーが打った文字ではない。 */
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
    j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
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

/** 全体走査にしない。`material` は取り込みのたびに呼ばれる。 */
function readOne(ref: SessionRef): Read | undefined {
  if (ref.kind === "claude-code") return readSession(ref.path)
  if (ref.path.endsWith("conversations.json")) {
    return readWebChats().find((r) => r.ref.sessionId === ref.sessionId)
  }
  return readDesignFile(ref.path)
}

/**
 * ユーザーの発話は削らず、応答の地の文だけを削って上限に収める。
 * 中央を一律に削らない — 長い会話ほどユーザーの言葉が多く、それが消える。
 */
function compress(turns: readonly Turn[]): string {
  // 応答は1往復の最後の1件だけ残す。途中は道具呼び出しごとの経過報告で、決定は最後に書かれる。
  const folded: Turn[] = []
  for (const t of turns) {
    if (t.who === "owner") {
      folded.push(t)
    } else if (folded.length > 0 && folded[folded.length - 1]?.who === "agent") {
      folded[folded.length - 1] = t
    } else {
      folded.push(t)
    }
  }

  const ownerChars = folded.reduce((n, t) => (t.who === "owner" ? n + t.text.length + 8 : n), 0)
  const replies = folded.filter((t) => t.who === "agent").length

  // 最後の1件は結論なので先に取り分ける。
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

const QUOTED = (what: string, said: string) =>
  v.object({
    what: v.pipe(v.string(), v.description(what)),
    said: v.pipe(v.string(), v.description(said)),
  })

const SAID = "根拠になった owner: 行からの**そのままの引用**(4〜60文字)。引けないなら項目ごと落とす"

/**
 * 全項目に `said`(ユーザー発話の引用)を必須にする。無いと agent の作業報告が「決定」として返り、
 * DB に入った後では本人の言葉かモデルの印象かを区別できない。
 */
const DIGEST_SCHEMA = rs(
  v.object({
    topic: v.pipe(v.string(), v.description("ユーザーがこの回で何をしようとしていたか。一行。")),
    decisions: v.pipe(
      v.array(
        v.object({
          what: v.pipe(v.string(), v.description("ユーザーが何を決めたか")),
          why: v.pipe(v.string(), v.description("なぜそう決めたか。ログから読み取れなければ「不明」")),
          said: v.pipe(v.string(), v.description(SAID)),
        }),
      ),
      v.description("ユーザーが選んだ・却下した・方針を定めたこと。相手側の成果報告は入れない。"),
    ),
    preferences: v.pipe(
      v.array(QUOTED("ユーザーのやり方・好み", SAID)),
      v.description("ユーザーのやり方・好みとして次回も当てはまるもの。この回限りの指示は入れない。"),
    ),
    corrections: v.pipe(
      v.array(QUOTED("ユーザーが否定・訂正したこと", SAID)),
      v.description("ユーザーが明示的に否定・訂正したこと。"),
    ),
  }),
)

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

const GRAPHEMES = new Intl.Segmenter("ja", { granularity: "grapheme" })

/**
 * owner の原文から引けない項目を落とす。スキーマの `required` は空文字や捏造を止めない。
 * agent の文はユーザーの言葉を推測して書いていることがあるので照合先にしない。
 */
const quoted = <T extends { said?: unknown }>(
  xs: readonly T[] | undefined,
  ownerTurns: readonly string[],
): T[] =>
  (xs ?? []).filter((x) => {
    if (typeof x.said !== "string") return false
    const said = x.said
    const length = [...GRAPHEMES.segment(said)].length
    return (
      length >= 4 && length <= 60 && said.trim() === said && ownerTurns.some((turn) => turn.includes(said))
    )
  })

/** 索引は trigram なので、英語の行は日本語の検索語で当たらない。 */
function japaneseRatio(s: string): number {
  if (s.length === 0) return 1
  return (s.match(/[ぁ-んァ-ヶ一-龥]/g)?.length ?? 0) / s.length
}
const JP_MIN = 0.05

/** 英語の覚え書きに足す日本語の見出し。訳文ではなく、本文はそのまま残す。 */
const HEADER_SCHEMA = rs(
  v.object({
    line: v.pipe(
      v.string(),
      v.minLength(20),
      v.maxLength(60),
      v.description("この覚え書きが何についてのものか。日本語1文、20〜60文字。"),
    ),
    words: v.pipe(
      v.array(v.string()),
      v.minLength(5),
      v.maxLength(12),
      v.description("本文に書かれている事柄を日本語で表す語。5〜12語。本文に無いことは足さない。"),
    ),
  }),
)

const HEADER_INSTRUCTION = `これはユーザー(Haru)についての覚え書きで、英語で書かれています。

**訳す必要はありません。要約もしません。** 本文はそのまま DB に残ります。
必要なのは、**日本語で探したときにこの覚え書きが見つかる**ようにするための見出しだけです。

- line には、この覚え書きが何についてのものかを日本語1文で書いてください。
- words には、本文に書かれている事柄を日本語で表す語を並べてください。
  英語の語に対応する日本語を選ぶ、ということです(例: job-searching → 転職)。
  **本文に書かれていないことは足さないでください。**`

const RULES = `- 素材のうち \`owner:\` の行だけがユーザーの言葉です。\`agent:\` の行は文脈にすぎません。
- **decisions・preferences・corrections のどの項目にも、根拠になった \`owner:\` 行からの引用を
  said に入れてください。** 引用はユーザーが実際に打った文字をそのまま写すもので、
  整えたり言い換えたりしないでください。
  **引用できないものは、ユーザーのことではありません。** その項目ごと落としてください。
- preferences は**次回も当てはまるもの**だけ。「今回はこうして」は入れない。
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

/** FTS に載る文字列。引用も入れる — 要約は語を言い換えるので、本人の言い回しで引けなくなる。 */
function render(d: Digest, ref: SessionRef): string {
  const parts = [d.topic]
  for (const x of d.decisions) parts.push(`決定: ${x.what} — ${x.why}${x.said ? `(「${x.said}」)` : ""}`)
  for (const x of d.preferences) parts.push(`好み: ${x.what}(「${x.said}」)`)
  for (const x of d.corrections) parts.push(`訂正: ${x.what}(「${x.said}」)`)
  parts.push(`(${ref.label})`)
  return parts.join("\n")
}

/** frontmatter のうち description だけは検索の手掛かりとして残す。 */
function stripFrontmatter(body: string): string {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (!m) return body.trim()
  const desc = /^description:\s*(.+)$/m.exec(m[1] ?? "")?.[1]?.trim()
  const rest = body.slice(m[0].length).trim()
  return desc ? `${desc}\n${rest}` : rest
}

/** 1節1イベントにして検索の粒度を揃える。 */
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

const makeIntake = () =>
  Effect.gen(function* () {
    const db = yield* Db
    const mem = yield* Memory

    /** 抹消された行は済みにしない。`redact` すれば同じ会話が候補に戻り、的外れな要約を取り直せる。 */
    const ingestedIds = Effect.gen(function* () {
      const rows = yield* db.all(
        `SELECT json_extract(provenance, '$[0].ref')AS ref FROM events
          WHERE kind = 'import' AND content IS NOT NULL`,
      )
      return new Set(rows.map((r) => String((r as { ref: unknown }).ref)))
    })

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
          // 読めないディレクトリで cycle を止めない。
        }
      }
      return out
    })

    /**
     * 古い順に返す。判断の理由は順に読まないと繋がらない。
     * 作業ログはファイル名が sessionId なので、済んだ回は開く前に外す(済んだ回が量の大半を占める)。
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
          // 書き出しが壊れていても作業ログは通す。
        }
        return refs.sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit)
      })

    /** モデルを呼ばないので、クォータを使わずに選別の結果を測れる。 */
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
          ownerTurns: found.turns.filter((t) => t.who === "owner").map((t) => t.text),
          rawBytes: found.rawBytes,
          keptBytes: Buffer.byteLength(text),
        }
        return m
      })

    /** 会話ログは web やファイルの内容を検査なしで含むので、境界マーカーで囲み、結果にも `taint` を立てる。 */
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
        const digest: Digest = {
          topic: d.topic ?? "",
          decisions: quoted(d.decisions, m.ownerTurns),
          preferences: quoted(d.preferences, m.ownerTurns),
          corrections: quoted(d.corrections, m.ownerTurns),
        }
        const text = render(digest, m.ref)
        const id = yield* mem.remember({
          kind: "import",
          source: "system",
          taint: true,
          content: { session: m.ref.sessionId, from: m.ref.label, turns: m.ref.turns, ...digest },
          text,
          // 二重取り込みの判定はこの provenance で行う。
          provenance: [{ kind: m.ref.kind, ref: m.ref.sessionId, at: m.ref.at }],
          at: m.ref.at,
        })
        return { id, ref: m.ref, digest, material: m }
      })

    /**
     * `memories.json` は Claude.ai が作った要約なので、再要約せず本文のまま置く。英語の項目にだけ日本語の見出しを足す。
     * 書いたのはユーザーではないので全部に `taint` を立てる。
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
        items.push({ ref: `memory:${s.title}`, label: s.title, body: s.body, at: nowIso() })
      }

      const runner = yield* Runner
      let added = 0
      let skipped = 0
      for (const it of items) {
        if (done.has(it.ref)) {
          skipped += 1
          continue
        }
        // 見出しが付かなくても取り込む。
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
          text: [`記憶(${it.label})`, index, it.body].filter((s) => s !== "").join("\n"),
          provenance: [{ kind: "claude-web-memory", ref: it.ref, at: it.at }],
          at: it.at,
        })
        added += 1
      }
      return { added, skipped }
    })

    return { scan, material, ingest, ingestMemories } as const
  })

export class Intake extends Context.Service<Intake, Effect.Success<ReturnType<typeof makeIntake>>>()(
  "Intake",
) {
  static readonly layer = Layer.effect(Intake, makeIntake()).pipe(Layer.provide(Memory.layer))
}
