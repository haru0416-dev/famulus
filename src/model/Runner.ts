/**
 * 構造化処理用の推論入口。precheck → 実行 → クォータ状態の更新 → 会計をまとめる。
 * AI SDK Agent 経路は src/model/governed.ts が同じ順序を middleware で実装する。
 * Layer が差し替え点なので、テストは `RunnerStub` を積むだけでOAuth資格情報は要らない。
 *
 * 役割→モデルは静的表。LLM にモデル選択と課金経路を開かない。
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { DailyRunLimit, DbFailed, Halt, QuotaCooldown } from "../core/errors.ts"
import { RunnerFailed } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { ExecutionKernel, type KernelLoopContext } from "../services/ExecutionKernel.ts"
import { Governance } from "../services/Governance.ts"
import { Ledger } from "../services/Ledger.ts"
import { callCodex } from "./codex-responses.ts"
import { digestOf, profileRefForModel } from "./kernel-spec.ts"
import { assertKnownModel, ModelCallError, poolForModel, type QuotaSignal, RUNTIME_PROMPT } from "./models.ts"
import type { RuntimeSchema } from "./schema.ts"
import { traceOf } from "./trace.ts"

export type Role = "structurer" | "scout" | "reviewer"

/**
 * 役割→モデル。全てChatGPT OAuthのGPTで、品質と処理量に応じてmodelを分ける。
 *
 * 現在 ROLE_MODEL を参照して呼ばれるのは `scout` / `reviewer` / `structurer`。
 * `briefing` / `dialogue` / `classify` の ROLE_MODEL エントリには呼び手がない。
 * 対話と cycle 本体のモデルは createAssistant() に渡す model id で決まる。
 * ここを取り違えると「structurer を守った」つもりで、引用を写す仕事のほうを動かすことになる。
 *
 * `reviewer` は引用精度を実測済みのgpt-5.6-solに置く。
 *
 * 実測(下書き4本 × 本文2通り = 8件): 引用を本文から一字一句写した割合は
 * opus 19/19・sol 18/18(luna は 19/24 で、写せなかった指摘はコードが落とす)。
 * 秒数は 8/8 で sol が opus より短い(中央値 24.8 秒 / 50.3 秒)。強さは測っていない。
 *
 * その `scout` が持つのは引用を原文のまま写す仕事で、引けなかった項目はコードが落とす。
 * 落ちた分は後から復元できないので、モデルを替えるときは引用の原文一致率を測ってから替える。
 */
export const ROLE_MODEL: Record<Role, string> = {
  // 締めの keeper(keeper)。ユーザーの発言から引用を写す仕事で、写せなかったものはコードが落とす
  // (keepGrounded)。scout と同じ性質なので同じ側に置く。ユーザーが話した回ごとに1回通るため、
  // 対話ごとに通るため、処理量を抑えたmodelに置く。
  structurer: "gpt-5.6-luna",
  // 下書きの精査(assistant の draft)。外に出る前の最後の検査で、書いた側とは別の系列に置く。
  // 既定の対話modelとは別modelに置く。
  reviewer: "gpt-5.6-sol",
  scout: "gpt-5.6-luna", // 取り込みの構造化。引用を写す役(Intake.ingest)
}

export interface RunPlan {
  readonly model: string
  readonly pool: string
}

export interface RunnerRequest {
  /** 既知の Role、または `MODEL_IDS` に載っている生のモデル id(実験・単発用途)。 */
  readonly role: Role | (string & {})
  readonly prompt: string
  readonly systemPrompt?: string
  /** 与えるとResponsesのjson_schemaによる構造化応答を要求する。 */
  readonly schema?: RuntimeSchema<unknown>
  readonly onText?: (delta: string) => void
  readonly signal?: AbortSignal
  readonly kind: string
  readonly execution?: KernelLoopContext
}

export interface RunnerResult {
  readonly text: string
  readonly structured?: unknown
  readonly model: string
  readonly usage: {
    inTok: number
    outTok: number
    cacheRead: number
    /** 初回にキャッシュへ書いた入力。system とスキーマ定義はここに入るので、落とすと入力の大半が消える。 */
    cacheWrite: number
    notionalUsd: number
  }
  readonly quota?: QuotaSignal
}

/**
 * run の型付き失敗チャネル。クールダウン、halt、日次上限などを文字列へ潰さず呼び出し側へ渡す。
 */
export type RunError = RunnerFailed | Halt | QuotaCooldown | DailyRunLimit | DbFailed

