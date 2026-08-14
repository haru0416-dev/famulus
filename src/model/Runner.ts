/**
 * 構造化処理用の推論入口。precheck → 実行 → クォータ状態の更新 → 会計をまとめる。
 * AI SDK Agent 経路は src/model/governed.ts が同じ順序を middleware で実装する。
 * Layer が差し替え点なので、テストは `RunnerStub` を積むだけで API キーも `claude` バイナリも要らない。
 *
 * 役割→モデルは静的表。LLM にモデル選択と課金経路を開かない。
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { DailyRunLimit, DbFailed, Halt, QuotaCooldown, UnpricedModel } from "../core/errors.ts"
import { RunnerFailed } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { Governance, type Meter } from "../services/Governance.ts"
import { Ledger } from "../services/Ledger.ts"
import { callClaude } from "./claude-cli.ts"
import { callCodex } from "./codex-responses.ts"
import {
  assertKnownModel,
  isGptModel,
  ModelCallError,
  poolForModel,
  type QuotaSignal,
  RUNTIME_PROMPT,
} from "./models.ts"
import type { RuntimeSchema } from "./schema.ts"
import { traceOf } from "./trace.ts"

export type Role = "briefing" | "dialogue" | "structurer" | "scout" | "classify" | "reviewer"

/**
 * 役割→モデル。品質が製品そのものになる役だけ opus に置く。
 *
 * 作業系は GPT(Codex の OAuth 定額枠)へ振り分ける。減っているのは金ではなくユーザーの Claude クォータなので、
 * 量を使う役をそちらから外すと、対話用クォータが残る。ChatGPT 側も OAuth の定額クォータで、
 * `poolForModel` が別の pool に数えるため、片方を回してももう片方は止まらない。
 *
 * 現在 ROLE_MODEL を参照して呼ばれるのは `scout` / `reviewer` / `structurer`。
 * `briefing` / `dialogue` / `classify` の ROLE_MODEL エントリには呼び手がない。
 * 対話と tick 本体のモデルは createAssistant() に渡す model id で決まる。
 * ここを取り違えると「structurer を守った」つもりで、引用を写す仕事のほうを動かすことになる。
 *
 * `reviewer` は書いた側と別のモデルに置く(docs/adr/0031)。前は opus が書いて opus が読んでいた。
 * ADR 0012 が「書いた本人以外に読ませてから出す」と決めたのに、同じモデルの2回目は同じ死角を持つ。
 * 弱い読み手に渡せないのはそのままなので、下げるのではなく別の系列の同じ段に移した。
 *
 * 実測(下書き4本 × 本文2通り = 8件、docs/adr/0031): 引用を本文から一字一句写した割合は
 * opus 19/19・sol 18/18(luna は 19/24 で、写せなかった指摘はコードが落とす)。
 * 秒数は 8/8 で sol が opus より短い(中央値 24.8 秒 / 50.3 秒)。強さは測っていない。
 *
 * その `scout` が持つのは引用を原文のまま写す仕事で、引けなかった項目はコードが落とす。
 * 落ちた分は後から復元できないので、モデルを替えるときは引用の原文一致率を測ってから替える。
 */
export const ROLE_MODEL: Record<Role, string> = {
  briefing: "claude-opus-5", // 朝会執筆
  dialogue: "claude-opus-5", // 対話(声。下げない)
  // 締めの keeper(keeper)。ユーザーの発言から引用を写す仕事で、写せなかったものはコードが落とす
  // (keepGrounded)。scout と同じ性質なので同じ側に置く。ユーザーが話した回ごとに1回通るため、
  // ここを opus にすると対話と同じクォータを毎回2回消費することになる。
  structurer: "gpt-5.6-luna",
  // 下書きの精査(assistant の draft)。外に出る前の最後の検査で、書いた側とは別の系列に置く。
  // クォータも分かれる(CODEX_POOL)ので、精査に1回使っても対話用クォータは減らない。
  reviewer: "gpt-5.6-sol",
  scout: "gpt-5.6-luna", // 取り込みの構造化。引用を写す役(Intake.ingest)
  classify: "gpt-5.6-luna", // 分類(呼び手はまだ無い)
}

export interface RunPlan {
  readonly model: string
  readonly meter: Meter
  readonly pool: string
}

