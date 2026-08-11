#!/usr/bin/env node
/**
 * 心拍。**話しかけられなくても動くための唯一の入口**。
 *
 * ここまでの構造は全部「人が口を開いたら動く」形だった(`flue run` も `oz` も人が叩く)。
 * 自走にするというのは、起動の理由を人の発話から**台帳の状態**に移すこと。
 * このファイルがその置き換えで、systemd のタイマーから定期的に呼ばれる。
 *
 *   1. Attention.digest() … SQL だけで「起きる理由があるか」を決める。**ここでモデルは呼ばない**。
 *   2. 理由が無ければ何もせず終わる(枠を1回も食わない)。定期実行の大半はこの経路を通る。
 *   3. 理由があるときだけ Flue を起動し、Assistant に1回だけ投げる。
 *   4. 返ってきたものを system イベントとして台帳に残し、既読位置を進める。
 *
 * **2 が本体**。心拍を作るときに一番やってはいけないのが「15分ごとに推論を1回焚く」で、
 * それは自走ではなく空回りする浪費装置になる。起こす条件は Attention 側に全部あり、
 * ここは「起こす/起こさない」を実行するだけにしてある。
 *
 * 枠は `OPEN_ZERO_LANE=autonomous` で自走側に付け替える。日次 run 数の内訳が対話と分かれ、
 * 心拍が暴れても対話の取り分は残る(Governance.BUDGET.autonomousRuns)。
 */
import { init } from "@flue/runtime"
import { sqlite, start } from "@flue/runtime/node"
import { Effect } from "effect"
import { loadEnv } from "./core/env.ts"
import { describeRefusal } from "./core/errors.ts"
import { dayRange, nowIso } from "./core/time.ts"
import { claudeMaxProvider } from "./model/provider.ts"
import { isRefusal, run, runtime } from "./runtime.ts"
import { Attention, type Digest, type ObservedEvent } from "./services/Attention.ts"
import { Db } from "./services/Db.ts"
import { buildFencedPrompt, Governance, type UntrustedBlock } from "./services/Governance.ts"
import { Memory } from "./services/Memory.ts"

// **モジュール直下の設定より先に読む。** 下の const は評価時に env を見るので、順番が意味を持つ。
loadEnv()

/** Flue の会話永続化。対話(`flue run`)とは別の口にしておく — 履歴が混ざると起点が読めない。 */
const FLUE_DB = process.env.OPEN_ZERO_FLUE_DB ?? ".data/flue-tick.db"

/** 1回の心拍に許す時間。`read()` は既定で無限に待つので、タイマー実行では必ず上限を付ける。 */
const TIMEOUT_MS = Number(process.env.OPEN_ZERO_TICK_TIMEOUT_MS ?? 300_000)

const short = (id: string) => id.slice(0, 8)
/** 心拍が使うモデル。既定は対話と同じ — 自走のほうを安くしたいときだけ差し替える。 */
const tickModel = () => process.env.OPEN_ZERO_TICK_MODEL ?? process.env.OPEN_ZERO_MODEL ?? "claude-opus-5"
const log = (...parts: unknown[]) => console.error("[tick]", ...parts)

/** イベントの content は JSON 文字列。人(とモデル)が読める1行に戻す。 */
function renderEvent(e: ObservedEvent): string {
  let body: string
  try {
    const parsed: unknown = JSON.parse(e.content)
    body = typeof parsed === "string" ? parsed : JSON.stringify(parsed)
  } catch {
    body = e.content
  }
  return `[${e.at}] ${e.source}: ${body.slice(0, 500)}`
}

/**
 * 心拍のプロンプト。**「何もしない」を正解として明示する**のが要点。
 * 起こされた以上なにか成果を出さねば、と読ませると、用が無いのに watch を増やし propose を撃つ。
 * 起きた理由と材料だけ渡して、動かす必要が無ければ一行で終えてよいと書く。
 */