export interface RunnerApi {
  readonly plan: (role: string) => RunPlan
  readonly run: (req: RunnerRequest) => Effect.Effect<RunnerResult, RunError>
}

export class Runner extends Context.Service<Runner, RunnerApi>()("Runner") {}

/**
 * precheck → run → クォータ状態の更新 → 会計 の共通処理。実行本体だけ差し替えられるようにしてある
 * (これがCodex層とStub層の唯一の違い)。
 */
const makeRunner = (
  exec: (req: RunnerRequest, plan: RunPlan) => Effect.Effect<Omit<RunnerResult, "model">, RunnerFailed>,
  plan: (role: string) => RunPlan,
) =>
  Effect.gen(function* () {
    const gov = yield* Governance
    const ledger = yield* Ledger
    const kernel = yield* ExecutionKernel

    const run = (req: RunnerRequest) =>
      Effect.gen(function* () {
        const p = yield* Effect.try({
          try: () => plan(req.role),
          catch: (error) =>
            new RunnerFailed({
              pool: "unselected",
              message: error instanceof Error ? error.message : String(error),
            }),
        })
        if (req.execution) {
          const actualProfile = yield* Effect.try({
            try: () => profileRefForModel(p.model),
            catch: (error) => new RunnerFailed({ pool: p.pool, message: String(error) }),
          })
          if (
            actualProfile.id !== req.execution.profile.id ||
            actualProfile.generation !== req.execution.profile.generation ||
            actualProfile.digest !== req.execution.profile.digest
          )
            return yield* Effect.fail(
              new RunnerFailed({ pool: p.pool, message: "実行modelと固定済みProfileが一致しない" }),
            )
        }
        const at = nowIso()
        const requestDigest = digestOf({
          model: p.model,
          prompt: req.prompt,
          systemPrompt: req.systemPrompt ?? RUNTIME_PROMPT,
          schema: req.schema?.jsonSchema ?? null,
        })
        const replay = req.execution
          ? yield* kernel.replayModelResult(req.execution, requestDigest)
          : undefined
        let out: Omit<RunnerResult, "model">
        if (replay) {
          const stored = replay as Partial<RunnerResult>
          if (stored.model !== p.model || typeof stored.text !== "string" || !stored.usage)
            return yield* Effect.fail(new RunnerFailed({ pool: p.pool, message: "保存済みmodel応答が不正" }))
          out = {
            text: stored.text,
            ...(stored.structured !== undefined ? { structured: stored.structured } : {}),
            usage: stored.usage,
            ...(stored.quota ? { quota: stored.quota } : {}),
          }
        } else {
          // ゲート。失敗チャネルに拒否が載るので、ここを通らずに下へは行けない。
          yield* gov.precheck({ pool: p.pool, at, nowMs: Date.now() })

          const attempt = req.execution
            ? yield* kernel.startModelAttempt(req.execution, requestDigest)
            : undefined
          out = yield* exec(req, p).pipe(
            // 失敗でもクォータシグナルが取れていれば必ず再実行を抑止する。
            // 抑止しないとリセット前のクォータへ毎 run 再試行する。
            Effect.tapError((e) =>
              e.exhausted === true
                ? gov.noteQuota({ pool: p.pool, window: "unknown", exhausted: true }, at, Date.now())
                : Effect.void,
            ),
            Effect.tapError(() =>
              attempt
                ? kernel.finishModelAttempt(attempt, {
                    outcome: "unknown",
                    ledger: {
                      kind: req.kind,
                      role: req.role,
                      model: p.model,
                      inTok: 0,
                      outTok: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      provenance: { pool: p.pool, outcome: "unknown" },
                      at,
                    },
                  })
                : Effect.void,
            ),
          )

          if (attempt) {
            yield* kernel.finishModelAttempt(attempt, {
              outcome: "succeeded",
              tokens: out.usage.inTok + out.usage.outTok + out.usage.cacheRead + out.usage.cacheWrite,
              costMicrousd: Math.ceil(out.usage.notionalUsd * 1_000_000),
              response: { ...out, model: p.model },
              ledger: {
                kind: req.kind,
                role: req.role,
                model: p.model,
                inTok: out.usage.inTok,
                outTok: out.usage.outTok,
                cacheRead: out.usage.cacheRead,
                cacheWrite: out.usage.cacheWrite,
                summary: traceOf(out.text),
                provenance: { pool: p.pool, notionalUsd: out.usage.notionalUsd },
                at,
              },
            })
          }

          if (out.quota) yield* gov.noteQuota(out.quota, at, Date.now())
        }

        const checked = req.schema?.validate(out.structured)

        if (!req.execution)
          yield* ledger.record({
            kind: req.kind,
            role: req.role, // role を入れないと日次 run 数の上限を適用できない
            model: p.model,
            usage: {
              inTok: out.usage.inTok,
              outTok: out.usage.outTok,
              cacheRead: out.usage.cacheRead,
              cacheWrite: out.usage.cacheWrite,
            },
            summary: traceOf(out.text),
            provenance: { pool: p.pool, notionalUsd: out.usage.notionalUsd },
            at,
          })

        if (checked && !checked.success) {
          return yield* Effect.fail(
            new RunnerFailed({
              pool: p.pool,
              message: `構造化応答が schema に合わない: ${checked.error.message}`,
            }),
          )
        }

        return {
          ...out,
          ...(checked?.success ? { structured: checked.value } : {}),
          model: p.model,
        } as RunnerResult
      })

    return { plan, run } as RunnerApi
  })

