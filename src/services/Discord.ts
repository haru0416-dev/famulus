/**
 * Discord。ユーザーとの入出力はここだけ。
 *
 * gateway でメッセージを受信しない。ボタン(interaction)は3秒以内の応答が要るため使わず、
 * リアクションと自由文を `src/poll.ts` から30秒ごとに REST で取得する。
 * オンライン表示だけは別プロセスの gateway 接続が担う(src/presence.ts)。
 *
 * 出す先は用途で分ける(`Desk`)。ミュートの単位が用途と一致する。チャンネルは id を env で
 * 指す。名前で引くと改名した日に出なくなる。
 *
 * 返事は最後に話しかけられた場所へ返す。リアクションを押させるものはスレッドを立てる
 * — スレッド外の自由文はどの1件への返事か判定できない。
 *
 * token / owner id が無ければ何もせず undefined を返す。自動処理を止めない。
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Conflict, ConnectorFailed, type DbFailed } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { canonicalJson, digestOf } from "../model/kernel-spec.ts"
import { Db } from "./Db.ts"
import type { DraftDecision } from "./Drafts.ts"

/** API の base URL。テストだけ差し替える。 */
const api = (): string => process.env.OPEN_ZERO_DISCORD_API ?? "https://discord.com/api/v10"

/** 1通の上限。Discord は 2000 字で弾くので、超えるぶんは分けて出す。 */
const LIMIT = 2000

/**
 * 携帯クライアントで縦長の投稿が畳まれにくいように設けた、ローカルな1通あたりの行数上限。
 * Discord API 自体の制限ではない。
 */
const LINES = 17

/** 押させるリアクション。絵文字1つに意味を1つ割り当てる。 */
export interface Tap {
  readonly emoji: string
  /** 押されたときにユーザーの発言として DB へ入る文。 */
  readonly reply: string
  readonly draft?: { readonly id: string; readonly decision: DraftDecision }
}

/**
 * 出す先の種類。呼ぶ側はチャンネル id を知らなくてよい。
 *
 * `talk` は会話、`draft` は外に出す文(リアクションを押させる)、`log` は進み具合。
 * `talk` と `draft` は指す先が無ければ DM に落ちるが、`log` は落ちない
 * — 1回動くたびに1行出るので、DM に混ぜると会話が埋まる。
 */
export type Desk = "talk" | "draft" | "log"

export interface Enqueue {
  /** 同じ用途の中で、同じ論理投稿を指す安定キー。 */
  readonly purpose: string
  readonly dedupeKey: string
  readonly text: string
  /** 付けるリアクション。出した直後に自分で付ける。 */
  readonly taps?: readonly Tap[]
  /** 出す先。既定は `talk`。 */
  readonly to?: Desk
  /** メンションを付ける。ミュートしていても届くので、返事が要るものだけ。DM には付けない。 */
  readonly ping?: boolean
  /** スレッドの名前。渡すと出した1通からスレッドを立て、そこも読みに行く。 */
  readonly thread?: string
}

export type OutboundState = "queued" | "sending" | "sent" | "failed" | "partial" | "unknown"

export interface OutboundAction {
  readonly ordinal: number
  readonly kind: "open_dm" | "message" | "thread" | "reaction"
  readonly state: "queued" | "sending" | "succeeded" | "failed" | "unknown"
  readonly spec: unknown
  readonly nonce?: string
  readonly receipt?: unknown
  readonly error?: string
}

export interface Outbound {
  readonly id: string
  readonly purpose: string
  readonly dedupeKey: string
  readonly state: OutboundState
  readonly spec: unknown
  readonly error?: string
  readonly actions: readonly OutboundAction[]
}

/** ユーザーから返ってきた1件。押したリアクションも自由文も、同じ形にして返す。 */
export interface Inbound {
  readonly id: string
  readonly text: string
  readonly draft?: { readonly id: string; readonly decision: DraftDecision }
}

/**
 * 1回読んだぶんと、まだ DB に書いていない既読位置。
 *
 * 読むことと記録することを分けてあるのは、記録前に cursor が進むと、記録が失敗した回の項目が
 * 二度と読まれないから。絞り込みは id の比較なので、cursor 以前の項目はチャンネルに残って
 * いても拾えない。
 */