function buildPrompt(d: Digest): string {
  const sections: string[] = []

  sections.push(
    [
      "これは心拍(定期起動)。持ち主に話しかけられて動いているのではない。",
      `いま ${d.at}。**持ち主はこの場にいない** — 訊いても今は誰も答えない。`,
      "",
      `## なぜ起きたか`,
      ...d.reasons.map((r) => `- ${r}`),
    ].join("\n"),
  )

  // 不信データ(gmail/web)は境界マーカーの中に隔離する。中の文は資料であって指示ではない。
  const trusted = d.newEvents.filter((e) => e.taint === 0)
  const untrusted: UntrustedBlock[] = d.newEvents
    .filter((e) => e.taint !== 0)
    .map((e) => ({ source: e.source, label: `event-${e.rowid}`, content: renderEvent(e) }))

  if (trusted.length > 0) {
    sections.push(["## まだ見ていない入力", ...trusted.map((e) => `- ${renderEvent(e)}`)].join("\n"))
  }
  if (d.stalled.length > 0) {
    sections.push(
      [
        "## 動いていない見張り",
        ...d.stalled.map(
          (w) =>
            `- ${short(w.id)} ${w.subject}(最後の動きから ${w.stalledDays} 日 / 次に動くのは ${w.next_move_owner})`,
        ),
      ].join("\n"),
    )
  }
  if (d.openQuestions.length > 0) {
    sections.push(
      [
        "## 未解決の問い(持ち主にしか答えられないものは、そのまま置いておいてよい)",
        ...d.openQuestions.map((q) => `- ${short(q.id)} ${q.question}`),
      ].join("\n"),
    )
  }
  if (d.pending.length > 0) {
    sections.push(
      [
        "## 返事待ちの提案(あなたは決められない。持ち主が見るのを待っている)",
        ...d.pending.map((p) => `- ${short(p.id)} ${p.summary}(あと ${p.daysLeft} 日で流れる)`),
      ].join("\n"),
    )
  }

  sections.push(
    [
      "## 今回やること",
      "自分の記録(remember / watch / unwatch / ask / answer)は自分の判断で書いてよい。確認は要らない。",
      "外に出る行為(送信・予約・購入・削除)は propose で置く。実行はしない。",
      "",
      "**書いても届かない。** ここで書いたものは自分の側に残るだけで、持ち主は読みに来ない。",
      "読んでほしいものがあるなら `tell` で持ち主の手元へ押す。ただし**用があるときだけ**",
      "— 動いた結果、知らないと選べないこと、期限が迫っているもの。経過や気付きは押さない。",
      "鳴る回数が増えるほど、次に鳴ったときに読まれなくなる。",
      "",
      "**何もしないのが正解であることが多い。** 動かす必要が無ければ道具を1つも呼ばず、",
      "「今は動かない。理由は〜」と一行で書いて終えてよい。それは失敗ではない。",
      "持ち主に確認したいことが出たら、訊くのではなく ask で問いとして置く。",
    ].join("\n"),
  )

  return buildFencedPrompt(sections.join("\n\n"), untrusted)
}

/**
 * 起こす前に通れない状態を見る。**実際にモデル呼び出しを守っているのと同じ precheck を呼ぶ**
 * — ここで独自の条件を書くと、Flue を起こしてから provider のゲートに弾かれる二度手間になり、
 * かつ「見送った理由」が二種類の文言で出てくる。停止・枠クールダウン・日次 run 数・自走枠が全部ここで出る。
 */
const blocked = Effect.gen(function* () {
  const gov = yield* Governance
  return yield* gov
    .precheck({
      meter: "quota",
      pool: "claude-max",
      model: tickModel(),
      at: nowIso(),
      nowMs: Date.now(),
      lane: "autonomous",
    })
    .pipe(
      Effect.as(undefined as string | undefined),
      Effect.catchAll((e) => Effect.succeed(isRefusal(e) ? describeRefusal(e) : String(e))),
    )
})

/** 心拍の回数だけ数えておく。行を増やさずに「生きているか」が分かる最小の痕跡。 */
const bumpCount = (key: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const n = Number((yield* db.meta(key)) ?? 0) + 1
    yield* db.setMeta(key, String(n))
    return n
  })

