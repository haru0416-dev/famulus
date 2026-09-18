/**
 * owner 入力への cycle 応答が完了した回に、主処理が保存しなかった確定値(belief)を補完する。dream も同じ判定を使う。
 * モデルが belief を書く経路は引用照合を通すここだけ。判定対象はユーザーの入力に限る。
 * belief は後の回が無検査で使うので、外部取得データを入れると取得した文が事実として DB に入る。
 */
import * as Effect from "effect/Effect"
import * as v from "valibot"
import { causeReason } from "../core/errors.ts"
import { profileRefForModel, resultContractRef } from "../model/kernel-spec.ts"
import { Runner } from "../model/Runner.ts"
import { rs } from "../model/schema.ts"
import {
  ExecutionKernel,
  type ExecutionOwnerRef,
  type KernelLoopContext,
} from "../services/ExecutionKernel.ts"
import { Memory } from "../services/Memory.ts"

/** 保存した値は無検査で使われるので少なく抑える。 */
const KEEP_MAX = 3

/** 回の終了処理なので、超えたら次の回に回す。 */
export const KEEP_MS = 45_000

export const KEEPER_SYSTEM = `あなたは記録を確定させる役です。ユーザーとのやり取りが1回終わったところで、
**そこで確かめられた値**を確定値として保存するかどうかだけを決めます。文章は書きません。

確定値として保存してよいのは、**ユーザーが言ったこと**に限ります。以下は保存しません:
- あなた(または過去のあなた)の推測・要約・言い換え
- 外から取得したもの(web・メールの中身)
- 「〜かもしれない」「〜のはず」— ユーザーが確言していないもの
- 一度きりの出来事の実況(「いま出かける」)。**次に参照して意味を持つ値**だけを保存します

境界は**確言か推測か**であって、現在か未来かではありません。「4月から移る**ことになった**」のような
決まった予定、「通知は Discord だけでいい」のような明言された好み・設定は保存対象です。
迷ったら: その値を次の回に前提として使ってユーザーが驚くなら保存しない、驚かないなら保存します。

保存するものには、ユーザーの発言からそのまま写した一節を付けます。**写せないなら保存しません。**
言い換えた引用はコード側で除外されるので、付けても保存されません。

slot は既存のものがあればそれに合わせます(同じ事柄に別名を作ると、後で引けなくなる)。
無ければ \`領域.項目\` の形で新しく作ります。値が変わったのなら、**同じ slot に新しい値**を
保存してください — 上書きではなく区間が継がれます。

\`validFrom\` は**その値がいつ真になったか**で、いま記録した時刻ではありません。
「先月から」と言われたなら先月です。分からなければ空にします。

**何も保存しない回もあります。** ただしそれは「特に無かった」ではなく、
**見て、どれも条件に足りなかった**という結論です。何を見て何が足りなかったかを \`looked\` に書きます。`

export const KEEPER_SCHEMA = rs(
  v.object({
    looked: v.pipe(
      v.string(),
      v.description(
        "何を見て、どう判断したか。一行。保存対象が無いなら、足りなかったもの(引用が写せない/確言していない/次に参照して意味を持たない)を名指す。",
      ),
    ),
    values: v.pipe(
      v.array(
        v.object({
          slot: v.pipe(
            v.string(),
            v.description("`領域.項目` の形(例: dentist.next_appt)。既存の slot があればそれに合わせる。"),
          ),
          value: v.pipe(v.string(), v.description("確定する値。後から読んで意味が通る一文にする。")),
          quote: v.pipe(
            v.string(),
            v.description("根拠。ユーザーの発言からそのまま写した一節。要約や言い換えにしない。"),
          ),
          validFrom: v.optional(
            v.pipe(v.string(), v.description("その値がいつ真になったか(IsoUtc)。分からなければ書かない。")),
          ),
          reason: v.optional(v.pipe(v.string(), v.description("既存の値を置き換えるなら、なぜ変わったか。"))),
        }),
      ),
      v.maxLength(KEEP_MAX),
      v.description(`確定値として保存するもの。無ければ空。多くて ${KEEP_MAX} 件。`),
    ),
  }),
)

export interface KeptValue {
  readonly slot: string
  readonly value: string
  readonly quote: string
  readonly validFrom?: string
  readonly reason?: string
}

interface EvidenceSource {
  readonly id: string
  readonly text: string
}

/** 写すときに改行や字下げが変わることがある。 */
const bare = (s: string): string => s.replace(/\s/g, "")

/**
 * 「ユーザーが言ったことだけ」はプロンプトの指示では守られないので、コードで除外する。
 * 漏れると後の回が無検査で使う確定値になる。
 */
export const keepGrounded = (values: readonly KeptValue[] | undefined, material: string): KeptValue[] => {
  const hay = bare(material)
  const seen = new Set<string>()
  return (values ?? [])
    .filter((v) => {
      const q = bare(v.quote ?? "")
      // 短すぎる引用はどこにでも一致する。
      if (q.length < 4 || !hay.includes(q)) return false
      // 同じ slot を1回で2度保存すると、同じ時刻に始まる区間が2本できる。
      if (seen.has(v.slot)) return false
      seen.add(v.slot)
      return true
    })
    .slice(0, KEEP_MAX)
}

