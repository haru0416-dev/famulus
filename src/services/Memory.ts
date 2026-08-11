/**
 * memory サービス。正本は append-only の `events`、`belief_slots` と `events_fts` は projection。
 *
 * **消せないことを SQL 側で強制する。** 忘却は DELETE ではなく `forget` イベントの追記、
 * 抹消は `content := NULL` の UPDATE だけ(それ以外の UPDATE はトリガが ABORT する)。
 *
 * `remember` は引数を最小・既定値を厚くしてある。**器があっても記録が溜まらなければ台帳は無いのと同じ**で、
 * 溜まらない原因が API の摩擦なら、それは設計の側で消せる。
 */
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { localStamp, nowIso } from "../core/time.ts"
import { Db, type Row } from "./Db.ts"

export type EventKind = "observe" | "belief" | "forget" | "redact" | "import"
export type EventSource = "owner" | "calendar" | "gmail" | "web" | "system"
export type Exposure = "private" | "public"

export interface SourceRef {
  readonly kind: string
  readonly ref?: string
  readonly at?: string
}

export interface RememberInput {
  readonly kind?: EventKind
  readonly source?: EventSource
  readonly content: unknown
  /** 不信データ由来か。gmail/web は既定で 1。 */
  readonly taint?: boolean
  readonly exposure?: Exposure
  /** 訂正・忘却の対象イベント id(lineage)。 */
  readonly supersedes?: string
  readonly provenance?: readonly SourceRef[]
  /** 検索用テキスト。省略時は content から導く。 */
  readonly text?: string
  readonly at?: string
}

export interface EventRow {
  readonly id: string
  readonly at: string
  readonly kind: EventKind
  readonly source: EventSource
  readonly taint: number
  readonly exposure: Exposure
  readonly supersedes: string | null
  readonly provenance: string
  readonly content: string | null
  /** FTS に入れた素のテキスト(JSON の殻を剥いだもの)。読ませるのはこちら。 */
  readonly text: string | null
  /** belief のとき、その slot の**今の値**か(0 なら上書き済みの旧版)。 */
  readonly is_current: number
}

/**
 * この belief イベントが、その slot の今の値か。
 *
 * `believe()` は追記なので、同じ slot を2回確定すると belief イベントが2本残る。
 * 両方を「確定」として並べると、読む側は**古い値と新しい値を区別できないまま**受け取る。
 * どちらが今なのかは projection(`belief_slots`)だけが知っている。
 *
 * **区間が閉じているかまで見る。** `resolved_from` の一致だけで判定していると、
 * 「転職活動中」を確定した行は上書きされた後も一致し続け、検索の最上位に居座る。
 */
const IS_CURRENT =
  "EXISTS (SELECT 1 FROM belief_slots b WHERE b.resolved_from = e.id AND b.valid_until IS NULL)"

/**
 * 層の重み。bm25 は「小さいほど関連が強い」負の値なので、**引くと前に出る**。
 *
 * 台帳は平らに1本だが、読む価値は平らではない。確定した事実(belief)は持ち主に確かめた1行、
 * `source='system'` は自分が書いた記録。同じ語を含んでいても、探しものとして役に立つ度合いが違う。
 *
 * **`kind` と `source` は別の問いに答えている**。source は誰が書いたか、kind はどんな記録か。
 * 取り込み(`import`)は自分が書くので source は system だが、中身は持ち主の判断の要約であって
 * 独り言ではない。source だけで下げると、入口から入れたものが全部検索の底に沈む。
 * だから `import` を `source='system'` より**先に**判定する。順序がそのまま意味になっている。
 */
const LAYER_BIAS = `CASE
    WHEN e.kind = 'belief' AND ${IS_CURRENT} THEN -2.5
    WHEN e.kind = 'belief'                   THEN  0.5
    WHEN e.kind = 'import'                   THEN  0.5
    WHEN e.source = 'system'                 THEN  1.5
    ELSE 0.0
  END`

