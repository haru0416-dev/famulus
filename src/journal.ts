/**
 * 1回ごとの進み具合を、外から確かめられる形にする。
 *
 * tick は自分で起きて自分で終わる。人が見ているのは締めの1文だけで、その文は自分で書いた報告
 * なので、やったと書いてあることとやったことがずれても外からは分からない。
 * ここが読むのは3つの別々の記録で、どれも報告文とは独立に残っている:
 *
 *   1. 呼ばれた道具の並び(`content.tools`)…AI SDK の `onStepFinish` が数えた実際の呼び出し
 *   2. その回の窓に残ったもの…提案・下書き・通知・コンテナ実行・確定した事実の行数
 *   3. モデル使用量(`ledger`)…run 数、出力トークン数
 *
 * 窓は `[content.tick, event.at]`。前者は digest を取った時刻、後者は記録を書いた時刻で、
 * その間がこの回の実働。窓の外で起きたことは数えない — 数えると、15分前の poll が入れた
 * ユーザー発言まで「この回の成果」として並ぶ。
 *
 * 1と2はずれてよい。一致させるためではなく、ずれ方を読むために並べている
 * (道具を呼んでも中身が残らない回はある。propose せずに終えた回、shell が失敗した回)。
 */
import * as Effect from "effect/Effect"
import type { DbFailed } from "./core/errors.ts"
import { localStamp } from "./core/time.ts"
import { Db } from "./services/Db.ts"

/** 1回ぶん。`said` と、それ以外を混ぜない。 */
export interface Entry {
  /** digest を取った時刻(この回の起点)。 */
  readonly at: string
  /** 起きた理由。digest が付けた文言そのまま。 */
  readonly reasons: readonly string[]
  /** 呼ばれた道具の並び。古い回は記録が無いので undefined。 */
  readonly tools?: readonly string[]
  readonly steps?: number
  readonly ms?: number
  /** 止まった理由。最後まで書けていれば undefined。 */
  readonly cutOff?: string
  /** 自分で書いた締めの文。報告であって記録ではない。 */
  readonly said: string
  /** この回の窓に残ったもの。数えたのは行数で、報告文とは関係が無い。 */
  readonly left: Left
  /** モデルを呼んだ回数。 */
  readonly runs: number
  /** 出力側だけを取る。入力はキャッシュの当たり外れで桁ごと動き、回どうしを比べにくい。 */
  readonly outTok: number
}

/** 窓の中に増えた行。0 も 0 と書く — 「何も残らなかった回」を読めるようにするため。 */
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

/**
 * 直近 n 回。実際に動いた回だけ返す(idle の回は tick の記録を書かない)。
 *
 * 窓ごとに数える問い合わせを投げるので、n を大きくすると SQL の本数がそのぶん増える。
 * 読むのは人なので、既定は画面に収まる程度にしてある。
 */
export const readJournal = (n = 10): Effect.Effect<readonly Entry[], DbFailed, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db.all(
      `SELECT at, content FROM events
        WHERE kind = 'observe' AND source = 'system'
          AND content IS NOT NULL AND json_extract(content, '$.tick')IS NOT NULL
        ORDER BY at DESC LIMIT ?`,
      n,
    )

    const out: Entry[] = []
    for (const row of rows) {
      const wroteAt = String(row.at)
      let c: Record<string, unknown>
      try {
        c = JSON.parse(String(row.content)) as Record<string, unknown>
      } catch {
        continue
      }
      const at = str(c.tick) ?? wroteAt
      // 窓の終わりは記録を書いた時刻。書く前に出したものまで入れる。
      // 起点だけで切って「以降ぜんぶ」にすると、次の回のぶんが混ざる。
      const left = yield* countLeft(at, wroteAt)
      const burn = yield* db.get(
        `SELECT COUNT(*)runs, COALESCE(SUM(out_tok), 0)out_tok
           FROM ledger WHERE at >= ?AND at <= ?`,
        at,
        wroteAt,
      )
      const tools = arr(c.tools)
      const steps = num(c.steps)
      const spent = num(c.ms)
      const cutOff = str(c.cutOff)
      out.push({
        at,
        reasons: arr(c.reasons) ?? [],
        ...(tools ? { tools } : {}),
        ...(steps === undefined ? {} : { steps }),
        ...(spent === undefined ? {} : { ms: spent }),
        ...(cutOff ? { cutOff } : {}),
        said: str(c.said) ?? "",
        left,
        runs: Number(burn?.runs ?? 0),
        outTok: Number(burn?.out_tok ?? 0),
      })
    }
    return out
  })

/**
 * 窓の中に増えた行を数える。tick の報告は読まない。
 *
 * watch実行はwatch_runsへ追記されるため、後の実行で古い回から消えない。
 */
