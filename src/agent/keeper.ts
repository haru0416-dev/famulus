/**
 * keeper は、owner 入力があり tick の応答が最後まで完了した回で、主処理が保存しなかった確定値を補完する後処理。
 * dream も同じ判定を複数日ぶんの材料に再利用する。
 *
 * DB には2つの層がある。`import`(過去の会話から起こした要約)は「その日時点でそう書かれていた」
 * という記録でしかなく、今の事実として使ってよいのは `belief` で確定した値だけ — recall の
 * 読み方がそう書いてある。以前は親 Agent の `remember` が確定値も書けたため、モデルがその回に
 * 呼ぶかどうかに全部かかっていた。現在、モデルが確定値を書く経路は引用照合を通す keeper だけ。
 * 呼ばれないと行は増えるのに引ける値は増えない問題を、回の終了時に補完する(docs/adr/0014)。
 *
 * 判定対象はユーザーの入力だけ。外部取得データ(web / gmail)は確定値として保存しない。
 * 確定値は「今の事実」として後の回に無検査で使われるので、外部取得データを対象に含めると、
 * 取得した文が事実として DB に入る経路ができる。引用がコード側で照合できるのも、
 * 判定対象をユーザーの入力に限っているから成り立つ。
 */
import * as Effect from "effect/Effect"
import * as v from "valibot"
import { causeReason } from "../core/errors.ts"
import { Runner } from "../model/Runner.ts"
import { rs } from "../model/schema.ts"
import { Memory } from "../services/Memory.ts"

/** 1回で確定値として保存してよい数。保存した値は無検査で使われるので、多いほど良いのではない。 */
const KEEP_MAX = 3

/** この役に許す時間。締めの経路なので、待たせるくらいなら次の回に回す。 */
export const KEEP_MS = 45_000

export const KEEPER_SYSTEM = `あなたは記録を確定させる役です。ユーザーとのやり取りが1回終わったところで、
**そこで確かめられた値**を確定値として保存するかどうかだけを決めます。文章は書きません。

確定値として保存してよいのは、**ユーザーが言ったこと**に限ります。以下は保存しません:
- あなた(または過去のあなた)の推測・要約・言い換え
- 外から取得したもの(web・メールの中身)
- 「〜かもしれない」「〜のはず」— ユーザーが確言していないもの
- 一度きりの出来事の実況(「いま出かける」)。**次に参照して意味を持つ値**だけを保存します

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

/** 空白を無視して比べる。写すときに改行や字下げが揃い直ることがある。 */
const bare = (s: string): string => s.replace(/\s/g, "")

/**
 * 判定対象に無い引用を付けたものを除外する。指示ではなくコードが弾く。
 *
 * 「ユーザーが言ったことだけ」は書いておけば守られる類の制約ではない。守られなかったときに
 * 残るのが確定値(後の回が今の事実として無検査で使う)なので、通してから気づく形にしない。
 */
export const keepGrounded = (values: readonly KeptValue[] | undefined, material: string): KeptValue[] => {
  const hay = bare(material)
  const seen = new Set<string>()
  return (values ?? [])
    .filter((v) => {
      const q = bare(v.quote ?? "")
      // 短すぎる引用はどこにでも当たる。照合が照合として働かない。
      if (q.length < 4 || !hay.includes(q)) return false
      // 同じ slot を1回で2度保存すると、区間が同じ瞬間に2本立つ。
      if (seen.has(v.slot)) return false
      seen.add(v.slot)
      return true
    })
    .slice(0, KEEP_MAX)
}

/**
 * 回の終了時に確定値補完処理(keeper)を1回実行する。失敗しても回全体は失敗させない。
 *
 * 戻り値は DB に残す1行。呼び出し側はこれを tick の記録に添えるだけで、経路の分岐には使わない
 * — keeper の処理失敗によって返信や既読位置が変わると、直す場所が分からなくなる。
 */
export const keep = (opts: {
  material: string
  since?: string
  signal?: AbortSignal
  /** 判定対象の見出し。対象期間を広げて呼ぶ側(dream)が「1回ぶんではない」と書けるようにする。 */
  header?: string
  /** 記録に付ける名前。既定は keeper。 */
  label?: string
  /** 判定に足す一節。対象期間が1回ぶんでないときに、何を数えてよいかを書き足す。 */
  extraSystem?: string
}) =>
  Effect.gen(function* () {
    const runner = yield* Runner
    const mem = yield* Memory
    const tag = opts.label ?? "keeper"
    if (bare(opts.material).length === 0) return `${tag}: 判定対象が無い(ユーザーの発言がこの回に無い)`

    // 既存の slot を見せる。別名を作らせないため — 同じ事柄が2つの名前で入ると、
    // どちらを引いても片方しか出てこない DB になる。
    const slots = yield* mem.currentBeliefs(40)
    const known =
      slots.length === 0
        ? "(まだ1つも無い)"
        : slots.map((s) => `- ${s.slot} = ${JSON.stringify(s.value)}`).join("\n")

    // この回で既に確定した slot には触らない。keeper は主処理が保存しなかった値を補完する側であって、
    // 同じ値を再保存する処理ではない。触ると、主処理が書いた値を数十秒後に言い換えた区間が追加され、
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

    const res = out.right.structured as { looked: string; values: KeptValue[] }
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
    const head =
      kept.length === 0 ? `${tag}: 保存対象は無かった` : `${tag}: ${kept.length} 件を確定値として保存`
    const body = kept.map((v) => `${v.slot}=${v.value}`).join(" / ")
    // 除外した数も残す。引用が写せずに除外したのと、本体が先に書いていたのと、
    // そもそも保存対象が無かったのは全部別の話。混ぜると、どれが起きているか読めない。
    const tail = [
      dropped > 0 ? `(引用が判定対象に無く ${dropped} 件を除外した)` : "",
      late > 0 ? `(${late} 件はこの回で確定済み)` : "",
    ]
      .filter(Boolean)
      .join("")
    return [head, body, tail, res.looked ? `— ${res.looked}` : ""].filter(Boolean).join(" ")
  })
