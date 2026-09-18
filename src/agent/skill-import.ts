/**
 * SKILL.md を読むだけで実行しない。正本は `~/.famulus/skills/`(`FAMULUS_SKILLS`)で、
 * Claude Code は `~/.claude/skills` の symlink から同じ正本を読む。
 * どの skill をどのスロットで使えるかは skills.ts の分類が決める。SKILL.md 自身の記述は untrusted。
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { digestOf } from "../model/kernel-spec.ts"

/** プロンプトに載せる前提の量に抑える。 */
export const SKILL_MD_MAX_BYTES = 64_000

export interface ImportedSkill {
  readonly name: string
  readonly description: string
  readonly body: string
  /** 正本の書き換えを世代として区別するのに使う。 */
  readonly digest: string
  readonly path: string
  readonly bytes: number
}

export interface SkillImportResult {
  readonly skills: readonly ImportedSkill[]
  readonly rejected: readonly { path: string; reason: string }[]
}

/** YAML パーサは使わない。要るのは `name` と `description` の2欄だけ。 */
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

/** 1つの不正で全体の読み込みを止めない。 */
export function importSkillsFrom(root: string): SkillImportResult {
  const skills: ImportedSkill[] = []
  const rejected: { path: string; reason: string }[] = []
  let rootReal: string
  try {
    rootReal = realpathSync(resolve(root))
  } catch (e) {
    // 空で返すと `fam skills` が「何も無い」と表示し、置き場の間違いに気付けない。
    return { skills, rejected: [{ path: root, reason: `正本のディレクトリを読めない: ${String(e)}` }] }
  }

  for (const entry of readdirSync(rootReal, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const path = join(rootReal, entry.name, "SKILL.md")
    try {
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
        // ずれを許すと別の skill と取り違える。
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
      if ((e as { code?: string }).code === "ENOENT") continue
      rejected.push({ path, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return { skills, rejected }
}