/**
 * 検索結果を**読ませる形**にする。呼ぶ側(CLI / recall ツール)で揃えたいのでここに置く。
 *
 * 生の `content` をそのまま出すと `{"said":"…` という JSON の殻がモデルにも人にも見える。
 * 殻は保存の都合であって中身ではない。索引に入れた素のテキストのほうを見せる。
 * 併せて**どの層の1行なのか**を頭に付ける — 確定した事実と自分の独り言を、
 * 読む側が区別できないまま並べない。
 *
 * 時刻は**持ち主の時計**で出す(`localStamp`)。UTC のまま帯なしで渡すと、
 * 夜中の記録が前日として読まれる。
 */
export function renderRecall(rows: readonly EventRow[], perRow = 180): string {
  if (rows.length === 0) return "該当なし"
  return rows
    .map((r) => {
      const label =
        r.kind === "belief"
          ? r.is_current
            ? "確定"
            : "確定(旧版)"
          : r.kind === "import"
            ? // 由来が要約であることを隠さない。持ち主が直接そう言った1行と混ぜて読ませない。
              "取り込み"
            : r.source === "system"
              ? "自分の記録"
              : r.source
      const body = (r.text && r.text.length > 0 ? r.text : safeText(r.content)).replace(/\s+/g, " ").trim()
      const shown = body.length > perRow ? `${body.slice(0, perRow)}…` : body
      return `- [${localStamp(r.at)} ${label}] ${shown}`
    })
    .join("\n")
}

/** content(JSON 文字列)から素のテキストに戻す。索引を持たない行だけがここに来る。 */
function safeText(content: string | null): string {
  if (content === null) return ""
  try {
    return deriveText(JSON.parse(content))
  } catch {
    return content
  }
}

/**
 * 同じ本文の行を畳む。関連度順で最初に出たものを残す。
 * 同じことを5回言われた台帳では、畳まないと1つの話題だけで枠が埋まる。
 */
function dedupe(rows: readonly EventRow[], limit: number): EventRow[] {
  const seen = new Set<string>()
  const out: EventRow[] = []
  for (const r of rows) {
    const key = (r.text ?? String(r.content ?? "")).slice(0, 120)
    if (key.length > 0 && seen.has(key)) continue
    seen.add(key)
    out.push(r)
    if (out.length >= limit) break
  }
  return out
}

/** FTS の trigram tokenizer は3文字窓。2文字以下のクエリは引けないので呼ぶ前に弾く。 */
export const FTS_MIN_QUERY = 3

/** content から検索テキストを起こす。文字列はそのまま、構造体は値だけ拾って連結。 */
function deriveText(content: unknown): string {
  if (typeof content === "string") return content
  if (content === null || content === undefined) return ""
  if (typeof content !== "object") return String(content)
  const parts: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4) return
    if (typeof v === "string") parts.push(v)
    else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v))
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1)
  }
  walk(content, 0)
  return parts.join(" ")
}