export interface Batch {
  /** 届いた順に並べたもの。 */
  readonly items: readonly Inbound[]
  /** チャンネルごとの新しい cursor。`commitInboundBatch` を呼ぶまで DB には入らない。 */
  readonly marks: Readonly<Record<string, string>>
  /** このbatchで押下を確認したmessage。commit時点の最新一覧からだけ削除する。 */
  readonly consumedTapIds: readonly string[]
  /** 最後に自由文が来たチャンネル。返事はここへ出す。 */
  readonly heard?: string
}

const token = (): string | undefined => process.env.OPEN_ZERO_DISCORD_TOKEN
const ownerId = (): string | undefined => process.env.OPEN_ZERO_DISCORD_OWNER_ID

/** 用途ごとの出し先。空文字は「指していない」と読む(env を消さずに空にすることがある)。 */
const ENV_CHANNEL: Readonly<Record<Desk, string>> = {
  talk: "OPEN_ZERO_DISCORD_CH_TALK",
  draft: "OPEN_ZERO_DISCORD_CH_DRAFT",
  log: "OPEN_ZERO_DISCORD_CH_LOG",
}

const fixedChannel = (to: Desk): string | undefined => {
  const raw = process.env[ENV_CHANNEL[to]]
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim()
}

/** 待っているリアクション。`{ メッセージid: { 絵文字: 返る文 } }` を schema_meta に置く。 */
interface PendingTap {
  readonly reply: string
  readonly draft?: { readonly id: string; readonly decision: DraftDecision }
}
type Pending = Record<string, Record<string, PendingTap>>

/** 覚えておくリアクション待ちの数。押されないまま溜まった古いものから落とす。 */
const MAX_PENDING = 20

/**
 * 読み続けるスレッドの数。リアクションが押されても閉じない — 「直す」を押した後に何を直すかが
 * 書かれる。古いものから落ちる。1つ増えるごとに poll が30秒ごとに読む先が1つ増える。
 */
const MAX_THREADS = 3

/**
 * `pollInbound()` が同時に出す GET の上限。
 * 読む先は talk / draft / log / DM の最大4件と、スレッド最大3件で合計7件。
 * rate-limit bucket の分離は保証ではないため、ここでは並列数だけを8に制限する。
 */
const FETCH_AT_ONCE = 8
/** HTTP timeoutを超えて残ったclaimだけを中断扱いにする。並行flush中のactionは閉じない。 */
const SENDING_STALE_MS = 30_000

/** `GET /channels/{id}/messages` の応答のうち使うフィールド。 */
interface RawMessage {
  readonly id: string
  readonly content: string
  readonly author: { id: string }
  readonly reactions?: { emoji: { name: string }; count: number; me: boolean }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isRawReaction = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.count === "number" &&
  typeof value.me === "boolean" &&
  isRecord(value.emoji) &&
  typeof value.emoji.name === "string"

const isRawMessages = (value: unknown): value is RawMessage[] =>
  Array.isArray(value) &&
  value.every(
    (message: unknown) =>
      isRecord(message) &&
      typeof message.id === "string" &&
      /^\d+$/.test(message.id) &&
      typeof message.content === "string" &&
      isRecord(message.author) &&
      typeof message.author.id === "string" &&
      (message.reactions === undefined ||
        (Array.isArray(message.reactions) && message.reactions.every(isRawReaction))),
  )

/** snowflake は上位ビットに生成時刻を持つ。文字列比較を避け、同時刻内は数値順で扱う。 */
const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b)

/** 字数で切る位置。改行で切る。後半に改行が無ければ LIMIT で切る。 */
const charCut = (s: string): number => {
  if (s.length <= LIMIT) return s.length
  const nl = s.lastIndexOf("\n", LIMIT)
  return nl > LIMIT / 2 ? nl : LIMIT
}

/** 行数で切る位置。LINES 行目の末尾。足りなければ切らない。 */
const lineCut = (s: string): number => {
  let at = -1
  for (let n = 0; n < LINES; n++) {
    const nl = s.indexOf("\n", at + 1)
    if (nl === -1) return s.length
    at = nl
  }
  return at
}

/** 字数と行数の、先に来たほうで切る。 */
const chunks = (text: string): string[] => {
  const out: string[] = []
  let rest = text
  for (;;) {
    const at = Math.min(charCut(rest), lineCut(rest))
    if (at <= 0 || at >= rest.length) break
    out.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, "")
  }
  out.push(rest)
  return out
}

