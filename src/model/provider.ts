/**
 * pi-ai の Provider として `claude -p` を差す。**これが Flue と定額枠を繋ぐ唯一の橋**。
 *
 * Flue はモデル呼び出しを pi-ai の Models に丸ごと委譲していて(`@flue/runtime` の
 * `providers.mjs` が `createModels()` を持ち、`setProvider()` で差し替えられる)、
 * pi-ai の Provider は「HTTP を叩くもの」とは定義されていない — 必要なのは
 * `stream(model, context, options) => AssistantMessageEventStream` を満たすことだけ。
 * だから**トランスポートを subprocess にできる**。ここがこの設計の成立点。
 *
 * これをやらずに `useModel('anthropic/...')` を使うと、Flue は `ANTHROPIC_API_KEY` を探しにいき、
 * **定額枠ではなく従量課金に戻る**。
 *
 * ## ツール呼び出しの搬送
 * `claude -p` は「ツール呼び出しを返す」API ではなく、自分でループを回して最終テキストを返す CLI。
 * なので `context.tools` があるときは **`--json-schema` で「次に呼びたいツール」を構造化提出させ**、
 * それを `ToolCall` コンテンツブロックに翻訳して Pi のハーネスに返す。
 * 実行するのは Pi/Flue 側(= `useTool` フックの統治が効く)。内側の claude は道具を持たない。
 *
 * **構造化提出はテキスト応答より入力が重い**(StructuredOutput の定義が載るため)。
 * ツール定義そのものもこちらの system prompt に載るので、その分だけ上乗せになる。
 */

import type {
  AssistantMessage,
  Model,
  Context as PiContext,
  Provider,
  StreamOptions,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai"
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai"
import { Effect } from "effect"
import { describeRefusal } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { isRefusal, run } from "../runtime.ts"
import { AUTONOMOUS_ROLE, Governance, type Lane } from "../services/Governance.ts"
import { Ledger } from "../services/Ledger.ts"
import { ClaudeCliError, callClaude, poolForModel, RUNTIME_PROMPT, resolveClaudeBin } from "./claude-cli.ts"

export const CLAUDE_MAX_PROVIDER_ID = "claude-max"
const API = "claude-cli"

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function model(id: string, name: string, contextWindow: number, maxTokens: number): Model<typeof API> {
  return {
    id,
    name,
    api: API,
    provider: CLAUDE_MAX_PROVIDER_ID,
    baseUrl: "cli://claude",
    reasoning: true,
    input: ["text"],
    // **定額枠なので限界費用は 0**。ここに単価を書くと Flue/pi の会計が「使うほど金が減る」表示になり、
    // 実際に減るのは窓なのに金額を見て判断することになる。会計は src/services/Ledger.ts が持つ。
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
  }
}

/**
 * GPT 側は **rmod 経由**。rmod は Anthropic Messages API を話す局所プロキシで、
 * `claude` の CLI 面をそのまま出しながら中身を OpenAI Responses API に差し替える。
 * つまりこちらは**アダプタを1本も書かなくていい** — `OPEN_ZERO_CLAUDE_BIN=~/.local/bin/rmod`
 * を立てて、モデル id をここに載せるだけで claude-cli.ts がそのまま通る
 * (`--json-schema` による構造化出力も含めて)。
 *
 * 認証は ChatGPT の OAuth(`~/.codex/auth.json`、auth_mode=chatgpt)。API キーではないので
 * 限界費用 0 の前提は Claude 側と変わらない。ただし**枠は別**で、`quotaCooldown` が見ているのは
 * Claude の使用率だけ。GPT 側を焚いても今のところ統治には映らない。
 */
const GPT_CONTEXT = 272_000

const MODELS: readonly Model<typeof API>[] = [
  model("claude-opus-5", "Claude Opus 5 (subscription)", 200_000, 64_000),
  model("claude-sonnet-5", "Claude Sonnet 5 (subscription)", 200_000, 64_000),
  model("claude-fable-5", "Claude Fable 5 (subscription)", 200_000, 64_000),
  model("claude-haiku-4-5", "Claude Haiku 4.5 (subscription)", 200_000, 32_000),
  model("gpt-5.6-sol", "GPT-5.6 Sol (ChatGPT, via rmod)", GPT_CONTEXT, 64_000),
  model("gpt-5.6-terra", "GPT-5.6 Terra (ChatGPT, via rmod)", GPT_CONTEXT, 64_000),
  model("gpt-5.6-luna", "GPT-5.6 Luna (ChatGPT, via rmod)", GPT_CONTEXT, 32_000),
  // `-web` は**外を見に行ける経路**(rmod のサーバ側 web_search)。上流に渡る id は接尾辞を外したもので、
  // 台帳にはこの id のまま残る — 外に出た呼び出しを後から数えるための印(claude-cli.ts の isWebModel)。
  model("gpt-5.6-luna-web", "GPT-5.6 Luna + web 検索 (via rmod)", GPT_CONTEXT, 32_000),
  model("gpt-5.6-sol-web", "GPT-5.6 Sol + web 検索 (via rmod)", GPT_CONTEXT, 64_000),
]

/** ツール呼び出しの提出スキーマ。`arguments` は自由形なので中身は Pi 側の Tool schema が検査する。 */
const TOOL_PROTOCOL_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "利用者に見せる文。ツールを呼ぶ場合はその理由を一言。" },
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

