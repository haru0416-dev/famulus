/**
 * 統治された推論の唯一の入口。precheck → 実行 → 枠の計上 → 会計 を1本にまとめる。
 *
 * governance・runner・ledger を別々に呼ぶ形にすると「ゲートを通さずに走らせる経路」が
 * 型の上で常に可能になる。ここでは Runner を通す以外にモデルへ届く道を作らない。
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
import { ClaudeCliError, callClaude, poolForModel, type QuotaSignal, RUNTIME_PROMPT } from "./claude-cli.ts"
import { traceOf } from "./trace.ts"

export type Role = "briefing" | "dialogue" | "structurer" | "scout" | "classify" | "reviewer"

/**
 * 役割→モデル。品質が製品そのものになる役だけ opus に置く。
 *
 * 作業系は GPT(rmod 経由)へ逃がす。減っているのは金ではなくユーザーの Claude の枠なので、
 * 量を使う役をそちらから外すと、対話に使える枠が残る。ChatGPT 側も OAuth の定額枠で、
 * `poolForModel` が別の pool に数えるため、片方を回してももう片方は止まらない。
 *
 * この表で今このプロセスから実際に呼ばれるのは `scout` / `reviewer` / `structurer` だけ
 * (src/services/Intake.ts の取り込み、src/agent/assistant.ts の `draft`、src/agent/keeper.ts の締め)。
 * `briefing` と `dialogue` は Flue 経路(src/model/provider.ts)を通るので、モデルは
 * `OPEN_ZERO_MODEL` / `OPEN_ZERO_TICK_MODEL` が決める。`classify` は呼び手がまだ無い。
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
  // ここを opus にすると対話と同じ枠を毎回2回叩くことになる。
  structurer: "gpt-5.6-luna",
  // 下書きの精査(assistant の draft)。外に出る前の最後の検査で、書いた側とは別の系列に置く。
  // 枠も分かれる(RMOD_POOL)ので、精査に1回使っても対話の枠は減らない。
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
  /** 既知の Role、または生のモデル id(実験・単発用途はそのまま通す)。 */
  readonly role: Role | (string & {})
  readonly prompt: string
  readonly systemPrompt?: string
  /** 与えると構造化応答を要求する(claude-cli の StructuredOutput 経路)。 */
  readonly schema?: unknown
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
 * run が失敗しうる理由の全部。呼び出し側はこれを網羅しないとコンパイルが通らない。
 * `{ ok:false, reason:string }` に潰すと「枠クールダウン(待てば戻る)」と
 * 「halt(人間の解除が要る)」の区別が呼び出し側から消える。
 */
export type RunError = RunnerFailed | Halt | QuotaCooldown | DailyRunLimit | UnpricedModel | DbFailed

export interface RunnerApi {
  readonly plan: (role: string) => RunPlan
  readonly run: (req: RunnerRequest) => Effect.Effect<RunnerResult, RunError>
}

export class Runner extends Context.Tag("Runner")<Runner, RunnerApi>() {}

/**
 * precheck → run → 枠の計上 → 会計 の共通骨格。実行本体だけ差し替えられるようにしてある
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
          // 失敗でも枠シグナルが取れていれば必ず冷やす。冷やさないと閉じた窓を毎 run 叩いて捨てる。
          Effect.tapError((e) =>
            e.exhausted === true
              ? gov.noteQuota({ pool: p.pool, window: "unknown", exhausted: true }, at, Date.now())
              : Effect.void,
          ),
        )

        if (out.quota) yield* gov.noteQuota(out.quota, at, Date.now())

        yield* ledger.record({
          kind: req.kind ?? "run",
          role: req.role, // role を入れないと日次 run 数の歯止めが効かない
          model: p.model,
          meter: p.meter,
          usage: {
            inTok: out.usage.inTok,
            outTok: out.usage.outTok,
            cacheRead: out.usage.cacheRead,
            cacheWrite: out.usage.cacheWrite,
            // 定額枠なので実費は 0。CLI が返す金額は影の値段として provenance にだけ残す。
            usd: p.meter === "quota" ? 0 : out.usage.notionalUsd,
          },
          summary: traceOf(out.text),
          provenance: { pool: p.pool, notionalUsd: out.usage.notionalUsd },
          at,
        })

        return { ...out, model: p.model } as RunnerResult
      })

    return { plan, run } as RunnerApi
  })

const defaultPlan = (role: string): RunPlan => ({
  // 未知の role は生モデル id として通す。
  model: ROLE_MODEL[role as Role] ?? role,
  // `total_cost_usd` が返ることと、それが請求であることは別。Claude Max は定額なので限界費用は 0 で、
  // 枯れるのは USD ではなく5時間窓。USD をゲートにすると窓が空いていても金額で止まる。
  meter: "quota",
  // pool は role ではなくモデルで決まる。ここを固定にしていると GPT の消費が Claude の窓に
  // 積まれ、「作業を GPT に逃がしたのに対話が止まる」が起きる。
  pool: poolForModel(ROLE_MODEL[role as Role] ?? role),
})

/** 本番の層。`claude -p` = 本人のサブスク枠。 */
export const RunnerClaudeCli = Layer.effect(
  Runner,
  makeRunner(
    (req, p) =>
      Effect.tryPromise({
        try: (abort) =>
          callClaude({
            prompt: req.prompt,
            model: p.model,
            systemPrompt: req.systemPrompt ?? RUNTIME_PROMPT,
            ...(req.schema !== undefined ? { jsonSchema: req.schema } : {}),
            ...(req.onText ? { onText: req.onText } : {}),
            signal: req.signal ?? abort,
          }),
        catch: (e) =>
          new RunnerFailed({
            pool: p.pool,
            message: e instanceof Error ? e.message : String(e),
            ...(e instanceof ClaudeCliError && e.quota?.exhausted ? { exhausted: true } : {}),
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
  /** 立てるとこの応答で失敗する(枠切れ経路の検査用)。 */
  readonly fail?: string
}

/**
 * テスト用の層。API キーも `claude` バイナリも要らない。
 * 台本を順に返し、尽きたら最後を繰り返す。precheck・記録・枠冷却は本番と同じ骨格を通るので、
 * 「ゲートが実際に効くか」をモデルを呼ばずに端から端まで確かめられる。
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
