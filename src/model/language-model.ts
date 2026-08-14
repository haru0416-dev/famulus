/**
 * `claude -p` を AI SDK の `LanguageModelV4` として差す。ここは翻訳だけで、統治は持たない。
 *
 * 分けてある理由: 前の形(src/model/provider.ts)は、CLI の呼び出しとゲートと会計が
 * 1つの `stream()` の中に並んでいた。同じ骨格が src/model/Runner.ts にもあるので、
 * 統治が二重に書かれていた。統治は middleware(src/model/governed.ts)に寄せ、
 * このファイルは「CLI の入出力を V4 の形に直す」だけを持つ。
 *
 * ## ツール呼び出しの搬送
 * `claude -p` は「ツール呼び出しを返す」API ではなく、自分でループを回して最終テキストを返す CLI。
 * なので道具があるときは `--json-schema` で「次に呼びたい道具」を構造化提出させ、
 * それを `tool-call` コンテンツに翻訳して返す。実行するのは AI SDK 側。内側の claude は道具を持たない。
 *
 * 構造化提出はテキスト応答より入力が重い(StructuredOutput の定義が載るため)。
 * 道具の定義そのものもこちらの system prompt に載るので、その分だけ上乗せになる。
 *
 * ## 統治の側へ渡すもの
 * クォータシグナルと従量課金換算額は `providerMetadata[PROVIDER_META]` に載せる。トークン数は V4 の `usage` が
 * 素・キャッシュ読み・キャッシュ書きを最初から分けて持つので、そのまま入る。
 */

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider"
import { callClaude } from "./claude-cli.ts"
import { RUNTIME_PROMPT } from "./models.ts"

export const CLAUDE_MAX_PROVIDER_ID = "claude-max"

/** `providerMetadata` の鍵。統治の middleware がここからクォータシグナルと従量課金換算額を読む。 */
export const PROVIDER_META = CLAUDE_MAX_PROVIDER_ID

/** 道具呼び出しの提出スキーマ。`arguments` は自由形なので中身は AI SDK 側の道具スキーマが検査する。 */
export const TOOL_PROTOCOL_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "利用者に見せる最終本文。ツールを呼ぶ途中の提出では空文字にする。",
    },
    toolCalls: {
      type: "array",
      description: "次に実行したいツール。無ければ空配列。",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: { type: "object" },
        },
        required: ["name", "arguments"],
      },
    },
  },
  required: ["text", "toolCalls"],
} as const

interface ToolProtocolReply {
  text?: string
  toolCalls?: { name?: string; arguments?: Record<string, unknown> }[]
}

/** 道具の結果を1本の文字列に戻す。V4 の出力は型付きの箱なので、中身だけ取り出す。 */
function toolOutputText(out: LanguageModelV4ToolResultOutput): string {
  switch (out.type) {
    case "text":
    case "error-text":
      return out.value
    case "execution-denied":
      return `(実行を断った${out.reason ? `: ${out.reason}` : ""})`
    default:
      return JSON.stringify("value" in out ? out.value : out)
  }
}

/**
 * 会話履歴を1本のテキストにまとめる。`claude -p` は prompt を1つしか取らないため。
 * system は畳まない — `--system-prompt` に別で渡す。
 */
export function renderPrompt(prompt: LanguageModelV4Prompt): string {
  const parts: string[] = []
  for (const m of prompt) {
    if (m.role === "system") continue
    if (m.role === "user") {
      const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("")
      if (text.trim()) parts.push(`## 利用者\n${text}`)
    } else if (m.role === "assistant") {
      const lines: string[] = []
      for (const c of m.content) {
        if (c.type === "text") lines.push(c.text)
        else if (c.type === "tool-call") lines.push(`→ ${c.toolName}(${c.input}) を呼んだ`)
      }
      const body = lines.filter((s) => s.trim()).join("\n")
      if (body) parts.push(`## あなた(前のターン)\n${body}`)
    } else {
      for (const c of m.content) {
        if (c.type !== "tool-result") continue
        parts.push(`## ツール結果 (${c.toolName})\n${toolOutputText(c.output)}`)
      }
    }
  }
  return parts.join("\n\n")
}

