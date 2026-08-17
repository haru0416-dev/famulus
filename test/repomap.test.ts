import { describe, expect, test } from "vitest"
import { extractSymbols, MAP_CHAR_BUDGET, renderMap } from "../src/core/repomap.ts"

describe("extractSymbols", () => {
  test("export された function/class/interface/type/const を拾う(非export・testは対象外)", () => {
    const src = [
      "export function foo(a: string): void {}",
      "export async function bar() {}",
      "export class Baz {}",
      "export interface Qux { x: number }",
      "export type Quux = string;",
      "export const LIMIT = 5;",
      "function privateFn() {}",
      "const local = 1;",
    ].join("\n")
    expect(extractSymbols(src)).toEqual(["foo()", "bar()", "class Baz", "Qux", "Quux", "LIMIT"])
  })

  test("export enum を正しく抽出する", () => {
    const src = [
      "export enum Status { Active = 'active', Inactive = 'inactive' }",
      "export enum Priority { Low, Medium, High }",
      "enum PrivateStatus { A, B }",
    ].join("\n")
    expect(extractSymbols(src)).toEqual(["Status", "Priority"])
  })
})

describe("renderMap", () => {
  test("ファイル毎1行+ヘッダ、予算超過はシンボル少ない側から省略して明示", () => {
    const map = [
      { file: "src/a.ts", symbols: ["a()", "b()", "c()"] },
      { file: "src/b.ts", symbols: ["d()"] },
    ]
    const out = renderMap(map)
    expect(out).toContain("alwaysApply: true")
    expect(out).toContain("- src/a.ts: a(), b(), c()")
    expect(out).toContain("- src/b.ts: d()")
    // ヘッダ(≈204字)+ a.ts行(26字)は収まるが b.ts行(16字)は溢れる予算。
    // シンボル少ない側(b.ts)が省略され、fail-loudに明示されることを検証する。
    const tiny = renderMap(map, 235)
    expect(tiny).toContain("omitted by budget")
    expect(tiny).not.toContain("- src/b.ts: d()")
    expect(renderMap(map).length).toBeLessThanOrEqual(MAP_CHAR_BUDGET + 100)
  })
})