/** 会話履歴を1本のテキストに畳む。`claude -p` は prompt を1つしか取らないため。 */
function renderPrompt(context: PiContext): string {
  const parts: string[] = []
  for (const m of context.messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.map(textOf).join("")
      parts.push(`## 利用者\n${text}`)
    } else if (m.role === "assistant") {
      const text = m.content.map(textOf).join("")
      const calls = m.content.filter((c): c is ToolCall => c.type === "toolCall")
      const lines = [text.trim(), ...calls.map((c) => `→ ${c.name}(${JSON.stringify(c.arguments)}) を呼んだ`)]
      parts.push(`## あなた(前のターン)\n${lines.filter(Boolean).join("\n")}`)
    } else {
      const text = m.content.map(textOf).join("")
      parts.push(`## ツール結果 (${m.toolName}${m.isError ? " / 失敗" : ""})\n${text}`)
    }
  }
  return parts.join("\n\n")
}

function textOf(c: { type: string; text?: string }): string {
  return c.type === "text" ? (c.text ?? "") : ""
}

function toolInstruction(context: PiContext): string {
  const tools = context.tools ?? []
  if (tools.length === 0) return ""
  const list = tools
    .map((t) => `- \`${t.name}\`: ${t.description}\n  引数スキーマ: ${JSON.stringify(t.parameters)}`)
    .join("\n")
  return [
    "",
    // **見出しを「ツール」にしない。** 内側の claude はツール一覧を「今この場で呼べるもの」と読み、
    // ネイティブに呼びに行って CLI に `No such tool available` で弾かれ、そこで「使えない」と
    // 結論して toolCalls を空のまま返す。呼び方が1つしかないことを見出しの側で先に言う。
    "## 提出できる依頼(**ツールではない**)",
    list,
    "",
    "呼び出し方はひとつだけ: 構造化出力の `toolCalls` に `{name, arguments}` を書いて**提出**する。",
    "実行するのは呼び出し側で、結果は次のターンに「ツール結果」として返る。**あなた自身は実行できない。**",
    "要らなければ `toolCalls` を空配列にして `text` だけ返す。",
    "",
    "**この場に実行系のツールは1つも無い。** 上の名前をツールとして呼ぼうとすると",
    "`No such tool available` で弾かれる。弾かれても「使えない」と結論しない — 提出していないだけ。",
    // ツールを封じても CLI の前置きは消えないので、素で訊けば Read / Edit / Write が並ぶ。
    "実行系が Read / Edit / Write / Glob / Grep / Bash のような一覧を見せることがあるが、**それは幻**で、",
    "この経路では1つも動かない。MCP・ファイル・カレンダーも最初から無い。",
    "上に載っているものについて「使えない」「載っていない」「権限が無い」とは書かない。",
    "呼んでいないものを呼んだと書かない。結果は次のターンにしか返らない。",
  ].join("\n")
}

