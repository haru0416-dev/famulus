/**
 * モデル呼び出しに利用制限と会計を適用する層。モデルの実体とは別に置く。
 *
 * 掛けるのは3つ:
 *   1. 呼ぶ前の検査(halt / クォータ抑止 / 日次 run 数)
 *   2. クォータ状態の更新(リセット前に再試行しないため)
 *   3. 会計(ledger。日次 run 数の上限がこれを数える)
 *
 * フックではなく middleware に置く。道具ループは1回の submission で何度も
 * モデルを呼ぶので、「開始時に1回」の位置に置くと検査は最初の1回きりになる。
 * クォータを実際に消費するのは1回1回の呼び出しなので、事前検査を通さずにモデルへ届く経路を作らないには
 * `wrapGenerate` の位置しかない。
 *
 * src/model/Runner.ts が同じ順序(precheck → 実行 → クォータ状態更新 → 会計)を Effect で持っている。
 * こちらは AI SDK の道具ループから呼ばれる側で、同じ DB の同じ表に載る。
 */

import type { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider"
import { wrapLanguageModel } from "ai"
import * as Effect from "effect/Effect"
import { describeRefusal } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { isRefusal, run } from "../runtime.ts"
import { AUTONOMOUS_ROLE, Governance, type Lane } from "../services/Governance.ts"
import { Ledger } from "../services/Ledger.ts"
import { CODEX_PROVIDER_META, codexResponsesModel } from "./codex-responses.ts"
import { claudeCliModel, PROVIDER_META } from "./language-model.ts"
import { assertKnownModel, isGptModel, ModelCallError, poolForModel, type QuotaSignal } from "./models.ts"
import { traceOf } from "./trace.ts"

/**
 * この経路がどちらのクォータを消費するか。プロセス単位で決まる。
 * tick(src/tick.ts)は systemd から別プロセスで起きるので、環境変数で仕切る
 * (1プロセスの中で対話と自走が混ざることがない、という事実をそのまま配置で表している)。
 *
 * 読み込み時ではなく呼び出し時に見る。const にすると import の順序が意味を持ってしまい、
 * 「tick.ts が env を設定する前に評価されていたので対話用クォータを消費していた」が起きる。
 */
export const lane = (): Lane => (process.env.OPEN_ZERO_LANE === "autonomous" ? "autonomous" : "interactive")

/** この経路の ledger.role。`role IS NOT NULL` が日次 run 数の数え上げ対象なので必ず入れる。 */
const laneRole = (): string => (lane() === "autonomous" ? AUTONOMOUS_ROLE : "dialogue")

/** 呼ぶ前の検査。拒否は Error にして投げる — 道具ループの外まで理由付きで出る。 */
async function gate(model: string): Promise<void> {
  const refusal = await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      yield* gov.precheck({
        meter: "quota",
        // pool はモデルで決まる(GPT を回しても Claude のクォータ状態は変わらない、逆も)。
        pool: poolForModel(model),
        model,
        at: nowIso(),
        nowMs: Date.now(),
        lane: lane(),
      })
      return undefined
    }).pipe(Effect.catch((e) => Effect.succeed(e))),
  )
  if (refusal === undefined) return
  throw new Error(isRefusal(refusal) ? describeRefusal(refusal) : `${refusal._tag}: ${refusal.message}`)
}

/** `providerMetadata` に載せたクォータシグナルを型のある形に戻す。解析できなくても処理は止めない。 */
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
 * 会計とクォータ状態の更新。この経路と Runner 経路が同じ DB に載るようにしてある。
 * ここを飛ばすと ledger が空のままになり、日次 run 数の上限(ledger を数える)を適用できない。
 * 記録の失敗で応答そのものを失敗させるのは割に合わないので、記録失敗は応答へ波及させない。
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
        usage: { ...usage, usd: 0 }, // 定額利用。従量課金換算額は provenance にだけ残す。
        summary: traceOf(text),
        provenance: { pool: poolForModel(model), notionalUsd, via: "agent" },
        at,
      })
    }).pipe(Effect.catch(() => Effect.void)),
  )
}

/** 失敗してもクォータシグナルが取れていれば、リセット時刻まで再実行を抑止する。 */
async function noteFailure(e: unknown): Promise<void> {
  if (!(e instanceof ModelCallError) || !e.quota) return
  const quota = e.quota
  const at = nowIso()
  await run(
    Effect.gen(function* () {
      const gov = yield* Governance
      yield* gov.noteQuota(quota, at, Date.now())
    }).pipe(Effect.catch(() => Effect.void)),
  )
}

/** AI SDK Agent 経路で、モデル呼び出しごとに事前検査 → 実行 → クォータ状態更新 → 会計を行う。 */
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
      // 2つの経路が別の鍵で載せる。どちらも「クォータと従量課金換算額」の欄で、読む側は同じ。
      const meta = result.providerMetadata?.[PROVIDER_META] ?? result.providerMetadata?.[CODEX_PROVIDER_META]
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
 * 統治つきのモデル。エージェントに差すのはこれだけ。
 * 素の `claudeCliModel` / `codexResponsesModel` を直接使う経路を作らない —
 * 事前検査を通らずにクォータが減る。
 *
 * 実装はモデル id で分かれる。Claude は `claude -p`、GPT は Codex の Responses を HTTP で直接。
 * 統治(ゲート・クォータ・会計)はどちらも同じ middleware がこの外側で適用する。
 *
 * 知らない id はここで失敗させる。呼ばれるのはエージェントを生成するときなので、env の打ち間違いは
 * 起動時に読める理由で止まる(実行を開始してから上流の 4xx で失敗しない)。
 */
export function claudeMax(modelId: string): LanguageModelV4 {
  assertKnownModel(modelId)
  const model = isGptModel(modelId) ? codexResponsesModel(modelId) : claudeCliModel(modelId)
  return wrapLanguageModel({ model, middleware: governance() })
}