/** 提出できる道具の一覧を system prompt に載せる。 */
export function toolInstruction(tools: LanguageModelV4CallOptions["tools"]): string {
  const fns = (tools ?? []).filter((t) => t.type === "function")
  if (fns.length === 0) return ""
  const list = fns
    .map((t) => `- \`${t.name}\`: ${t.description ?? ""}\n  引数スキーマ: ${JSON.stringify(t.inputSchema)}`)
    .join("\n")
  return [
    "",
    // 見出しを「ツール」にしない。内側の claude はツール一覧を「今この場で呼べるもの」と読み、
    // ネイティブに呼びに行って CLI に `No such tool available` で拒否され、そこで「使えない」と
    // 結論して toolCalls を空のまま返す。呼び方が1つしかないことを見出しの側で先に言う。
    "## 提出できる依頼(**ツールではない**)",
    list,
    "",
    "呼び出し方はひとつだけ: 構造化出力の `toolCalls` に `{name, arguments}` を書いて**提出**する。",
    "実行するのは呼び出し側で、結果は次のターンに「ツール結果」として返る。**あなた自身は実行できない。**",
    "ツールを提出する途中は `text` を空文字にする。結果が返った後、`toolCalls` を空配列にして完全な最終本文を1度だけ返す。",
    "",
    "**この場に実行系のツールは1つも無い。** 上の名前をツールとして呼ぼうとすると",
    "`No such tool available` で拒否される。拒否されても「使えない」と結論しない — 提出していないだけ。",
    // ツールを封じても CLI の前置きは消えないので、素で訊けば Read / Edit / Write が並ぶ。
    "実行系が Read / Edit / Write / Glob / Grep / Bash のような一覧を見せることがあるが、**それは幻**で、",
    "この経路では1つも動かない。MCP・ファイル・カレンダーも最初から無い。",
    "上に載っているものについて「使えない」「載っていない」「権限が無い」とは書かない。",
    "呼んでいないものを呼んだと書かない。結果は次のターンにしか返らない。",
  ].join("\n")
}

/**
 * 提出された道具名を実在の道具に寄せる。
 * 自由記述のスキーマなので `budget ` のような揺れが混ざる。名前が1文字違うだけで
 * 「そんな道具は無い」と返り、モデルは「接続されていない」と誤診する。
 * 完全一致 → 前後空白除去 → 大文字小文字無視、まで寄せて、それでも無ければ原文のまま返す
 * (存在しない道具を黙って別の道具に読み替えるのは、直すより悪い)。
 */
export function normalizeToolName(raw: string | undefined, names: readonly string[]): string {
  const name = (raw ?? "").trim()
  if (name.length === 0) return ""
  if (names.includes(name)) return name
  return names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? name
}

/**
 * 再提出するか。指示文だけに頼らず、CLI のエラーから判定する。
 *
 * 内側の claude が提出用の名前をネイティブに呼んで CLI に拒否され、そのまま「使えなかった」と
 * 道具呼び出しを1件も提出せず戻ることがある。
 * 判定に使うのは CLI が流した tool_use_error だけで、応答の文面は読まない —
 * 「ツールが無い」と書いてあるかどうかで決めると、正しく諦めた回までやり直す。
 */
export function needsResubmit(
  hasTools: boolean,
  nativeToolAttempt: boolean | undefined,
  calls: number,
): boolean {
  return hasTools && nativeToolAttempt === true && calls === 0
}

/** 取り直しのときだけ足す一行。道具ではなく呼び方の問題だと名指しする。 */
const RESUBMIT_HINT = `
直前の試行で、上の名前をネイティブのツールとして呼んで \`No such tool available\` で拒否されている。
**道具が無いのではなく、呼び方が違う。** 今回は必ず \`toolCalls\` に \`{name, arguments}\` を書いて提出する。
「使えない」と書いて終わらせない。`

/**
 * `claude -p` を1つの V4 モデルにする。統治は掛かっていない —
 * ゲートと会計は src/model/governed.ts の middleware が挟む。素のこれを直接使わない。
 */
