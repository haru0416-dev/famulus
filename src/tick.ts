#!/usr/bin/env bun
/**
 * tick。**話しかけられなくても動くための唯一の入口**。
 *
 * ここまでの構造は全部「人が口を開いたら動く」形だった(`pnpm agent` も `oz` も人が叩く)。
 * 自走にするというのは、起動の理由を人の発話から**DB の状態**に移すこと。
 * このファイルがその置き換えで、systemd のタイマーから定期的に呼ばれる。
 *
 *   1. Attention.digest() …SQL だけで「起きる理由があるか」を決める。**ここでモデルは呼ばない**。
 *   2. 理由が無ければ何もせず終わる(枠を1回も食わない)。定期実行の大半はこの経路を通る。
 *   3. 理由があるときだけエージェントを組み立て、1回だけ投げる。
 *   4. 返ってきたものを system イベントとして DB に残し、既読位置を進める。
 *
 * **2 が本体**。tick を作るときに一番やってはいけないのが「15分ごとに推論を1回回す」で、
 * それは自走ではなく空回りする浪費装置になる。起こす条件は Attention 側に全部あり、
 * ここは「起こす/起こさない」を実行するだけにしてある。
 *
 * 枠は `OPEN_ZERO_LANE=autonomous` で自走側に付け替える。日次 run 数の内訳が対話と分かれ、
 * tick が暴れても対話の取り分は残る(Governance.BUDGET.autonomousRuns)。
 */
import { Effect } from "effect"
import { DRAFTING } from "./agent/drafting.ts"
import { DREAM_DAILY, dream, dreamDue } from "./agent/dream.ts"
import { KEEP_MS, keep } from "./agent/keeper.ts"
import { CLEANUP_DAILY, cleanup, cleanupDue } from "./core/cleanup.ts"
import { clearDeadline, startDeadline } from "./core/deadline.ts"
import { loadEnv } from "./core/env.ts"
import { causeReason, describeRefusal } from "./core/errors.ts"
import { dayRange, nowIso } from "./core/time.ts"
import { listWorkspaces, renderWorkspaces, type Workspace } from "./core/workspaces.ts"
import { drainInbox } from "./inbox.ts"
import { oneLine, readJournal } from "./journal.ts"
import { isRefusal, run, runtime } from "./runtime.ts"
import { Attention, type Digest, type ObservedEvent } from "./services/Attention.ts"
import { Db } from "./services/Db.ts"
import { Discord } from "./services/Discord.ts"
import { buildFencedPrompt, Governance, type UntrustedBlock } from "./services/Governance.ts"
import { Memory } from "./services/Memory.ts"

// **モジュール直下の設定より先に読む。** 下の const は評価時に env を見るので、順番が意味を持つ。
loadEnv()

