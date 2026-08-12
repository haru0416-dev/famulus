#!/usr/bin/env node
/**
 * tick。**話しかけられなくても動くための唯一の入口**。
 *
 * ここまでの構造は全部「人が口を開いたら動く」形だった(`flue run` も `oz` も人が叩く)。
 * 自走にするというのは、起動の理由を人の発話から**DB の状態**に移すこと。
 * このファイルがその置き換えで、systemd のタイマーから定期的に呼ばれる。
 *
 *   1. Attention.digest() …SQL だけで「起きる理由があるか」を決める。**ここでモデルは呼ばない**。
 *   2. 理由が無ければ何もせず終わる(枠を1回も食わない)。定期実行の大半はこの経路を通る。
 *   3. 理由があるときだけ Flue を起動し、Assistant に1回だけ投げる。
 *   4. 返ってきたものを system イベントとして DB に残し、既読位置を進める。
 *
 * **2 が本体**。tick を作るときに一番やってはいけないのが「15分ごとに推論を1回回す」で、
 * それは自走ではなく空回りする浪費装置になる。起こす条件は Attention 側に全部あり、
 * ここは「起こす/起こさない」を実行するだけにしてある。
 *
 * 枠は `OPEN_ZERO_LANE=autonomous` で自走側に付け替える。日次 run 数の内訳が対話と分かれ、
 * tick が暴れても対話の取り分は残る(Governance.BUDGET.autonomousRuns)。
 */
import { init } from "@flue/runtime"
import { sqlite, start } from "@flue/runtime/node"
import { Effect } from "effect"
import { DRAFTING } from "./agent/drafting.ts"
import { DREAM_DAILY, dream, dreamDue } from "./agent/dream.ts"
import { KEEP_MS, keep } from "./agent/keeper.ts"
import { CLEANUP_DAILY, cleanup, cleanupDue } from "./core/cleanup.ts"
import { clearDeadline, startDeadline } from "./core/deadline.ts"
import { loadEnv } from "./core/env.ts"
import { causeReason, describeRefusal } from "./core/errors.ts"
import { dayRange, nowIso } from "./core/time.ts"
import { drainInbox } from "./inbox.ts"
import { claudeMaxProvider } from "./model/provider.ts"
import { isRefusal, run, runtime } from "./runtime.ts"
import { Attention, type Digest, type ObservedEvent } from "./services/Attention.ts"
import { Db } from "./services/Db.ts"
import { Discord } from "./services/Discord.ts"
import { buildFencedPrompt, Governance, type UntrustedBlock } from "./services/Governance.ts"
import { Memory } from "./services/Memory.ts"

// **モジュール直下の設定より先に読む。** 下の const は評価時に env を見るので、順番が意味を持つ。
loadEnv()

/** Flue の会話永続化。対話(`flue run`)とは別にしておく — 履歴が混ざると起点が読めない。 */
const FLUE_DB = process.env.OPEN_ZERO_FLUE_DB ?? ".data/flue-tick.db"

/**
 * 1回の tick に許す時間。`read()` は既定で無限に待つので、タイマー実行では必ず上限を付ける。
 *
 * 300 秒では下書きの日が入り切らない(docs/adr/0012)。書いて精査に出して直してもう一度出す形になり、
 * 実測した回は 270 秒の時点でまだ3稿目を書いていた。unit の `TimeoutStartSec` は 600 秒なので、
 * **その内側**に収まる範囲で伸ばす。コンテナの上限(180 秒)との差は広がる方向なので ADR 0002 は保たれる。
 */
const TIMEOUT_MS = Number(process.env.OPEN_ZERO_TICK_TIMEOUT_MS ?? 420_000)

const short = (id: string) => id.slice(0, 8)
/** tick が使うモデル。既定は対話と同じ — 自走のほうを安くしたいときだけ差し替える。 */
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
 * tick のプロンプト。**「何もしない」を正解として明示する**のが要点。
 * 起こされた以上なにか成果を出さねば、と読ませると、用が無いのに watch を増やし propose を出す。
 * 起きた理由と材料だけ渡して、動かす必要が無ければ一行で終えてよいと書く。
 */
