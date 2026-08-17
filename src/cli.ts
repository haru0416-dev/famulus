#!/usr/bin/env bun
import { resolve } from "node:path"
/**
 * ユーザー向け管理 CLI。提案の承認・却下、停止、状態確認、記憶や watch の操作をまとめる。
 * 提案の承認を記録する入口はこの CLI だけで、承認後の実行コネクタはまだ無い。
 *
 * コマンドの一覧と説明は下の USAGE が正。
 *
 * 承認しても実行はされない。コネクタ(送信・予約)が1つも無いので、approved は
 * 「承認済み・未実行」で止まる。ここを実行したことにするのが一番大きい嘘なので、そうしない。
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { DREAM_DAYS, dream } from "./agent/dream.ts"
import { cleanup } from "./core/cleanup.ts"
import { appConfig, configureApp } from "./core/config.ts"
import { loadEnv } from "./core/env.ts"
import { describeRefusal } from "./core/errors.ts"
import { selfdev } from "./core/selfdev.ts"
import { localDayRange, localStamp, nowIso } from "./core/time.ts"
import { listWorkspaces, renderWorkspaces } from "./core/workspaces.ts"
import { checkDatabase, createBackup, latestBackup, verifyAndRecordRestore } from "./db/maintenance.ts"
import { readJournal, renderJournal } from "./journal.ts"
import { XAI_POOL } from "./model/models.ts"
import { xaiDeviceLogin } from "./model/xai-auth.ts"
import { isRefusal, runtime } from "./runtime.ts"
import { Attention, type NextMove } from "./services/Attention.ts"
import { CycleLease } from "./services/CycleLease.ts"
import { Db } from "./services/Db.ts"
import { Discord } from "./services/Discord.ts"
import { AUTONOMOUS_ROLE, Governance } from "./services/Governance.ts"
import { Intake } from "./services/Intake.ts"
import { Ledger } from "./services/Ledger.ts"
import { Memory, renderRecall, STALE_BELIEF_DAYS } from "./services/Memory.ts"
import { type ProposalRow, type ProposalStatus, Proposals } from "./services/Proposals.ts"
import { Research } from "./services/Research.ts"
import { runsRoot } from "./services/Sandbox.ts"

const short = (id: string) => id.slice(0, 8)
/** 桁が見えれば足りるので k で丸める。1000 未満は素の数。 */
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`)

/** Discord の出し先。DM かチャンネルかを言い分ける — 読む側が探しに行く場所が違う。 */
const place = (ch: string | undefined, dm: string | undefined) =>
  ch === undefined ? "出せない" : ch === dm ? "DM" : `チャンネル ${ch}`

const USAGE = `fam — famulus の承認 CLI

  fam status                今の停止状態・クォータ・今日の使用量・承認待ち件数・自動処理の最終実行状態
  fam halt <理由>           全停止(自動解除しない)
  fam resume                停止解除
  fam attention             自動処理の対象(watch・未解決の問い・次回の実行条件)
  fam journal [n]           自動処理の実働(既定 10 回)。呼んだ道具・残った行数を、
                           自分で書いた報告文と分けて出す
  fam answer <id> <答え>    問いに答えて閉じる(ユーザーの答えは確認済みとして入る)
  fam drop <id> <理由>      問いを答えないまま取り下げる。理由は必須
  fam watch <やること>      watch に置く(既定は自分の番。--human で人待ち)
  fam unwatch <id>          watch を閉じる
  fam list [status]         提案一覧。status は proposed(既定)/approved/denied/expired/all
  fam show <id>             承認カード全文(id は前方一致可)
  fam approve <id>          承認(実行はされない — 実行の仕組みはまだ無い)
  fam deny <id> <理由>      却下。理由は必須
  fam recall <語>           DB を全文検索
  fam dossier [id]          調査dossier一覧。idを渡すと引用・hash・実験check・限界を表示
  fam belief <slot>         事実の今の値と変遷(いつからいつまで何だったか)
  fam belief <slot> <値>    新しい値を確定。前の区間はそこで閉じる(上書きしない)
                           --from <ISO> で「いつから真だったか」を遡って書ける
  fam dream [日数] [--dry]   何日ぶんかをまとめて見直し、確定に上げ直す(既定 7 日)
  fam cleanup [日数] [--dry] workspace と読まれない会話を落とす(既定 14 日・events は触らない)
  fam backup                DB snapshotを作成し、一時復元で検証する
  fam restore --verify [path] backupを一時DBへ復元し、整合性とschemaを検証する
  fam doctor                設定・live DB・最新backupを診断する
  fam ws                    workspace の一覧(何のための場所か・大きさ・最後に触った時刻)
  fam selfdev [--fresh]     自分のソースの clone を workspace に置き、中でゲートが通るまで確かめる
                           --fresh は clone ごと取り直す(中で直しかけていたものは消える)
  fam grok-login            SuperGrok OAuth の device flow を通す(トークンを保存)
  fam code <指示> [--cwd <path>] [--plan] [--model <id>]
                           コーディングを Cursor へ委譲する(taskブランチに commit。merge はしない)
  fam code-models           Cursor で使えるモデル一覧(API鍵の生死確認を兼ねる)
  fam cursor-hook <event>   (内部用)coder workspace の guard.sh から呼ばれる — 手で打つ命令ではない
  fam skills                skill の一覧(組み込み・取り込み・未分類・拒否)と正本の場所
  fam intake --dry [n]      過去の会話を選別だけして圧縮率を見る(モデルを呼ばない)
  fam intake [n]            未取り込みの会話を古い順に n 件(既定 10)DB へ入れる
                           取り込み元は Claude Code のログと Claude.ai の書き出しの両方
