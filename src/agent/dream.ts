/**
 * 何日ぶんかをまとめて見直す回。1回のやり取りの中では見えないものを拾う。
 *
 * keeper(docs/adr/0014)は owner 入力への tick 応答が完了したとき、その回の発言だけを判定する。
 * 「3日にわたって同じことを言っている」「先週の値が今週の発言で変わった」の類は、
 * 1回ぶんの材料の中に現れないので保存対象にならない。ここは対象期間を複数日に広げて同じ判定を通す。
 * 判定は keeper と同じものを使う — 引用の照合(keepGrounded)も1回の上限も共通で、
 * 違うのは材料の集め方と、進んだところを覚えておくところだけ。
 *
 * 材料はユーザーの発言に限る。import(過去の会話から起こした要約)は taint=1 で、
 * 「その日時点で誰かがそう書いた」という記録でしかない。ここを開くと、要約の言い換えが
 * 事実として確定に入る。OpenClaw の dreaming も同じ扱いで、untrusted と system 由来は
 * 点を引くのではなく候補から外している(構造で外す。点数で下げると、材料が少ない日に通る)。
 *
 * 進んだところは `dream:through` に置く。次の回はそこから先だけを見る —
 * 同じ材料を毎晩読み直すと、同じ値が毎晩再保存され、有効期間が1日だけの履歴行が増え続ける。
 */
import * as Effect from "effect/Effect"
import { dayRange, localHour, nowIso } from "../core/time.ts"
import { Db } from "../services/Db.ts"
import { KEEP_MS, keep } from "./keeper.ts"

/** 遡ってよい日数。初回と、長く止まっていたあとに使う。 */
export const DREAM_DAYS = 7

/** 1回で読む発言の上限。超えた分は次の回に残る(取りこぼさない)。 */
export const DREAM_MAX = 60

/** ここまで見た、を置く場所。 */
export const DREAM_CURSOR = "dream:through"

/** その日ぶんを済ませたかどうかを置く場所。値は `dayRange().key`。 */
export const DREAM_DAILY = "daily:dream"

/**
 * ユーザーの時計でこの時刻を過ぎてから回す。既定は 4 時。
 *
 * 前日ぶんの発言が出揃っていて、かつユーザーがモデルを使っていない時間帯に置く。
 * 日付の境界(0 時)より後でなければ、その日ぶんの目印とずれる。
 */
export const DREAM_HOUR = Number(process.env.OPEN_ZERO_DREAM_HOUR ?? 4)

/**
 * この tick で回すかどうか。1日1回。
 *
 * 判定だけで、済んだ印は付けない — 付けるのは実際に回した側(src/tick.ts)。
 * ここで付けると、呼んだが回さなかった回にも印が立つ。
 */
export const dreamDue = (atIso: string) =>
  Effect.gen(function* () {
    if (localHour(atIso) < DREAM_HOUR) return false
    const db = yield* Db
    return (yield* db.meta(DREAM_DAILY)) !== dayRange(atIso).key
  })

/**
 * 対象期間を広げたぶんだけ、判定に足すもの。keeper の本文は書き換えない —
 * あちらは1回ぶんの判定で、そこに「繰り返し」を混ぜると1回の中で数えようとする。
 *
 * 繰り返しを数えてよいと書いてあるかどうかで結果が変わる。書かずに60件を渡した最初の回は
 * 0件で返り、`looked` に「この回で新たに確言された値はない」と書いてきた
 * — 材料が1回ぶんだと思って読んでいる(docs/adr/0018)。
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

/**
 * 材料を集める。モデルは呼ばない。数えるだけで結果が見られるようにしてある。
 *
 * 古い順に返す。上限で切ったとき、切った位置から次の回が続けられる。
 */
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

/**
 * 見直しを1回通す。戻り値は DB に残す1行。
 *
 * `dry` は材料を数えるだけで返る。モデルを呼ばずに「今夜の保存候補があるか」が分かるので、
 * 動きを確かめるときはこちら。
 */
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
      // 対象期間の開始時刻を渡す。この期間中に既に確定した slot は触らない —
      // 触ると、日中に本体が書いた値を夜に言い換えた区間が上に乗る。
      since: from,
      label: "dream",
      extraSystem: DREAM_NOTE,
      header: `直近 ${rows.length} 件のユーザーの発言(${span}・1回ぶんではない)`,
      signal: opts?.signal ?? AbortSignal.timeout(KEEP_MS),
    })

    // 進めるのは最後に読んだ発言の時刻まで。`at` まで進めると、上限で切った分が飛ぶ。
    const through = rows[rows.length - 1]?.at ?? from
    yield* db.setMeta(DREAM_CURSOR, through)
    return `${line}(${span}・${rows.length} 件を見た)`
  })