/**
 * 提出されたツール名を実在のツールに寄せる。
 * 自由記述のスキーマなので `budget ` のような揺れが混ざる。名前が1文字違うだけで
 * 「そんなツールは無い」と返り、モデルは「接続されていない」と誤診する。
 * 完全一致 → 前後空白除去 → 大文字小文字無視、まで寄せて、それでも無ければ原文のまま返す
 * (存在しないツールを黙って別のツールに読み替えるのは、直すより悪い)。
 */
function normalizeToolName(raw: string | undefined, context: PiContext): string {
  const name = (raw ?? "").trim()
  if (name.length === 0) return ""
  const names = (context.tools ?? []).map((t) => t.name)
  if (names.includes(name)) return name
  const ci = names.find((n) => n.toLowerCase() === name.toLowerCase())
  return ci ?? name
}

/**
 * 取り直すか。**言い方だけに頼らない**ための歯止め。
 *
 * 内側の claude が提出用の名前をネイティブに呼んで CLI に弾かれ、そのまま「使えなかった」と
 * 手ぶらで戻ってくることがある。
 * 判定に使うのは CLI が流した tool_use_error だけで、応答の文面は読まない —
 * 「ツールが無い」と書いてあるかどうかで決めると、正しく諦めた回まで焚き直す。
 */
export function needsResubmit(
  hasTools: boolean,
  nativeToolAttempt: boolean | undefined,
  calls: number,
): boolean {
  return hasTools && nativeToolAttempt === true && calls === 0
}

/** 取り直しのときだけ足す一行。**道具ではなく呼び方の問題だと名指しする。** */
const RESUBMIT_HINT = `
直前の試行で、上の名前をネイティブのツールとして呼んで \`No such tool available\` に弾かれている。
**道具が無いのではなく、呼び方が違う。** 今回は必ず \`toolCalls\` に \`{name, arguments}\` を書いて提出する。
「使えない」と書いて終わらせない。`

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { ...ZERO_COST, total: 0 },
  }
}

/**
 * この経路がどちらの枠を食うか。**プロセス単位で決まる**。
 * 心拍(src/tick.ts)は systemd から別プロセスで起きるので、環境変数で仕切るのが素直で嘘が無い
 * (1プロセスの中で対話と自走が混ざることがない、という事実をそのまま型ではなく配置で表している)。
 */
// **読み込み時ではなく呼び出し時に見る**。const にすると import の順序が意味を持ってしまい、
// 「tick.ts が env を立てる前に provider.ts が評価されていたので対話枠を食っていた」が起きる。
export const lane = (): Lane => (process.env.OPEN_ZERO_LANE === "autonomous" ? "autonomous" : "interactive")

/** この経路の ledger.role。`role IS NOT NULL` が日次 run 数の数え上げ対象なので必ず入れる。 */
const flueRole = (): string => (lane() === "autonomous" ? AUTONOMOUS_ROLE : "dialogue")

/**
 * モデルを呼ぶ前のゲート。**フックではなくここに置くのが要点**。
 * `useAgentStart` は submission ごとに1回しか走らないので、道具ループで何度モデルを呼んでも
 * 検査は最初の1回きりになる。枠を実際に消費するのは1回1回の呼び出しなので、
 * 「ゲートを通さずにモデルへ届く道を作らない」を満たすにはこの位置しかない。
 */
async function gate(model: string): Promise<void> {
  const refusal = await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      yield* gov.precheck({
        meter: "quota",
        // **pool はモデルで決まる**(GPT を焚いても Claude の窓は閉じない、逆も)。
        pool: poolForModel(model),
        model,
        at: nowIso(),
        nowMs: Date.now(),
        lane: lane(),
      })
      return undefined
    }).pipe(Effect.catchAll((e) => Effect.succeed(e))),
  )
  if (refusal === undefined) return
  throw new Error(isRefusal(refusal) ? describeRefusal(refusal) : `${refusal._tag}: ${refusal.message}`)
}