`

const STATUS_LABEL: Record<string, string> = {
  proposed: "承認待ち",
  approved: "承認済み(未実行)",
  denied: "却下",
  expired: "期限切れ",
}

/**
 * `<id> <自由文>` を取る命令の引数(deny / answer / drop が同じ形)。
 * シェルは自由文を空白で刻んで渡してくるので、繋ぎ直してから空を弾く。
 * 足りないときは `null` を返し、呼んだ側がその命令の使い方を出す — 文言が一つに揃うと、
 * どれが足りなかったのか読めなくなる。
 */
const idAndText = (rest: readonly string[]): { id: string; text: string } | null => {
  const [id, ...words] = rest
  const text = words.join(" ").trim()
  return id && text ? { id, text } : null
}

/** `fam watch` で次に動く相手を指定するフラグ。無指定は famulus。 */
const NEXT_MOVE_FLAG: Readonly<Record<string, NextMove>> = {
  "--famulus": "famulus",
  "--human": "human",
}

/**
 * `fam watch <やること> [--human]` の引数を割る。
 *
 * 知らないフラグは読み飛ばさずに弾く。読み飛ばすと、打ち間違えたフラグが watch の本文から
 * 一語消えたまま登録され、宛先も既定のままになる — 二重に化けたうえ、
 * 登録は成功して見えるので気づく機会が無い。
 */
const parseWatch = (rest: readonly string[]) =>
  Effect.gen(function* () {
    let owner: NextMove = "famulus"
    const words: string[] = []
    for (const arg of rest) {
      if (!arg.startsWith("--")) {
        words.push(arg)
        continue
      }
      const flag = NEXT_MOVE_FLAG[arg]
      if (!flag) {
        const known = Object.keys(NEXT_MOVE_FLAG).join(" / ")
        return yield* Effect.fail(new Error(`知らない指定: ${arg}(使えるのは ${known})`))
      }
      owner = flag
    }
    const subject = words.join(" ").trim()
    if (!subject) return yield* Effect.fail(new Error("中身が要る: fam watch <やること> [--human]"))
    return { subject, owner }
  })

const line = (p: ProposalRow) => `${short(p.id)}  ${STATUS_LABEL[p.status] ?? p.status}  ${p.summary}`

const card = (p: ProposalRow) =>
  [
    `id        : ${p.id}`,
    `状態      : ${STATUS_LABEL[p.status] ?? p.status}${p.deny_reason ? ` — ${p.deny_reason}` : ""}`,
    `作成      : ${p.created_at}   期限: ${p.expires_at}`,
    // 自動処理側の結論。承認の代わりではない — 「自分の側では進まない」と書いただけで、
    // 提案はまだユーザーの判断を待っている。
    ...(p.settled_note ? [`自動処理の結論: ${p.settled_note}(${p.settled_at})`] : []),
    "",
    `見出し    : ${p.summary}`,
    `根拠      : ${p.assessment}`,
    `判断      : ${p.ask}`,
    "",
    `何を      : ${p.c_what}`,
    `いつ      : ${p.c_when}`,
    `誰が      : ${p.c_who}`,
    `どうやって: ${p.c_how}`,
    `確認方法  : ${p.c_how_verified}`,
  ].join("\n")

const program = (argv: readonly string[]) =>
  Effect.gen(function* () {
    const [cmd, ...rest] = argv
    const gov = yield* Governance
    const proposals = yield* Proposals

    switch (cmd) {
      case "dossier": {
        const research = yield* Research
        const db = yield* Db
        const [id] = rest
        if (!id) {
          const rows = yield* research.list()
          return rows.length === 0
            ? "調査dossierはまだ無い"
            : rows.map((row) => `${short(String(row.id))}  ${row.state}  ${row.question}`).join("\n")
        }
        const matches = yield* db.all(
          "SELECT id FROM research_dossiers WHERE substr(id,1,?)=? ORDER BY created_at DESC LIMIT 2",
          id.length,
          id,
        )
        if (matches.length === 0) return yield* Effect.fail(new Error(`dossier が無い: ${id}`))
        if (matches.length > 1) return yield* Effect.fail(new Error(`dossier id が曖昧: ${id}`))
        return yield* research.render(String(matches[0]?.id))
      }

      case "status": {
        const ledger = yield* Ledger
        const db = yield* Db
        const halt = yield* gov.readHalt
        // production modelは全て同じSuperGrokクォータを使う。
        const cd = yield* gov.quotaCooldown(XAI_POOL, Date.now())
        const poolLine = cd
          ? `クォータ ${XAI_POOL}/${cd.window}: クールダウン中(${new Date(cd.untilMs).toISOString()} まで)`
          : `クォータ ${XAI_POOL}: 利用可`
        const t = yield* ledger.today()
        const pending = yield* proposals.list("proposed", 100)
        const day = localDayRange(nowIso())
        // 自走が今日どれだけ使ったか。全体の内訳として出す(区分が分かれているか人が見る唯一の場所)。
        const a = yield* db.get(
          "SELECT COUNT(*)n FROM ledger WHERE role = ?AND at >= ?AND at < ?",
          AUTONOMOUS_ROLE,
          day.startIso,
          day.endIso,
        )
        const discord = yield* Discord
        const dc = yield* discord.where()
        const last = yield* db.meta("cycle:last")
        const lastActive = yield* db.meta("cycle:last_active")
        const backupAt = yield* db.meta("backup:last_at")
        const backupPath = yield* db.meta("backup:last_path")
        const restoreAt = yield* db.meta("restore:last_verified_at")
        const restorePath = yield* db.meta("restore:last_verified_path")
        const inboundOk = yield* db.meta("health:inbound:last_success")
        const inboundFailed = yield* db.meta("health:inbound:last_failure")
        // 配送成功は drafts の実データから導く。成功時にだけ書く別台帳は、書き忘れがそのまま「まだ無い」表示になる。
        const draftOk = yield* db.get("SELECT MAX(delivered_at)d FROM drafts WHERE delivered_at IS NOT NULL")
        const draftFailed = yield* db.meta("health:draft:last_failure")
        const lease = yield* (yield* CycleLease).status()
        // 記録が溜まっているか。仕組みがあることと中身があることは別で、
        // ここを出さないと「静かなのは用が無いからか、何も知らないからか」がユーザーに分からない。
        const mem = yield* db.get(
          `SELECT COUNT(*)n,
                  SUM(kind = 'import' AND content IS NOT NULL)imported
             FROM events WHERE content IS NOT NULL`,
        )
        return [
          halt ? `停止中: ${halt.reason}(${halt.at}) — fam resume で解除` : "停止: なし",
          poolLine,
          `${t.day}: run ${t.runs} 回(うち自走 ${Number(a?.n ?? 0)}/${appConfig().governance.autonomousRuns})` +
            ` / 入力 ${fmtTok(t.inTok)} 出力 ${fmtTok(t.outTok)}`,
          // 自動処理は通知なしに停止しうる。最後に呼ばれた時刻を出しておかないと、
          // 「静かなのは用が無いからか、止まっているからか」がユーザーに区別できない。
          last
            ? `自動処理: 最終 ${last}(最後に実際に動いたのは ${lastActive ?? "まだ無い"})`
            : "自動処理: まだ一度も回っていない — systemctl --user status famulus-cycle.timer",
          `DB: ${Number(mem?.n ?? 0)} 件(うち取り込み ${Number(mem?.imported ?? 0)} セッション)`,
          backupAt
            ? `バックアップ: 最終 ${backupAt} (${backupPath ?? "保存先不明"})`
            : "バックアップ: まだ無い — fam backup",
          restoreAt
            ? `復元検証: 最終 ${restoreAt} (${restorePath ?? "対象不明"})`
            : "復元検証: まだ無い — fam backup または fam restore --verify",
          `受信health: 成功 ${inboundOk ?? "まだ無い"}${inboundFailed ? ` / 失敗 ${inboundFailed}` : ""}`,
          `下書きhealth: 配送成功 ${draftOk?.d ?? "まだ無い"}${draftFailed ? ` / 失敗 ${draftFailed}` : ""}`,
          lease.state === "held"
            ? `cycle lease: held fence=${lease.fence} ${lease.owner_hostname ?? "host不明"}:${lease.owner_pid ?? "pid不明"} expires=${new Date(lease.expires_at_ms as number).toISOString()}`
            : `cycle lease: ${lease.state} fence=${lease.fence}`,
          `承認待ち: ${pending.length} 件`,
          // 宛先が無いことは実行時に何も起こさない(黙って何もしない)ので、ここで出さないと
          // 「静かなのは用が無いからか、宛先が空だからか」が分からない。行き来はこの1本だけ。
          discord.configured()
            ? `Discord: 会話 ${place(dc.talk, dc.dm)} / 下書き ${place(dc.draft, dc.dm)} — リアクションも自由文も受けられる`
            : "Discord: 宛先が無い(.env の FAMULUS_DISCORD_TOKEN が空)",
          // 進み具合は落とす先を持たない。指していなければ出ないので、
          // ここで言わないと「動いていないのか、出す先が無いのか」が分からない。
          dc.log
            ? `進み具合: チャンネル ${dc.log} に1回1行(呼びかけなし)`
            : "進み具合: 出さない(.env の FAMULUS_DISCORD_CH_LOG が空)— fam journal で見る",
        ].join("\n")
      }

      case "attention": {
        const att = yield* Attention
        const memory = yield* Memory
        const d = yield* att.planCycle()
        const watches = yield* att.openWatches()
        const staleBefore = new Date(Date.parse(d.at) - STALE_BELIEF_DAYS * 86_400_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z")
        const staleBeliefs = yield* memory.staleBeliefs(staleBefore, 10)
        return [
          `いま ${d.at}`,
          d.idle
            ? `次回は動かない(冷却 ${d.cooldownHours} 時間 / 前回の実働から ${Number.isFinite(d.sinceLastActiveHours) ? `${d.sinceLastActiveHours.toFixed(1)} 時間` : "まだ無い"})`
            : `次回は動く: ${d.reasons.join(" / ")}`,
          "",
          `watch(${watches.length} 件)`,
          ...(watches.length === 0
            ? ["  なし"]
            : watches.map(
                (w) =>
                  `  ${short(w.id)} ${w.subject}(${w.stalledDays} 日動いていない / 次は ${w.next_move_owner})`,
              )),
          "",
          `未解決の問い(${d.openQuestions.length} 件)`,
          ...(d.openQuestions.length === 0
            ? ["  なし"]
            : d.openQuestions.map((q) => `  ${short(q.id)} ${q.question}`)),
          "",
          `確かめてから ${STALE_BELIEF_DAYS} 日以上たった事実(${staleBeliefs.length} 件)`,
          ...(staleBeliefs.length === 0
            ? ["  なし"]
            : staleBeliefs.map(
                (b) => `  ${b.slot} = ${JSON.stringify(b.value)}(${localStamp(b.validFrom, false)} から)`,
              )),
        ].join("\n")
      }

      /**
       * `attention` が「これから何を見るか」で、こちらは「実際に何をしたか」。
       * 自分で書いた報告(`言った`)だけでは進み具合を確かめられないので、
       * 呼んだ道具の並びと、窓の中に増えた行数を別の欄に置く。
       */
      case "journal": {
        const n = Number(rest.find((a) => /^\d+$/.test(a)) ?? 10)
        return renderJournal(yield* readJournal(n))
      }

      /**
       * cycle が見ているものを、ユーザーの側から置く/やめる4本。
       *
       * 問いも watch も、増やす経路はエージェントの道具にしかなく、減らす経路は答えるときしか無かった。
       * 片方向しかない置き場は必ず溜まる。溜まった側は `openQuestions` の上限を埋めて、
       * 新しく立った問いを cycle の一覧から外す(実測: open 38 件のうち cycle が見ていたのは 20 件)。
       */
      case "answer": {
        const a = idAndText(rest)
        if (!a) return yield* Effect.fail(new Error("id と答えが要る: fam answer <id> <答え>"))
        const att = yield* Attention
        // ユーザーが打った答えは一次情報。この経路だけは確認済みとして入れてよい。
        const q = yield* att.answer(a.id, a.text, { confirmed: true })
        return `答えた: ${short(q.id)} ${q.question}\n  → ${q.answer}`
      }

      case "drop": {
        const a = idAndText(rest)
        if (!a) return yield* Effect.fail(new Error("id と理由が要る: fam drop <id> <理由>"))
        const att = yield* Attention
        const q = yield* att.drop(a.id, a.text)
        return `問いを取り下げた: ${short(q.id)} ${q.question}\n  理由: ${q.answer}`
      }

      case "watch": {
        const w = yield* parseWatch(rest)
        const att = yield* Attention
        const id = yield* att.watch(w.subject, w.owner)
        return `watch に入れた: ${short(id)} ${w.subject}\n  次に動くのは ${w.owner}`
      }

      case "unwatch": {
        if (!rest[0]) return yield* Effect.fail(new Error("id が要る: fam unwatch <id>"))
        const att = yield* Attention
        const w = yield* att.closeWatch(rest[0])
        return `watch を閉じた: ${short(w.id)} ${w.subject}`
      }

      case "halt": {
        const reason = rest.join(" ").trim()
        if (!reason) return yield* Effect.fail(new Error("理由が要る: fam halt <理由>"))
        yield* gov.writeHalt(reason, nowIso())
        return `停止した: ${reason}\n自動では明けない。再開は fam resume。`
      }

      case "resume": {
        const halt = yield* gov.readHalt
        yield* gov.clearHalt
        return halt ? `停止を解除した(理由だった: ${halt.reason})` : "停止していない"
      }

      case "list": {
        const status = (rest[0] ?? "proposed") as ProposalStatus | "all"
        const rows = yield* proposals.list(status, 50)
        if (rows.length === 0) return status === "proposed" ? "承認待ちは無い" : "該当なし"
        return rows.map(line).join("\n")
      }

      case "show": {
        if (!rest[0]) return yield* Effect.fail(new Error("id が要る: fam show <id>"))
        return card(yield* proposals.get(rest[0]))
      }

      case "approve": {
        if (!rest[0]) return yield* Effect.fail(new Error("id が要る: fam approve <id>"))
        const r = yield* proposals.approve(rest[0])
        return [
          `承認した: ${short(r.id)}`,
          `payload 指紋: ${r.payloadHash.slice(0, 16)}…(承認後に中身が変われば実行させない)`,
          "",
          "注意: **まだ実行はされていない**。コネクタが無いので実行はされない。",
          "      状態は「承認済み・未実行」で止まっている。",
        ].join("\n")
      }

      case "deny": {
        const a = idAndText(rest)
        if (!a) return yield* Effect.fail(new Error("id と理由が要る: fam deny <id> <理由>"))
        const r = yield* proposals.deny(a.id, a.text)
        return `却下した: ${short(r.id)} — ${a.text}`
      }

      case "recall": {
        const q = rest.join(" ").trim()
        if (!q) return yield* Effect.fail(new Error("検索語が要る: fam recall <語>"))
        const mem = yield* Memory
        return renderRecall(yield* mem.recall(q, 20))
      }

      /**
       * 事実の変遷を見る/書き換える。上書きではなく区間を継ぐので、
       * 「今なんなのか」と「あのとき何だったか」が両方残る。
       *   fam belief <slot>                    … 今の値と変遷
       *   fam belief <slot> <値> [--from ISO]  … 新しい値を確定(前の区間はそこで閉じる)
       */
      case "belief": {
        const mem = yield* Memory
        const slot = rest[0]
        if (!slot) return yield* Effect.fail(new Error("slot が要る: fam belief <slot> [新しい値]"))
        const fromAt = rest.indexOf("--from")
        const validFrom = fromAt >= 0 ? rest[fromAt + 1] : undefined
        const value = rest
          .slice(1, fromAt >= 0 ? fromAt : undefined)
          .join(" ")
          .trim()

        if (value !== "") {
          if (fromAt >= 0 && !validFrom) {
            return yield* Effect.fail(new Error("--from には時刻が要る(例: --from 2026-09-01T00:00:00Z)"))
          }
          yield* mem.recordBelief(slot, value, {
            ...(validFrom ? { validFrom } : {}),
            reason: "ユーザーが fam belief で更新した",
          })
        }

        const now = yield* mem.currentBelief(slot)
        if (!now) return `${slot}: まだ確定していない`
        const hist = yield* mem.beliefHistory(slot)
        return [
          `${slot} = ${JSON.stringify(now.value)}`,
          `  ${localStamp(now.validFrom)} から(DB が知ったのは ${localStamp(now.updatedAt, false)})`,
          "",
          `変遷(${hist.length} 件)`,
          // 閉じた区間も消さずに出す。「あのとき何だったか」に答えられるのがこの形の要点。
          ...hist.map((h) => {
            const span = h.validUntil === null ? "いまも" : `〜 ${localStamp(h.validUntil, false)}`
            const why = h.invalidatedReason === null ? "" : `  ← ${h.invalidatedReason}`
            return `  ${localStamp(h.validFrom, false)} ${span}  ${JSON.stringify(h.value)}${why}`
          }),
        ].join("\n")
      }

      case "dream": {
        // 何日ぶんかをまとめて見直す。--dry は枠を使わないので、既定の確認手段はこちら。
        const dry = rest.includes("--dry")
        const days = Number(rest.find((a) => /^\d+$/.test(a)) ?? DREAM_DAYS)
        return yield* dream({ days, ...(dry ? { dry: true } : {}) })
      }

      case "cleanup": {
        // 消すほうは取り消せないので、既定の確認手段は --dry。
        const dry = rest.includes("--dry")
        const days = Number(rest.find((a) => /^\d+$/.test(a)) ?? appConfig().cleanup.days)
        return yield* cleanup({ days, ...(dry ? { dry: true } : {}) })
      }

      case "ws": {
        const list = yield* listWorkspaces
        return [`workspace(${list.length} 件)— ${runsRoot()}`, "", renderWorkspaces(list, Date.now())].join(
          "\n",
        )
      }

      case "selfdev": {
        // 中でゲートが通るところまでやる。clone を置いただけの状態を「できた」と出すと、
        // 次の cycle が依存の取得で持ち時間を全部使って、そこで切られる。
        return yield* selfdev(rest.includes("--fresh") ? { fresh: true } : {})
      }

      case "intake": {
        const intake = yield* Intake
        const dry = rest.includes("--dry")
        const n = Number(rest.find((a) => /^\d+$/.test(a)) ?? (dry ? 100 : 10))
        const refs = yield* intake.scan(n)

        // 選別だけ。クォータを1回も使わずに結果が測れるので、既定の確認手段はこちら。
        if (dry) {
          if (refs.length === 0) return "取り込むものは無い(全部済んでいる)"
          let raw = 0
          let kept = 0
          const lines: string[] = []
          for (const ref of refs) {
            const m = yield* intake.material(ref)
            if (!m) continue
            raw += m.rawBytes
            kept += m.keptBytes
            lines.push(
              `  ${localStamp(ref.at, false)} ${String(ref.turns).padStart(3)}発話 ` +
                `${kb(m.rawBytes).padStart(8)} → ${kb(m.keptBytes).padStart(7)}  ${ref.label}`,
            )
          }
          return [
            `未取り込み ${refs.length} セッション(選別のみ・モデルは呼んでいない)`,
            ...lines,
            "",
            `合計 ${kb(raw)} → ${kb(kept)}(${(raw / Math.max(kept, 1)).toFixed(0)}:1)`,
          ].join("\n")
        }

        // 記憶ファイルはモデルを呼ばない。枠が閉じていても入るので、会話より先に済ませる。
        const memo = yield* intake.ingestMemories
        const head = memo.added > 0 ? [`記憶ファイル: ${memo.added} 件取り込んだ`] : []
        if (refs.length === 0) {
          return [...head, "会話で取り込むものは無い(全部済んでいる)"].join("\n")
        }

        const done: string[] = []
        let stopped = ""
        for (const ref of refs) {
          // 途中で枠が閉じたら、そこで止めて済んだぶんは残す。
          // 全体を1トランザクションにすると、最後の1件のクォータ枯渇でそれまで取り込んだぶんまで消える。
          const r = yield* intake.ingest(ref).pipe(
            Effect.catch((e) => {
              stopped = isRefusal(e) ? describeRefusal(e) : describe(e)
              return Effect.succeed(undefined)
            }),
          )
          if (stopped) break
          if (r) done.push(`  ${localStamp(ref.at, false)} ${r.digest.topic}`)
        }
        return [
          ...head,
          `取り込んだ: ${done.length} 件`,
          ...done,
          ...(stopped ? ["", `途中で止めた: ${stopped}`, "残りは次の fam intake で続きから入る。"] : []),
        ].join("\n")
      }

      default:
        return USAGE
    }
  })

/** 失敗を人に読める1行にする。CLI にスタックトレースを出さない(読む相手はユーザー)。 */
function describe(e: unknown): string {
  if (isRefusal(e)) return describeRefusal(e)
  const err = e as { _tag?: string; message?: string; reason?: string; id?: string; what?: string }
  switch (err?._tag) {
    // 何を引いて外したかは失敗側が持っている。ここで「提案」と決め打つと、
    // 問いや watch を引いたときに、当たらなかった相手を偽って報せることになる。
    case "NotFound":
      return `そんな${err.what}は無い: ${err.id}`
    case "Conflict":
      return `${err.what} ${err.id}: ${err.reason}`
    case "DbFailed":
      return `DB: ${err.message}`
    default:
      return err?.message || String(e)
  }
}

const main = async (): Promise<void> => {
  loadEnv()
  let config: ReturnType<typeof configureApp>
  try {
    config = configureApp()
  } catch (error) {
    console.error(describe(error))
    process.exitCode = 1
    return
  }

  const [command, ...args] = process.argv.slice(2)
  try {
    if (command === "backup" || command === "restore" || command === "doctor") {
      const migrationRuntime = runtime()
      try {
        await migrationRuntime.runPromise(Effect.flatMap(Db, () => Effect.void))
      } finally {
        await migrationRuntime.dispose()
      }
    }
    if (command === "skills") {
      if (args.length !== 0) throw new Error("引数は取らない: fam skills")
      const { IMPORTED_CLASSIFICATION, importedSkills, SKILLS } = await import("./agent/skills.ts")
      const lines: string[] = [`正本: ${config.paths.skills}`, "", "組み込み:"]
      for (const skill of Object.values(SKILLS)) {
        lines.push(`  ${skill.id}  [${skill.slot}/${skill.composition}]  ${skill.summary}`)
      }
      const imported = importedSkills(config.paths.skills)
      lines.push("", "取り込み(分類済み = 使える):")
      for (const skill of imported.skills) {
        const cls = IMPORTED_CLASSIFICATION[skill.name]
        lines.push(
          cls
            ? `  ${skill.name}  [${cls.slot}/${cls.composition}]  ${Math.round(skill.bytes / 1024)}KB  ${skill.digest.slice(0, 8)}`
            : `  ${skill.name}  [未分類 — 読み込むが使えない]  ${Math.round(skill.bytes / 1024)}KB`,
        )
      }
      for (const r of imported.rejected) lines.push(`  拒否: ${r.path} — ${r.reason}`)
      console.log(lines.join("\n"))
      return
    }
    if (command === "grok-login") {
      // device flow。URL とコードを出して、手元のブラウザでの承認を待つ。
      if (args.length !== 0) throw new Error("引数は取らない: fam grok-login")
      const auth = await xaiDeviceLogin((uri, code) => {
        console.log(`ブラウザで開いて承認する: ${uri}`)
        console.log(`コード: ${code}`)
      })
      console.log(`ログイン完了${auth.email ? `: ${auth.email}` : ""} → ${config.paths.xaiAuth}`)
      return
    }
    if (command === "cursor-hook") {
      // Cursor のフックランタイムから直接起動される(coder の workspace の guard.sh 経由)。
      // ここは famulus の runtime も DB も使わない — 判定と stdout だけ。
      const { runGuardHook } = await import("./core/guard-hook.ts")
      await runGuardHook(args[0], () => Bun.stdin.text())
      return
    }
    if (command === "code-models") {
      if (args.length !== 0) throw new Error("引数は取らない: fam code-models")
      const { listCursorModels } = await import("./model/cursor.ts")
      const models = await listCursorModels()
      console.log(models.map((m) => `${m.id}${m.displayName ? `\t${m.displayName}` : ""}`).join("\n"))
      return
    }
    if (command === "code") {
      // 委譲の入口はここだけ。自走(cycle)からは呼べない — 従量課金のコスト上限が
      // governance に入るまでこの境界は動かさない。
      const plan = args.includes("--plan")
      const cwdAt = args.indexOf("--cwd")
      const modelAt = args.indexOf("--model")
      const flagged = new Set<number>()
      for (const at of [cwdAt, modelAt]) {
        if (at !== -1) {
          flagged.add(at)
          flagged.add(at + 1)
        }
      }
      const task = args
        .filter((a, i) => a !== "--plan" && !flagged.has(i))
        .join(" ")
        .trim()
      if (!task) throw new Error("何をするかを書く: fam code <指示> [--cwd <path>] [--plan]")
      const root = resolve(config.rootDir, cwdAt === -1 ? "." : (args[cwdAt + 1] ?? "."))
      const model = modelAt === -1 ? undefined : args[modelAt + 1]
      const { runCodeTask } = await import("./agent/coder.ts")
      const outcome = await runCodeTask({
        root,
        task,
        ...(plan ? { plan: true } : {}),
        ...(model ? { model } : {}),
      })
      // 記帳: 枠の消費としてではなく実費として残す(SuperGrok の pool とは別の kind)。
      const rt = runtime()
      try {
        await rt.runPromise(
          Effect.flatMap(Ledger, (ledger) =>
            ledger.record({
              kind: "code",
              role: "coder",
              model: outcome.model,
              summary: `${outcome.run.status}: ${task.slice(0, 120)}`,
              provenance: {
                pool: "cursor-metered",
                via: "coder",
                ...(outcome.costUsd !== undefined ? { notionalUsd: outcome.costUsd } : {}),
                ...(outcome.branch ? { branch: outcome.branch } : {}),
                ...(outcome.run.aborted ? { aborted: outcome.run.aborted } : {}),
              },
            }),
          ),
        )
      } finally {
        await rt.dispose()
      }
      console.log(
        [
          `${outcome.run.status}${outcome.run.aborted ? `(打ち切り: ${outcome.run.aborted})` : ""} — ${outcome.model}`,
          `道具 ${outcome.run.toolCalls} 回(失敗 ${outcome.run.toolErrors})/ ${Math.round(outcome.run.durationMs / 1000)}秒`,
          outcome.costUsd === undefined
            ? "概算コスト: 不明(単価未登録)"
            : `概算コスト: $${outcome.costUsd.toFixed(4)}`,
          `ブランチ: ${outcome.branchDetail}`,
          ...(outcome.run.diffStat ? ["", outcome.run.diffStat] : []),
          ...(outcome.run.error ? ["", `エラー: ${outcome.run.error}`] : []),
        ].join("\n"),
      )
      return
    }
    if (command === "backup") {
      if (args.length !== 0) throw new Error("引数は取らない: fam backup")
      const result = createBackup(config.paths.db, config.paths.backups, {
        keep: config.maintenance.backupKeep,
      })
      console.log(
        [
          `バックアップ完了: ${result.path}`,
          `DB ${kb(result.bytes)}`,
          `復元検証: ok`,
          `削除: ${result.removed.length} 世代`,
        ].join("\n"),
      )
      return
    }
    if (command === "restore") {
      if (!args.includes("--verify") || args.filter((arg) => arg === "--verify").length !== 1)
        throw new Error("復元は検証だけを明示する: fam restore --verify [backup path]")
      const paths = args.filter((arg) => arg !== "--verify")
      if (paths.length > 1) throw new Error("backup pathは1つだけ指定する")
      const backup = paths[0] ? resolve(config.rootDir, paths[0]) : latestBackup(config.paths.backups)
      if (!backup) throw new Error("検証するbackupが無い: 先に fam backup")
      const result = verifyAndRecordRestore(config.paths.db, backup)
      console.log(`復元検証完了: ${backup}\nDB ${kb(result.bytes)}`)
      return
    }
    if (command === "doctor") {
      if (args.length !== 0) throw new Error("引数は取らない: fam doctor")
      const live = checkDatabase(config.paths.db)
      const backup = latestBackup(config.paths.backups)
      const restored = backup ? verifyAndRecordRestore(config.paths.db, backup) : undefined
      console.log(
        [
          "設定: ok",
          `live DB: ok (${kb(live.bytes)})`,
          restored
            ? `最新backup復元: ok (${backup} / ${kb(restored.bytes)})`
            : "最新backup復元: 未実施 (backupなし — fam backup)",
        ].join("\n"),
      )
      return
    }
  } catch (error) {
    console.error(describe(error))
    process.exitCode = 1
    return
  }

  const rt = runtime()
  try {
    // runPromise は失敗を FiberFailure で包んで投げてくる(message が "An error has occurred" になる)。
    // Exit で受けて cause を外し、元の失敗値そのものを見て文言を選ぶ。
    const exit = await rt.runPromise(Effect.exit(program(process.argv.slice(2))))
    if (Exit.isSuccess(exit)) {
      console.log(exit.value)
      return
    }
    console.error(describe(Cause.squash(exit.cause)))
    process.exitCode = 1
  } finally {
    await rt.dispose()
  }
}

await main()