/**
 * 1回の tick に許す時間。**上限を付けないと無限に待つ。**
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
function buildPrompt(d: Digest, spokenTo: boolean, workspaces: readonly Workspace[]): string {
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
        // 残りの件数だけ出す。**中身は出さない** — 出すと結局全部読むことになり、絞った意味が消える。
        ...(d.stalledHeld > 0
          ? [
              `他に ${d.stalledHeld} 件が冷却明けで待っているが、**この回は上の ${d.stalled.length} 件だけ見る。**`,
              "残りは次の回に上がる。全部を見ようとしない — 一覧を読み直すだけで終わった回が実際に続いた。",
              "",
            ]
          : []),
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
        // 前回の結論を一緒に渡す。watch の `前回:` と同じ形(docs/adr/0017)。
        ...d.pending.map((p) => {
          const head = `- ${short(p.id)} ${p.summary}(あと ${p.daysLeft} 日で流れる)`
          return p.settled_note ? `${head}\n  前回: ${p.settled_note}` : head
        }),
        "",
        "**今回できることが無いなら `settle` で一行残す。** 残すとこの件では起こされなくなる",
        "(一覧には残る — 承認はまだ要る)。呼ばないと、期限が近いというだけで毎回起きて、",
        "毎回同じ「あなた待ちです」を書き直すことになる。**前回の結論が既に載っているなら、",
        "同じことをもう一度書かない。**状況が動いたときだけ `settle` を上書きする。",
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

  // 在る作業場は毎回載せる。**引ける道具(`workspaces`)を置いただけでは引かれない** —
  // 引くかどうかを判断するには、まず在ることを知っていなければならない。数行で済む。
  if (workspaces.length > 0) {
    sections.push(
      [
        "## 使える作業場(`shell` の workspace に渡す名前)",
        renderWorkspaces(workspaces, Date.parse(d.at)),
        "",
        "**続きをやれるものが在るなら新しく作らない。** 作り直すと依存の取得からやり直しになり、",
        "その回の持ち時間がそれで終わる。新しく作るときは `purpose` に何のための場所かを一行書く。",
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
      "- DB を読むだけなら `recall` を自分で引く。子(`digger` / `researcher`)を呼ぶのは",
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
      // 「何もしないでよい」は**載せるものが無い回にだけ**言う。無条件に書くと、冷却の明けた
      // watch を並べておきながら同じ文で「動かなくてよい」と言うことになる。実測(直近40回の実働)では
      // watch で起きた9回のうち7回が道具呼び出し4回以下だった。逆に「必ず何かやれ」と書くと
      // 用の無い watch と提案が増える。**分けるのは件数ではなく、載っているかどうか。**
      // **この分岐そのものの効き目は測れていない**(前後1回ずつでは差が出なかった。docs/adr/0028)。
      ...(spokenTo
        ? [
            "**訊き返してよい。** 相手はいま画面の前にいる。分岐が決められないなら、",
            "選べる形にして1つだけ訊く(ask で置くのは、その場で答えが要らないものだけ)。",
          ]
        : d.stalled.length > 0
          ? [
              "**上の「動いていない watch」から、この回で少なくとも1件は回す。** 載っているのは",
              "冷却が明けたものだけで、読み直すために出しているのではない。回して `ran` に残せば、",
              "**何も出てこなかった回でもこの回の成果になる。** 一覧を眺めて終えた回だけが何も残さない。",
              "そのうえで**新しく仕事を作らない。** 用が無いのに watch を増やしたり提案を出したりしない。",
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

  // 自走枠であることを **エージェントを組み立てる前に** 立てる。
  // lane() は呼び出し時評価なのでこれだけで足りるが、モデル id は createAssistant() の
  // 時点で確定するので、差し替えるならこの順序でなければ効かない。
  process.env.OPEN_ZERO_LANE = "autonomous"
  // 道具一式を読み込むのは、起きると決まってから。idle の回(定期実行の大半)は
  // ここを通らないので、その回の起動は DB を1回引くだけで終わる。
  const { createAssistant } = await import("./agent/assistant.ts")

  try {
    const assistant = createAssistant({ model: tickModel() })
    // 道具に締切を見せる。**プロンプトに書くだけでは足りない** — 起動時の文は、9回目を
    // 走らせるかどうかを決める時点では過去の話になっている(src/core/deadline.ts)。
    startDeadline(TIMEOUT_MS)
    // **切られてもここで受け止める。** 投げ返すと commit に辿り着かないので冷却の起点が進まず、
    // 次のタイマーが同じ理由で起きて同じだけ焼いて同じように落ちる。落ちた回も1回動いた回として
    // 締める — 実際にモデルは走り、道具も動いて、その跡は DB に残っている。
    const deadline = AbortSignal.timeout(TIMEOUT_MS)
    const prompt = buildPrompt(d, spokenTo, await run(listWorkspaces))
    // **「載せた」を記録するのはここ**。digest の中ではない — digest は起きる理由が無い回にも
    // 走るので、そこで印を付けると誰も読んでいない一覧を載せたことにして順番だけが進む。
    // 切られた回でも記録は残す。載ったことは事実で、次は他のものに順番を渡す(docs/adr/0028)。
    if (d.stalled.length > 0) {
      await run(
        Effect.gen(function* () {
          const att = yield* Attention
          yield* att.noteShown(d.stalled.map((w) => w.id))
        }),
      )
    }
    const began = Date.now()
    const turn = await assistant.respond(prompt, { signal: deadline })
    const ms = Date.now() - began
    // **時間切れと、それ以外の止まり方を混ぜない。** 混ぜると「420秒で切られた」だけが DB に残り、
    // 自走枠の使い切りもモデル側の落ちも同じ顔になる。次の回で何を直せばいいか読めなくなる。
    const cutOff = turn.cutOff
      ? deadline.aborted
        ? `${Math.round(TIMEOUT_MS / 1000)}秒で時間切れ`
        : turn.cutOff
      : undefined
    if (cutOff) log("止まった:", cutOff, `/ ${turn.steps} 手まで`)

    // 切られた回でも、そこまでに書けた文は捨てない。**道具ループの途中の文が残っている**
    // ことがあり、それが「9回走らせて何が分かったか」の唯一の記録になる。
    const text = (turn.text || (cutOff ? `(${cutOff}。この回の締めの文は書けていない)` : "")).trim()

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
          // **やったことと、やったと書いたことを別の欄に置く。** `said` は自分で書いた報告なので、
          // それだけでは外から進み具合を確かめられない(docs/adr/0030)。`tools` は実際に呼ばれた
          // 道具の並び、`steps` は手数、`ms` は掛かった時間 — どれも呼び出し側で数えた値。
          // 切られた回は `cutOff` も残す。**止まったことが `said` に書かれるとは限らない。**
          content: {
            tick: d.at,
            reasons: d.reasons,
            said: text,
            tools: turn.tools,
            steps: turn.steps,
            ms,
            ...(cutOff ? { cutOff } : {}),
            ...(kept ? { kept } : {}),
          },
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
        // ── 進み具合を1行だけ出す(docs/adr/0030)。**呼びかけない。**
        // 動くたびに出るものなので、名指しを付けると通知が鳴り続けて、鳴っても見なくなる。
        // 出す先が指してなければ何も起きない(`Desk` の "log" は DM に落ちない)。
        //
        // **書いた記録をそのまま読み直して出す。** ここで数え直すと、画面で見る値と
        // `oz journal` の値が別々に育って、食い違ったときにどちらが本当か決められなくなる。
        // 最後に置いてあるのは、外へ出すのに失敗しても commit まで済んでいるようにするため。
        const [entry] = yield* readJournal(1)
        if (entry) yield* discord.post({ text: oneLine(entry), to: "log" })
      }),
    )
    if (cutOff) return `止まった(${cutOff})— 走った跡は DB に残っている`
    return text ? `動いた: ${text.slice(0, 400)}` : "動いた(発話なし)"
  } finally {
    clearDeadline()
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