/**
 * 会計と枠記帳。**Flue 経路と Runner 経路が同じ台帳に載る**ようにしてある。
 * ここを飛ばすと ledger が空のままになり、日次 run 数の歯止め(ledger を数える)が永久に効かない。
 * 記帳の失敗で応答そのものを落とすのは割に合わないので、失敗は握って進む。
 */
async function account(model: string, result: Awaited<ReturnType<typeof callClaude>>): Promise<void> {
  const at = nowIso()
  await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      const ledger = yield* Ledger
      if (result.quota) yield* gov.noteQuota(result.quota, at, Date.now())
      yield* ledger.record({
        kind: "turn",
        role: flueRole(),
        model,
        meter: "quota",
        usage: {
          inTok: result.usage.inTok,
          outTok: result.usage.outTok,
          cacheRead: result.usage.cacheRead,
          cacheWrite: result.usage.cacheWrite,
          usd: 0, // 定額枠。影の値段は provenance にだけ残す。
        },
        summary: result.text.slice(0, 200),
        provenance: { pool: poolForModel(model), notionalUsd: result.usage.notionalUsd, via: "flue" },
        at,
      })
    }).pipe(Effect.catchAll(() => Effect.void)),
  )
}

/** 失敗しても枠シグナルが取れていれば冷やす。冷やさないと閉じた窓を毎ターン叩いて捨てる。 */
async function noteFailure(e: unknown): Promise<void> {
  if (!(e instanceof ClaudeCliError) || !e.quota) return
  const at = nowIso()
  const quota = e.quota
  await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      yield* gov.noteQuota(quota, at, Date.now())
    }).pipe(Effect.catchAll(() => Effect.void)),
  )
}

/**
 * `claude -p` を pi-ai の stream 契約に翻訳する。
 * CLI は完了してから result を返すため、テキストは `--include-partial-messages` の
 * `content_block_delta` を text_delta として流し、ツール呼び出しは最後にまとめて出す。
 */
