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
import { appConfig } from "../core/config.ts"
import { Conflict, ConnectorFailed, type DbFailed } from "../core/errors.ts"
import { nowIso } from "../core/time.ts"
import { canonicalJson, digestOf } from "../model/kernel-spec.ts"
import { Db, type DbTx } from "./Db.ts"
import type { DraftDecision } from "./Drafts.ts"

/** API の base URL。テストだけ差し替える。 */
const api = (): string => appConfig().discord.api

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
  /** `heard`を決めたメッセージ。並行batchが返信先を巻き戻さないために使う。 */
  readonly heardAt?: string
  /** owner自由文を保存するeventへ引き継ぐ、messageごとの受信場所。 */
  readonly locations?: Readonly<Record<string, string>>
}

const token = (): string | undefined => appConfig().discord.token
const ownerId = (): string | undefined => appConfig().discord.ownerId

/** 用途ごとの出し先。Config境界で空文字は「指していない」として除かれる。 */
const fixedChannel = (to: Desk): string | undefined => appConfig().discord.channels[to]

/** 待っているリアクション。`{ メッセージid: { 絵文字: 返る文 } }` を schema_meta に置く。 */
interface PendingTap {
  readonly reply: string
  readonly draft?: { readonly id: string; readonly decision: DraftDecision }
  /** outboundがsentになる前の押下を消費しないための永続参照。旧metadataには無い。 */
  readonly outboundId?: string
  /** 最新一覧から落ちたmessageを直接確認するための配送先。旧metadataには無い。 */
  readonly channelId?: string
}
type Pending = Record<string, Record<string, PendingTap>>

/** 完了済みoutboundについて覚えておくリアクション待ちの数。古いものから落とす。 */
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
/** Discordの一覧APIが1回に返せる最大件数。 */
const MESSAGE_PAGE_SIZE = 100
/** HTTP timeoutを超えて残ったclaimだけを中断扱いにする。並行flush中のactionは閉じない。 */
const SENDING_STALE_MS = 30_000

/** `GET /channels/{id}/messages` の応答のうち使うフィールド。 */
interface RawMessage {
  readonly id: string
  readonly content: string
  readonly author: { id: string }
  readonly reactions?: { emoji: { name: string | null }; count: number; me: boolean }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const decodePending = (raw: string | undefined): Pending => {
  let value: unknown
  try {
    value = raw ? (JSON.parse(raw) as unknown) : {}
  } catch {
    return {}
  }
  if (!isRecord(value)) return {}
  const pending: Pending = {}
  for (const [messageId, reactions] of Object.entries(value)) {
    if (!/^\d+$/.test(messageId) || !isRecord(reactions)) continue
    const taps: Record<string, PendingTap> = {}
    for (const [emoji, tap] of Object.entries(reactions)) {
      if (typeof tap === "string") {
        taps[emoji] = { reply: tap }
        continue
      }
      if (!isRecord(tap) || typeof tap.reply !== "string") continue
      const draft = tap.draft
      const validDraft =
        isRecord(draft) &&
        typeof draft.id === "string" &&
        (draft.decision === "accept" || draft.decision === "revise" || draft.decision === "discard")
      taps[emoji] = {
        reply: tap.reply,
        ...(validDraft
          ? { draft: { id: draft.id as string, decision: draft.decision as DraftDecision } }
          : {}),
        ...(typeof tap.outboundId === "string" ? { outboundId: tap.outboundId } : {}),
        ...(typeof tap.channelId === "string" ? { channelId: tap.channelId } : {}),
      }
    }
    if (Object.keys(taps).length > 0) pending[messageId] = taps
  }
  return pending
}

const isRawReaction = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.count === "number" &&
  typeof value.me === "boolean" &&
  isRecord(value.emoji) &&
  (typeof value.emoji.name === "string" || value.emoji.name === null)

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

const isRawMessage = (value: unknown): value is RawMessage => isRawMessages([value])

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

