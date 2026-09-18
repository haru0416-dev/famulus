/**
 * 1回ごとの進み具合を、外から確かめられる形にする。
 *
 * cycle は自分で起きて自分で終わる。人が見ているのは締めの1文だけで、その文は自分で書いた報告
 * なので、やったと書いてあることとやったことがずれても外からは分からない。
 * ここが読むのは3つの別々の記録で、どれも報告文とは独立に残っている:
 *
 *   1. 呼ばれた道具の並び(`content.tools`)…AI SDK の `onStepFinish` が数えた実際の呼び出し
 *   2. その回に帰属する行…提案・下書き・通知・コンテナ実行・確定した事実
 *   3. モデル使用量(`ledger`)…role を持つ run 数、出力トークン数
 *
 * 実行IDで結び付ける。時刻の窓では、同時に動いた対話や別の回を区別できない。
 * 実行IDを記録する前の履歴は帰属不明のまま読み、時刻から成果や使用量を推測しない。
 *
 * 1と2はずれてよい。一致させるためではなく、ずれ方を読むために並べている
 * (道具を呼んでも中身が残らない回はある。propose せずに終えた回、shell が失敗した回)。
 */
import * as Effect from "effect/Effect"
import type { DbFailed } from "./core/errors.ts"
import { localDayRange, localStamp } from "./core/time.ts"
import { Db } from "./services/Db.ts"

/** 1回ぶん。`said` と、それ以外を混ぜない。 */
export interface Entry {
  /** digest を取った時刻(この回の起点)。 */
  readonly at: string
  /** 実行ごとのID。旧記録は未帰属で、数量も不明として返す。 */
  readonly cycleId: string | undefined
  /** 起きた理由。digest が付けた文言そのまま。 */
  readonly reasons: readonly string[]
  /** 呼ばれた道具の並び。古い回は記録が無いので undefined。 */
  readonly tools?: readonly string[]
  /** 道具ごとの対象(最初の1回ぶん)。回数だけでは「同じ語を引き直したか」が読めない。 */
  readonly toolTargets?: Readonly<Record<string, string>>
  readonly steps?: number
  readonly ms?: number
  /** 止まった理由。最後まで書けていれば undefined。 */
  readonly cutOff?: string
  /** 自分で書いた締めの文。報告であって記録ではない。 */
  readonly said: string
  /** 指示や仕組みへの戸惑い(自己申告)。fam journal でだけ出す — Discord のログには出さない。 */
  readonly confusion?: string
  /** この回に帰属する行数。報告文とは関係が無く、未帰属の回は undefined。 */
  readonly left: Left | undefined
  /** role を持つモデル呼び出しの回数。未帰属の回は undefined。 */
  readonly runs: number | undefined
  /** 出力側だけを取る。未帰属の回は undefined。 */
  readonly outTok: number | undefined
}

/** 実行IDが一致する行。0 と未帰属を混ぜない。 */
export interface Left {
  readonly proposals: number
  readonly drafts: number
  readonly tells: number
  readonly shells: number
  readonly beliefs: number
  readonly watchRuns: number
}

/** content から取り出す用。DB の JSON は何でも入りうるので、形が違えば黙って落とす。 */
const arr = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)

/** 道具名→対象の表。値が文字列でないものは落とす(DB の JSON は何でも入りうる)。 */
const strMap = (v: unknown): Record<string, string> | undefined => {
  if (v === null || typeof v !== "object") return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && val !== "") out[k] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 直近 n 回。実際に動いた回だけ返す(idle の回は cycle の記録を書かない)。
 *
 * 回ごとに数える問い合わせを投げるので、n を大きくすると SQL の本数がそのぶん増える。
 * 読むのは人なので、既定は画面に収まる程度にしてある。
 */
export const readJournal = (n = 10): Effect.Effect<readonly Entry[], DbFailed, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db.all(
      `SELECT at, content FROM events
        WHERE kind = 'observe' AND source = 'system'
          AND content IS NOT NULL
          AND COALESCE(json_extract(content, '$.cycle'), json_extract(content, '$.tick'))IS NOT NULL
        ORDER BY at DESC LIMIT ?`,
      n,
    )
    return yield* entriesOf(rows)
  })

/**
 * 記録を書いた時刻が [fromIso, toIso) の回。1日ぶんの Discord まとめが読む。
 * 窓の鍵は書いた時刻 — 日付を跨いで書き終えた回は、書き終えた日の側に入る。
 */