export interface RunnerRequest {
  /** 既知の Role、または `MODEL_IDS` に載っている生のモデル id(実験・単発用途)。 */
  readonly role: Role | (string & {})
  readonly prompt: string
  readonly systemPrompt?: string
  /** 与えると構造化応答を要求する(Claude は StructuredOutput、GPT は Responses の json_schema)。 */
  readonly schema?: RuntimeSchema<unknown>
  readonly onText?: (delta: string) => void
  readonly signal?: AbortSignal
  /** 会計の種別。既定 'run'。 */
  readonly kind?: string
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
export type RunError = RunnerFailed | Halt | QuotaCooldown | DailyRunLimit | UnpricedModel | DbFailed

export interface RunnerApi {
  readonly plan: (role: string) => RunPlan
  readonly run: (req: RunnerRequest) => Effect.Effect<RunnerResult, RunError>
}

export class Runner extends Context.Service<Runner, RunnerApi>()("Runner") {}

/**
 * precheck → run → クォータ状態の更新 → 会計 の共通処理。実行本体だけ差し替えられるようにしてある
 * (これが ClaudeCli 層と Stub 層の唯一の違い)。
 */
const makeRunner = (
  exec: (req: RunnerRequest, plan: RunPlan) => Effect.Effect<Omit<RunnerResult, "model">, RunnerFailed>,
  plan: (role: string) => RunPlan,
) =>
  Effect.gen(function* () {
    const gov = yield* Governance
    const ledger = yield* Ledger

    const run = (req: RunnerRequest) =>
      Effect.gen(function* () {
        const p = plan(req.role)
        const at = nowIso()

        // ゲート。失敗チャネルに拒否が載るので、ここを通らずに下へは行けない。
        yield* gov.precheck({ meter: p.meter, pool: p.pool, model: p.model, at, nowMs: Date.now() })

        const out = yield* exec(req, p).pipe(
          // 失敗でもクォータシグナルが取れていれば必ず再実行を抑止する。
          // 抑止しないとリセット前のクォータへ毎 run 再試行する。
          Effect.tapError((e) =>
            e.exhausted === true
              ? gov.noteQuota({ pool: p.pool, window: "unknown", exhausted: true }, at, Date.now())
              : Effect.void,
          ),
        )

        if (out.quota) yield* gov.noteQuota(out.quota, at, Date.now())

        const checked = req.schema?.validate(out.structured)

        yield* ledger.record({
          kind: req.kind ?? "run",
          role: req.role, // role を入れないと日次 run 数の上限を適用できない
          model: p.model,
          meter: p.meter,
          usage: {
            inTok: out.usage.inTok,
            outTok: out.usage.outTok,
            cacheRead: out.usage.cacheRead,
            cacheWrite: out.usage.cacheWrite,
            // 定額利用なので実費は 0。CLI が返す金額は従量課金換算額として provenance にだけ残す。
            usd: p.meter === "quota" ? 0 : out.usage.notionalUsd,
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

const defaultPlan = (role: string): RunPlan => {
  // 既知の role でなければモデル id そのものとして読む。ただし知らない id は受け付けない —
  // 通すと `claude` 側は「不明なモデル」、Codex 側は上流の 4xx で、どちらも実行開始後に失敗する。
  const model = assertKnownModel(ROLE_MODEL[role as Role] ?? role)
  return {
    model,
    // `total_cost_usd` が返ることと、それが請求であることは別。Claude Max は定額なので限界費用は 0 で、
    // 制限されるのは USD ではなく5時間単位の利用量。USD を条件にするとクォータが残っていても金額で止まる。
    meter: "quota",
    // pool は role ではなくモデルで決まる。ここを固定にしていると GPT の消費が Claude のクォータに
    // 計上され、「作業を GPT に振り分けたのに対話が止まる」が起きる。
    pool: poolForModel(model),
  }
}

/**
 * 本番の層。どちらもユーザー本人の定額クォータで、実装だけがモデルで分かれる。
 * Claude は `claude -p`、GPT は Codex の Responses を HTTP で直接(src/model/codex-responses.ts)。
 * 入出力の型は揃えてあるので、ここは呼び先を選ぶだけ。
 */
export const RunnerClaudeCli = Layer.effect(
  Runner,
  makeRunner(
    (req, p) =>
      Effect.tryPromise({
        try: (abort) =>
          (isGptModel(p.model) ? callCodex : callClaude)({
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
    defaultPlan,
  ),
)

export interface StubReply {
  readonly text: string
  readonly structured?: unknown
  readonly quota?: QuotaSignal
  /** 立てるとこの応答で失敗する(クォータ枯渇経路の検査用)。 */
  readonly fail?: string
}

/**
 * テスト用の層。API キーも `claude` バイナリも要らない。
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
        usage: { inTok: 100, outTok: 20, cacheRead: 0, cacheWrite: 0, notionalUsd: 0.001 },
        ...(reply.quota ? { quota: reply.quota } : {}),
      })
    }, defaultPlan),
  )
  return { layer, calls }
}
