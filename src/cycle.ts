#!/usr/bin/env bun
/**
 * 自走の入口。systemd のタイマーから呼ばれ、起動の理由を人の発話ではなく DB の状態に置く。
 * 実行条件は Attention.planCycle()(SQL のみ)に集約し、満たさない回はモデルを呼ばずに終わる。
 * lane は autonomous で計上し、cycle が過剰実行されても対話用の run 数は残す。
 */
import { randomUUID } from "node:crypto"
import * as Effect from "effect/Effect"
import type { AssistantOptions, AssistantTurnResult } from "./agent/assistant.ts"
import { DRAFTING } from "./agent/drafting.ts"
import { DREAM_DAILY, dream, dreamDue } from "./agent/dream.ts"
import { KEEP_MS, keep } from "./agent/keeper.ts"
import { compileSkillPlan, renderSkillOverlay } from "./agent/skills.ts"
import { describePendingImages } from "./agent/vision.ts"
import { CLEANUP_DAILY, cleanup, cleanupDue } from "./core/cleanup.ts"
import { configureApp } from "./core/config.ts"
import { currentCycleId, withCycleContext } from "./core/cycle-context.ts"
import { clearDeadline, startDeadline } from "./core/deadline.ts"
import { loadEnv } from "./core/env.ts"
import { ConnectorFailed, causeReason, describeRefusal } from "./core/errors.ts"
import { localDayRange, nowIso } from "./core/time.ts"
import { listWorkspaces, renderWorkspaces, type Workspace } from "./core/workspaces.ts"
import { wakePendingDelivery } from "./deliver.ts"
import { drainInbox } from "./inbox.ts"
import { dailyLogWindow, dailyPost, readJournalRange, tally } from "./journal.ts"
import { digestOf } from "./model/kernel-spec.ts"
import { poolForModel } from "./model/models.ts"
import { isRefusal, run, runtime } from "./runtime.ts"
import { Attention, type CyclePlan, type ObservedEvent } from "./services/Attention.ts"
import { CycleLease, type CycleLeaseToken } from "./services/CycleLease.ts"
import { Db } from "./services/Db.ts"
import { Discord } from "./services/Discord.ts"
import { buildFencedPrompt, Governance, setLane, type UntrustedBlock } from "./services/Governance.ts"
import { Memory } from "./services/Memory.ts"
import { Proposals } from "./services/Proposals.ts"

// static import は設定を読まない。runtime を作る前に .env を反映し、検証済み Config を置く。
loadEnv()
const CONFIG = configureApp()

/**
 * 短くすると下書きの日に入り切らない。unit の `TimeoutStartSec`(600秒)の内側に収める。
 * 個々のコンテナ走行は180秒で先に切り、締め処理の時間を残す。
 */
const TIMEOUT_MS = CONFIG.cycle.timeoutMs

/** 出すのは件数だけ。超えたら頭打ちで出る。 */
const MAX_PENDING_SHOWN = 100

/** 分類・正本のどちらが欠けても下書きは止めない。 */
function jissokuOverlay(): string | undefined {
  try {
    const plan = compileSkillPlan({ profile: "autonomous-parent", presentation: "jissoku-writing" })
    return renderSkillOverlay(plan)
  } catch {
    return undefined
  }
}

const short = (id: string) => id.slice(0, 8)
/** 既定は対話と同じ。 */
const cycleModel = () => CONFIG.models.cycle
const log = (...parts: unknown[]) => console.error("[cycle]", ...parts)

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

function ownerEvidenceText(e: ObservedEvent): string | undefined {
  try {
    const parsed: unknown = JSON.parse(e.content)
    if (typeof parsed === "string") return parsed
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { said?: unknown }).said === "string"
    )
      return (parsed as { said: string }).said
  } catch {
    return e.content
  }
  return undefined
}