export function claudeCliModel(modelId: string): LanguageModelV4 {
  const doGenerate: LanguageModelV4["doGenerate"] = async (options) => {
    const fns = (options.tools ?? []).filter((t) => t.type === "function")
    const names = fns.map((t) => t.name)
    const hasTools = fns.length > 0

    const systemPrompt = [
      options.prompt.find((m) => m.role === "system")?.content ?? RUNTIME_PROMPT,
      toolInstruction(options.tools),
    ]
      .filter(Boolean)
      .join("\n")

    const call = (system: string) =>
      callClaude({
        prompt: renderPrompt(options.prompt),
        model: modelId,
        systemPrompt: system,
        ...(hasTools ? { jsonSchema: TOOL_PROTOCOL_SCHEMA } : {}),
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      })

    let result = await call(systemPrompt)
    const asReply = (r: typeof result): ToolProtocolReply =>
      hasTools
        ? ((r.structured as ToolProtocolReply | undefined) ?? { text: r.text, toolCalls: [] })
        : { text: r.text, toolCalls: [] }

    if (needsResubmit(hasTools, result.nativeToolAttempt, (asReply(result).toolCalls ?? []).length)) {
      if (process.env.OZ_DEBUG) console.error("[oz] ネイティブ呼び出しが拒否された。取り直す:", modelId)
      result = await call(`${systemPrompt}\n${RESUBMIT_HINT}`)
    }

    const reply = asReply(result)
    const content: LanguageModelV4Content[] = []
    if (reply.text) content.push({ type: "text", text: reply.text })

    const calls = (reply.toolCalls ?? [])
      .map((c) => ({ ...c, name: normalizeToolName(c.name, names) }))
      .filter((c) => c.name.length > 0)
    for (const [i, c] of calls.entries()) {
      content.push({
        type: "tool-call",
        // CLI は tool_use_id を返さないので、こちらで安定な id を振る。
        toolCallId: `oz_${modelId}_${Date.now()}_${i}`,
        toolName: c.name,
        input: JSON.stringify(c.arguments ?? {}),
      })
    }

    const u = result.usage
    return {
      content,
      finishReason: {
        unified: calls.length > 0 ? ("tool-calls" as const) : ("stop" as const),
        raw: undefined,
      },
      usage: {
        // 入力は3つ足して数える。V4 は最初からこの3列を持つ。
        inputTokens: {
          total: u.inTok + u.cacheRead + u.cacheWrite,
          noCache: u.inTok,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
        },
        outputTokens: { total: u.outTok, text: u.outTok, reasoning: undefined },
      },
      // 統治の側が読む欄。定額利用なので、値段は請求ではなく従量課金換算額として渡すだけ。
      providerMetadata: {
        [PROVIDER_META]: {
          notionalUsd: result.usage.notionalUsd,
          ...(result.quota
            ? {
                quota: {
                  pool: result.quota.pool,
                  window: result.quota.window,
                  ...(result.quota.usedPercent !== undefined
                    ? { usedPercent: result.quota.usedPercent }
                    : {}),
                  ...(result.quota.resetsAtMs !== undefined ? { resetsAtMs: result.quota.resetsAtMs } : {}),
                  ...(result.quota.exhausted !== undefined ? { exhausted: result.quota.exhausted } : {}),
                },
              }
            : {}),
        },
      },
      warnings: [],
    }
  }

  return {
    specificationVersion: "v4",
    provider: CLAUDE_MAX_PROVIDER_ID,
    modelId,
    supportedUrls: {},
    doGenerate,
    /**
     * CLI は完了してから result を返すので、逐次配信はここには無い。
     * 1回ぶんを組み立ててから流し直しているだけ(構造化提出の途中は JSON なので出せない)。
     */
    async doStream(options) {
      const gen = await doGenerate(options)
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }]
      for (const [i, c] of gen.content.entries()) {
        if (c.type === "text") {
          parts.push({ type: "text-start", id: String(i) })
          parts.push({ type: "text-delta", id: String(i), delta: c.text })
          parts.push({ type: "text-end", id: String(i) })
        } else if (c.type === "tool-call") {
          parts.push(c)
        }
      }
      parts.push({
        type: "finish",
        finishReason: gen.finishReason,
        usage: gen.usage,
        ...(gen.providerMetadata ? { providerMetadata: gen.providerMetadata } : {}),
      })
      return {
        stream: new ReadableStream({
          start(ctrl) {
            for (const p of parts) ctrl.enqueue(p)
            ctrl.close()
          },
        }),
      }
    },
  }
}