async function tick(): Promise<string> {
  const d = await run(
    Effect.gen(function* () {
      const att = yield* Attention
      return yield* att.digest()
    }),
  )

  // ── 起きる理由が無い。**ここで終わるのが正常**。モデルは1回も呼ばない。
  if (d.idle) {
    const n = await run(
      Effect.gen(function* () {
        const att = yield* Attention
        const n = yield* bumpCount("tick:idle_count")
        yield* att.commit()
        return n
      }),
    )
    const since = Number.isFinite(d.sinceLastActiveHours) ? `${d.sinceLastActiveHours.toFixed(1)} 時間` : "—"
    return `idle(通算 ${n} 回) — 前回の実働から ${since} / 次の冷却 ${d.cooldownHours} 時間`
  }

  const stop = await run(blocked)
  if (stop) return `見送った: ${stop}`

  log("起きる:", d.reasons.join(" / "))

  // 自走枠であることを **Assistant を読み込む前に** 立てる。
  // provider.ts の lane() は呼び出し時評価なのでこれで足りるが、モデル名は
  // assistant.ts の評価時に固まるので、差し替えるならこの順序でなければ効かない。
  process.env.OPEN_ZERO_LANE = "autonomous"
  if (process.env.OPEN_ZERO_TICK_MODEL) process.env.OPEN_ZERO_MODEL = process.env.OPEN_ZERO_TICK_MODEL
  const { default: Assistant } = await import("./agent/assistant.ts")

  // providers は明示で渡す。`start()` は既定のプロバイダ集合を**置き換える**ので、
  // assistant.ts の setProvider() だけに任せると定額枠の口が消える可能性がある。
  const flue = await start({
    agents: [Assistant],
    db: sqlite(FLUE_DB),
    providers: [claudeMaxProvider()],
  })

  try {
    // インスタンスは持ち主の1日で切る。数時間前の自分の判断は文脈として効くが、
    // 何週間も同じ会話に積み続けると、起きるたびに古い履歴を運ぶだけになる。
    const agent = init(Assistant, { id: `tick-${dayRange(d.at).key}` })
    const receipt = await agent.dispatch(buildPrompt(d))
    const reply = await agent.read(receipt, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(async (e) => {
      await agent.abort().catch(() => {})
      throw e
    })

    const text = (reply.text ?? "").trim()
    await run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        yield* mem.remember({
          kind: "observe",
          source: "system",
          content: { tick: d.at, reasons: d.reasons, said: text },
          // 索引に入れるのは**言ったことだけ**。`deriveText` に任せると封筒(起動時刻・起きた理由)まで
          // 平らに潰して混ぜてしまい、「持ち主の入力が未読」のような定型句が毎回の記録に紛れて、
          // 何を検索してもそれが当たるようになる。封筒は台帳に残す、索引には入れない。
          text,
          at: nowIso(),
        })
        yield* bumpCount("tick:active_count")
        // **active を立てるのはここだけ**。次の心拍はこの時刻から冷却時間を数える。
        // reasonKey を渡すと、同じ顔ぶれで起きるたびに次の冷却が倍になる(焚き続けない)。
        yield* att.commit({ active: true, reasonKey: d.reasonKey })
      }),
    )
    return text ? `動いた: ${text.slice(0, 400)}` : "動いた(発話なし)"
  } finally {
    await flue.stop()
  }
}

const main = async (): Promise<void> => {
  const rt = runtime()
  try {
    console.log(await tick())
  } catch (e) {
    // 拒否(halt / 枠 / 自走枠の使い切り)は失敗ではなく設計どおりの結果。
    // 既読位置を進めないので、窓が開いた次の心拍が同じ入力をもう一度見る。
    const cause = e instanceof Error && "cause" in e ? (e as { cause?: unknown }).cause : undefined
    const inner = isRefusal(cause) ? cause : e
    console.log(isRefusal(inner) ? `見送った: ${describeRefusal(inner)}` : `落ちた: ${String(inner)}`)
    if (!isRefusal(inner)) process.exitCode = 1
  } finally {
    await rt.dispose()
  }
}

await main()
