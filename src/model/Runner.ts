/**
 * 構造化処理用の推論入口。precheck → 実行 → クォータ状態の更新 → 会計。AI SDK Agent 経路は
 * src/model/governed.ts が同じ順序を middleware で実装する。役割→モデルは静的表で、LLM にモデル選択と課金経路を開かない。
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { DailyRunLimit, DbFailed, Halt, QuotaCooldown } from "../core/errors.ts"
import { RunnerFailed } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import {
  ExecutionKernel,
  type KernelLoopContext,
  type ModelAttemptToken,
} from "../services/ExecutionKernel.ts"
import { accountingRole, currentLane, Governance } from "../services/Governance.ts"
import { Ledger } from "../services/Ledger.ts"
import { callCodex } from "./codex-responses.ts"
import { digestOf, profileRefForModel } from "./kernel-spec.ts"
import {
  assertKnownModel,
  ModelCallError,
  type ModelProvider,
  poolForModel,
  providerForModel,
  type QuotaSignal,
  RUNTIME_PROMPT,
} from "./models.ts"
import type { RuntimeSchema } from "./schema.ts"
import { traceOf } from "./trace.ts"
import { callXai } from "./xai-responses.ts"

const PROVIDER_CALL = { xai: callXai, codex: callCodex } satisfies Record<ModelProvider, typeof callXai>

export type Role = "structurer" | "scout" | "reviewer" | "looker"

/**
 * `structurer` と `scout` は引用を原文のまま写す。写せなかった項目はコードが落として復元できないので、
 * モデルを替えるときは引用の原文一致率を検証する。
 */
export const ROLE_MODEL: Record<Role, string> = {
  // 写せなかった引用は keepGrounded が落とす。対話ごとに通るので処理量を抑えた model に置く。
  structurer: "grok-4.3",
  // 外に出る前の最後の検査なので、書き手(grok)と別系列で強いモデルに置く。枠が逼迫したときの交代先は luna。
  reviewer: "gpt-5.6-sol",
  scout: "grok-4.3", // 引用を写す役(Intake.ingest)
  // 記述は言い換えなので確定値には昇格させない。
  looker: "grok-4.3",
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
  readonly schema?: RuntimeSchema<unknown>
  readonly onText?: (delta: string) => void
  /** 画像入力。512ピクセル未満は API が拒否する。 */
  readonly images?: readonly { readonly data: Uint8Array; readonly mediaType: string }[]
  readonly signal?: AbortSignal
  /** 未指定だと xai 経路の既定 180 秒で切られる。 */
  readonly timeoutMs?: number
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
    /** system とスキーマ定義はここに入るので、落とすと入力の大半が消える。 */
    cacheWrite: number
    notionalUsd: number
  }
  readonly quota?: QuotaSignal
}

/** クールダウン・halt・日次上限を文字列へ潰さず呼び出し側へ渡す。 */
export type RunError = RunnerFailed | Halt | QuotaCooldown | DailyRunLimit | DbFailed

export interface RunnerApi {
  readonly plan: (role: string) => RunPlan
  readonly run: (req: RunnerRequest) => Effect.Effect<RunnerResult, RunError>
}

export class Runner extends Context.Service<Runner, RunnerApi>()("Runner") {}