function stream(m: Model<string>, context: PiContext, options?: StreamOptions) {
  const events = createAssistantMessageEventStream()
  if (process.env.OZ_DEBUG)
    console.error(
      "[oz] stream()",
      m.id,
      "tools=",
      (context.tools ?? []).map((t) => t.name).join(","),
      "msgs=",
      context.messages.length,
    )
  const hasTools = (context.tools?.length ?? 0) > 0

  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: API,
    provider: CLAUDE_MAX_PROVIDER_ID,
    model: m.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  } as AssistantMessage

  const systemPrompt = [context.systemPrompt ?? RUNTIME_PROMPT, toolInstruction(context)]
    .filter(Boolean)
    .join("\n")

  void (async () => {
    events.push({ type: "start", partial })
    let textIndex = -1
    let acc = ""

    const openText = () => {
      if (textIndex >= 0) return
      textIndex = partial.content.length
      partial.content.push({ type: "text", text: "" })
      events.push({ type: "text_start", contentIndex: textIndex, partial })
    }

    try {
      // ゲート。halt / 枠クールダウン / 日次 run 数を通らないとここから先に行けない。
      await gate(m.id)

      const call = async (system: string) => {
        const r = await callClaude({
          prompt: renderPrompt(context),
          model: m.id,
          systemPrompt: system,
          ...(hasTools ? { jsonSchema: TOOL_PROTOCOL_SCHEMA } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          // 構造化経路では逐次テキストがプロトコル JSON なので流さない。
          ...(hasTools
            ? {}
            : {
                onText: (delta: string) => {
                  openText()
                  acc += delta
                  const block = partial.content[textIndex]
                  if (block?.type === "text") block.text = acc
                  events.push({ type: "text_delta", contentIndex: textIndex, delta, partial })
                },
              }),
        })
        // 会計・枠記帳。1回のモデル呼び出しにつき1行(取り直した分も別行で残す)。
        await account(m.id, r)
        return r
      }

      let result = await call(systemPrompt)
      const asReply = (r: typeof result): ToolProtocolReply =>
        hasTools
          ? ((r.structured as ToolProtocolReply | undefined) ?? { text: r.text, toolCalls: [] })
          : { text: r.text, toolCalls: [] }

      if (needsResubmit(hasTools, result.nativeToolAttempt, (asReply(result).toolCalls ?? []).length)) {
        if (process.env.OZ_DEBUG) console.error("[oz] ネイティブ呼び出しで弾かれた。取り直す:", m.id)
        result = await call(`${systemPrompt}\n${RESUBMIT_HINT}`)
      }

      const reply = asReply(result)

      const finalText = reply.text ?? ""
      if (finalText || textIndex >= 0) {
        const streamed = textIndex >= 0
        openText()
        const text = finalText || acc
        const block = partial.content[textIndex]
        if (block?.type === "text") block.text = text
        // 構造化経路では逐次配信をしていないので、ここで全文を1回の delta として流す。
        // 消費側(Flue の会話記録)は delta を積んで返信本文を作るため、delta を出さないと本文が空になる。
        if (!streamed && text) {
          events.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial })
        }
        events.push({ type: "text_end", contentIndex: textIndex, content: text, partial })
      }

      const calls = (reply.toolCalls ?? [])
        .map((c) => ({ ...c, name: normalizeToolName(c.name, context) }))
        .filter((c) => c.name.length > 0)
      for (const [n, c] of calls.entries()) {
        const contentIndex = partial.content.length
        const toolCall: ToolCall = {
          type: "toolCall",
          // CLI は tool_use_id を返さないので、こちらで安定な id を振る。
          id: `oz_${result.model}_${Date.now()}_${n}`,
          name: c.name,
          arguments: c.arguments ?? {},
        }
        partial.content.push(toolCall)
        events.push({ type: "toolcall_start", contentIndex, partial })
        events.push({ type: "toolcall_end", contentIndex, toolCall, partial })
      }

      const u = result.usage
      partial.usage = {
        input: u.inTok,
        output: u.outTok,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        totalTokens: u.inTok + u.outTok + u.cacheRead + u.cacheWrite,
        // 定額枠なので 0。影の値段(`total_cost_usd`)は Ledger 側の provenance に残す。
        cost: { ...ZERO_COST, total: 0 },
      }
      partial.stopReason = calls.length > 0 ? "toolUse" : "stop"
      events.push({ type: "done", reason: partial.stopReason, message: partial })
      events.end(partial)
    } catch (e) {
      await noteFailure(e)
      partial.stopReason = "error"
      partial.errorMessage = e instanceof Error ? e.message : String(e)
      if (process.env.OZ_DEBUG) console.error("[oz] stream error:", partial.errorMessage)
      events.push({ type: "error", reason: "error", error: partial })
      events.end(partial)
    }
  })()

  return events
}

/**
 * Flue に差す Provider。`setProvider(claudeMaxProvider())` して
 * `useModel('claude-max/claude-opus-5')` で使う。
 */
export function claudeMaxProvider(): Provider<typeof API> {
  return createProvider<typeof API>({
    id: CLAUDE_MAX_PROVIDER_ID,
    name: "Claude Max (claude CLI)",
    models: MODELS,
    auth: {
      apiKey: {
        name: "claude CLI (subscription)",
        // 鍵は要らない。**「設定済みか」= `claude` が居るか**だけを報告する。
        // ここで undefined を返すと Flue 側が「未設定」と判定する。
        resolve: async () =>
          resolveClaudeBin() ? { auth: {}, source: "claude CLI (~/.claude)" } : undefined,
        check: async () => (resolveClaudeBin() ? { type: "api_key", source: "claude CLI" } : undefined),
      },
    },
    api: { stream, streamSimple: stream },
  })
}