export const readJournalRange = (
  fromIso: string,
  toIso: string,
): Effect.Effect<readonly Entry[], DbFailed, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db.all(
      `SELECT at, content FROM events
        WHERE kind = 'observe' AND source = 'system'
          AND content IS NOT NULL
          AND COALESCE(json_extract(content, '$.cycle'), json_extract(content, '$.tick'))IS NOT NULL
          AND at >= ?AND at < ?
        ORDER BY at`,
      fromIso,
      toIso,
    )
    return yield* entriesOf(rows)
  })

const entriesOf = (rows: readonly Record<string, unknown>[]): Effect.Effect<readonly Entry[], DbFailed, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const out: Entry[] = []
    for (const row of rows) {
      const wroteAt = String(row.at)
      let c: Record<string, unknown>
      try {
        c = JSON.parse(String(row.content)) as Record<string, unknown>
      } catch {
        continue
      }
      // 旧イベントの tick は履歴データとして読む。新しい記録は cycle だけを書く。
      const at = str(c.cycle) ?? str(c.tick) ?? wroteAt
      const cycleId = str(c.cycleId)
      const left = cycleId === undefined ? undefined : yield* countLeft(cycleId)
      const burn =
        cycleId === undefined
          ? undefined
          : yield* db.get(
              `SELECT COUNT(*)runs, COALESCE(SUM(out_tok), 0)out_tok
           FROM ledger WHERE cycle_id = ? AND role IS NOT NULL`,
              cycleId,
            )
      const tools = arr(c.tools)
      const toolTargets = strMap(c.toolTargets)
      const steps = num(c.steps)
      const spent = num(c.ms)
      const cutOff = str(c.cutOff)
      const confusion = str(c.confusion)
      out.push({
        at,
        cycleId,
        reasons: arr(c.reasons) ?? [],
        ...(tools ? { tools } : {}),
        ...(toolTargets ? { toolTargets } : {}),
        ...(steps === undefined ? {} : { steps }),
        ...(spent === undefined ? {} : { ms: spent }),
        ...(cutOff ? { cutOff } : {}),
        said: str(c.said) ?? "",
        ...(confusion ? { confusion } : {}),
        left,
        runs: cycleId === undefined ? undefined : Number(burn?.runs ?? 0),
        outTok: cycleId === undefined ? undefined : Number(burn?.out_tok ?? 0),
      })
    }
    return out
  })

/**
 * 同じ実行IDの行を数える。cycle の報告は読まない。
 *
 * watch実行はwatch_runsへ追記されるため、後の実行で古い回から消えない。
 */
const countLeft = (cycleId: string): Effect.Effect<Left, DbFailed, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const ev = yield* db.get(
      `SELECT
         SUM(json_extract(content, '$.drafted')IS NOT NULL)drafts,
         SUM(json_extract(content, '$.told')   IS NOT NULL)tells,
         SUM(json_extract(content, '$.ran')    IS NOT NULL)shells
       FROM events
        WHERE source = 'system' AND kind = 'observe' AND content IS NOT NULL
          AND cycle_id = ?`,
      cycleId,
    )
    const bl = yield* db.get("SELECT COUNT(*)n FROM events WHERE kind = 'belief' AND cycle_id = ?", cycleId)
    const pr = yield* db.get("SELECT COUNT(*)n FROM proposals WHERE cycle_id = ?", cycleId)
    const wr = yield* db.get("SELECT COUNT(*)n FROM watch_runs WHERE cycle_id = ?", cycleId)
    return {
      proposals: Number(pr?.n ?? 0),
      drafts: Number(ev?.drafts ?? 0),
      tells: Number(ev?.tells ?? 0),
      shells: Number(ev?.shells ?? 0),
      beliefs: Number(bl?.n ?? 0),
      watchRuns: Number(wr?.n ?? 0),
    }
  })

/**
 * `shell shell ran shell` → `shell×2 · ran`。並びを捨てて数だけにする。
 *
 * Discord に出す側で使う。幅が狭い場所では並びを持たせられない — 15手ぶんの並びは
 * 92桁になり、スマホの幅で3行に折れて、折り返した先は何の行だったか読めなくなる。
 * 「10回呼んで0本残っていない」というずれは数だけでも見えるので、そちらを取った。
 * 順番は `runs()` が持っていて、`fam journal` から読める。
 */