/** 本番層と Stub 層の違いは実行本体だけ。 */
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
        const lane = currentLane()
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
        let at = nowIso()
        const requestDigest = digestOf({
          model: p.model,
          prompt: req.prompt,
          systemPrompt: req.systemPrompt ?? RUNTIME_PROMPT,
          schema: req.schema?.jsonSchema ?? null,
          // 画像は中身まで digest に入れない。画像が違えば別リクエストと分かる程度でよい
          images: req.images?.map((i) => `${i.mediaType}:${i.data.byteLength}`) ?? null,
        })
        const replay = req.execution
          ? yield* kernel.replayModelResult(req.execution, requestDigest)
          : undefined
        let out: Omit<RunnerResult, "model">
        let attempt: ModelAttemptToken | undefined
        let replayed: Omit<RunnerResult, "model"> | undefined
        if (replay) {
          const stored = replay as Partial<RunnerResult>
          if (stored.model === p.model && typeof stored.text === "string" && stored.usage) {
            const candidate = {
              text: stored.text,
              ...(stored.structured !== undefined ? { structured: stored.structured } : {}),
              usage: stored.usage,
              ...(stored.quota ? { quota: stored.quota } : {}),
            }
            const replayChecked = req.schema?.validate(candidate.structured)
            if (!replayChecked || replayChecked.success) replayed = candidate
          }
          if (!replayed && req.execution) yield* kernel.invalidateModelResult(req.execution, requestDigest)
        }
        if (replayed) {
          out = replayed
        } else {
          // 失敗チャネルに拒否が載るので、ここを通らずに下へは行けない。
          yield* gov.precheck({ pool: p.pool, at, nowMs: Date.now(), lane })
          at = yield* gov.claimRun({ lane })

          attempt = req.execution
            ? yield* kernel
                .startModelAttempt(req.execution, requestDigest)
                .pipe(Effect.tapError(() => gov.releaseRunClaim({ at, lane })))
            : undefined
          out = yield* exec(req, p).pipe(
            // 失敗でもクォータシグナルが取れていれば再実行を抑止する。抑止しないとリセット前のクォータへ毎 run 再試行する。
            Effect.tapError((e) =>
              e.exhausted === true
                ? gov.noteQuota({ pool: p.pool, window: "unknown", exhausted: true }, at, Date.now())
                : Effect.void,
            ),
            Effect.tapError((error) =>
              attempt
                ? kernel.finishModelAttempt(attempt, {
                    outcome: "unknown",
                    ledger: {
                      kind: req.kind,
                      role: accountingRole(req.role, lane),
                      model: p.model,
                      inTok: 0,
                      outTok: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      provenance: { pool: p.pool, outcome: "unknown" },
                      at,
                    },
                  })
                : ledger.record({
                    kind: "model-failed",
                    role: accountingRole(req.role, lane),
                    model: p.model,
                    usage: { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0 },
                    summary: traceOf(error.message),
                    provenance: { pool: p.pool, outcome: "failed" },
                    at,
                  }),
            ),
          )

          if (out.quota) yield* gov.noteQuota(out.quota, at, Date.now())
        }

        const checked = req.schema?.validate(out.structured)
        const ledgerInput = {
          kind: req.kind,
          role: accountingRole(req.role, lane),
          model: p.model,
          inTok: out.usage.inTok,
          outTok: out.usage.outTok,
          cacheRead: out.usage.cacheRead,
          cacheWrite: out.usage.cacheWrite,
          summary: traceOf(out.text),
          provenance: {
            pool: p.pool,
            notionalUsd: out.usage.notionalUsd,
            ...(checked && !checked.success ? { outcome: "schema-invalid" } : {}),
          },
          at,
        }
        const tokens = out.usage.inTok + out.usage.outTok + out.usage.cacheRead + out.usage.cacheWrite
        const costMicrousd = Math.ceil(out.usage.notionalUsd * 1_000_000)

        if (attempt) {
          yield* kernel.finishModelAttempt(
            attempt,
            checked && !checked.success
              ? { outcome: "failed", tokens, costMicrousd, ledger: ledgerInput }
              : {
                  outcome: "succeeded",
                  tokens,
                  costMicrousd,
                  response: { ...out, model: p.model },
                  ledger: ledgerInput,
                },
          )
        }

        if (!req.execution)
          yield* ledger.record({
            kind: ledgerInput.kind,
            role: ledgerInput.role, // role を入れないと日次 run 数の上限を適用できない
            model: ledgerInput.model,
            usage: {
              inTok: ledgerInput.inTok,
              outTok: ledgerInput.outTok,
              cacheRead: ledgerInput.cacheRead,
              cacheWrite: ledgerInput.cacheWrite,
            },
            summary: ledgerInput.summary,
            provenance: ledgerInput.provenance,
            at: ledgerInput.at,
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
  // 知らない id は受け付けない。通すと実行開始後に上流の 4xx で失敗する。
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

/** SuperGrok の定額クォータを xAI Responses で使う。 */
export const RunnerLive = Layer.effect(
  Runner,
  makeRunner(
    (req, p) =>
      Effect.tryPromise({
        try: (abort) =>
          PROVIDER_CALL[providerForModel(p.model)]({
            prompt: req.prompt,
            model: p.model,
            systemPrompt: req.systemPrompt ?? RUNTIME_PROMPT,
            ...(req.schema !== undefined ? { jsonSchema: req.schema.jsonSchema } : {}),
            ...(req.onText ? { onText: req.onText } : {}),
            ...(req.images ? { images: req.images } : {}),
            ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
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
          usage: r.usage,
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
  /** クォータ枯渇経路の検査用。 */
  readonly fail?: string
  readonly usage?: RunnerResult["usage"]
}

/** 台本を順に返し、尽きたら最後を繰り返す。precheck・記録・クォータ抑止は本番と同じ処理を通る。 */
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
