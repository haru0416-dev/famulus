/**
 * 回の終わりに、確かめられた値を確定へ上げる役。**「何も残さない回」を正常としない。**
 *
 * DB には2つの層がある。`import`(過去の会話から起こした要約)は「その日時点でそう書かれていた」
 * という記録でしかなく、今の事実として使ってよいのは `belief` で確定した値だけ — recall の
 * 読み方がそう書いてある。ところが確定へ上げる経路は道具(`remember` の `slot`)しか無く、
 * **ユーザーが話した回にモデルがそれを呼ぶかどうかに全部かかっていた。** 呼ばれないまま流れると、
 * 行は増えるのに引ける値は増えない。実際にそうなっていた(docs/adr/0014)。
 *
 * だから道具として置かず、**回の締めに必ず1回通る経路**にしてある。Hermes Agent の
 * memory nudge(一定ターンごとに、制限した道具立ての fork で記憶を見直させる)と同じ位置付けで、
 * あちらの効いている一文 — *A pass that does nothing is a missed learning opportunity,
 * not a neutral outcome* — をそのまま持ってきている。
 *
 * **材料はユーザーの入力だけ。** 外から来たもの(web / gmail)は確定に上げない。
 * 確定値は「今の事実」として後の回に無検査で使われるので、ここを外に開くと、
 * 拾ってきた文が事実として DB に入る道ができる。引用がコード側で照合できるのも、
 * 材料をユーザーの入力に限っているから成り立つ。
 */
import { Effect } from "effect"
import { causeReason } from "../core/errors.ts"
import { Runner } from "../model/Runner.ts"
import { Memory } from "../services/Memory.ts"

/** 1回で確定に上げてよい数。**多いほど良いのではない** — 上げたものは無検査で使われる。 */
const KEEP_MAX = 3

/** この役に許す時間。締めの経路なので、待たせるくらいなら次の回に回す。 */
export const KEEP_MS = 45_000

export const KEEPER_SYSTEM = `あなたは記録を確定させる役です。ユーザーとのやり取りが1回終わったところで、
**そこで確かめられた値**を確定へ上げるかどうかだけを決めます。文章は書きません。

確定に上げてよいのは、**ユーザーが言ったこと**に限ります。以下は上げません:
- あなた(または過去のあなた)の推測・要約・言い換え
- 外から拾ってきたもの(web・メールの中身)
- 「〜かもしれない」「〜のはず」— ユーザーが確言していないもの
- 一度きりの出来事の実況(「いま出かける」)。**次に引いて意味を持つ値**だけを上げます

上げるものには、ユーザーの発言からそのまま写した一節を付けます。**写せないなら上げません。**
言い換えた引用はコード側で落とされるので、付けても消えます。

slot は既存のものがあればそれに合わせます(同じ事柄に別名を作ると、後で引けなくなる)。
無ければ \`領域.項目\` の形で新しく作ります。値が変わったのなら、**同じ slot に新しい値**を
上げてください — 上書きではなく区間が継がれます。

\`validFrom\` は**その値がいつ真になったか**で、いま記録した時刻ではありません。
「先月から」と言われたなら先月です。分からなければ空にします。

**何も上げない回もあります。** ただしそれは「特に無かった」ではなく、
**見て、どれも条件に足りなかった**という結論です。何を見て何が足りなかったかを \`looked\` に書きます。`

export const KEEPER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["looked", "values"],
  properties: {
    looked: {
      type: "string",
      description:
        "何を見て、どう判断したか。一行。上げるものが無いなら、足りなかったもの(引用が写せない/確言していない/次に引いて意味を持たない)を名指す。",
    },
    values: {
      type: "array",
      description: `確定に上げるもの。無ければ空。多くて ${KEEP_MAX} 件。`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slot", "value", "quote"],
        properties: {
          slot: {
            type: "string",
            description: "`領域.項目` の形(例: dentist.next_appt)。既存の slot があればそれに合わせる。",
          },
          value: { type: "string", description: "確定する値。後から読んで意味が通る一文にする。" },
          quote: {
            type: "string",
            description: "根拠。ユーザーの発言からそのまま写した一節。要約や言い換えにしない。",
          },
          validFrom: {
            type: "string",
            description: "その値がいつ真になったか(IsoUtc)。分からなければ書かない。",
          },
          reason: { type: "string", description: "既存の値を置き換えるなら、なぜ変わったか。" },
        },
      },
    },
  },
} as const

export interface KeptValue {
  readonly slot: string
  readonly value: string
  readonly quote: string
  readonly validFrom?: string
  readonly reason?: string
}

/** 空白を無視して比べる。写すときに改行や字下げが揃い直ることがある。 */
const bare = (s: string): string => s.replace(/\s/g, "")