    const readMessages = (ch: string, query: string): Effect.Effect<RawMessage[], ConnectorFailed> => {
      const path = `/channels/${ch}/messages?${query}`
      return readJson<unknown>(path).pipe(
        Effect.flatMap((messages) =>
          isRawMessages(messages)
            ? Effect.succeed(messages)
            : Effect.fail(
                new ConnectorFailed({
                  connector: "Discord",
                  operation: `GET /channels/${ch}/messages`,
                  message: "response is not a message array",
                }),
              ),
        ),
      )
    }

    const readPendingMessage = (
      ch: string,
      id: string,
    ): Effect.Effect<
      { readonly state: "found"; readonly message: RawMessage } | { readonly state: "gone" | "deferred" }
    > => {
      const path = `/channels/${ch}/messages/${id}`
      return Effect.gen(function* () {
        const requested = yield* Effect.result(call(path))
        if (requested._tag === "Failure") return { state: "deferred" } as const
        const response = requested.success
        if (response.status === 403 || response.status === 404) return { state: "gone" } as const
        if (!response.ok) return { state: "deferred" } as const
        const decoded = yield* Effect.result(Effect.tryPromise(() => response.json() as Promise<unknown>))
        if (decoded._tag === "Failure" || !isRawMessage(decoded.success))
          return { state: "deferred" } as const
        return { state: "found", message: decoded.success } as const
      })
    }

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

    const pendingTaps = (tx: DbTx): Pending => {
      const raw = tx.get("SELECT value FROM schema_meta WHERE key='discord:taps'")?.value
      return decodePending(raw === undefined ? undefined : String(raw))
    }

    const writePendingTaps = (tx: DbTx, pending: Pending): void => {
      tx.run("INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:taps',?)", JSON.stringify(pending))
    }

    const rememberTap = (
      tx: DbTx,
      outboundId: string,
      channelId: string,
      messageId: string,
      spec: Extract<ActionSpec, { kind: "reaction" }>,
    ): void => {
      const pending = pendingTaps(tx)
      pending[messageId] = {
        ...(pending[messageId] ?? {}),
        [spec.emoji]: {
          reply: spec.reply,
          ...(spec.draft ? { draft: spec.draft } : {}),
          outboundId,
          channelId,
        },
      }
      writePendingTaps(tx, pending)
    }

    const forgetOutboundTaps = (tx: DbTx, outboundId: string): void => {
      const pending = pendingTaps(tx)
      for (const [messageId, taps] of Object.entries(pending)) {
        const kept = Object.fromEntries(
          Object.entries(taps).filter(([, tap]) => tap.outboundId !== outboundId),
        )
        if (Object.keys(kept).length === 0) delete pending[messageId]
        else pending[messageId] = kept
      }
      writePendingTaps(tx, pending)
    }