function buildPrompt(d: Digest, spokenTo: boolean): string {
  const sections: string[] = []

  sections.push(
    [
      spokenTo
        ? "**ユーザーがいま話しかけている。**下に載っている owner の入力がそれ。"
        : "これは tick(定期起動)。ユーザーに話しかけられて動いているのではない。",
      spokenTo
        ? `いま ${d.at}。**この回で最後に書いた文が、そのまま Discord の返信として届く。**`
        : `いま ${d.at}。**ユーザーはこの場にいない** — 訊いても今は誰も答えない。`,
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
        "## 動いていない watch",
        // 前回の結果を一緒に渡す。**これが無いと毎回まっさらな状態で同じ一覧を読み直す**ことになり、
        // 先週を踏まえた文が一度も出ない。実際に AI追跡の watch がそうなっていた。
        ...d.stalled.map((w) => {
          const head = `- ${short(w.id)} ${w.subject}(最後の動きから ${w.stalledDays} 日 / 次に動くのは ${w.next_move_owner}`
          const runs = w.run_count > 0 ? ` / 通算 ${w.run_count} 回` : " / まだ一度も回していない"
          const prev = w.last_result ? `\n  前回: ${w.last_result}` : ""
          return `${head}${runs})${prev}`
        }),
        "",
        "回したら `ran` で結果を残す。**何も出てこなかった回も残す** — 呼ばないと次の tick でまた上がる。",
        "**前に回したのに記録し忘れているなら、そのときの時刻を `at` に渡して今記録する。**",
        "冷却はその時刻から数えるので後ろへずれない。件名に走行記録を書き込むのではなく、ここを使う。",
      ].join("\n"),
    )
  }
  if (d.openQuestions.length > 0) {
    sections.push(
      [
        "## 未解決の問い(ユーザーにしか答えられないものは、そのまま置いておいてよい)",
        ...d.openQuestions.map((q) => `- ${short(q.id)} ${q.question}`),
      ].join("\n"),
    )
  }
  if (d.pending.length > 0) {
    sections.push(
      [
        "## 返事待ちの提案(あなたは決められない。ユーザーが見るのを待っている)",
        ...d.pending.map((p) => `- ${short(p.id)} ${p.summary}(あと ${p.daysLeft} 日で流れる)`),
      ].join("\n"),
    )
  }
  if (d.refused.length > 0) {
    sections.push(
      [
        // watch に前回の結果を渡すのと同じ(docs/adr/0017)。断られた側を渡さないと、
        // まっさらな状態で同じ相手に同じ用件を出し直す。
        "## 断られた提案(同じ形をもう一度出さない)",
        ...d.refused.map((p) => `- ${p.summary}\n  → ${p.reason}`),
        "",
        "**理由が「前提が変わった」「その話ごと畳んだ」なら、その用件は出さない。**",
        "日付や文面を差し替えて出し直してよいのは、断られた理由がその一点だけだったとき。",
      ].join("\n"),
    )
  }

  // 下書きの規律は**出す日にだけ載せる**。毎回渡すと、書かない回のぶんだけ枠を食う。
  if (d.draftDue) {
    sections.push(
      [
        "## 今日ぶんの下書き",
        "1日に1本、外に出せる文を `draft` で置く。出す先は Zenn を想定した記事。",
        "",
        "**書き始める前に `recall` で自分の走行記録を引く。** 切られた tick、通らなかった経路、",
        "効かなかった設定、使った枠 — 自走するエージェントを実際に動かして壊れた記録は他の誰も持っていない。",
        "引いて何も出てこなければ `draft` を呼ばず、「材料が無い」と一行書いて終える。",
        "",
        DRAFTING,
      ].join("\n"),
    )
  }

  sections.push(
    [
      "## 今回やること",
      `**この回に使える時間は ${Math.round(TIMEOUT_MS / 1000)} 秒**。\`shell\` の返り値に残りが出る。` +
        "尽きる前に手を止めて、分かったことを書く。続きは同じ作業場の名前を渡せば次の tick で継げる。",
      "",
      ...(spokenTo
        ? [
            "**最後に書いた文がそのまま返信になる。** `tell` は要らない — 同じ画面に出る。",
            "答えるのであって、報告しない。何を調べたか・どの道具を呼んだかは書かない。",
            "訊かれたことに答え、動いたなら何がどうなったかを書く。**それ以外は書かない。**",
          ]
        : [
            "**書いても届かない。** ここで書いたものは自分の側に残るだけで、ユーザーは読みに来ない。",
            "読んでほしいものがあるなら `tell` でユーザーの手元へ押す。ただし**用があるときだけ**",
            "— 動いた結果、知らないと選べないこと、期限が迫っているもの。経過や気付きは押さない。",
            "鳴る回数が増えるほど、次に鳴ったときに読まれなくなる。",
          ]),
      "",
      "**調べ直すより、手元にあるもので終える。** tick は数分で切られる。途中で切られると",
      "その回の働きは丸ごと消えて、ユーザーには何も残らない。だから:",
      "- `recall` は当たった時点で止める。**同じ語をもう一度引かない**。「該当なし」が2回続いたら DB に無い。",
      "- DB を読むだけなら自分で引く。`task` で子(`digger` / `researcher`)を立てるのは",
      "  **1回では足りないとき**と、**外(web)を見に行くとき**だけ。",
      "- **探すときは割って投げる。** 同じ問いを1つの文脈で順に調べると、2件目は1件目の語彙を",
      "  引き継いで同じ側しか見なくなる。**別の切り口を別の子に渡し、互いの結果は見せない。**",
      "  合わせるのは戻ってきてから。詰めの段(答えが見えている)では割らず、手元で終える。",
      "- **投げる前に「たぶんこう返る」を一行書いておく。** 予告どおりに返ったものは既に知っていたことの",
      "  確認でしかない。**予告を外した返りだけが新しい。** 外れたら、外れた側を書く。",
      "- **ユーザーに届ける値打ちがあると言うなら、同じ物差しに掛けて落ちたものを1つ名指す。**",
      "  落ちたものを名指せない物差しは何でも通すので、通ったことが証拠にならない。",
      "- 材料が揃ったらそこで打ち切って、`tell` なり `remember` なりで形にして終える。",
      "",
      ...(spokenTo
        ? [
            "**訊き返してよい。** 相手はいま画面の前にいる。分岐が決められないなら、",
            "選べる形にして1つだけ訊く(ask で置くのは、その場で答えが要らないものだけ)。",
          ]
        : [
            "**何もしないのが正解であることが多い。** 動かす必要が無ければ道具を1つも呼ばず、",
            "「今は動かない。理由は〜」と一行で書いて終えてよい。それは失敗ではない。",
          ]),
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

/** tick の回数だけ数えておく。行を増やさずに「生きているか」が分かる最小の痕跡。 */
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
      // **digest より先に読む** — 届いていた文がそのまま未読の入力になり、「ユーザーから
      // 言われた」ことが起きる理由になる。ここが後だと、返事は次の tick まで読まれない。
      // poll が先に取り込んでいれば0件で通り、DB に残っているぶんが digest に出る。
      const arrived = yield* drainInbox
      if (arrived > 0) log(`受信箱から ${arrived} 件`)
      const att = yield* Attention
      return yield* att.digest()
    }),
  )

  // ── 起きる理由が無い。**ここで終わるのが正常**。モデルは1回も呼ばない。
  if (d.idle) {
    // ただし1日1回だけ、何日ぶんかの見直しをここで回す(docs/adr/0018)。
    // **idle の回に置く理由は、返信を待たせないため。** 見直しは Luna で 30 秒前後かかるので、
    // 話しかけられた回に挟むとその秒数だけ返事が遅れる。起きる理由が無い回なら誰も待っていない。
    // その日に idle の回が一度も来なければ翌日へ回る — 窓は 7 日あり、`dream:through` が
    // 進んだところを覚えているので、飛ばした日ぶんの材料は次の回にそのまま出てくる。
    const dreamed = (await run(dreamDue(d.at)))
      ? await run(dream()).catch((e: unknown) => `dream: 落ちた(${causeReason(e)})`)
      : undefined
    if (dreamed) log(dreamed)
    // 落とすほうも1日1回(docs/adr/0019)。**印は別に持つ** — 見直しが落ちた日に
    // 掃除まで止まると、増える側だけが進む。こちらはモデルを呼ばないので枠にも関係しない。
    const swept = (await run(cleanupDue(d.at)))
      ? await run(cleanup()).catch((e: unknown) => `cleanup: 落ちた(${causeReason(e)})`)
      : undefined
    if (swept) log(swept)
    const n = await run(
      Effect.gen(function* () {
        const att = yield* Attention
        const db = yield* Db
        const mem = yield* Memory
        const n = yield* bumpCount("tick:idle_count")
        // 落ちた回にも印を付ける。付けないと、同じ落ち方を 15 分ごとに1日じゅう繰り返す。
        if (dreamed) yield* db.setMeta(DREAM_DAILY, dayRange(d.at).key)
        if (swept) yield* db.setMeta(CLEANUP_DAILY, dayRange(d.at).key)
        const lines = [dreamed, swept].filter(Boolean) as string[]
        if (lines.length > 0) {
          yield* mem.remember({
            kind: "observe",
            source: "system",
            content: { ...(dreamed ? { dream: dreamed } : {}), ...(swept ? { cleanup: swept } : {}) },
            text: lines.join("\n"),
            at: nowIso(),
          })
        }
        // 見ていないので進めない。idle は入力が無いという判定なので、この起動と入れ違いに
        // 届いたぶんまで既読にすると、届いた側は何も返らないまま消える。
        yield* att.commit({ upto: d.cursor })
        return n
      }),
    )
    const since = Number.isFinite(d.sinceLastActiveHours) ? `${d.sinceLastActiveHours.toFixed(1)} 時間` : "—"
    return [`idle(通算 ${n} 回) — 前回の実働から ${since} / 次の冷却 ${d.cooldownHours} 時間`, dreamed, swept]
      .filter(Boolean)
      .join("\n")
  }

  const stop = await run(blocked)
  if (stop) return `見送った: ${stop}`

  // **話しかけられて起きたのか、自分の都合で起きたのか。** ここで返信の宛先が決まる。
  // owner の未読があるなら、この回の最後の文は DB ではなくユーザーの画面へ出す。
  const spokenTo = d.newEvents.some((e) => e.source === "owner")
  log("起きる:", d.reasons.join(" / "), spokenTo ? "(返信)" : "")

  // 自走枠であることを **Assistant を読み込む前に** 立てる。
  // provider.ts の lane() は呼び出し時評価なのでこれで足りるが、モデル名は
  // assistant.ts の評価時に固まるので、差し替えるならこの順序でなければ効かない。
  process.env.OPEN_ZERO_LANE = "autonomous"
  if (process.env.OPEN_ZERO_TICK_MODEL) process.env.OPEN_ZERO_MODEL = process.env.OPEN_ZERO_TICK_MODEL
  const { default: Assistant } = await import("./agent/assistant.ts")

  // providers は明示で渡す。`start()` は既定のプロバイダ集合を**置き換える**ので、
  // assistant.ts の setProvider() だけに任せると定額枠の経路が消える可能性がある。
  const flue = await start({
    agents: [Assistant],
    db: sqlite(FLUE_DB),
    providers: [claudeMaxProvider()],
  })

  try {
    // インスタンスはユーザーの1日で切る。数時間前の自分の判断は文脈として効くが、
    // 何週間も同じ会話に積み続けると、起きるたびに古い履歴を運ぶだけになる。
    const agent = init(Assistant, { id: `tick-${dayRange(d.at).key}` })
    // 道具に締切を見せる。**プロンプトに書くだけでは足りない** — 起動時の文は、9回目を
    // 走らせるかどうかを決める時点では過去の話になっている(src/core/deadline.ts)。
    startDeadline(TIMEOUT_MS)
    const receipt = await agent.dispatch(buildPrompt(d, spokenTo))
    // **切られてもここで受け止める。** 投げ直すと commit に辿り着かないので冷却の起点が進まず、
    // 次のタイマーが同じ理由で起きて同じだけ焼いて同じように落ちる。落ちた回も1回動いた回として
    // 締める — 実際にモデルは走り、道具も動いて、その跡は DB に残っている。
    const deadline = AbortSignal.timeout(TIMEOUT_MS)
    let cutOff: string | undefined
    const reply = await agent.read(receipt, { signal: deadline }).catch(async (e) => {
      await agent.abort().catch(() => {})
      // **時間切れと、それ以外の止まり方を混ぜない。** 混ぜると「300秒で切られた」だけが DB に残り、
      // 自走枠の使い切りも provider の落ちも同じ顔になる。次の回で何を直せばいいか読めなくなる。
      cutOff = deadline.aborted ? `${Math.round(TIMEOUT_MS / 1000)}秒で時間切れ` : causeReason(e)
      log("止まった:", cutOff)
      return { text: `(${cutOff}。この回の締めの文は書けていない)` }
    })

    const text = (reply.text ?? "").trim()

    // ── 締めの keeper。**ユーザーが話した回にだけ通る**(docs/adr/0014)。
    // 材料はユーザーの発言そのもので、外から来たものは渡さない。切られた回は通さない —
    // 途中で止まった回のやり取りは、確かめられたかどうかが判断できる形になっていない。
    let kept: string | undefined
    if (spokenTo && !cutOff) {
      const material = d.newEvents
        .filter((e) => e.source === "owner" && e.taint === 0)
        .map(renderEvent)
        .join("\n")
      // `since` はこの回の起点。本体が既に確定させた slot を keeper が言い換え直さないための線。
      kept = await run(keep({ material, since: d.at, signal: AbortSignal.timeout(KEEP_MS) })).catch(
        (e: unknown) => `keeper: 落ちた(${causeReason(e)})`,
      )
      log(kept)
    }

    await run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const att = yield* Attention
        const db = yield* Db
        const discord = yield* Discord
        // **返信は DB より先に出す。** ユーザーは待っている側なので、記録に手間取って
        // 返事が遅れる順序にしない。出せなくても DB には残るので、失っては困るものは無い。
        // 切られた回の穴埋め文は出さない。**待っている側に届けてよいのは、書かれた返事だけ。**
        if (spokenTo && text && !cutOff) yield* discord.post({ text })
        yield* mem.remember({
          kind: "observe",
          source: "system",
          content: { tick: d.at, reasons: d.reasons, said: text, ...(kept ? { kept } : {}) },
          // 索引に入れるのは**言ったことだけ**。`deriveText` に任せると封筒(起動時刻・起きた理由)まで
          // 平らに潰して混ぜてしまい、「ユーザーの入力が未読」のような定型句が毎回の記録に紛れて、
          // 何を検索してもそれが当たるようになる。封筒は DB に残す、索引には入れない。
          text,
          at: nowIso(),
        })
        yield* bumpCount("tick:active_count")
        // **書けたかどうかに関わらず、その日は1回で打ち切る。** `draft` を呼ばなかった=材料が無かった
        // ということで、同じ材料のまま15分ごとに書かせ直しても出てくるものは変わらない。
        // ただし切られた回は数えない — 書かないと決めたのではなく、決める前に止められている。
        if (d.draftDue && !cutOff) yield* db.setMeta("daily:draft", dayRange(d.at).key)
        // **active を立てるのはここだけ**。次の tick はこの時刻から冷却時間を数える。
        // reasonKey を渡すと、同じ組み合わせで起きるたびに次の冷却が倍になる(回し続けない)。
        // **進めるのは digest に載った行までにする。** 走っている間に届いたぶんは未読のまま残り、
        // 30秒ごとの poll(poll.ts)が次の起動で拾い直す。ここを最大 rowid にすると黙って落ちる。
        yield* att.commit({
          active: true,
          reasonKey: d.reasonKey,
          upto: d.newEvents.at(-1)?.rowid ?? d.cursor,
        })
      }),
    )
    if (cutOff) return `止まった(${cutOff})— 走った跡は DB に残っている`
    return text ? `動いた: ${text.slice(0, 400)}` : "動いた(発話なし)"
  } finally {
    clearDeadline()
    await flue.stop()
  }
}

const main = async (): Promise<void> => {
  const rt = runtime()
  try {
    console.log(await tick())
  } catch (e) {
    // 拒否(halt / 枠 / 自走枠の使い切り)は失敗ではなく設計どおりの結果。
    // 既読位置を進めないので、窓が開いた次の tick が同じ入力をもう一度見る。
    const cause = e instanceof Error && "cause" in e ? (e as { cause?: unknown }).cause : undefined
    const inner = isRefusal(cause) ? cause : e
    console.log(isRefusal(inner) ? `見送った: ${describeRefusal(inner)}` : `落ちた: ${String(inner)}`)
    if (!isRefusal(inner)) process.exitCode = 1
  } finally {
    await rt.dispose()
  }
}

await main()