export const tally = (
  tools: readonly string[],
  targets: Readonly<Record<string, string>> = {},
  top = Number.POSITIVE_INFINITY,
): string => {
  const seen = new Map<string, number>()
  for (const t of tools) seen.set(t, (seen.get(t) ?? 0) + 1)
  const sorted = [...seen].sort((a, b) => b[1] - a[1]) // 同数なら先に呼んだ順(Map が挿入順を持っている)
  const head = sorted
    .slice(0, top)
    .map(([name, n]) => `${label(name, targets)}${n > 1 ? `×${n}` : ""}`)
    .join(" · ")
  // 1日ぶんを畳むと種類が多くて幅を超えるので、上位だけ出して残りは数にする。
  return sorted.length > top ? `${head} · 他${sorted.length - top}種` : head
}

/** 道具名に対象を1つ添える。何に対して呼んだかは、名前と回数だけでは残らない。 */
const label = (name: string, targets: Readonly<Record<string, string>>): string =>
  targets[name] ? `${name}(${targets[name]})` : name

/** `shell shell ran shell` → `shell×2 → ran → shell`。並びは崩さない — 何の後に何を呼んだかが読める。 */
export const runs = (tools: readonly string[], targets: Readonly<Record<string, string>> = {}): string =>
  tools
    .reduce<{ name: string; n: number }[]>((acc, t) => {
      const last = acc.at(-1)
      if (last?.name === t) last.n += 1
      else acc.push({ name: t, n: 1 })
      return acc
    }, [])
    .map((r) => `${label(r.name, targets)}${r.n > 1 ? `×${r.n}` : ""}`)
    .join(" → ")

/**
 * 残ったものを言葉にする。0 の欄は並べない — 0 を並べると「何も残らなかった」という
 * 一番読ませたい状態が数の列に埋もれる。無ければ無いと文で書き、あるものだけを書く。
 */
const leftLine = (l: Left, none = "何も残らなかった"): string => {
  const parts = [
    [l.proposals, "提案", "件"],
    [l.drafts, "下書き", "本"],
    [l.tells, "通知", "件"],
    [l.shells, "コンテナ実行", "回"],
    [l.beliefs, "確定した事実", "件"],
    [l.watchRuns, "watch を実行した", "本"],
  ] as const
  const got = parts.filter(([n]) => n > 0).map(([n, name, unit]) => `${name} ${n}${unit}`)
  return got.length === 0 ? none : got.join(" / ")
}

/** 桁が見えれば足りるので k で丸める。 */
const tok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** 秒だけだと 554 秒が長いのか短いのか読めない。1分を超えたら分に繰り上げる。 */
const took = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`
}

/** 実働の数。手数と時間は記録が無い回がある(記録を足す前の回)ので、0 とは書かない。 */
const workLine = (e: Entry): string =>
  [
    e.steps === undefined ? "手数の記録なし" : `${e.steps}手`,
    ...(e.ms === undefined ? [] : [took(e.ms)]),
    e.runs === undefined || e.outTok === undefined
      ? "使用量不明(未帰属)"
      : `${e.runs}run 出力${tok(e.outTok)}`,
    ...(e.cutOff ? [`止まった: ${e.cutOff}`] : []),
  ].join(" / ")

/** 報告文を1行にまとめる。文の途中では切らない — 途中で切れた文は、言っていないことを言わせる。 */
const saidLine = (said: string, max = 140): string => {
  const flat = said.replace(/\s+/g, " ").trim()
  if (flat === "") return "(何も書かなかった)"
  if (flat.length <= max) return flat
  const head = flat.slice(0, max)
  const stop = Math.max(head.lastIndexOf("。"), head.lastIndexOf("、"))
  return `${stop > max / 3 ? head.slice(0, stop + 1) : head}…`
}

/**
 * 1日ぶんを Discord に1通で出す形。回ごとには出さない — 動くたびに出る行は
 * そのうち読まれなくなる。回ごとの並びと報告文は `fam journal` に残っている。
 *
 * 幅の規律は従来どおり: 読むのはたいてい携帯で、本文に使える幅はおよそ 40 桁
 * (全角20文字)しかない。空白で桁を揃える形は1行折り返した時点で崩れるので、
 * `- ` のリスト項目にしている。道具は1日ぶんを畳むと種類が増えるので上位6種まで。
 *
 * 自己申告(`said`)と対象(`toolTargets`)は載せない — 数えた記録だけを出す。
 */
export const dailyPost = (entries: readonly Entry[], label: string, pending = 0): string => {
  const cut = entries.filter((e) => e.cutOff !== undefined)
  const ms = entries.reduce((a, e) => a + (e.ms ?? 0), 0)
  const attributed = entries.filter((e) => e.cycleId !== undefined)
  const unknown = entries.length - attributed.length
  const runCount = attributed.reduce((a, e) => a + (e.runs ?? 0), 0)
  const outTok = attributed.reduce((a, e) => a + (e.outTok ?? 0), 0)
  const tools = entries.flatMap((e) => e.tools ?? [])
  const left = attributed.reduce<Left>(
    (a, e) => ({
      proposals: a.proposals + (e.left?.proposals ?? 0),
      drafts: a.drafts + (e.left?.drafts ?? 0),
      tells: a.tells + (e.left?.tells ?? 0),
      shells: a.shells + (e.left?.shells ?? 0),
      beliefs: a.beliefs + (e.left?.beliefs ?? 0),
      watchRuns: a.watchRuns + (e.left?.watchRuns ?? 0),
    }),
    { proposals: 0, drafts: 0, tells: 0, shells: 0, beliefs: 0, watchRuns: 0 },
  )
  return [
    `### ${label} のまとめ`,
    // 止まった回はここに出す。下に置くと、上だけ読んで全部走り切った日と見分けが付かない。
    ...(cut.length > 0 ? [`- **止まった ${cut.length}回** ${tally(cut.map((c) => c.cutOff ?? ""))}`] : []),
    `- 動いた ${entries.length}回${ms > 0 ? ` / 計${took(ms)}` : ""}`,
    ...(unknown > 0 ? [`- 未帰属 ${unknown}回: 数量不明`] : []),
    ...(unknown > 0 && attributed.length > 0 ? [`- 集計対象 IDあり ${attributed.length}回`] : []),
    `- 推論 ${attributed.length > 0 || unknown === 0 ? `${runCount}run / 出力${tok(outTok)}` : "不明(未帰属)"}`,
    `- 道具 ${tools.length > 0 ? tally(tools, {}, 6) : "記録なし"}`,
    `- 残った ${attributed.length > 0 || unknown === 0 ? leftLine(left, "なし") : "不明(未帰属)"}`,
    // 他の行は前の日ぶんの集計だが、これだけは出す時点の残数。混ぜて読まれないよう明示する。
    ...(pending > 0 ? [`- 承認待ち ${pending}件(現在)`] : []),
  ].join("\n")
}