/**
 * 材料に無い引用を付けたものを落とす。**指示ではなくコードが弾く。**
 *
 * 「ユーザーが言ったことだけ」は書いておけば守られる類の制約ではない。守られなかったときに
 * 残るのが**確定値**(後の回が今の事実として無検査で使う)なので、通してから気づく形にしない。
 */
export const keepGrounded = (values: readonly KeptValue[] | undefined, material: string): KeptValue[] => {
  const hay = bare(material)
  const seen = new Set<string>()
  return (values ?? [])
    .filter((v) => {
      const q = bare(v.quote ?? "")
      // 短すぎる引用はどこにでも当たる。照合が照合として働かない。
      if (q.length < 4 || !hay.includes(q)) return false
      // 同じ slot を1回で2度上げると、区間が同じ瞬間に2本立つ。
      if (seen.has(v.slot)) return false
      seen.add(v.slot)
      return true
    })
    .slice(0, KEEP_MAX)
}

/**
 * 締めの keeper を1回通す。**失敗しても回そのものは落とさない。**
 *
 * 戻り値は DB に残す1行。呼び出し側はこれを tick の記録に添えるだけで、経路の分岐には使わない
 * — keeper が転んだせいで返信や既読位置が変わると、直す場所が分からなくなる。
 */
export const keep = (opts: {
  material: string
  since?: string
  signal?: AbortSignal
  /** 材料の見出し。窓を広げて呼ぶ側(dream)が「1回ぶんではない」と書けるようにする。 */
  header?: string
  /** 記録に付ける名前。既定は keeper。 */
  label?: string
  /** 判定に足す一節。窓が1回ぶんでないときに、何を数えてよいかを書き足す。 */
  extraSystem?: string
}) =>
  Effect.gen(function* () {
    const runner = yield* Runner
    const mem = yield* Memory
    const tag = opts.label ?? "keeper"
    if (bare(opts.material).length === 0) return `${tag}: 材料が無い(ユーザーの発言がこの回に無い)`

    // 既存の slot を見せる。**別名を作らせないため** — 同じ事柄が2つの名前で入ると、
    // どちらを引いても片方しか出てこない DB になる。
    const slots = yield* mem.currentBeliefs(40)
    const known =
      slots.length === 0
        ? "(まだ1つも無い)"
        : slots.map((s) => `- ${s.slot} = ${JSON.stringify(s.value)}`).join("\n")

    // **この回で既に確定した slot には触らない。** keeper は取りこぼしを拾う網であって、
    // 二人目の書き手ではない。触ると、本体が書いた値を数十秒で言い換えた区間が上に乗り、
    // 履歴が寿命1分未満の行で埋まる(実際にそうなった)。
    const since = opts.since
    const already = new Set(
      since === undefined ? [] : slots.filter((s) => s.updatedAt >= since).map((s) => s.slot),
    )

    const out = yield* Effect.either(
      runner.run({
        role: "structurer",
        kind: "keep",
        systemPrompt: opts.extraSystem ? `${KEEPER_SYSTEM}\n\n${opts.extraSystem}` : KEEPER_SYSTEM,
        prompt: `## いま DB にある確定値\n${known}\n\n## ${opts.header ?? "この回のユーザーの発言"}\n${opts.material}`,
        schema: KEEPER_SCHEMA,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    )
    if (out._tag === "Left") return `${tag}: 呼べなかった(${causeReason(out.left)})`

    const res = (out.right.structured ?? {}) as { looked?: string; values?: KeptValue[] }
    const grounded = keepGrounded(res.values, opts.material)
    const kept = grounded.filter((v) => !already.has(v.slot))
    const dropped = (res.values?.length ?? 0) - grounded.length
    const late = grounded.length - kept.length
    for (const v of kept) {
      yield* mem.believe(v.slot, v.value, {
        ...(v.validFrom ? { validFrom: v.validFrom } : {}),
        ...(v.reason ? { reason: v.reason } : {}),
      })
    }
    const head = kept.length === 0 ? `${tag}: 上げるものは無かった` : `${tag}: ${kept.length} 件を確定へ`
    const body = kept.map((v) => `${v.slot}=${v.value}`).join(" / ")
    // **落とした数も残す。** 引用が写せずに落ちたのと、本体が先に書いていたのと、
    // そもそも上げるものが無かったのは全部別の話。混ぜると、どれが起きているか読めない。
    const tail = [
      dropped > 0 ? `(引用が材料に無く ${dropped} 件を落とした)` : "",
      late > 0 ? `(${late} 件はこの回で確定済み)` : "",
    ]
      .filter(Boolean)
      .join("")
    return [head, body, tail, res.looked ? `— ${res.looked}` : ""].filter(Boolean).join(" ")
  })