function renderWatchSection(d: CyclePlan): string | undefined {
  if (d.stalled.length === 0) return undefined
  return [
    "## 対応対象の watch",
    // 前回の結果を渡さないと、毎回同じ一覧を読み直して前回を踏まえた文が出ない。
    ...d.stalled.map((w) => {
      const head = `- ${short(w.id)} ${w.subject}(最後の動きから ${w.stalledDays} 日 / 次に動くのは ${w.next_move_owner}`
      const runs = w.run_count > 0 ? ` / 通算 ${w.run_count} 回` : " / まだ一度も実行していない"
      const prev = w.last_result ? `\n  前回: ${w.last_result}` : ""
      return `${head}${runs})${prev}`
    }),
    "",
    // 中身は出さない。出すと全部読むことになり、絞った意味が消える。
    ...(d.stalledHeld > 0
      ? [
          `他に ${d.stalledHeld} 件が再提示可能な状態で待っているが、**この回は上の ${d.stalled.length} 件だけ見る。**`,
          "残りは次回の処理対象になる。全部を見ようとしない — 一覧を読み直すだけで終わった回が実際に続いた。",
          "",
        ]
      : []),
    "状態を確認するか famulus 側の担当作業を進めたら `record_watch_run` で結果を残す。**変化が無くても残す** — 呼ばないと次回も対応対象になる。",
    "**以前対応した結果を記録し忘れているなら、そのときの時刻を `at` に渡して今記録する。**",
    "再提示待機時間はその時刻から数えるので後ろへずれない。件名に対応記録を書き込むのではなく、ここを使う。",
  ].join("\n")
}

function renderPendingSection(d: CyclePlan): string | undefined {
  if (d.pending.length === 0) return undefined
  return [
    "## 返事待ちの提案(あなたは決められない。ユーザーが見るのを待っている)",
    ...d.pending.map((p) => {
      const expiry = p.daysLeft >= 0 ? `あと ${p.daysLeft} 日で期限切れ` : "期限切れ"
      const head = `- ${short(p.id)} ${p.summary}(${expiry})`
      return p.settled_note ? `${head}\n  前回: ${p.settled_note}` : head
    }),
    "",
    "**今回できることが無いなら `record_pending_conclusion` で一行残す。** 残すとこの件は次回の実行条件から外れる",
    "(一覧には残る — 承認はまだ要る)。呼ばないと、この件を理由に自動処理が毎回実行され、",
    "毎回同じ「あなた待ちです」を書き直すことになる。**前回の結論が既に載っているなら、",
    "同じことをもう一度書かない。**状況が動いたときだけ `record_pending_conclusion` を上書きする。",
  ].join("\n")
}

function renderRefusedSection(d: CyclePlan): string | undefined {
  if (d.refused.length === 0) return undefined
  return [
    // 断られた提案を渡さないと、同じ相手に同じ用件を出し直す。
    "## 断られた提案(同じ形をもう一度出さない)",
    ...d.refused.map((p) => `- ${p.summary}\n  → ${p.reason}`),
    "",
    "**理由が「前提が変わった」「その用件自体を中止した」なら、その用件は出さない。**",
    "日付や文面を差し替えて出し直してよいのは、断られた理由がその一点だけだったとき。",
  ].join("\n")
}

/** owner の未読の最後の1件だけに付ける。場所は provenance から読む。 */
function discordAck(events: readonly ObservedEvent[]): { channelId: string; messageId: string } | undefined {
  for (const e of [...events].reverse()) {
    if (e.source !== "owner" || !e.origin_id || !e.provenance) continue
    try {
      const refs = JSON.parse(e.provenance) as { kind?: string; ref?: string }[]
      const channelId = refs.find((r) => r.kind === "discord" && typeof r.ref === "string")?.ref
      if (channelId) return { channelId, messageId: e.origin_id }
    } catch {
      // 形が違う記録は飛ばす
    }
  }
  return undefined
}