    const prunePendingTaps = (tx: DbTx): void => {
      const classified: {
        readonly messageId: string
        readonly taps: Record<string, PendingTap>
        readonly ready: boolean
      }[] = []
      const states = new Map<string, unknown>()
      for (const [messageId, taps] of Object.entries(pendingTaps(tx))) {
        let hasReady = false
        let hasDeferred = false
        const kept: Record<string, PendingTap> = {}
        for (const [emoji, tap] of Object.entries(taps)) {
          let outboundId = tap.outboundId
          if (!outboundId) {
            const delivery = tx.get(
              `SELECT a.outbound_id,o.state
                 FROM discord_outbound_actions a
                 JOIN discord_outbound o ON o.id=a.outbound_id
                WHERE a.kind='message' AND a.state='succeeded'
                  AND json_extract(a.receipt,'$.messageId')=?
                LIMIT 1`,
              messageId,
            )
            if (typeof delivery?.outbound_id === "string") {
              outboundId = delivery.outbound_id
              states.set(outboundId, delivery.state)
            }
          }
          if (!outboundId) {
            hasReady = true
            kept[emoji] = tap
            continue
          }
          if (!states.has(outboundId))
            states.set(outboundId, tx.get("SELECT state FROM discord_outbound WHERE id=?", outboundId)?.state)
          const state = states.get(outboundId)
          if (state === "sent") hasReady = true
          else if (state === "queued" || state === "sending") hasDeferred = true
          else continue
          kept[emoji] = tap
        }
        if (Object.keys(kept).length === 0) continue
        if (hasReady || hasDeferred) classified.push({ messageId, taps: kept, ready: hasReady })
      }
      const keepReady = new Set(
        classified
          .filter((entry) => entry.ready)
          .slice(-MAX_PENDING)
          .map((entry) => entry.messageId),
      )
      writePendingTaps(
        tx,
        Object.fromEntries(
          classified
            .filter((entry) => !entry.ready || keepReady.has(entry.messageId))
            .map((entry) => [entry.messageId, entry.taps]),
        ),
      )
    }

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
          // 旧版はHTTP開始前やreceipt保存後の停止まで親だけunknownにしていた。action側に
          // 曖昧性が無い行だけを再調停へ戻す。現行版のunknownにはunknown actionがあるため対象外。
          const legacySafe = tx.all(
            `SELECT id FROM discord_outbound o
              WHERE state='unknown' AND error='interrupted during HTTP'
                AND NOT EXISTS (
                  SELECT 1 FROM discord_outbound_actions a
                   WHERE a.outbound_id=o.id AND a.state IN ('sending','failed','unknown')
                )`,
          )
          for (const outbound of legacySafe) {
            const id = String(outbound.id)
            tx.run(
              "UPDATE discord_outbound SET state='sending',error=NULL WHERE id=? AND state='unknown'",
              id,
            )
            tx.run(
              `UPDATE drafts SET state='delivery_pending',review_feedback=NULL,updated_at=?
                WHERE outbound_id=? AND state='delivery_failed'
                  AND review_feedback='interrupted during HTTP'`,
              at,
              id,
            )
          }
          const staleOutbounds = tx.all(
            "SELECT id FROM discord_outbound WHERE state='sending' AND updated_at<?",
            staleAt,
          )
          tx.run(
            "UPDATE discord_outbound_actions SET state='unknown',error='interrupted during HTTP',updated_at=? WHERE state='sending' AND updated_at<?",
            at,
            staleAt,
          )
          // 旧版はreaction receiptとtap metadataを別transactionで保存していた。親を再開する前に
          // 到達可能だった中間状態を補修する。現行版の行に対しても同じ値を書くので冪等。
          const recovered = tx.all(
            `SELECT a.outbound_id,a.ordinal,a.kind,a.spec,a.receipt
               FROM discord_outbound_actions a
               JOIN discord_outbound o ON o.id=a.outbound_id
              WHERE o.state='sending' AND o.updated_at<? AND a.state='succeeded'
              ORDER BY a.outbound_id,a.ordinal`,
            staleAt,
          )
          const recoveredReceipts = new Map<string, Map<number, Record<string, unknown>>>()
          for (const action of recovered) {
            const receipt = parse(action.receipt)
            if (!isRecord(receipt)) continue
            const outboundId = String(action.outbound_id)
            const receipts = recoveredReceipts.get(outboundId) ?? new Map()
            receipts.set(Number(action.ordinal), receipt)
            recoveredReceipts.set(outboundId, receipts)
          }
          for (const action of recovered) {
            if (action.kind !== "reaction") continue
            const rawSpec = parse(action.spec)
            if (
              !isRecord(rawSpec) ||
              rawSpec.kind !== "reaction" ||
              typeof rawSpec.messageOrdinal !== "number" ||
              typeof rawSpec.emoji !== "string" ||
              typeof rawSpec.reply !== "string"
            )
              continue
            const spec = rawSpec as unknown as Extract<ActionSpec, { kind: "reaction" }>
            const messageReceipt = recoveredReceipts.get(String(action.outbound_id))?.get(spec.messageOrdinal)
            const messageId = messageReceipt?.messageId
            const channelId = messageReceipt?.channelId
            if (typeof messageId === "string" && typeof channelId === "string")
              rememberTap(tx, String(action.outbound_id), channelId, messageId, spec)
          }
          tx.run(
            `UPDATE discord_outbound SET state='unknown',error='interrupted during HTTP',updated_at=?
              WHERE state='sending' AND updated_at<?
                AND EXISTS (
                  SELECT 1 FROM discord_outbound_actions a
                   WHERE a.outbound_id=discord_outbound.id AND a.state='unknown'
                )`,
            at,
            staleAt,
          )
          // receipt済みで曖昧なHTTPが無ければ、残りの未着手actionだけを安全に再開できる。
          tx.run(
            `UPDATE discord_outbound SET state='queued',updated_at=?
              WHERE state='sending' AND updated_at<?
                AND EXISTS (
                  SELECT 1 FROM discord_outbound_actions a
                   WHERE a.outbound_id=discord_outbound.id AND a.state='queued'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM discord_outbound_actions a
                   WHERE a.outbound_id=discord_outbound.id AND a.state IN ('sending','failed','unknown')
                )`,
            at,
            staleAt,
          )
          // 最後のreceipt直後に停止した場合は、HTTPを繰り返さず親だけを完了させる。
          tx.run(
            `UPDATE discord_outbound SET state='sent',updated_at=?
              WHERE state='sending' AND updated_at<?
                AND NOT EXISTS (
                  SELECT 1 FROM discord_outbound_actions a
                   WHERE a.outbound_id=discord_outbound.id AND a.state!='succeeded'
                )`,
            at,
            staleAt,
          )
          let completed = false
          for (const outbound of staleOutbounds) {
            const id = String(outbound.id)
            const state = tx.get("SELECT state FROM discord_outbound WHERE id=?", id)?.state
            if (state === "sent") completed = true
            else if (state === "failed" || state === "partial" || state === "unknown")
              forgetOutboundTaps(tx, id)
          }
          if (completed) prunePendingTaps(tx)
        })

        const queued = yield* db.all(
          "SELECT id FROM discord_outbound WHERE state='queued' ORDER BY created_at,id",
        )
        const flushed: Outbound[] = []
        for (const row of queued) {
          const id = String(row.id)
          const claimAt = nowIso()
          const claimedOutbound = yield* db.withImmediateTransaction(
            "claim Discord outbound",
            (tx) =>
              tx.run(
                "UPDATE discord_outbound SET state='sending',updated_at=? WHERE id=? AND state='queued'",
                claimAt,
                id,
              ).changes === 1,
          )
          if (!claimedOutbound) continue
          const outbound = yield* getOutbound(id)
          if (!outbound) continue
          const receipts = new Map<number, Record<string, unknown>>(
            outbound.actions.flatMap((action) =>
              action.state === "succeeded" && isRecord(action.receipt)
                ? [[action.ordinal, action.receipt] as const]
                : [],
            ),
          )
          let stopped = false

          for (const action of outbound.actions) {
            if (action.state === "succeeded") continue
            if (action.state !== "queued") {
              stopped = true
              break
            }
            const claimed = yield* db.withImmediateTransaction("claim Discord outbound action", (tx) => {
              const result = tx.run(
                `UPDATE discord_outbound_actions SET state='sending',updated_at=?
                  WHERE outbound_id=? AND ordinal=? AND state='queued'
                    AND EXISTS (
                      SELECT 1 FROM discord_outbound o
                       WHERE o.id=? AND o.state='sending' AND o.updated_at=?
                    )`,
                nowIso(),
                id,
                action.ordinal,
                id,
                claimAt,
              )
              return result.changes === 1
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
            } else if (requested.success.status < 200 || requested.success.status >= 300) {
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
                const terminal = tx.run(
                  "UPDATE discord_outbound SET state=?,error=?,updated_at=? WHERE id=? AND state='sending' AND updated_at=?",
                  state,
                  finalError,
                  nowIso(),
                  id,
                  claimAt,
                )
                if (terminal.changes !== 0) forgetOutboundTaps(tx, id)
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
              } else if (spec.kind === "reaction" && channelId && messageId)
                rememberTap(tx, id, channelId, messageId, spec)
              return true
            })
            if (!completed) {
              stopped = true
              break
            }
            receipts.set(action.ordinal, receipt)
          }

          if (!stopped)
            yield* db.withImmediateTransaction("complete Discord outbound", (tx) => {
              const sent = tx.run(
                `UPDATE discord_outbound SET state='sent',updated_at=?
                  WHERE id=? AND state='sending'
                    AND updated_at=?
                    AND NOT EXISTS (
                      SELECT 1 FROM discord_outbound_actions a
                       WHERE a.outbound_id=discord_outbound.id AND a.state!='succeeded'
                    )`,
                nowIso(),
                id,
                claimAt,
              )
              // Bun reports trigger updates in `changes` too。0だけがclaimを失った場合。
              if (sent.changes === 0) return
              prunePendingTaps(tx)
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
     * 返ってきたものを読む。リアクションと自由文を同じ形で返す。自由文はcursorまで一覧を遡り、
     * 一覧から落ちたリアクション待ちはmessage IDで直接確認する。
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
        const pending = decodePending(yield* db.meta("discord:taps"))
        const tapReady = new Map<string, boolean>()
        const pendingChannels = new Map<string, string>()
        const pendingOutbounds = new Map<string, string>()
        for (const [messageId, taps] of Object.entries(pending)) {
          const storedChannel = Object.values(taps).find((tap) => tap.channelId)?.channelId
          if (storedChannel) pendingChannels.set(messageId, storedChannel)
          const storedOutbound = Object.values(taps).find((tap) => tap.outboundId)?.outboundId
          if (storedOutbound) pendingOutbounds.set(messageId, storedOutbound)
          if (!storedChannel || !storedOutbound) {
            const delivery = yield* db.get(
              `SELECT a.outbound_id,o.state,json_extract(a.receipt,'$.channelId') channel_id
                 FROM discord_outbound_actions a
                 JOIN discord_outbound o ON o.id=a.outbound_id
                WHERE a.kind='message' AND a.state='succeeded'
                  AND json_extract(a.receipt,'$.messageId')=?
                LIMIT 1`,
              messageId,
            )
            if (!storedChannel && typeof delivery?.channel_id === "string")
              pendingChannels.set(messageId, delivery.channel_id)
            if (!storedOutbound && typeof delivery?.outbound_id === "string")
              pendingOutbounds.set(messageId, delivery.outbound_id)
            if (typeof delivery?.outbound_id === "string")
              tapReady.set(delivery.outbound_id, delivery.state === "sent")
          }
          for (const tap of Object.values(taps)) {
            if (!tap.outboundId || tapReady.has(tap.outboundId)) continue
            const outbound = yield* db.get("SELECT state FROM discord_outbound WHERE id=?", tap.outboundId)
            tapReady.set(tap.outboundId, outbound?.state === "sent")
          }
        }
        const out: Inbound[] = []
        const consumedTapIds = new Set<string>()
        const marks: Record<string, string> = {}
        const locations: Record<string, string> = {}
        let heard: string | undefined
        // 比較用に、`heard` を決めたときのメッセージ id を別に持つ。`heard` はチャンネル id なので、
        // それと m.id を比べると常に m.id のほうが新しくなる(チャンネルはその中のどの
        // メッセージよりも先に作られる)。
        let heardAt: string | undefined

        const cursors = new Map<string, string | undefined>()
        for (const ch of channels) cursors.set(ch, yield* cursorOf(ch))

        // チャンネル間のGETだけ並列にする。各チャンネル内は最初の高水位からcursorへ順に遡る。
        // 下の処理は直列のまま — `pending` の消し込み、`heard`、`marks` の順序に依存する。
        const fetched = yield* Effect.all(
          channels.map((ch) =>
            Effect.gen(function* () {
              const cursor = cursors.get(ch)
              let page = yield* readMessages(ch, `limit=${MESSAGE_PAGE_SIZE}`)
              const messages = new Map(page.map((message) => [message.id, message]))

              while (cursor && page.length === MESSAGE_PAGE_SIZE) {
                const oldest = page.reduce(
                  (a, message) => (newer(a, message.id) ? message.id : a),
                  page[0]?.id ?? "0",
                )
                if (!newer(oldest, cursor)) break
                const previous = yield* readMessages(
                  ch,
                  `limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(oldest)}`,
                )
                if (previous.length === 0) break
                const previousOldest = previous.reduce(
                  (a, message) => (newer(a, message.id) ? message.id : a),
                  previous[0]?.id ?? "0",
                )
                if (!newer(oldest, previousOldest)) {
                  return yield* Effect.fail(
                    new ConnectorFailed({
                      connector: "Discord",
                      operation: `GET /channels/${ch}/messages`,
                      message: "pagination did not move toward the cursor",
                    }),
                  )
                }
                for (const message of previous) messages.set(message.id, message)
                page = previous
              }

              return {
                ch,
                cursor,
                msgs: [...messages.values()].sort((a, b) => (newer(a.id, b.id) ? -1 : 1)),
              }
            }),
          ),
          { concurrency: FETCH_AT_ONCE },
        )

        const fetchedMessageIds = new Set(fetched.flatMap(({ msgs }) => msgs.map((message) => message.id)))
        const directTargets: { readonly messageId: string; readonly channelId: string }[] = []
        for (const messageId of Object.keys(pending)) {
          if (fetchedMessageIds.has(messageId)) continue
          const stored = pendingChannels.get(messageId)
          for (const channelId of stored ? [stored] : channels) directTargets.push({ messageId, channelId })
        }
        const direct = yield* Effect.all(
          directTargets.map(({ messageId, channelId }) =>
            readPendingMessage(channelId, messageId).pipe(Effect.map((result) => ({ messageId, result }))),
          ),
          { concurrency: FETCH_AT_ONCE },
        )

        const collectTap = (message: RawMessage): void => {
          const waiting = pending[message.id]
          if (!waiting) return
          for (const reaction of message.reactions ?? []) {
            const name = reaction.emoji.name
            if (name === null) continue
            const tap = waiting[name]
            const outboundId = tap?.outboundId ?? pendingOutbounds.get(message.id)
            const ready = tap && (!outboundId || tapReady.get(outboundId) === true)
            // 自分で付けたぶんを超えていれば、bot 以外の誰かが押している。
            if (ready && reaction.count > (reaction.me ? 1 : 0)) {
              out.push({
                id: `${message.id}:${name}`,
                text: tap.reply,
                ...(tap.draft ? { draft: tap.draft } : {}),
              })
              delete pending[message.id]
              consumedTapIds.add(message.id)
              break
            }
          }
        }

        for (const { ch, cursor, msgs } of fetched) {
          if (!msgs?.length) continue

          // 古い順に見る。API は新しい順で返す。
          for (const m of [...msgs].reverse()) {
            if (cursor && m.author.id === owner && m.content.trim() !== "" && newer(m.id, cursor)) {
              out.push({ id: m.id, text: m.content })
              locations[m.id] = ch
              // 一番新しい自由文のチャンネルを覚える。リアクションでは動かさない
              // (押すのは前に出したものへの返事で、話しかけられたのとは違う)。
              if (heardAt === undefined || newer(m.id, heardAt)) {
                heard = ch
                heardAt = m.id
              }
            }
            collectTap(m)
          }

          const newest = msgs.reduce((a, m) => (newer(m.id, a) ? m.id : a), msgs[0]?.id ?? "0")
          marks[ch] = cursor && newer(cursor, newest) ? cursor : newest
        }

        const directByMessage = new Map<string, (typeof direct)[number]["result"][]>()
        for (const { messageId, result } of direct) {
          const results = directByMessage.get(messageId) ?? []
          results.push(result)
          directByMessage.set(messageId, results)
        }
        for (const [messageId, results] of directByMessage) {
          const found = results.find((result) => result.state === "found")
          if (found?.state === "found") collectTap(found.message)
          else if (results.every((result) => result.state === "gone")) {
            delete pending[messageId]
            consumedTapIds.add(messageId)
          }
        }

        return {
          // チャンネルをまたいで snowflake の時刻順に並べる。同一ミリ秒内は id の数値順。
          items: out.sort((a, b) => (newer(a.id.split(":")[0] ?? "0", b.id.split(":")[0] ?? "0") ? 1 : -1)),
          marks,
          consumedTapIds: [...consumedTapIds],
          ...(heard === undefined ? {} : { heard }),
          ...(heardAt === undefined ? {} : { heardAt }),
          ...(Object.keys(locations).length === 0 ? {} : { locations }),
        } satisfies Batch
      })

    /**
     * cursor を DB に書く。`pollInbound` の返り値を記録し終えた側が呼ぶ。
     * 呼ばずに終えた回は次に同じものをもう一度読む。
     */
    const commitInboundBatch = (b: Batch): Effect.Effect<void, DbFailed> =>
      db.withImmediateTransaction("commit Discord inbound", (tx) => {
        let currentHeardAt = tx.get("SELECT value FROM schema_meta WHERE key='discord:heard_at'")?.value
        const latestOwner = tx.get(
          `SELECT origin_id,provenance FROM events
            WHERE source='owner' AND origin_kind='discord'
              AND origin_id NOT GLOB '*[^0-9]*'
            ORDER BY length(origin_id) DESC,origin_id DESC LIMIT 1`,
        )
        if (latestOwner) {
          const id = String(latestOwner.origin_id)
          let channel: string | undefined
          try {
            const provenance = JSON.parse(String(latestOwner.provenance)) as unknown
            const ref = Array.isArray(provenance)
              ? provenance.find(
                  (source): source is Record<string, unknown> =>
                    isRecord(source) && source.kind === "discord" && typeof source.ref === "string",
                )?.ref
              : undefined
            channel = typeof ref === "string" ? ref : undefined
          } catch {
            channel = undefined
          }
          if (!currentHeardAt || id === currentHeardAt || newer(id, String(currentHeardAt))) {
            currentHeardAt = id
          }
          if (channel && id === currentHeardAt) {
            tx.run("INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:heard_in',?)", channel)
            tx.run(
              "INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:heard_at',?)",
              currentHeardAt,
            )
          }
        }
        if (!currentHeardAt && b.heard !== undefined && b.heardAt !== undefined) {
          const heard = tx.get("SELECT value FROM schema_meta WHERE key='discord:heard_in'")?.value
          if (heard) {
            currentHeardAt = tx.get(
              "SELECT value FROM schema_meta WHERE key=?",
              `discord:last:${heard}`,
            )?.value
            if (currentHeardAt)
              tx.run(
                "INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:heard_at',?)",
                currentHeardAt,
              )
          }
        }
        for (const [ch, id] of Object.entries(b.marks)) {
          const current = tx.get("SELECT value FROM schema_meta WHERE key=?", `discord:last:${ch}`)?.value
          if (!current || newer(id, String(current)))
            tx.run("INSERT OR REPLACE INTO schema_meta(key,value)VALUES(?,?)", `discord:last:${ch}`, id)
        }
        if (b.heard !== undefined && b.heardAt !== undefined) {
          if (!currentHeardAt || b.heardAt === currentHeardAt || newer(b.heardAt, String(currentHeardAt))) {
            tx.run("INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:heard_in',?)", b.heard)
            tx.run("INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:heard_at',?)", b.heardAt)
          }
        }
        if (b.consumedTapIds.length === 0) return
        const pending = pendingTaps(tx)
        for (const messageId of b.consumedTapIds) delete pending[messageId]
        tx.run(
          "INSERT OR REPLACE INTO schema_meta(key,value)VALUES('discord:taps',?)",
          JSON.stringify(pending),
        )
      })

    /** 出せるか。CLI の表示にだけ使う。 */
    const configured = (): boolean => token() !== undefined && ownerId() !== undefined

    /**
     * いまどのチャンネルに出るか。CLI の表示にだけ使う。
     * `talk` は最後に話しかけられたチャンネルで動くので、固定Configだけでは分からない。
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