const countLeft = (fromIso: string, toIso: string): Effect.Effect<Left, DbFailed, Db> =>
  Effect.gen(function* () {
    const db = yield* Db
    const ev = yield* db.get(
      `SELECT
         SUM(json_extract(content, '$.drafted')IS NOT NULL)drafts,
         SUM(json_extract(content, '$.told')   IS NOT NULL)tells,
         SUM(json_extract(content, '$.ran')    IS NOT NULL)shells
       FROM events
        WHERE source = 'system' AND kind = 'observe' AND content IS NOT NULL
          AND at >= ?AND at <= ?`,
      fromIso,
      toIso,
    )
    const bl = yield* db.get(
      "SELECT COUNT(*)n FROM events WHERE kind = 'belief' AND at >= ?AND at <= ?",
      fromIso,
      toIso,
    )
    const pr = yield* db.get(
      "SELECT COUNT(*)n FROM proposals WHERE created_at >= ?AND created_at <= ?",
      fromIso,
      toIso,
    )
    const wr = yield* db.get("SELECT COUNT(*)n FROM watch_runs WHERE at >= ?AND at <= ?", fromIso, toIso)
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
 * 順番は `runs()` が持っていて、`oz journal` から読める。
 */
export const tally = (tools: readonly string[]): string => {
  const seen = new Map<string, number>()
  for (const t of tools) seen.set(t, (seen.get(t) ?? 0) + 1)
  return [...seen]
    .sort((a, b) => b[1] - a[1]) // 同数なら先に呼んだ順(Map が挿入順を持っている)
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
    .join(" · ")
}

/** `shell shell ran shell` → `shell×2 → ran → shell`。並びは崩さない — 何の後に何を呼んだかが読める。 */
export const runs = (tools: readonly string[]): string =>
  tools
    .reduce<{ name: string; n: number }[]>((acc, t) => {
      const last = acc.at(-1)
      if (last?.name === t) last.n += 1
      else acc.push({ name: t, n: 1 })
      return acc
    }, [])
    .map((r) => (r.n > 1 ? `${r.name}×${r.n}` : r.name))
    .join(" → ")

/**
 * 残ったものを言葉にする。0 の欄は並べない。
 *
 * 前は6つの数を 0 も含めて全部横に並べていた。数の列は読む側が目で走査することになり、
 * 「この回は何も残らなかった」という一番読ませたい状態が、0 が6つ並んだ形でしか出なかった。
 * いまはその状態だけを文にする。残ったものがあるときは、あるものだけを書く。
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

/** 時刻だけ取り出す。読めない値は切らずに返す — `localStamp` は解釈できない文字列をそのまま返す。 */
const clock = (atIso: string): string => {
  const s = localStamp(atIso)
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) ? s.slice(11) : s
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
    `${e.runs}run 出力${tok(e.outTok)}`,
    ...(e.cutOff ? [`**止まった: ${e.cutOff}**`] : []),
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
 * 1回ぶんを Discord に出す形。幅の狭い画面を先に見て決めた。
 *
 * 読むのはたいてい携帯で、本文に使える幅はおよそ 40 桁(全角20文字)しかない。
 * 前は全角空白で桁を揃えて4行に並べていたが、揃えた桁は1行が折り返した時点で消える
 * — 折り返した2行目は左端から始まるので、ラベルと中身の対応が読めなくなる。
 *
 * いまは `- ` のリスト項目にしている。リストは折り返しても中身の側にぶら下がるので、
 * 長い行が入っても項目の切れ目が残る。それでも道具の並びは 92 桁あって3行に折れるため、
 * ここだけは並びを捨てて数にした(`tally`)。
 *
 * 見出しに置くのは時刻だけ。日付は Discord 自身が持っている。
 */
export const logPost = (e: Entry): string =>
  [
    `### ${clock(e.at)} の実行`,
    // 止まった回はここに出す。下に置くと、上だけ読んで終わった回と見分けが付かない。
    ...(e.cutOff ? [`- **止まった** ${e.cutOff}`] : []),
    `- 実行条件 ${e.reasons.join(" / ") || "記録なし"}`,
    `- 実働 ${e.steps === undefined ? "手数の記録なし" : `${e.steps}手`}${e.ms === undefined ? "" : ` / ${took(e.ms)}`}`,
    `- 推論 ${e.runs}run / 出力${tok(e.outTok)}`,
    `- 道具 ${e.tools?.length ? tally(e.tools) : "記録なし"}`,
    `- 残った ${leftLine(e.left, "なし")}`,
  ].join("\n")

/**
 * 人が読む形に。自己申告(`言った`)を最後に置く。
 * 上に置くと、そこだけ読んで「やった」と受け取れてしまう。数えた欄より先には来させない。
 */
export const renderJournal = (entries: readonly Entry[]): string => {
  if (entries.length === 0) return "実働の記録がまだ無い(tick が一度も動いていないか、記録より前)"
  const body = entries.map((e) =>
    [
      `── ${localStamp(e.at)} ${"─".repeat(20)}`,
      `  条件    ${e.reasons.join(" / ") || "実行条件の記録なし"}`,
      `  実働    ${workLine(e).replace(/\*\*/g, "")}`,
      `  道具    ${e.tools?.length ? runs(e.tools) : "記録なし(この回より前)"}`,
      `  残った  ${leftLine(e.left)}`,
      `  言った  ${saidLine(e.said)}`,
    ].join("\n"),
  )
  return [
    `直近 ${entries.length} 回の実働(新しい順)`,
    "  道具 = 実際に呼ばれた並び / 残った = DB に増えた行 / 言った = 自分で書いた報告",
    "",
    body.join("\n\n"),
  ].join("\n")
}
