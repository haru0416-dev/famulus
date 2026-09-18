/**
 * 数日ぶんの owner 発言に keeper と同じ判定を通し、1回のやり取りには現れない繰り返しと値の変化を拾う。
 * 材料は taint=0 の owner 発言だけ。import の要約を入れると、言い換えが belief として確定する。
 * 同じ材料を毎晩読み直すと有効期間1日の履歴行が増え続けるので、`dream:through` から先だけを見る。
 */
import * as Effect from "effect/Effect"
import { appConfig } from "../core/config.ts"
import { localDayRange, localHour, nowIso } from "../core/time.ts"
import { Db } from "../services/Db.ts"
import { KEEP_MS, keep } from "./keeper.ts"

/** 遡ってよい日数。初回と、長く止まっていたあとに使う。 */
export const DREAM_DAYS = 7

/** 超えた分は次の回に読む。 */
const DREAM_MAX = 60

export const DREAM_CURSOR = "dream:through"

/** 値は `localDayRange().key`。 */
export const DREAM_DAILY = "daily:dream"

/**
 * dreamHour は前日ぶんが出揃い、ユーザーが使っていない時間帯。
 * 済んだ記録は実際に回した src/cycle.ts が付ける。ここで付けると、回さなかった回にも付く。
 */
export const dreamDue = (atIso: string) =>
  Effect.gen(function* () {
    if (localHour(atIso) < appConfig().schedule.dreamHour) return false
    const db = yield* Db
    return (yield* db.meta(DREAM_DAILY)) !== localDayRange(atIso).key
  })

/**
 * KEEPER_SYSTEM に混ぜると、1回ぶんの判定でも繰り返しを数えようとするので別に足す。
 * 書かずに渡すと、材料を1回ぶんとして読んで0件で返る。
 */
export const DREAM_NOTE = `この材料は**1回のやり取りではなく、数日ぶん**です。だから次の2つを足して見ます。

- **繰り返し出てくるもの。** 同じ依頼・同じ関心が**別々の機会に**何度も出ているなら、
  それは一度きりの出来事ではありません。今後も参照する確定値として保存してよいものです。
  日をまたいでいれば明らかにそうですが、同じ日のうちに何度も戻ってきている場合も含みます。
  引用は、そのうちの1回からそのまま写します。
  **この種の slot は \`interest.\` で始めます** — 既に \`interest.\` の slot があって同じ事柄なら、
  新しく作らずそれに合わせます。名前が割れると、どちらを引いても片方しか出てきません。
- **値が変わったもの。** 前に言われた値と食い違う発言が後の日にあるなら、
  同じ slot に新しい有効区間を保存します。\`reason\` に何がどう変わったかを書きます。
  こちらは \`interest.\` ではなく、既存の slot の名前をそのまま使います。

回数を数えたこと自体は根拠になりません。**保存するものには必ず、写せる一節が要ります。**`

const shiftDays = (iso: string, days: number): string =>
  new Date(Date.parse(iso) - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z")

export interface DreamRow {
  readonly id: string
  readonly at: string
  readonly text: string
}

/** モデルは呼ばない。古い順に返すので、上限で切った位置から次の回が続けられる。 */
export const dreamMaterial = (opts?: { at?: string; days?: number; limit?: number }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const at = opts?.at ?? nowIso()
    const days = opts?.days ?? DREAM_DAYS
    const cursor = yield* db.meta(DREAM_CURSOR)
    const window = shiftDays(at, days)
    const from = cursor !== undefined && cursor > window ? cursor : window
    const rows = yield* db.all(
      `SELECT e.id AS id, e.at AS at, f.text AS text
         FROM events e JOIN events_fts f ON f.event_id = e.id
        WHERE e.source = 'owner' AND e.taint = 0 AND e.kind = 'observe'
          AND e.content IS NOT NULL AND e.at > ? AND e.at <= ?
        ORDER BY e.at ASC, e.rowid ASC
        LIMIT ?`,
      from,
      at,
      opts?.limit ?? DREAM_MAX,
    )
    return { from, at, rows: rows as unknown as DreamRow[] }
  })

/** 戻り値は DB に残す1行。`dry` はモデルを呼ばずに材料を数える。 */
export const dream = (opts?: {
  at?: string
  days?: number
  limit?: number
  dry?: boolean
  signal?: AbortSignal
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { from, at, rows } = yield* dreamMaterial(opts)
    const span = `${from.slice(0, 10)}〜${at.slice(0, 10)}`
    if (rows.length === 0) return `dream: 材料が無い(${span} にユーザーの発言なし)`
    if (opts?.dry) return `dream: ${rows.length} 件の発言が対象(${span}・モデルは呼んでいない)`

    const material = rows.map((r) => `- ${r.at} ${r.text}`).join("\n")
    const line = yield* keep({
      material,
      evidence: rows.map((r) => ({ id: r.id, text: r.text })),
      // この期間中に既に確定した slot は触らない。触ると、日中に書いた値を夜に言い換えた区間が重なる。
      since: from,
      label: "dream",
      extraSystem: DREAM_NOTE,
      header: `直近 ${rows.length} 件のユーザーの発言(${span}・1回ぶんではない)`,
      signal: opts?.signal
        ? AbortSignal.any([AbortSignal.timeout(KEEP_MS), opts.signal])
        : AbortSignal.timeout(KEEP_MS),
    })

    // `at` まで進めると、上限で切った分を読まずに通り過ぎる。
    opts?.signal?.throwIfAborted()
    const through = rows[rows.length - 1]?.at ?? from
    yield* db.setMeta(DREAM_CURSOR, through)
    return `${line}(${span}・${rows.length} 件を見た)`
  })