/**
 * 1日1回の出しどきの判定。meta には「ここより前の日は出した」の境界(ISO)を置く。
 *
 * 初回は境界を今日の頭に置くだけで出さない — 導入した日に過去ぶんをまとめて流さない。
 * 境界が今日の頭より前なら、そこから今日の頭までを1通ぶんの窓として返す。
 * 空白日を跨いだときは窓が複数日になり、ラベルが「開始日〜終了日」になる。
 */
export const dailyLogWindow = (
  upto: string | undefined,
  atIso: string,
):
  | {
      readonly set: string
      readonly post?: { readonly fromIso: string; readonly toIso: string; readonly label: string }
    }
  | undefined => {
  const today = localDayRange(atIso)
  if (upto === undefined) return { set: today.startIso }
  if (upto >= today.startIso) return undefined
  const fromKey = localDayRange(upto).key
  // 窓の最終日 = 今日の頭の1秒前が属する日。
  const lastKey = localDayRange(new Date(Date.parse(today.startIso) - 1000).toISOString()).key
  return {
    set: today.startIso,
    post: {
      fromIso: upto,
      toIso: today.startIso,
      label: fromKey === lastKey ? fromKey : `${fromKey}〜${lastKey}`,
    },
  }
}

/**
 * 人が読む形に。自己申告(`言った`)を最後に置く。
 * 上に置くと、そこだけ読んで「やった」と受け取れてしまう。数えた欄より先には来させない。
 */
export const renderJournal = (entries: readonly Entry[]): string => {
  if (entries.length === 0) return "実働の記録がまだ無い(自動処理が一度も動いていないか、記録より前)"
  const body = entries.map((e) =>
    [
      `── ${localStamp(e.at)} ${"─".repeat(20)}`,
      `  条件    ${e.reasons.join(" / ") || "実行条件の記録なし"}`,
      `  実働    ${workLine(e)}`,
      `  道具    ${e.tools?.length ? runs(e.tools, e.toolTargets ?? {}) : "記録なし(この回より前)"}`,
      `  残った  ${e.left === undefined ? "不明(未帰属)" : leftLine(e.left)}`,
      `  言った  ${saidLine(e.said)}`,
      ...(e.confusion ? [`  戸惑い  ${e.confusion}`] : []),
    ].join("\n"),
  )
  return [
    `直近 ${entries.length} 回の実働(新しい順)`,
    "  道具 = 実際に呼ばれた並び / 残った = DB に増えた行 / 言った = 自分で書いた報告",
    "",
    body.join("\n\n"),
  ].join("\n")
}