const makeDiscord = () =>
  Effect.gen(function* () {
    const db = yield* Db

    const call = (path: string, init?: RequestInit) =>
      Effect.tryPromise(() =>
        fetch(`${api()}${path}`, {
          ...init,
          headers: {
            authorization: `Bot ${token()}`,
            "content-type": "application/json",
            ...(init?.headers ?? {}),
          },
          signal: AbortSignal.timeout(10_000),
        }),
      )

    const readJson = <T>(path: string): Effect.Effect<T, ConnectorFailed> =>
      call(path).pipe(
        Effect.flatMap((r) =>
          r.ok
            ? Effect.tryPromise({
                try: () => r.json() as Promise<T>,
                catch: (error) =>
                  new ConnectorFailed({
                    connector: "Discord",
                    operation: `GET ${path}`,
                    message: `invalid JSON: ${String(error)}`,
                  }),
              })
            : Effect.fail(
                new ConnectorFailed({
                  connector: "Discord",
                  operation: `GET ${path}`,
                  message: `HTTP ${r.status}`,
                }),
              ),
        ),
        Effect.mapError((error) =>
          error instanceof ConnectorFailed
            ? error
            : new ConnectorFailed({
                connector: "Discord",
                operation: `GET ${path}`,
                message: String(error),
              }),
        ),
      )

    const meta = <T>(key: string, fallback: T): Effect.Effect<T, DbFailed> =>
      db.meta(key).pipe(
        Effect.map((raw) => {
          if (!raw) return fallback
          try {
            return JSON.parse(raw) as T
          } catch {
            return fallback
          }
        }),
      )

    /** DM を開く HTTP は flushQueued だけが行う。ここでは永続 cache だけを見る。 */
    const dm = (): Effect.Effect<string | undefined, DbFailed> => db.meta("discord:dm")

    /**
     * 出す先を決める。`talk` は最後に話しかけられたチャンネルが最優先。
     * `log` は指してあるチャンネルにしか出さない — 落とす先を持たせると進み具合の1行が
     * 会話や DM に混ざる。
     */
    const channel = (to: Desk = "talk"): Effect.Effect<{ id?: string; dm: boolean } | undefined, DbFailed> =>
      Effect.gen(function* () {
        if (!token() || !ownerId()) return undefined
        if (to === "log") {
          const id = fixedChannel("log")
          return id ? { id, dm: false } : undefined
        }
        if (to === "draft") {
          const fixed = fixedChannel("draft") ?? fixedChannel("talk")
          if (fixed) return { id: fixed, dm: false }
        } else {
          const heard = yield* db.meta("discord:heard_in")
          if (heard) return { id: heard, dm: heard === (yield* dm()) }
          const fixed = fixedChannel("talk")
          if (fixed) return { id: fixed, dm: false }
        }
        const cached = yield* dm()
        return { ...(cached ? { id: cached } : {}), dm: true }
      })

    type ActionSpec =
      | { readonly kind: "open_dm"; readonly recipientId: string }
      | { readonly kind: "message"; readonly channelId?: string; readonly message: Record<string, unknown> }
      | {
          readonly kind: "thread"
          readonly channelId?: string
          readonly messageOrdinal: number
          readonly name: string
        }
      | {
          readonly kind: "reaction"
          readonly channelId?: string
          readonly messageOrdinal: number
          readonly emoji: string
          readonly reply: string
          readonly draft?: { readonly id: string; readonly decision: DraftDecision }
        }

    const parse = (raw: unknown): unknown => JSON.parse(String(raw)) as unknown

    const getOutbound = (id: string): Effect.Effect<Outbound | undefined, DbFailed> =>
      Effect.gen(function* () {
        const row = yield* db.get("SELECT * FROM discord_outbound WHERE id=?", id)
        if (!row) return undefined
        const actions = yield* db.all(
          "SELECT ordinal,kind,state,spec,nonce,receipt,error FROM discord_outbound_actions WHERE outbound_id=? ORDER BY ordinal",
          id,
        )
        return {
          id: String(row.id),
          purpose: String(row.purpose),
          dedupeKey: String(row.dedupe_key),
          state: row.state as OutboundState,
          spec: parse(row.spec),
          ...(row.error ? { error: String(row.error) } : {}),
          actions: actions.map((a) => ({
            ordinal: Number(a.ordinal),
            kind: a.kind as OutboundAction["kind"],
            state: a.state as OutboundAction["state"],
            spec: parse(a.spec),
            ...(a.nonce ? { nonce: String(a.nonce) } : {}),
            ...(a.receipt ? { receipt: parse(a.receipt) } : {}),
            ...(a.error ? { error: String(a.error) } : {}),
          })),
        }
      })

    /** 宛先と全 HTTP action を確定して永続化する。ここでは network に触れない。 */
    const enqueue = (p: Enqueue): Effect.Effect<Outbound | undefined, DbFailed | Conflict> =>
      Effect.gen(function* () {
        const destination = yield* channel(p.to)
        if (!destination) return undefined
        const owner = ownerId()
        if (!owner) return undefined
        const head = p.ping && !destination.dm ? `<@${owner}>\n` : ""
        const actionSpecs: ActionSpec[] = []
        if (!destination.id) actionSpecs.push({ kind: "open_dm", recipientId: owner })
        const parts = chunks(head + p.text)
        const messageOrdinals: number[] = []
        for (const [partIndex, content] of parts.entries()) {
          const nonce = digestOf({ purpose: p.purpose, dedupeKey: p.dedupeKey, partIndex }).slice(0, 25)
          messageOrdinals.push(actionSpecs.length)
          actionSpecs.push({
            kind: "message",
            ...(destination.id ? { channelId: destination.id } : {}),
            message: { content, nonce, enforce_nonce: true },
          })
        }
        const lastMessage = messageOrdinals.at(-1)
        if (lastMessage === undefined) return undefined
        if (p.thread)
          actionSpecs.push({
            kind: "thread",
            ...(destination.id ? { channelId: destination.id } : {}),
            messageOrdinal: lastMessage,
            name: p.thread.slice(0, 100),
          })
        for (const tap of p.taps ?? [])
          actionSpecs.push({
            kind: "reaction",
            ...(destination.id ? { channelId: destination.id } : {}),
            messageOrdinal: lastMessage,
            emoji: tap.emoji,
            reply: tap.reply,
            ...(tap.draft ? { draft: tap.draft } : {}),
          })

        const spec = canonicalJson({
          purpose: p.purpose,
          dedupeKey: p.dedupeKey,
          to: p.to ?? "talk",
          actions: actionSpecs,
        })
        const specHash = digestOf(spec)
        const existing = yield* db.get(
          "SELECT id,spec_hash FROM discord_outbound WHERE purpose=? AND dedupe_key=?",
          p.purpose,
          p.dedupeKey,
        )
        if (existing) {
          if (existing.spec_hash !== specHash)
            return yield* Effect.fail(
              new Conflict({
                what: "Discord outbound",
                id: `${p.purpose}:${p.dedupeKey}`,
                reason: "同じ dedupe key の action spec が変わっている",
              }),
            )
          return yield* getOutbound(String(existing.id))
        }

        const id = digestOf({ purpose: p.purpose, dedupeKey: p.dedupeKey }).slice(0, 32)
        const at = nowIso()
        yield* db.withImmediateTransaction("enqueue Discord outbound", (tx) => {
          tx.run(
            `INSERT INTO discord_outbound
              (id,purpose,dedupe_key,spec,spec_hash,state,created_at,updated_at)
             VALUES (?,?,?,?,?,'queued',?,?)`,
            id,
            p.purpose,
            p.dedupeKey,
            spec,
            specHash,
            at,
            at,
          )
          for (const [ordinal, action] of actionSpecs.entries()) {
            const actionJson = canonicalJson(action)
            const nonce = action.kind === "message" ? String(action.message.nonce) : null
            tx.run(
              `INSERT INTO discord_outbound_actions
                (outbound_id,ordinal,kind,spec,spec_hash,nonce,state,updated_at)
               VALUES (?,?,?,?,?,?,'queued',?)`,
              id,
              ordinal,
              action.kind,
              actionJson,
              digestOf(actionJson),
              nonce,
              at,
            )
          }
        })
        return yield* getOutbound(id)
      })

    /** 受信開始時にも従来どおり DM を解決するが、HTTP より先に open_dm action を残す。 */
    const ensureDmQueued = (): Effect.Effect<void, DbFailed> =>
      Effect.gen(function* () {
        const owner = ownerId()
        if (!token() || !owner || (yield* dm())) return
        const purpose = "discord-dm-cache"
        const dedupeKey = owner
        if (
          yield* db.get(
            "SELECT id FROM discord_outbound WHERE purpose=? AND dedupe_key=?",
            purpose,
            dedupeKey,
          )
        )
          return
        const action: ActionSpec = { kind: "open_dm", recipientId: owner }
        const spec = canonicalJson({ purpose, dedupeKey, to: "dm", actions: [action] })
        const id = digestOf({ purpose, dedupeKey }).slice(0, 32)
        const at = nowIso()
        yield* db.withImmediateTransaction("queue Discord DM cache", (tx) => {
          tx.run(
            `INSERT INTO discord_outbound
              (id,purpose,dedupe_key,spec,spec_hash,state,created_at,updated_at)
             VALUES (?,?,?,?,?,'queued',?,?)`,
            id,
            purpose,
            dedupeKey,
            spec,
            digestOf(spec),
            at,
            at,
          )
          const actionJson = canonicalJson(action)
          tx.run(
            `INSERT INTO discord_outbound_actions
              (outbound_id,ordinal,kind,spec,spec_hash,state,updated_at)
             VALUES (?,0,'open_dm',?,?,'queued',?)`,
            id,
            actionJson,
            digestOf(actionJson),
            at,
          )
        })
      })

    const flushQueued = (): Effect.Effect<readonly Outbound[], DbFailed> =>
      Effect.gen(function* () {
        const at = nowIso()
        const staleAt = new Date(Date.now() - SENDING_STALE_MS).toISOString().replace(/\.\d{3}Z$/, "Z")
        // HTTP timeoutを超えて残った action は結果を判定できない。再送せず unknown で閉じる。
        yield* db.withImmediateTransaction("close interrupted Discord outbound", (tx) => {
          tx.run(
            "UPDATE discord_outbound_actions SET state='unknown',error='interrupted during HTTP',updated_at=? WHERE state='sending' AND updated_at<?",
            at,
            staleAt,
          )
          tx.run(
            `UPDATE discord_outbound SET state='unknown',error='interrupted during HTTP',updated_at=?
              WHERE state='sending' AND updated_at<?
                AND NOT EXISTS (
                  SELECT 1 FROM discord_outbound_actions a
                   WHERE a.outbound_id=discord_outbound.id AND a.state='sending'
                )`,
            at,
            staleAt,
          )
        })

        const queued = yield* db.all(
          "SELECT id FROM discord_outbound WHERE state='queued' ORDER BY created_at,id",
        )
        const flushed: Outbound[] = []
        for (const row of queued) {
          const id = String(row.id)
          const claimedOutbound = yield* db.withImmediateTransaction(
            "claim Discord outbound",
            (tx) =>
              tx.run(
                "UPDATE discord_outbound SET state='sending',updated_at=? WHERE id=? AND state='queued'",
                nowIso(),
                id,
              ).changes === 1,
          )
          if (!claimedOutbound) continue
          const outbound = yield* getOutbound(id)
          if (!outbound) continue
          const receipts = new Map<number, Record<string, unknown>>()
          const completedTaps: {
            readonly messageId: string
            readonly spec: Extract<ActionSpec, { kind: "reaction" }>
          }[] = []
          let stopped = false

          for (const action of outbound.actions) {
            if (action.state !== "queued") continue
            const claimed = yield* db.withImmediateTransaction("claim Discord outbound action", (tx) => {
              const result = tx.run(
                `UPDATE discord_outbound_actions SET state='sending',updated_at=?
                  WHERE outbound_id=? AND ordinal=? AND state='queued'
                    AND EXISTS (SELECT 1 FROM discord_outbound o WHERE o.id=? AND o.state='sending')`,
                nowIso(),
                id,
                action.ordinal,
                id,
              )
              if (result.changes !== 1) return false
              return true
            })
            if (!claimed) {
              stopped = true
              break
            }

            const spec = action.spec as ActionSpec
            const dmChannel = () => {
              const opened = receipts.get(0)?.channelId
              return typeof opened === "string" ? opened : undefined
            }
            const channelId = spec.kind === "open_dm" ? undefined : (spec.channelId ?? dmChannel())
            const messageReceipt = "messageOrdinal" in spec ? receipts.get(spec.messageOrdinal) : undefined
            const messageId =
              typeof messageReceipt?.messageId === "string" ? messageReceipt.messageId : undefined

            let path: string | undefined
            let init: RequestInit | undefined
            if (spec.kind === "open_dm") {
              path = "/users/@me/channels"
              init = { method: "POST", body: JSON.stringify({ recipient_id: spec.recipientId }) }
            } else if (spec.kind === "message" && channelId) {
              path = `/channels/${channelId}/messages`
              init = { method: "POST", body: JSON.stringify(spec.message) }
            } else if (spec.kind === "thread" && channelId && messageId) {
              path = `/channels/${channelId}/messages/${messageId}/threads`
              init = {
                method: "POST",
                body: JSON.stringify({ name: spec.name, auto_archive_duration: 1440 }),
              }
            } else if (spec.kind === "reaction" && channelId && messageId) {
              path = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(spec.emoji)}/@me`
              init = { method: "PUT" }
            }

            const requested = path
              ? yield* Effect.result(call(path, init))
              : ({ _tag: "Failure", failure: new Error("required receipt is missing") } as const)
            let receipt: Record<string, unknown> | undefined
            let outcome: "succeeded" | "failed" | "unknown"
            let error: string | undefined

            if (requested._tag === "Failure") {
              outcome = "unknown"
              error = String(requested.failure)
            } else if (
              requested.success.status >= 500 ||
              requested.success.status < 200 ||
              requested.success.status >= 300
            ) {
              outcome =
                requested.success.status >= 400 && requested.success.status < 500 ? "failed" : "unknown"
              error = `HTTP ${requested.success.status}`
            } else if (spec.kind === "reaction") {
              outcome = "succeeded"
              receipt = { status: requested.success.status }
            } else {
              const decoded = yield* Effect.result(
                Effect.tryPromise(() => requested.success.json() as Promise<{ id?: unknown }>),
              )
              const remoteId = decoded._tag === "Success" ? decoded.success.id : undefined
              if (typeof remoteId !== "string" || remoteId === "") {
                outcome = "unknown"
                error = "required receipt is missing"
              } else {
                outcome = "succeeded"
                receipt =
                  spec.kind === "open_dm"
                    ? { channelId: remoteId }
                    : spec.kind === "message"
                      ? { channelId, messageId: remoteId }
                      : { threadId: remoteId }
              }
            }

            if (outcome !== "succeeded" || !receipt) {
              const finalError = error ?? "Discord outbound failed"
              yield* db.withImmediateTransaction("fail Discord outbound action", (tx) => {
                tx.run(
                  "UPDATE discord_outbound_actions SET state=?,error=?,updated_at=? WHERE outbound_id=? AND ordinal=? AND state='sending'",
                  outcome,
                  finalError,
                  nowIso(),
                  id,
                  action.ordinal,
                )
                const succeeded = Number(
                  tx.get(
                    "SELECT COUNT(*) n FROM discord_outbound_actions WHERE outbound_id=? AND state='succeeded'",
                    id,
                  )?.n ?? 0,
                )
                const state = outcome === "unknown" ? "unknown" : succeeded > 0 ? "partial" : "failed"
                tx.run(
                  "UPDATE discord_outbound SET state=?,error=?,updated_at=? WHERE id=? AND state='sending'",
                  state,
                  finalError,
                  nowIso(),
                  id,
                )
              })
              stopped = true
              break
            }

            const completed = yield* db.withImmediateTransaction("complete Discord outbound action", (tx) => {
              const result = tx.run(
                "UPDATE discord_outbound_actions SET state='succeeded',receipt=?,updated_at=? WHERE outbound_id=? AND ordinal=? AND state='sending'",
                canonicalJson(receipt),
                nowIso(),
                id,
                action.ordinal,
              )
              if (result.changes !== 1) return false
              if (spec.kind === "open_dm") {
                tx.run(
                  "INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:dm',?)",
                  receipt.channelId,
                )
              } else if (spec.kind === "thread") {
                const threadId = String(receipt.threadId)
                tx.run(
                  "INSERT OR REPLACE INTO schema_meta(key,value)VALUES(?,?)",
                  `discord:last:${threadId}`,
                  threadId,
                )
                const raw = tx.get("SELECT value FROM schema_meta WHERE key='discord:threads'")?.value
                let open: string[] = []
                try {
                  open = raw ? (JSON.parse(String(raw)) as string[]) : []
                } catch {
                  open = []
                }
                tx.run(
                  "INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:threads',?)",
                  JSON.stringify([...open, threadId].slice(-MAX_THREADS)),
                )
              }
              return true
            })
            if (!completed) {
              stopped = true
              break
            }
            receipts.set(action.ordinal, receipt)
            if (spec.kind === "reaction" && messageId) completedTaps.push({ messageId, spec })
          }

          if (!stopped)
            yield* db.withImmediateTransaction("complete Discord outbound", (tx) => {
              const sent = tx.run(
                `UPDATE discord_outbound SET state='sent',updated_at=?
                  WHERE id=? AND state='sending'
                    AND NOT EXISTS (
                      SELECT 1 FROM discord_outbound_actions a
                       WHERE a.outbound_id=discord_outbound.id AND a.state!='succeeded'
                    )`,
                nowIso(),
                id,
              )
              // Bun reports trigger updates in `changes` too。0だけがclaimを失った場合。
              if (sent.changes === 0) return

              const raw = tx.get("SELECT value FROM schema_meta WHERE key='discord:taps'")?.value
              let pending: Pending = {}
              try {
                pending = raw ? (JSON.parse(String(raw)) as Pending) : {}
              } catch {
                pending = {}
              }
              for (const { messageId, spec } of completedTaps) {
                pending[messageId] = {
                  ...(pending[messageId] ?? {}),
                  [spec.emoji]: { reply: spec.reply, ...(spec.draft ? { draft: spec.draft } : {}) },
                }
              }
              const kept = Object.entries(pending).slice(-MAX_PENDING)
              tx.run(
                "INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:taps',?)",
                JSON.stringify(Object.fromEntries(kept)),
              )
            })
          const result = yield* getOutbound(id)
          if (result) flushed.push(result)
        }
        return flushed
      })

    /** 読みに行くチャンネル。出す先すべてと DM、立てたスレッド。 */
    const listening = (): Effect.Effect<readonly string[], DbFailed> =>
      Effect.gen(function* () {
        if (!token()) return []
        const out = new Set<string>()
        // log も読む。返事を求めないチャンネルでもユーザーが書くことはある。
        for (const to of ["talk", "draft", "log"] as const) {
          const fixed = fixedChannel(to)
          if (fixed) out.add(fixed)
        }
        const d = yield* dm()
        if (d) out.add(d)
        for (const t of yield* meta<string[]>("discord:threads", [])) out.add(t)
        return [...out]
      })

    /**
     * そのチャンネルの cursor。持っていなければ undefined(取り込まずに cursor だけ進める)。
     */
    const cursorOf = (ch: string): Effect.Effect<string | undefined, DbFailed> =>
      db.meta(`discord:last:${ch}`)

    /**
     * 返ってきたものを読む。リアクションと自由文を同じ形で返す。一覧を1回引いて両方見る
     * (リアクションは古いメッセージに後から付くので `after` では拾えない)。
     *
     * cursor は進めない。進めるのは `commitInboundBatch`。
     *
     * cursor を持たないチャンネルは自由文を取り込まず cursor だけ返す。DM には過去の会話が
     * 残っていて、cursor なしで引くと去年の発言が今日の入力になる。リアクションは対象外
     * (自分が出したメッセージにしか登録されていない)。
     *
     * 取得失敗は失敗として返す。空配列だけを「届いていない」と扱う。
     */
    const pollInbound = (): Effect.Effect<Batch, DbFailed | ConnectorFailed> =>
      Effect.gen(function* () {
        yield* ensureDmQueued()
        yield* flushQueued()
        const owner = ownerId()
        const channels = yield* listening()
        if (token() && owner && channels.length === 0) {
          return yield* Effect.fail(
            new ConnectorFailed({
              connector: "Discord",
              operation: "resolve inbound channels",
              message: "no fixed channel or usable DM channel",
            }),
          )
        }
        const pending = yield* meta<Pending>("discord:taps", {})
        const out: Inbound[] = []
        const consumedTapIds: string[] = []
        const marks: Record<string, string> = {}
        let heard: string | undefined
        // 比較用に、`heard` を決めたときのメッセージ id を別に持つ。`heard` はチャンネル id なので、
        // それと m.id を比べると常に m.id のほうが新しくなる(チャンネルはその中のどの
        // メッセージよりも先に作られる)。
        let heardAt: string | undefined

        // GET だけ並列にする。逐次だとチャンネル数ぶん往復が加算される(3 本で実測 1082〜2349ms、
        // 並列で 325〜932ms)。下のループは直列のまま — `pending` の消し込み、`heard`、`marks` の
        // 並びがチャンネルの順序に依存する。`Effect.all` は入力順で返す。
        const fetched = yield* Effect.all(
          channels.map((ch) =>
            readJson<unknown>(`/channels/${ch}/messages?limit=50`).pipe(
              Effect.flatMap((msgs) =>
                isRawMessages(msgs)
                  ? Effect.succeed({ ch, msgs })
                  : Effect.fail(
                      new ConnectorFailed({
                        connector: "Discord",
                        operation: `GET /channels/${ch}/messages`,
                        message: "response is not a message array",
                      }),
                    ),
              ),
            ),
          ),
          { concurrency: FETCH_AT_ONCE },
        )

        for (const { ch, msgs } of fetched) {
          if (!msgs?.length) continue

          const cursor = yield* cursorOf(ch)

          // 古い順に見る。API は新しい順で返す。
          for (const m of [...msgs].reverse()) {
            if (cursor && m.author.id === owner && m.content.trim() !== "" && newer(m.id, cursor)) {
              out.push({ id: m.id, text: m.content })
              // 一番新しい自由文のチャンネルを覚える。リアクションでは動かさない
              // (押すのは前に出したものへの返事で、話しかけられたのとは違う)。
              if (heardAt === undefined || newer(m.id, heardAt)) {
                heard = ch
                heardAt = m.id
              }
            }
            const waiting = pending[m.id]
            if (!waiting) continue
            for (const r of m.reactions ?? []) {
              const tap = waiting[r.emoji.name]
              // 自分で付けたぶんを超えていれば、bot 以外の誰かが押している。
              if (tap && r.count > (r.me ? 1 : 0)) {
                out.push({
                  id: `${m.id}:${r.emoji.name}`,
                  text: tap.reply,
                  ...(tap.draft ? { draft: tap.draft } : {}),
                })
                delete pending[m.id]
                consumedTapIds.push(m.id)
                break
              }
            }
          }

          marks[ch] = msgs.reduce((a, m) => (newer(m.id, a) ? m.id : a), msgs[0]?.id ?? "0")
        }

        return {
          // チャンネルをまたいで snowflake の時刻順に並べる。同一ミリ秒内は id の数値順。
          items: out.sort((a, b) => (newer(a.id.split(":")[0] ?? "0", b.id.split(":")[0] ?? "0") ? 1 : -1)),
          marks,
          consumedTapIds,
          ...(heard === undefined ? {} : { heard }),
        } satisfies Batch
      })

    /**
     * cursor を DB に書く。`pollInbound` の返り値を記録し終えた側が呼ぶ。
     * 呼ばずに終えた回は次に同じものをもう一度読む。
     */
    const commitInboundBatch = (b: Batch): Effect.Effect<void, DbFailed> =>
      Effect.gen(function* () {
        for (const [ch, id] of Object.entries(b.marks)) yield* db.setMeta(`discord:last:${ch}`, id)
        if (b.heard !== undefined) yield* db.setMeta("discord:heard_in", b.heard)
        if (b.consumedTapIds.length > 0)
          yield* db.withImmediateTransaction("commit Discord taps", (tx) => {
            const raw = tx.get("SELECT value FROM schema_meta WHERE key='discord:taps'")?.value
            let pending: Pending = {}
            try {
              pending = raw ? (JSON.parse(String(raw)) as Pending) : {}
            } catch {
              pending = {}
            }
            for (const messageId of b.consumedTapIds) delete pending[messageId]
            tx.run(
              "INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:taps',?)",
              JSON.stringify(pending),
            )
          })
      })

    /** 出せるか。CLI の表示にだけ使う。 */
    const configured = (): boolean => token() !== undefined && ownerId() !== undefined

    /**
     * いまどのチャンネルに出るか。CLI の表示にだけ使う。
     * `talk` は最後に話しかけられたチャンネルで動くので、env を読むだけでは分からない。
     */
    const where = (): Effect.Effect<{ talk?: string; draft?: string; log?: string; dm?: string }, DbFailed> =>
      Effect.gen(function* () {
        const talk = yield* channel("talk")
        const draft = yield* channel("draft")
        const lg = yield* channel("log")
        const d = yield* dm()
        return {
          ...(talk?.id ? { talk: talk.id } : {}),
          ...(draft?.id ? { draft: draft.id } : {}),
          ...(lg?.id ? { log: lg.id } : {}),
          ...(d ? { dm: d } : {}),
        }
      })

    return { enqueue, getOutbound, flushQueued, pollInbound, commitInboundBatch, configured, where } as const
  })

export class Discord extends Context.Service<Discord, Effect.Success<ReturnType<typeof makeDiscord>>>()(
  "Discord",
) {
  static readonly layer = Layer.effect(Discord, makeDiscord())
}
