/**
 * モデル呼び出しに統治を掛ける層。**モデルの実体とは別に置く。**
 *
 * 掛けるのは3つ:
 *   1. 呼ぶ前のゲート(halt / 枠クールダウン / 日次 run 数)
 *   2. 枠シグナルの計上(閉じた窓を毎ターン叩かないため)
 *   3. 会計(ledger。日次 run 数の歯止めがこれを数える)
 *
 * **フックではなく middleware に置くのが要点。** 道具ループは1回の submission で何度も
 * モデルを呼ぶので、「開始時に1回」の位置に置くと検査は最初の1回きりになる。
 * 枠を実際に消費するのは1回1回の呼び出しなので、ゲートを通さずにモデルへ届く道を作らないには
 * `wrapGenerate` の位置しかない。
 *
 * src/model/Runner.ts が同じ順序(precheck → 実行 → 枠 → 会計)を Effect で持っている。
 * こちらは AI SDK の道具ループから呼ばれる側で、**同じ DB の同じ表に載る**。
 */

import type { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider"
import { wrapLanguageModel } from "ai"
import * as Effect from "effect/Effect"
import { describeRefusal } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { isRefusal, run } from "../runtime.ts"
import { AUTONOMOUS_ROLE, Governance, type Lane } from "../services/Governance.ts"
import { Ledger } from "../services/Ledger.ts"
import { ClaudeCliError, poolForModel, type QuotaSignal } from "./claude-cli.ts"
import { claudeCliModel, PROVIDER_META } from "./language-model.ts"
import { traceOf } from "./trace.ts"

/**
 * この経路がどちらの枠を食うか。**プロセス単位で決まる**。
 * tick(src/tick.ts)は systemd から別プロセスで起きるので、環境変数で仕切るのが素直で嘘が無い
 * (1プロセスの中で対話と自走が混ざることがない、という事実をそのまま型ではなく配置で表している)。
 *
 * **読み込み時ではなく呼び出し時に見る。** const にすると import の順序が意味を持ってしまい、
 * 「tick.ts が env を立てる前に評価されていたので対話枠を食っていた」が起きる。
 */
export const lane = (): Lane => (process.env.OPEN_ZERO_LANE === "autonomous" ? "autonomous" : "interactive")

/** この経路の ledger.role。`role IS NOT NULL` が日次 run 数の数え上げ対象なので必ず入れる。 */
const laneRole = (): string => (lane() === "autonomous" ? AUTONOMOUS_ROLE : "dialogue")

/** 呼ぶ前のゲート。拒否は Error にして投げる — 道具ループの外まで理由付きで出る。 */
async function gate(model: string): Promise<void> {
  const refusal = await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      yield* gov.precheck({
        meter: "quota",
        // **pool はモデルで決まる**(GPT を回しても Claude の窓は閉じない、逆も)。
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

/** `providerMetadata` に載せた枠シグナルを型のある形に戻す。落ちても止めない。 */
function readQuota(meta: unknown): QuotaSignal | undefined {
  if (typeof meta !== "object" || meta === null) return undefined
  const q = (meta as { quota?: unknown }).quota
  if (typeof q !== "object" || q === null) return undefined
  const o = q as Record<string, unknown>
  if (typeof o.pool !== "string" || typeof o.window !== "string") return undefined
  return {
    pool: o.pool,
    window: o.window,
    ...(typeof o.usedPercent === "number" ? { usedPercent: o.usedPercent } : {}),
    ...(typeof o.resetsAtMs === "number" ? { resetsAtMs: o.resetsAtMs } : {}),
    ...(typeof o.exhausted === "boolean" ? { exhausted: o.exhausted } : {}),
  }
}

/**
 * 会計と枠の計上。**この経路と Runner 経路が同じ DB に載る**ようにしてある。
 * ここを飛ばすと ledger が空のままになり、日次 run 数の歯止め(ledger を数える)が永久に効かない。
 * 記録の失敗で応答そのものを落とすのは割に合わないので、失敗は握って進む。
 */
async function account(
  model: string,
  usage: { inTok: number; outTok: number; cacheRead: number; cacheWrite: number },
  text: string,
  notionalUsd: number,
  quota: QuotaSignal | undefined,
): Promise<void> {
  const at = nowIso()
  await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      const ledger = yield* Ledger
      if (quota) yield* gov.noteQuota(quota, at, Date.now())
      yield* ledger.record({
        kind: "turn",
        role: laneRole(),
        model,
        meter: "quota",
        usage: { ...usage, usd: 0 }, // 定額枠。影の値段は provenance にだけ残す。
        summary: traceOf(text),
        provenance: { pool: poolForModel(model), notionalUsd, via: "agent" },
        at,
      })
    }).pipe(Effect.catchAll(() => Effect.void)),
  )
}

/** 失敗しても枠シグナルが取れていれば冷やす。冷やさないと閉じた窓を毎ターン叩いて捨てる。 */
async function noteFailure(e: unknown): Promise<void> {
  if (!(e instanceof ClaudeCliError) || !e.quota) return
  const quota = e.quota
  const at = nowIso()
  await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      yield* gov.noteQuota(quota, at, Date.now())
    }).pipe(Effect.catchAll(() => Effect.void)),
  )
}

/** ゲート → 実行 → 枠 → 会計。**この順以外でモデルへ届く道を作らない。** */
export function governance(): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate, model }) {
      await gate(model.modelId)
      let result: Awaited<ReturnType<typeof doGenerate>>
      try {
        result = await doGenerate()
      } catch (e) {
        await noteFailure(e)
        throw e
      }
      const meta = result.providerMetadata?.[PROVIDER_META]
      const u = result.usage
      await account(
        model.modelId,
        {
          inTok: u.inputTokens.noCache ?? 0,
          outTok: u.outputTokens.total ?? 0,
          cacheRead: u.inputTokens.cacheRead ?? 0,
          cacheWrite: u.inputTokens.cacheWrite ?? 0,
        },
        result.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
        typeof meta?.notionalUsd === "number" ? meta.notionalUsd : 0,
        readQuota(meta),
      )
      return result
    },
  }
}

/**
 * 統治つきのモデル。**エージェントに差すのはこれだけ**。
 * 素の `claudeCliModel` を直接使う経路を作らない — ゲートを通らずに枠が減る。
 */
export function claudeMax(modelId: string): LanguageModelV4 {
  return wrapLanguageModel({ model: claudeCliModel(modelId), middleware: governance() })
}