const testPlan = (role: string): RunPlan => {
  // 既知の role でなければモデル id そのものとして読む。ただし知らない id は受け付けない —
  // 通すとCodex上流の4xxで、実行開始後に失敗する。
  const model = assertKnownModel(ROLE_MODEL[role as Role] ?? role)
  return {
    model,
    pool: poolForModel(model),
  }
}

const productionPlan = (role: string): RunPlan => {
  const model = ROLE_MODEL[role as Role]
  if (!model) throw new Error(`production Runnerは固定roleのみ受け付ける: ${role}`)
  return { model, pool: poolForModel(model) }
}

/**
 * 本番の層。ChatGPT OAuthの定額クォータをCodex Responsesで使う。
 */
export const RunnerLive = Layer.effect(
  Runner,
  makeRunner(
    (req, p) =>
      Effect.tryPromise({
        try: (abort) =>
          callCodex({
            prompt: req.prompt,
            model: p.model,
            systemPrompt: req.systemPrompt ?? RUNTIME_PROMPT,
            ...(req.schema !== undefined ? { jsonSchema: req.schema.jsonSchema } : {}),
            ...(req.onText ? { onText: req.onText } : {}),
            signal: req.signal ?? abort,
          }),
        catch: (e) =>
          new RunnerFailed({
            pool: p.pool,
            message: e instanceof Error ? e.message : String(e),
            ...(e instanceof ModelCallError && e.quota?.exhausted ? { exhausted: true } : {}),
          }),
      }).pipe(
        Effect.map((r) => ({
          text: r.text,
          ...(r.structured !== undefined ? { structured: r.structured } : {}),
          usage: {
            inTok: r.usage.inTok,
            outTok: r.usage.outTok,
            cacheRead: r.usage.cacheRead,
            cacheWrite: r.usage.cacheWrite,
            notionalUsd: r.usage.notionalUsd,
          },
          ...(r.quota ? { quota: r.quota } : {}),
        })),
      ),
    productionPlan,
  ),
)

export interface StubReply {
  readonly text: string
  readonly structured?: unknown
  readonly quota?: QuotaSignal
  /** 立てるとこの応答で失敗する(クォータ枯渇経路の検査用)。 */
  readonly fail?: string
  readonly usage?: RunnerResult["usage"]
}

/**
 * テスト用の層。OAuth資格情報は要らない。
 * 台本を順に返し、尽きたら最後を繰り返す。precheck・記録・クォータ抑止は本番と同じ処理を通るので、
 * 「ゲートが実際に判定するか」をモデルを呼ばずに端から端まで確かめられる。
 */
export const RunnerStub = (script: readonly StubReply[]) => {
  let i = 0
  const calls: RunnerRequest[] = []
  const layer = Layer.effect(
    Runner,
    makeRunner((req, p) => {
      calls.push(req)
      const reply = script[Math.min(i++, script.length - 1)] ?? { text: "" }
      if (reply.fail) {
        return Effect.fail(
          new RunnerFailed({
            pool: p.pool,
            message: reply.fail,
            ...(reply.quota?.exhausted ? { exhausted: true } : {}),
          }),
        )
      }
      return Effect.succeed({
        text: reply.text,
        ...(reply.structured !== undefined ? { structured: reply.structured } : {}),
        usage: reply.usage ?? { inTok: 100, outTok: 20, cacheRead: 0, cacheWrite: 0, notionalUsd: 0.001 },
        ...(reply.quota ? { quota: reply.quota } : {}),
      })
    }, testPlan),
  )
  return { layer, calls }
}