/**
 * 失敗しても回全体は失敗させない。戻り値は cycle の記録に添える1行で、分岐には使わない
 * (keeper の失敗で返信や既読位置が変わると、原因の箇所が分からなくなる)。
 */
export const keep = (opts: {
  material: string
  evidence?: readonly EvidenceSource[]
  since?: string
  signal?: AbortSignal
  /** dream が「1回ぶんではない」と書けるようにする。 */
  header?: string
  label?: string
  /** 対象期間が1回ぶんでないときに、何を数えてよいかを書き足す。 */
  extraSystem?: string
  /** 指定された回だけExecutionRootへ載せる。移行中の互換経路では省略する。 */
  executionOwner?: ExecutionOwnerRef
}) =>
  Effect.gen(function* () {
    const runner = yield* Runner
    const mem = yield* Memory
    const kernel = yield* ExecutionKernel
    const tag = opts.label ?? "keeper"
    if (bare(opts.material).length === 0) return `${tag}: 判定対象が無い(ユーザーの発言がこの回に無い)`

    // 別名を作らせないため既存の slot を見せる。同じ事柄が2つの名前で入ると、どちらを引いても片方しか出ない。
    const slots = yield* mem.currentBeliefs(40)
    const known =
      slots.length === 0
        ? "(まだ1つも無い)"
        : slots.map((s) => `- ${s.slot} = ${JSON.stringify(s.value)}`).join("\n")

    // この回で既に確定した slot には触らない。触ると主処理が書いた値の言い換えが数十秒後に足され、
    // 有効期間1分未満の履歴行が増え続ける。
    const since = opts.since
    const already = new Set(
      since === undefined ? [] : slots.filter((s) => s.updatedAt >= since).map((s) => s.slot),
    )

    let execution: KernelLoopContext | undefined
    if (opts.executionOwner) {
      const plan = runner.plan("structurer")
      execution = yield* kernel.openSingleLoop({
        owner: opts.executionOwner,
        stableSlot: "keeper",
        role: "structurer",
        profile: profileRefForModel(plan.model),
        resultContract: resultContractRef("keeper-v1", KEEPER_SCHEMA),
        taskInput: {
          material: opts.material,
          known,
          header: opts.header ?? "この回のユーザーの発言",
          extraSystem: opts.extraSystem ?? null,
        },
        deadlineAtMs: Date.now() + KEEP_MS,
        budget: { modelCalls: 1, toolCalls: 0, tokens: 100_000, costMicrousd: 5_000_000 },
        modelTokenAllowance: 100_000,
        modelCostAllowanceMicrousd: 5_000_000,
      })
    }

    const out = yield* Effect.result(
      runner.run({
        role: "structurer",
        kind: "keep",
        systemPrompt: opts.extraSystem ? `${KEEPER_SYSTEM}\n\n${opts.extraSystem}` : KEEPER_SYSTEM,
        prompt: `## いま DB にある確定値\n${known}\n\n## ${opts.header ?? "この回のユーザーの発言"}\n${opts.material}`,
        schema: KEEPER_SCHEMA,
        ...(execution ? { execution } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    )
    if (out._tag === "Failure") {
      if (execution) yield* kernel.finishLoop(execution, "failed").pipe(Effect.ignore)
      return `${tag}: 呼べなかった(${causeReason(out.failure)})`
    }

    const res = out.success.structured as { looked: string; values: KeptValue[] }
    const grounded = keepGrounded(res.values, opts.material)
    const novel = grounded.filter((v) => !already.has(v.slot))
    const kept = novel.flatMap((value) => {
      const quote = bare(value.quote)
      const evidenceEventId = opts.evidence?.find((e) => bare(e.text).includes(quote))?.id
      return evidenceEventId === undefined ? [] : [{ value, evidenceEventId }]
    })
    const dropped = (res.values?.length ?? 0) - grounded.length + (novel.length - kept.length)
    const late = grounded.length - novel.length
    for (const { value: v, evidenceEventId } of kept) {
      yield* mem.recordBelief(v.slot, v.value, {
        ...(v.validFrom ? { validFrom: v.validFrom } : {}),
        ...(v.reason ? { reason: v.reason } : {}),
        evidenceEventId,
        evidenceQuote: v.quote,
      })
    }
    if (execution) yield* kernel.finishLoop(execution, "completed")
    const head =
      kept.length === 0 ? `${tag}: 保存対象は無かった` : `${tag}: ${kept.length} 件を確定値として保存`
    const body = kept.map(({ value: v }) => `${v.slot}=${v.value}`).join(" / ")
    // 引用の不一致・この回で確定済み・保存対象なしを分けて残す。混ぜるとどれが起きたか読めない。
    const tail = [
      dropped > 0 ? `(引用が判定対象に無く ${dropped} 件を除外した)` : "",
      late > 0 ? `(${late} 件はこの回で確定済み)` : "",
    ]
      .filter(Boolean)
      .join("")
    return [head, body, tail, res.looked ? `— ${res.looked}` : ""].filter(Boolean).join(" ")
  })
