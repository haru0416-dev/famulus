/**
 * SKILL.md の取り込み(.ward/plans/010 の前倒し許可範囲 — no-exec validator と読み込みだけ)。
 *
 * 正本は `~/.claude/skills/`(`OPEN_ZERO_SKILLS`)。Haru が Claude Code 用に整備している
 * skill を famulus がそのまま読む — 書く規律のような共有の手続き知識を二重管理しない(一本化)。
 *
 * 実行はしない。読み込みは frontmatter(name / description)と本文の抽出、サイズ上限、
 * root 外への symlink 脱出の拒否だけ。**どの skill をどのスロットで使ってよいかは
 * ホスト側の分類(src/agent/skills.ts)が決める** — SKILL.md 自身の記述は untrusted な
 * 主張であって、権限も道具も運ばない(plan 010 の信頼模型)。
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { digestOf } from "../model/kernel-spec.ts"

/** 1つの SKILL.md の上限。これを超えるものは skill ではなく文書 — プロンプトに載せる前提の量に縛る。 */
export const SKILL_MD_MAX_BYTES = 64_000

export interface ImportedSkill {
  readonly name: string
  readonly description: string
  readonly body: string
  /** 内容の指紋。Haru が正本を書き換えれば変わる — 世代の固定に使う。 */
  readonly digest: string
  readonly path: string
  readonly bytes: number
}

export interface SkillImportResult {
  readonly skills: readonly ImportedSkill[]
  readonly rejected: readonly { path: string; reason: string }[]
}

/**
 * frontmatter を読む。YAML 全体は解さない — 要るのは `name` と `description` の2欄だけで、
 * folded(`>`)の複数行 description だけ追って、他の欄は素通しする。
 */
export function parseSkillMd(content: string): { name: string; description: string; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) throw new Error("frontmatter(--- で囲まれた先頭ブロック)が無い")
  const [, front = "", body = ""] = m
  const lines = front.split(/\r?\n/)
  const field = (key: string): string | undefined => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`))
    if (at === -1) return undefined
    const head = (lines[at] ?? "").slice(key.length + 1).trim()
    if (head !== ">" && head !== "|" && head !== "") return head
    // folded / block 形式: 続くインデント行を集める
    const parts: string[] = []
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (!/^\s+\S/.test(line)) break
      parts.push(line.trim())
    }
    return parts.join(" ").trim() || undefined
  }
  const name = field("name")
  const description = field("description")
  if (!name) throw new Error("frontmatter に name が無い")
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`name の形が不正: ${name}`)
  if (!description) throw new Error("frontmatter に description が無い")
  const trimmed = body.trim()
  if (trimmed.length === 0) throw new Error("本文が空")
  return { name, description, body: trimmed }
}

/**
 * `<root>/<dir>/SKILL.md` を全部読む。壊れたものは落として理由を残す —
 * 1つの不正が全体の読み込みを止めない(plan 010 の component-level failure isolation)。
 */
export function importSkillsFrom(root: string): SkillImportResult {
  const skills: ImportedSkill[] = []
  const rejected: { path: string; reason: string }[] = []
  const rootReal = (() => {
    try {
      return realpathSync(resolve(root))
    } catch {
      return undefined
    }
  })()
  if (!rootReal) return { skills, rejected }

  for (const entry of readdirSync(rootReal, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const path = join(rootReal, entry.name, "SKILL.md")
    try {
      // symlink で root の外の実体を指しているものは読まない(閉じ込めの検証)。
      const real = realpathSync(path)
      if (!real.startsWith(`${rootReal}/`)) {
        rejected.push({ path, reason: "root の外を指している" })
        continue
      }
      const bytes = statSync(real).size
      if (bytes > SKILL_MD_MAX_BYTES) {
        rejected.push({ path, reason: `大きすぎる(${bytes} bytes > ${SKILL_MD_MAX_BYTES})` })
        continue
      }
      const parsed = parseSkillMd(readFileSync(real, "utf8"))
      if (parsed.name !== entry.name) {
        // ディレクトリ名と frontmatter の name のずれは取り違えの元 — 拒否して直させる。
        rejected.push({ path, reason: `name(${parsed.name})がディレクトリ名(${entry.name})と違う` })
        continue
      }
      skills.push({
        ...parsed,
        digest: digestOf(parsed.body),
        path: real,
        bytes,
      })
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") continue // SKILL.md を持たないディレクトリは対象外
      rejected.push({ path, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return { skills, rejected }
}