/** 「何もしない」を正解として明示する。成果を出さねばと読ませると、用が無いのに watch を増やし propose を出す。 */
function buildPrompt(
  d: CyclePlan,
  spokenTo: boolean,
  workspaces: readonly Workspace[],
  imageNotes: readonly string[] = [],
): string {
  const sections: string[] = []

  sections.push(
    [
      spokenTo
        ? "**ユーザーがいま話しかけている。**下に載っている owner の入力がそれ。"
        : "これは自動処理(定期起動)。ユーザーに話しかけられて動いているのではない。",
      spokenTo
        ? `いま ${d.at}。**この回で最後に書いた文が、そのまま Discord の返信として届く。**`
        : `いま ${d.at}。**ユーザーはこの場にいない** — 訊いても今は誰も答えない。`,
      "",
      `## 今回の実行条件`,
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
  if (imageNotes.length > 0) {
    sections.push(
      [
        "## 受け取った画像(モデルによる記述・未検証)",
        ...imageNotes,
        "",
        "記述は言い換えであって原文ではない。日付・金額のような確定が要る値は、本文か",
        "ユーザーへの確認で裏を取ってから使う。",
      ].join("\n"),
    )
  }
  const watchSection = renderWatchSection(d)
  if (watchSection) sections.push(watchSection)
  if (d.openQuestions.length > 0) {
    sections.push(
      [
        "## 未解決の問い(ユーザーにしか答えられないものは、そのまま置いておいてよい)",
        ...d.openQuestions.map((q) => `- ${short(q.id)} ${q.question}`),
      ].join("\n"),
    )
  }
  const pendingSection = renderPendingSection(d)
  if (pendingSection) sections.push(pendingSection)
  const refusedSection = renderRefusedSection(d)
  if (refusedSection) sections.push(refusedSection)

  // 道具(`workspaces`)を置くだけでは引かれない。存在を知らないと引く判断ができないので毎回載せる。
  if (workspaces.length > 0) {
    sections.push(
      [
        "## 使える workspace(`shell` の workspace に渡す名前)",
        renderWorkspaces(workspaces, Date.parse(d.at)),
        "",
        "**続きをやれるものが在るなら新しく作らない。** 作り直すと依存の取得からやり直しになり、",
        "その回の持ち時間がそれで終わる。新しく作るときは `purpose` に何のための場所かを一行書く。",
      ].join("\n"),
    )
  }

  // 下書きの規律は出す日にだけ載せる。毎回渡すと、書かない回にもコンテキスト容量を使う。
  if (d.draftDue) {
    const pending = d.pendingDraft
    // 正本は共有 skill(~/.famulus/skills/jissoku-writing)。読めない日は DRAFTING だけで書き、下書きは止めない。
    const overlay = jissokuOverlay()
    sections.push(
      [
        "## 今日ぶんの下書き",
        ...(pending
          ? [
              pending.state === "review_pending"
                ? "レビュー待ちの下書きがある。新しく書かず、次の本文を `draft` に渡して再開する。"
                : pending.state === "revision_needed"
                  ? "修正待ちの下書きがある。前回の精査に沿って本文を改稿してから `draft` に渡す。"
                  : "下書きはDiscordの送信待ちに入っている。新しく書かない。",
              ...(pending.reviewFeedback ? [`前回の結果: ${pending.reviewFeedback}`] : []),
              "",
              `題: ${pending.title}`,
              `調査dossier: ${pending.dossierId}`,
              "本文:",
              pending.body,
              "",
            ]
          : []),
        "1日に1本、外に出せる文を `draft` で置く。出す先は Zenn を想定した記事。",
        "",
        "**書き始める前に `recall` で自分の走行記録を引く。** 切られた自動処理、通らなかった経路、",
        "動かなかった設定、使ったモデル利用量 — 自走するエージェントを実際に動かして失敗した記録は他の誰も持っていない。",
        "引いて何も出てこなければ `draft` を呼ばず、「書ける実測が無い」と一行書いて終える。",
        "",
        DRAFTING,
        ...(overlay ? ["", overlay] : []),
      ].join("\n"),
    )
  }

  sections.push(
    [
      "## 今回やること",
      `**この回に使える時間は ${Math.round(TIMEOUT_MS / 1000)} 秒**。\`shell\` の返り値に残りが出る。` +
        "尽きる前に中断して、分かったことを書く。続きは同じ workspace の名前を渡せば次回継げる。",
      "",
      ...(spokenTo
        ? [
            "**最後に書いた文がそのまま返信になる。** `tell` は要らない — 同じ画面に出る。",
            "答えるのであって、報告しない。何を調べたか・どの道具を呼んだかは書かない。",
            "訊かれたことに先に答え、動いたなら何がどうなったかを書く。判断を変える気づきは添えてよいが、",
            "無関係な話題、作業記録、答えを言い直すためだけの説明は書かない。",
          ]
        : [
            "**書いても届かない。** ここで書いたものは自分の側に残るだけで、ユーザーは読みに来ない。",
            "読んでほしいものがあるなら `tell` で Discord に通知する。ただし**用があるときだけ**",
            "— 動いた結果、知らないと選べないこと、期限が迫っているもの。経過や気付きだけでは通知しない。",
            "通知回数が増えるほど、次の通知が読まれにくくなる。",
          ]),
      "",
      "**調べ直すより、取得済みの情報で終える。** 自動処理は数分で切られる。途中で切られると",
      "その回の働きは丸ごと消えて、ユーザーには何も残らない。だから:",
      "- `recall` は当たった時点で止める。**同じ語をもう一度引かない**。「該当なし」が2回続いたら DB に無い。",
      "- DB を読むだけなら `recall` を自分で引く。委譲エージェント(`digger` / `researcher`)を呼ぶのは",
      "  **1回では足りないとき**と、**web を調べるとき**だけ。",
      "- **X(投稿・反応・発表)は `x_search`**。検索エンジンの要約ではなく実在の投稿と URL が返る。",
      "  観点を1つに絞り、分かっているならハンドルと日付で絞る。",
      "- **探索は観点別の独立タスクに分ける。** 同じ問いを1つの文脈で順に調べると、2件目は1件目の語彙を",
      "  引き継いで同じ観点しか見なくなる。**別の観点を別の委譲エージェントに渡し、互いの結果は見せない。**",
      "  統合するのは結果が戻ってから。答えが見えている段階では分割せず、取得済みの情報で終える。",
      '  観点を自分で並べられない広い問いは、`researcher` に mode: "explore" を渡すと7方向の独立探索に割れる',
      "  (残り時間が足りない回は断られる — そのときは分割せず終える)。",
      "- AI の動向は**一次の先を名指しで引く** — search の where に arxiv・hfpapers、リリースは release(語は owner/repo)。",
      "  既定の検索先は索引なので、二次の索引だけを根拠に結論しない。",
      "- 委譲依頼の中に「たぶんこう返る」と、その予想を外す条件を書く。予告どおりなら既に知っていたことの",
      "  確認でしかない。**予告を外した返りだけが新しい。** 利用者への本文には委譲前の予告や経過を書かず、外れた側を書く。",
      "- **ユーザーに届ける価値があると判断するなら、同じ評価基準で除外したものを1つ名指す。**",
      "  除外例を名指せない評価基準は何でも採用するので、採用されたことが証拠にならない。",
      "- 必要な情報が揃ったらそこで打ち切って、`tell` なり `remember` なりで形にして終える。",
      "- 指示や記録の仕組みに分かりにくい点があったら `confusion` で1行残す。タスクの難しさは書かない。無ければ呼ばない。",
      "",
      // 「何もしないでよい」は載せるものが無い回にだけ言う。無条件に書くと、冷却の明けた watch を並べながら
      // 動かなくてよいと言うことになる。「必ず何かやれ」と書くと用の無い watch と提案が増える。
      ...(spokenTo
        ? [
            "**訊き返してよい。** 相手はいま画面の前にいる。分岐が決められないなら、",
            "選べる形にして1つだけ訊く(ask で置くのは、その場で答えが要らないものだけ)。",
          ]
        : d.stalled.length > 0
          ? [
              "**上の「対応対象の watch」から、この回で少なくとも1件に対応する。** human が次に動くものは状態を確認し、",
              "famulus が次に動くものは自分の担当作業を進める。対応して `record_watch_run` に残せば、",
              "**変化が無い結果でもこの回の成果になる。** 一覧を眺めて終えた回だけが何も残さない。",
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

const blocked = Effect.gen(function* () {
  const gov = yield* Governance
  const model = cycleModel()
  return yield* gov
    .precheck({
      pool: poolForModel(model),
      at: nowIso(),
      nowMs: Date.now(),
      lane: "autonomous",
    })
    .pipe(
      Effect.as(undefined as string | undefined),
      Effect.catch((e) => Effect.succeed(isRefusal(e) ? describeRefusal(e) : String(e))),
    )
})

/** cycle の起動回数だけ数える。行を増やさずに最終実行状態を確認するための最小記録。 */
const bumpCount = (key: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const n = Number((yield* db.meta(key)) ?? 0) + 1
    yield* db.setMeta(key, String(n))
    return n
  })

const assertLease = (token: CycleLeaseToken): Promise<void> =>
  run(Effect.flatMap(CycleLease, (lease) => lease.assertCurrent(token)))

export interface CycleDependencies {
  readonly createAssistant?: (opts: AssistantOptions) => {
    readonly respond: (
      input: string,
      opts?: { readonly signal?: AbortSignal | undefined },
    ) => Promise<AssistantTurnResult>
  }
  readonly keep?: (opts: Parameters<typeof keep>[0]) => Promise<string>
  readonly wakePendingDelivery?: (enabled: boolean) => Promise<boolean>
}

async function runCycleHeld(
  token: CycleLeaseToken,
  leaseAbort: AbortController,
  dependencies: CycleDependencies,
): Promise<string> {
  const leaseSignal = leaseAbort.signal
  const wakeDelivery = dependencies.wakePendingDelivery ?? wakePendingDelivery
  const d = await run(
    Effect.gen(function* () {
      const lease = yield* CycleLease
      yield* lease.assertCurrent(token)
      // planCycle より先に読む。後だと、届いていた返事が次回まで読まれない。
      const arrived = yield* drainInbox
      const db = yield* Db
      yield* db.setMeta("health:inbound:last_success", nowIso())
      if (arrived > 0) log(`受信箱から ${arrived} 件`)
      const att = yield* Attention
      return yield* att.planCycle()
    }),
  )
  // 手動起動や idle/blocked の回でも、配送 worker へ queue を渡す。
  await wakeDelivery(CONFIG.discord.token !== undefined)

  // 実行条件が無い回はここで終わる。モデルは呼ばない。
  if (d.idle) {
    // 1日1回の見直しは idle の回に回す。話しかけられた回に挟むとその秒数だけ返事が遅れる。
    // idle の回が来なかった日は翌日へ回る(`dream:through` が進んだ位置を持つ)。
    const shouldDream = await run(dreamDue(d.at))
    if (shouldDream) await assertLease(token)
    const dreamed = shouldDream
      ? await run(dream({ signal: leaseSignal })).catch((e: unknown) => `dream: 失敗(${causeReason(e)})`)
      : undefined
    if (dreamed) log(dreamed)
    // 実行済み状態は見直しと別に持つ。見直しが失敗した日に掃除まで止めない。
    const shouldClean = await run(cleanupDue(d.at))
    if (shouldClean) await assertLease(token)
    const swept = shouldClean
      ? await run(cleanup()).catch((e: unknown) => `cleanup: 失敗(${causeReason(e)})`)
      : undefined
    if (swept) log(swept)
    const n = await run(
      Effect.gen(function* () {
        const lease = yield* CycleLease
        yield* lease.assertCurrent(token)
        const att = yield* Attention
        const db = yield* Db
        const mem = yield* Memory
        const n = yield* bumpCount("cycle:idle_count")
        // 失敗した回にも付ける。付けないと同じ失敗を15分ごとに1日じゅう繰り返す。
        if (dreamed) yield* db.setMeta(DREAM_DAILY, localDayRange(d.at).key)
        if (swept) yield* db.setMeta(CLEANUP_DAILY, localDayRange(d.at).key)
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
        // 見ていないので進めない。入れ違いに届いたぶんまで既読にすると、何も返らないまま消える。
        yield* att.completeCycle({ upto: d.cursor })
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

  // owner の未読があるなら、この回の最後の文は DB ではなくユーザーの画面へ出す。
  const spokenTo = d.newEvents.some((e) => e.source === "owner")
  log("実行条件:", d.reasons.join(" / "), spokenTo ? "(返信)" : "")

  // 答えまで数分かかるので、受け取った発言に 👀 を付けて先に返す(本文は増やさない)。
  const acked = spokenTo ? discordAck(d.newEvents) : undefined
  if (acked) {
    await run(
      Effect.gen(function* () {
        const discord = yield* Discord
        const outbound = yield* discord.enqueue({
          purpose: "cycle-ack",
          dedupeKey: acked.messageId,
          text: "",
          ack: { ...acked, emoji: "👀" },
        })
        if (outbound) yield* discord.flushOutbound(outbound.id)
      }),
    ).catch(() => {})
  }

  // 道具一式はモデル実行が決まってから読み込む。idle の回の起動は DB を1回引くだけで終える。
  const createAssistant =
    dependencies.createAssistant ?? (await import("./agent/assistant.ts")).createAssistant

  // typing は即時、道具の経過は1通を編集で更新する。durable queue は通さない。自律実行の回には出さない。
  const display = acked ? await run(Effect.map(Discord, (dc) => dc.progressFor(acked.channelId))) : undefined

  try {
    const assistant = createAssistant({
      model: cycleModel(),
      leaseToken: token,
      // 外部書き込みは、この回で実際に読んだ owner event の引用まで照合する。
      ownerEvidence: d.newEvents
        .filter((event) => event.source === "owner" && event.taint === 0)
        .flatMap((event) => {
          const text = ownerEvidenceText(event)
          return text === undefined ? [] : [{ id: event.id, text }]
        }),
      onLeaseLost: (reason) => leaseAbort.abort(reason),
      ...(display ? { onToolStep: (tools, targets) => display.want(`🛠 ${tally(tools, targets)}`) } : {}),
    })
    // 起動時のプロンプトに書いた締切は判断の時点では古いので、道具に締切を見せる(src/core/deadline.ts)。
    startDeadline(TIMEOUT_MS)
    // 切られても例外を外へ出さない。出すと completeCycle に届かず冷却の起点が進まないので、
    // 次のタイマーが同じ理由で失敗を繰り返す。失敗した回も1回動いた回として締める。
    const deadline = AbortSignal.timeout(TIMEOUT_MS)
    // プロンプトより先に画像の記述を付ける。無いと返信が画像に触れられない。
    const imageNotes = await run(describePendingImages(d.newEvents, { signal: deadline })).catch(
      (e: unknown) => {
        log("画像の記述に失敗:", causeReason(e))
        return [] as string[]
      },
    )
    const prompt = buildPrompt(d, spokenTo, await run(listWorkspaces), imageNotes)
    // 載せた記録は planCycle ではなくここで付ける。planCycle は idle の回にも走るので、そこで付けると
    // 読まれていない一覧の順番が進む。切られた回でも記録は残す。
    if (d.stalled.length > 0) {
      await run(
        Effect.gen(function* () {
          const lease = yield* CycleLease
          yield* lease.assertCurrent(token)
          const att = yield* Attention
          yield* att.noteShown(d.stalled.map((w) => w.id))
        }),
      )
    }
    const began = Date.now()
    await assertLease(token)
    const ticker = display ? setInterval(() => void run(display.tick()).catch(() => {}), 5_000) : undefined
    if (display) void run(display.tick()).catch(() => {})
    let turn: Awaited<ReturnType<typeof assistant.respond>>
    try {
      turn = await assistant.respond(prompt, { signal: AbortSignal.any([deadline, leaseSignal]) })
    } finally {
      if (ticker) clearInterval(ticker)
      // 切られた回も消す(⚠️ の合図が残る)。
      if (display) await run(display.stop()).catch(() => {})
    }
    const ms = Date.now() - began
    // 時間切れとそれ以外の止まり方を混ぜない。混ぜると上限到達とモデルの失敗が同じ文言になる。
    const cutOff = turn.cutOff
      ? deadline.aborted
        ? `${Math.round(TIMEOUT_MS / 1000)}秒で時間切れ`
        : turn.cutOff
      : undefined
    if (cutOff) log("止まった:", cutOff, `/ ${turn.steps} 手まで`)

    // 切られた回でも書けた文は捨てない。それがその回の唯一の記録になることがある。
    let text = (turn.text || (cutOff ? `(${cutOff}。この回の締めの文は書けていない)` : "")).trim()

    // 返信は keeper より先に配送する。durable queue に置いてから flush する。
    // 鍵は締めの前に落ちた回の再実行でも同じなので、二重送信にならない。
    const deliveryKey = digestOf({
      reasonKey: d.reasonKey,
      upto: d.newEvents.at(-1)?.rowid ?? d.cursor,
      inputIds: d.newEvents.map((event) => event.id),
    })
    if (spokenTo && text && !cutOff) {
      await assertLease(token)
      // 保存に失敗したら入力を未処理のまま残す。配送失敗とは違い、再送できる本文がまだ無い。
      const outbound = await run(
        Effect.gen(function* () {
          const db = yield* Db
          const discord = yield* Discord
          const existing = yield* db.get(
            "SELECT id FROM discord_outbound WHERE purpose='cycle-reply' AND dedupe_key=?",
            deliveryKey,
          )
          // 締める前に落ちた回では、保存済みの返信を正本にする。enqueue の spec 照合は緩めない。
          if (existing) return yield* discord.getOutbound(String(existing.id))
          return yield* discord.enqueue({ purpose: "cycle-reply", dedupeKey: deliveryKey, text })
        }),
      )
      if (outbound) {
        text = outbound.actions
          .filter((action) => action.kind === "message")
          .map((action) => {
            const spec = action.spec
            if (
              typeof spec !== "object" ||
              spec === null ||
              !("message" in spec) ||
              typeof spec.message !== "object" ||
              spec.message === null ||
              !("content" in spec.message) ||
              typeof spec.message.content !== "string"
            )
              throw new Error("保存済みの cycle 返信本文を読めない")
            return spec.message.content
          })
          .join("")
        await run(Effect.flatMap(Discord, (discord) => discord.flushOutbound(outbound.id))).catch(
          (e: unknown) => log("返信の配送に失敗(保存済みの queue を保持):", causeReason(e)),
        )
      }
    }

    // keeper はユーザーが話した回にだけ通し、材料はユーザーの発言だけにする。
    // 切られた回は確かめられたかを判断できないので通さない。
    let kept: string | undefined
    if (spokenTo && !cutOff) {
      const evidence = d.newEvents.filter((e) => e.source === "owner" && e.taint === 0)
      const material = evidence.map(renderEvent).join("\n")
      // `since` はこの回の起点。本体が確定させた slot を keeper が言い換え直さないため。
      await assertLease(token)
      const keepInput = {
        material,
        evidence: evidence.map((e) => ({ id: e.id, text: renderEvent(e) })),
        since: d.at,
        signal: AbortSignal.any([AbortSignal.timeout(KEEP_MS), leaseSignal]),
      } satisfies Parameters<typeof keep>[0]
      kept = await (dependencies.keep ? dependencies.keep(keepInput) : run(keep(keepInput))).catch(
        (e: unknown) => `keeper: 落ちた(${causeReason(e)})`,
      )
      log(kept)
    }

    await run(
      Effect.gen(function* () {
        const lease = yield* CycleLease
        yield* lease.assertCurrent(token)
        const mem = yield* Memory
        const att = yield* Attention
        const discord = yield* Discord
        yield* mem.remember({
          kind: "observe",
          source: "system",
          // `said` は自己申告なので、呼び出し側で数えた `tools`・`steps`・`ms` を別の欄に置く。
          // 止まったことが `said` に書かれるとは限らないので `cutOff` も残す。
          content: {
            cycle: d.at,
            cycleId: currentCycleId(),
            reasons: d.reasons,
            said: text,
            tools: turn.tools,
            ...(turn.toolTargets ? { toolTargets: turn.toolTargets } : {}),
            steps: turn.steps,
            ms,
            ...(cutOff ? { cutOff } : {}),
            ...(turn.confusion ? { confusion: turn.confusion } : {}),
            ...(kept ? { kept } : {}),
          },
          // 索引には言ったことだけ入れる。`deriveText` に任せると起動時刻や理由の定型句が毎回混ざり、
          // 何を検索してもそれが当たる。
          text,
          at: nowIso(),
        })
        yield* bumpCount("cycle:active_count")
        // active を立てるのはここだけ(次の cycle はこの時刻から冷却を数える)。reasonKey を渡すと同じ組み合わせの
        // 冷却が倍になる。進めるのは planCycle に載った行まで。最大 rowid にすると走行中に届いたぶんが落ちる。
        yield* att.completeCycle({
          active: true,
          reasonKey: d.reasonKey,
          upto: d.newEvents.at(-1)?.rowid ?? d.cursor,
        })
        // 👀 は進行中の印なので、終わりの合図と同時に外す。
        if (acked)
          yield* discord
            .enqueue({
              purpose: "cycle-done",
              dedupeKey: acked.messageId,
              text: "",
              ack: { ...acked, emoji: cutOff ? "⚠️" : "✅", clear: "👀" },
            })
            .pipe(Effect.catch(() => Effect.void))
        // 進み具合は1日1通。書いた記録を読み直して出す(数え直すと `fam journal` と食い違う)。
        // 境界(meta)は enqueue の後に書く。逆だと enqueue に失敗した日ぶんが二度と出ない。
        const db = yield* Db
        const w = dailyLogWindow(yield* db.meta("log:upto"), nowIso())
        if (w) {
          if (w.post) {
            const entries = yield* readJournalRange(w.post.fromIso, w.post.toIso)
            if (entries.length > 0) {
              yield* lease.assertCurrent(token)
              const proposals = yield* Proposals
              const pending = (yield* proposals.list("proposed", MAX_PENDING_SHOWN)).length
              yield* discord.enqueue({
                purpose: "cycle-log",
                dedupeKey: digestOf({ dailyLog: w.post.label }),
                text: dailyPost(entries, w.post.label, pending),
                to: "log",
              })
            }
          }
          yield* db.setMeta("log:upto", w.set)
        }
      }),
    )
    // 独立 worker だけに任せると次の poll まで queued のまま待つので、書けた時点で起こす。
    // 失敗しても例外にしない(queue は永続で、次の poll が再送する)。
    await wakeDelivery(CONFIG.discord.token !== undefined)
    if (cutOff) return `止まった(${cutOff})— 走った跡は DB に残っている`
    return text ? `動いた: ${text.slice(0, 400)}` : "動いた(発話なし)"
  } finally {
    clearDeadline()
  }
}

export async function runCycle(dependencies: CycleDependencies = {}): Promise<string> {
  // dream を含む cycle 内の全モデル実行を、自走枠で検査・計上する。
  setLane("autonomous")
  let token: CycleLeaseToken
  try {
    token = await run(
      Effect.flatMap(CycleLease, (lease) => lease.acquire({ ttlMs: CONFIG.cycle.leaseTtlMs })),
    )
  } catch (error) {
    const tag = (error as { _tag?: unknown })._tag
    if (tag === "CycleLeaseHeld") return "見送った: 別のcycleが実行中"
    if (tag === "CycleLeaseRecoveryUncertain") return "見送った: 前のcycleの終了を確認できない"
    throw error
  }

  const leaseAbort = new AbortController()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: Promise<void> | undefined
  let heartbeatFailure: unknown
  const schedule = () => {
    timer = setTimeout(() => {
      heartbeat = run(Effect.flatMap(CycleLease, (lease) => lease.heartbeat(token)))
        .catch((error) => {
          heartbeatFailure = error
          leaseAbort.abort(error)
        })
        .finally(() => {
          heartbeat = undefined
          if (!stopped) schedule()
        })
    }, CONFIG.cycle.heartbeatMs)
  }
  schedule()

  try {
    const result = await withCycleContext(randomUUID(), () => runCycleHeld(token, leaseAbort, dependencies))
    if (heartbeatFailure) throw heartbeatFailure
    return result
  } finally {
    stopped = true
    clearTimeout(timer)
    await heartbeat
    await run(Effect.flatMap(CycleLease, (lease) => lease.release(token))).catch((error) => {
      if (!heartbeatFailure) throw error
    })
    clearDeadline()
  }
}

const main = async (): Promise<void> => {
  const rt = runtime()
  try {
    console.log(await runCycle())
  } catch (e) {
    // 拒否(halt / クォータ再実行抑止 / 自律実行上限)は失敗ではない。既読位置を進めないので次の cycle が同じ入力を見る。
    const cause = e instanceof Error && "cause" in e ? (e as { cause?: unknown }).cause : undefined
    const inner = isRefusal(cause) ? cause : e
    if (inner instanceof ConnectorFailed) {
      await run(
        Effect.flatMap(Db, (db) =>
          db.setMeta(
            "health:inbound:last_failure",
            JSON.stringify({ at: nowIso(), stage: "cycle-inbox", error: String(inner) }),
          ),
        ),
        rt,
      ).catch(() => {})
    }
    console.log(isRefusal(inner) ? `見送った: ${describeRefusal(inner)}` : `落ちた: ${String(inner)}`)
    if (!isRefusal(inner)) process.exitCode = 1
  } finally {
    await rt.dispose()
  }
}

if (import.meta.main) await main()
