import assert from "node:assert/strict"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "vitest"
import { importSkillsFrom, parseSkillMd, SKILL_MD_MAX_BYTES } from "../../src/agent/skill-import.ts"
import { compileSkillPlan, renderSkillOverlay, SkillPlanRejected, skillRef } from "../../src/agent/skills.ts"
import { configureApp } from "../../src/core/config.ts"

const roots: string[] = []
const makeRoot = (): string => {
  const root = join(tmpdir(), `skills-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}
const put = (root: string, name: string, content: string) => {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, "SKILL.md"), content)
}
const skillMd = (name: string, body = "# 本文\n規律。") =>
  `---\nname: ${name}\ndescription: 説明。\n---\n\n${body}\n`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  // 他のテストが素の設定で走れるように戻す
  delete process.env.FAMULUS_SKILLS
  configureApp()
})

test("frontmatter の name と folded description を読み、欠けは拒否する", () => {
  const folded = parseSkillMd(
    "---\nname: chrome-ext\ndescription: >\n  1行目\n  2行目\nversion: 1.0\n---\n本文",
  )
  assert.equal(folded.name, "chrome-ext")
  assert.equal(folded.description, "1行目 2行目")
  assert.equal(folded.body, "本文")

  assert.throws(() => parseSkillMd("---\ndescription: x\n---\n本文"), /name が無い/)
  assert.throws(() => parseSkillMd("---\nname: Bad Name\ndescription: x\n---\n本文"), /形が不正/)
  assert.throws(() => parseSkillMd("---\nname: ok\ndescription: x\n---\n"), /本文が空/)
  assert.throws(() => parseSkillMd("本文だけ"), /frontmatter/)
})

test("取り込みは壊れた1件で全体を止めず、封じ込めとサイズと名前ずれを拒否する", () => {
  const root = makeRoot()
  const outside = makeRoot()
  put(root, "good", skillMd("good"))
  put(root, "misnamed", skillMd("other-name")) // ディレクトリ名と frontmatter の name がずれている
  put(root, "huge", skillMd("huge", "x".repeat(SKILL_MD_MAX_BYTES)))
  // root の外を指す symlink
  writeFileSync(join(outside, "SKILL.md"), skillMd("escaped"))
  mkdirSync(join(root, "escaped"))
  symlinkSync(join(outside, "SKILL.md"), join(root, "escaped", "SKILL.md"))
  mkdirSync(join(root, "no-skill-here")) // SKILL.md の無いディレクトリは拒否ではなく対象外

  const result = importSkillsFrom(root)
  assert.deepEqual(
    result.skills.map((s) => s.name),
    ["good"],
  )
  const reasons = result.rejected.map((r) => r.reason)
  assert.ok(reasons.some((r) => r.includes("ディレクトリ名")))
  assert.ok(reasons.some((r) => r.includes("大きすぎる")))
  assert.ok(reasons.some((r) => r.includes("root の外")))
  assert.equal(result.rejected.length, 3)
})

test("分類済みの取り込み skill は合成でき、未分類は拒否される", () => {
  const root = makeRoot()
  put(root, "jissoku-writing", skillMd("jissoku-writing", "# 実測を書く\n「効く」で文を締めない。"))
  put(root, "impeccable", skillMd("impeccable")) // 実在するが分類が無い
  process.env.FAMULUS_SKILLS = root
  configureApp()

  const plan = compileSkillPlan({ profile: "autonomous-parent", presentation: "jissoku-writing" })
  assert.ok(renderSkillOverlay(plan).includes("「効く」で文を締めない"))
  const pair = compileSkillPlan({ profile: "autonomous-parent", presentation: "jissoku-writing" })
  assert.equal(pair.presentation?.id, "skill:jissoku-writing")

  assert.throws(
    () => compileSkillPlan({ profile: "autonomous-parent", presentation: "impeccable" }),
    SkillPlanRejected,
  )
})

test("取り込み skill の世代は内容で固定される — 正本を書き換えると digest が変わる", () => {
  const root = makeRoot()
  put(root, "jissoku-writing", skillMd("jissoku-writing", "版1"))
  process.env.FAMULUS_SKILLS = root
  configureApp()
  const before = skillRef("jissoku-writing").digest

  const root2 = makeRoot()
  put(root2, "jissoku-writing", skillMd("jissoku-writing", "版2"))
  process.env.FAMULUS_SKILLS = root2
  configureApp()
  const after = skillRef("jissoku-writing").digest
  assert.notEqual(before, after)
})

test("正本のディレクトリごと読めないときは、0件ではなく理由を返す", () => {
  const result = importSkillsFrom(join(tmpdir(), `not-here-${process.pid}-${Math.random()}`))
  assert.deepEqual(result.skills, [])
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0]?.reason ?? "", /正本のディレクトリを読めない/)
})