/** FTS5 のクエリ構文文字を落として素の語として扱う(ユーザー入力をそのまま渡さない)。 */
function sanitizeFts(q: string): string {
  return q.replace(/["'*(){}:^-]/g, " ").trim()
}

export class Memory extends Effect.Service<Memory>()("Memory", {
  effect: Effect.gen(function* () {
    const db = yield* Db

    /** イベントを1件追記し、FTS projection も同トランザクションで更新する。 */
    const remember = (input: RememberInput) =>
      Effect.gen(function* () {
        const id = randomUUID()
        const at = input.at ?? nowIso()
        const source = input.source ?? "owner"
        const kind = input.kind ?? "observe"
        // gmail/web は既定で taint。明示指定があればそれを優先する。
        const taint = input.taint ?? (source === "gmail" || source === "web")
        const provenance = JSON.stringify(input.provenance ?? [{ kind: source, at }])
        const content = JSON.stringify(input.content ?? null)
        const text = input.text ?? deriveText(input.content)

        yield* db.run("BEGIN")
        const written = yield* Effect.gen(function* () {
          yield* db.run(
            `INSERT INTO events (id, at, kind, source, taint, exposure, supersedes, provenance, content)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            at,
            kind,
            source,
            taint ? 1 : 0,
            input.exposure ?? "private",
            input.supersedes ?? null,
            provenance,
            content,
          )
          if (text.length > 0) {
            yield* db.run("INSERT INTO events_fts (event_id, text) VALUES (?, ?)", id, text)
          }
          yield* db.run("COMMIT")
          return id
        }).pipe(Effect.tapError(() => db.run("ROLLBACK").pipe(Effect.ignore)))
        return written
      })

    /**
     * belief slot を確定する。**projection の直接上書きではなく、必ず belief event を経由**させる
     * (`resolved_from` が NOT NULL の FK なので、根拠なしにスロットは立たない)。
     *
     * 上書きしない。**今の区間に `valid_until` を打って閉じ、次の区間を隣に足す。**
     * 上書きにすると「転職活動中」だった時期そのものが台帳から消え、
     * 過去形の問い(「去年の今ごろ何をしていたか」)に答えられなくなる。
     *
     * `validFrom` は**その事実がいつ真になったか**で、記帳時刻とは別物。
     * 「6月に終わっていたと8月に知った」なら validFrom は6月、updated_at は8月。
     * 分からなければ記帳時刻に落ちる — 推測で埋めるより「遅くともこの時点」のほうが正しい。
     */
    const believe = (
      slot: string,
      value: unknown,
      opts?: { exposure?: Exposure; supersedes?: string; validFrom?: string; reason?: string },
    ) =>
      Effect.gen(function* () {
        const at = nowIso()
        const exposure = opts?.exposure ?? "private"
        const cur = yield* db.get(
          "SELECT resolved_from, valid_from FROM belief_slots WHERE slot = ? AND valid_until IS NULL",
          slot,
        )
        // 遡って書くとき、前の区間より前には戻さない(区間が裏返るとどの並びも壊れる)。
        const prevFrom = cur === undefined ? undefined : String(cur.valid_from)
        const asked = opts?.validFrom ?? at
        const validFrom = prevFrom !== undefined && asked < prevFrom ? prevFrom : asked
        const eventId = yield* remember({
          kind: "belief",
          source: "system",
          content: { slot, value, validFrom },
          exposure,
          // 何を訂正したのかは events 側にも残す。projection を捨てても系譜が辿れる。
          ...((opts?.supersedes ?? cur)
            ? { supersedes: opts?.supersedes ?? String(cur?.resolved_from) }
            : {}),
          text: `${slot} ${deriveText(value)}`,
          at,
        })
        if (cur !== undefined) {
          yield* db.run(
            `UPDATE belief_slots
                SET valid_until = ?, invalidated_by = ?, invalidated_reason = ?
              WHERE slot = ? AND valid_until IS NULL`,
            validFrom,
            eventId,
            opts?.reason ?? null,
            slot,
          )
        }
        yield* db.run(
          `INSERT INTO belief_slots (slot, value, exposure, resolved_from, updated_at, valid_from)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(slot, valid_from) DO UPDATE SET
             value = excluded.value, exposure = excluded.exposure,
             resolved_from = excluded.resolved_from, updated_at = excluded.updated_at,
             valid_until = NULL, invalidated_by = NULL, invalidated_reason = NULL`,
          slot,
          JSON.stringify(value ?? null),
          exposure,
          eventId,
          at,
          validFrom,
        )
        return eventId
      })

    const view = (slot: string, r: Row | undefined) =>
      r === undefined
        ? undefined
        : {
            slot,
            value: r.value === null ? null : JSON.parse(r.value as string),
            exposure: r.exposure as Exposure,
            resolvedFrom: r.resolved_from as string,
            updatedAt: r.updated_at as string,
            validFrom: r.valid_from as string,
            validUntil: (r.valid_until ?? null) as string | null,
            invalidatedReason: (r.invalidated_reason ?? null) as string | null,
          }

    const SLOT_COLS =
      "value, exposure, resolved_from, updated_at, valid_from, valid_until, invalidated_reason"

    /** 今の値。**閉じていない区間は slot ごとに高々1本**(部分 UNIQUE が保証している)。 */
    const belief = (slot: string) =>
      db
        .get(`SELECT ${SLOT_COLS} FROM belief_slots WHERE slot = ? AND valid_until IS NULL`, slot)
        .pipe(Effect.map((r) => view(slot, r)))

    /**
     * **その時点での値**。過去形の問いはここを通る。
     * 半開区間 `[valid_from, valid_until)` — 隣り合う区間が同じ瞬間を二重に主張しない。
     */
    const beliefAsOf = (slot: string, at: string) =>
      db
        .get(
          `SELECT ${SLOT_COLS} FROM belief_slots
            WHERE slot = ? AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)`,
          slot,
          at,
          at,
        )
        .pipe(Effect.map((r) => view(slot, r)))

    /** 値の変遷。古い順。 */
    const beliefHistory = (slot: string) =>
      db
        .all(`SELECT ${SLOT_COLS} FROM belief_slots WHERE slot = ? ORDER BY valid_from ASC`, slot)
        .pipe(Effect.map((rows) => rows.map((r) => view(slot, r)).filter((v) => v !== undefined)))

    /**
     * **確かめてから時間が経った事実**。転職が終わったのに台帳が知らない、を見つける唯一の口。
     *
     * 陳腐化は検索では絶対に見つからない。古い値も新しい値と同じくらい自然に検索に当たるから。
     * 「最後に真だと確かめたのがいつか」を持っている側から引くしかない。
     */
    const staleBeliefs = (before: string, limit = 20) =>
      db
        .all(
          `SELECT slot, ${SLOT_COLS} FROM belief_slots
            WHERE valid_until IS NULL AND valid_from < ?
            ORDER BY valid_from ASC LIMIT ?`,
          before,
          limit,
        )
        .pipe(Effect.map((rows) => rows.map((r) => view(String(r.slot), r)).filter((v) => v !== undefined)))

    /**
     * 全文検索。trigram なので部分一致する。
     *
     * **2文字以下は FTS では引けない**(trigram は3文字窓)。日本語は「会議」「予定」「金額」のように
     * 常用語の多くが2文字なので、ここで空を返すと「無いのか引けないのか分からない」状態になる。
     * その帯だけ LIKE の素朴な走査に落とす(events は個人の台帳規模で、走査しても実用上問題ない)。
     *
     * 並びは **bm25 の関連度**。`at DESC` にすると「一致した中の新着順」でしかなくなり、
     * 心拍が毎回書く長い自己言及が"新しい"というだけで上位を占めて、探している事実を押し下げる。
     *
     * 併せて層で重みを付ける。**同じ語を含むだけの独り言より、確定した1行のほうが常に役に立つ。**
     * 台帳は平らだが、読む価値は平らではない。
     */
    /**
     * @param exclude 検索から外す event id。**今のターンの入力そのものを渡す**。
     *
     * 入力は モデルを呼ぶ前に台帳へ落ちる(assistant.ts の useAgentStart)ので、これが無いと
     * 自分が今受け取ったばかりの発言が検索に当たり、**過去の記録として読まれる**
     * (「さっき言われたこと」を「前にも言っていた」と言い出す)。
     * 自走側は `text: ""` で索引に入れないことで同じ穴を塞いでいるが、対話の入力は索引に要る
     * (溜まらないと育たない)ので、除外は検索の側でやる。
     */
    const recall = (query: string, limit = 10, exclude?: string) =>
      Effect.gen(function* () {
        // **空白は語の区切りとして扱う**。1本のフレーズとして投げると空白ごと含む行しか当たらず、
        // 「エージェント メモリ」のような絞り込みが該当なしになる。
        const terms = sanitizeFts(query)
          .split(/\s+/)
          .filter((t) => t.length > 0)
        if (terms.length === 0) return [] as EventRow[]
        // 同じことを繰り返し言われた行が枠を食い潰さないよう、多めに取って本文で畳む。
        const wide = Math.max(limit * 3, 30)
        // trigram は3文字窓なので、2文字以下の語は索引では引けない(日本語の常用語の多くがこれ)。
        // その語だけ本文への LIKE に落とし、索引で引ける語と **AND で重ねる**。
        const indexed = terms.filter((t) => t.length >= FTS_MIN_QUERY)
        const short = terms.filter((t) => t.length < FTS_MIN_QUERY)
        // LIKE のワイルドカードはリテラルとして扱う(検索語をクエリ構文にしない)。
        const likes = short.map(() => "f.text LIKE '%' || ? || '%' ESCAPE '\\'").join(" AND ")
        const args = short.map((t) => t.replace(/[\\%_]/g, "\\$&"))
        const notSelf = exclude ? "AND e.id <> ?" : ""
        const selfArg = exclude ? [exclude] : []

        const rows =
          indexed.length === 0
            ? // **内部結合**なのが要る: 索引を持たない行(心拍が自分に出したプロンプトなど)は
              // 台帳には残すが検索には出さない。`text: ""` の意味を両経路で揃える。
              yield* db.all(
                `SELECT e.*, f.text AS text, ${IS_CURRENT} AS is_current FROM events e
                   JOIN events_fts f ON f.event_id = e.id
                  WHERE e.content IS NOT NULL AND ${likes} ${notSelf}
                  ORDER BY ${LAYER_BIAS} ASC, e.at DESC, e.rowid DESC
                  LIMIT ?`,
                ...args,
                ...selfArg,
                wide,
              )
            : yield* db.all(
                `SELECT e.*, f.text AS text, ${IS_CURRENT} AS is_current FROM events_fts f
                   JOIN events e ON e.id = f.event_id
                  WHERE events_fts MATCH ?
                    AND e.content IS NOT NULL
                    ${short.length > 0 ? `AND ${likes}` : ""}
                    ${notSelf}
                  ORDER BY bm25(events_fts) + ${LAYER_BIAS} ASC, e.at DESC
                  LIMIT ?`,
                indexed.map((t) => `"${t}"`).join(" AND "),
                ...args,
                ...selfArg,
                wide,
              )
        return dedupe(rows as unknown as EventRow[], limit)
      })

    const recent = (limit = 20) =>
      db
        .all(
          `SELECT e.*, f.text AS text FROM events e
             LEFT JOIN events_fts f ON f.event_id = e.id
            ORDER BY e.at DESC, e.rowid DESC LIMIT ?`,
          limit,
        )
        .pipe(Effect.map((rows) => rows as unknown as EventRow[]))

    /** 抹消。トリガが許す唯一の UPDATE(content := NULL)+ 監査用に redact イベントを残す。 */
    const redact = (eventId: string, reason: string) =>
      Effect.gen(function* () {
        yield* db.run("UPDATE events SET content = NULL WHERE id = ?", eventId)
        yield* db.run("DELETE FROM events_fts WHERE event_id = ?", eventId)
        return yield* remember({
          kind: "redact",
          source: "system",
          content: { redacted: eventId, reason },
          supersedes: eventId,
          text: "",
        })
      })

    const count = db.get("SELECT COUNT(*) n FROM events").pipe(Effect.map((r) => Number(r?.n ?? 0)))

    return {
      remember,
      believe,
      belief,
      beliefAsOf,
      beliefHistory,
      staleBeliefs,
      recall,
      recent,
      redact,
      count,
    } as const
  }),
}) {}
