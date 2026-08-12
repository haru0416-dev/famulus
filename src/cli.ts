#!/usr/bin/env node
/**
 * ユーザー側の入口。**承認はここでしか起きない**。
 *
 * エージェント側(Flue)は提案を書いて止まる。その相手方が無いと片肺なので、
 * 承認・却下・停止・解除・確認を1本の CLI に置く。Discord も Web も無い今、
 * 「実行を伴うことに人が明示的に触る」唯一の面がこれ。
 *
 *   oz status              … 停止/枠/今日の使用量/承認待ち件数/tick の生死
 *   oz halt <理由>         … 全停止。自動では明けない
 *   oz resume              … 停止解除
 *   oz attention           …tick が今なにを見ているか(watch・問い・次に起きる条件)
 *   oz answer <id> <答え>  … 問いに答えて閉じる
 *   oz drop <id> <理由>    … 追わないと決めた問いを畳む(答えずに閉じる)
 *   oz watch <やること>    …watch に置く(既定は famulus = tick の起床理由になる)
 *   oz unwatch <id>        … 決着した watch を閉じる
 *   oz list [status]       … 提案一覧(既定は承認待ち)
 *   oz show <id>           … 承認カード全文(id は前方一致でよい)
 *   oz approve <id>        … 承認。approvals 行を書き、payload を指紋で固定する
 *   oz deny <id> <理由>    … 却下。理由は次の生成へ還流させるので必須
 *   oz recall <語>         … 記憶を引く
 *   oz belief <slot> [値]  … 事実の今の値と変遷。値を渡すと前の区間を閉じて継ぐ
 *   oz dream [日数] [--dry]… 何日ぶんかをまとめて見直して確定に上げる(1回ぶんでは見えない値)
 *   oz cleanup [日数] [--dry]… `.data/` の増え続けるものを落とす(events は触らない)
 *   oz ws                  … 作業場の一覧(名前・用途・大きさ・最後に触った時刻)
 *   oz selfdev [--fresh]   … 自分のソースの clone を作業場に置く(コンテナから直せるようにする)
 *   oz intake [--dry] [n]  … 過去の会話を圧縮して DB に入れる(DB の入口)
 *
 * **承認しても実行はされない**。コネクタ(送信・予約)が1つも無いので、approved は
 * 「承認済み・未実行」で止まる。ここを実行したことにするのが一番大きい嘘なので、そうしない。
 */
import { Cause, Effect, Exit } from "effect"
import { DREAM_DAYS, dream } from "./agent/dream.ts"
import { CLEANUP_DAYS, cleanup } from "./core/cleanup.ts"
import { loadEnv } from "./core/env.ts"
import { describeRefusal } from "./core/errors.ts"
import { selfdev } from "./core/selfdev.ts"
import { dayRange, localStamp, nowIso } from "./core/time.ts"
import { listWorkspaces, renderWorkspaces } from "./core/workspaces.ts"
import { CLAUDE_POOL, RMOD_POOL } from "./model/claude-cli.ts"
import { isRefusal, runtime } from "./runtime.ts"
import { Attention, type NextMove, STALE_BELIEF_DAYS } from "./services/Attention.ts"
import { Db } from "./services/Db.ts"
import { Discord } from "./services/Discord.ts"
import { AUTONOMOUS_ROLE, BUDGET, Governance } from "./services/Governance.ts"
import { Intake } from "./services/Intake.ts"
import { Ledger } from "./services/Ledger.ts"
import { Memory, renderRecall } from "./services/Memory.ts"
import { Notify } from "./services/Notify.ts"
import { type ProposalRow, type ProposalStatus, Proposals } from "./services/Proposals.ts"
import { runsRoot } from "./services/Sandbox.ts"

const short = (id: string) => id.slice(0, 8)
/** 桁が見えれば足りるので k で丸める。1000 未満は素の数。 */
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`)

/** Discord の出し先。**DM かチャンネルかを言い分ける** — 読む側が探しに行く場所が違う。 */
const place = (ch: string | undefined, dm: string | undefined) =>
  ch === undefined ? "出せない" : ch === dm ? "DM" : `チャンネル ${ch}`

const USAGE = `oz — open-zero の承認 CLI

  oz status                今の停止状態・枠・今日の使用量・承認待ち件数・tick の生死
  oz halt <理由>           全停止(自動解除しない)
  oz resume                停止解除
  oz attention             tick の視野(watch・未解決の問い・次に起きる条件)
  oz answer <id> <答え>    問いに答えて閉じる(ユーザーの答えは確認済みとして入る)
  oz drop <id> <理由>      問いを答えないまま取り下げる。理由は必須
  oz watch <やること>      watch に置く(既定は自分の番。--human で人待ち)
  oz unwatch <id>          watch を閉じる
  oz list [status]         提案一覧。status は proposed(既定)/approved/denied/expired/all
  oz show <id>             承認カード全文(id は前方一致可)
  oz approve <id>          承認(実行はされない — 実行の仕組みはまだ無い)
  oz deny <id> <理由>      却下。理由は必須
  oz recall <語>           DB を全文検索
  oz belief <slot>         事実の今の値と変遷(いつからいつまで何だったか)
  oz belief <slot> <値>    新しい値を確定。前の区間はそこで閉じる(上書きしない)
                           --from <ISO> で「いつから真だったか」を遡って書ける
  oz dream [日数] [--dry]   何日ぶんかをまとめて見直し、確定に上げ直す(既定 7 日)
  oz cleanup [日数] [--dry] 作業場と読まれない会話を落とす(既定 14 日・events は触らない)
  oz ws                    作業場の一覧(何のための場所か・大きさ・最後に触った時刻)
  oz selfdev [--fresh]     自分のソースの clone を作業場に置き、中でゲートが通るまで確かめる
                           --fresh は clone ごと取り直す(中で直しかけていたものは消える)
  oz intake --dry [n]      過去の会話を選別だけして圧縮率を見る(モデルを呼ばない)
  oz intake [n]            未取り込みの会話を古い順に n 件(既定 10)DB へ入れる
                           取り込み元は Claude Code のログと Claude.ai の書き出しの両方
`

const STATUS_LABEL: Record<string, string> = {
  proposed: "承認待ち",
  approved: "承認済み(未実行)",
  deferred: "保留",
  denied: "却下",
  expired: "期限切れ",
  executing: "実行中",
  executed: "実行済み",
  failed: "失敗",
}

/**
 * `<id> <自由文>` を取る命令の引数(deny / answer / drop が同じ形)。
 * シェルは自由文を空白で刻んで渡してくるので、繋ぎ直してから空を弾く。
 * 足りないときは `null` を返し、**呼んだ側がその命令の使い方を出す** — 文言が一つに揃うと、
 * どれが足りなかったのか読めなくなる。
 */
const idAndText = (rest: readonly string[]): { id: string; text: string } | null => {
  const [id, ...words] = rest
  const text = words.join(" ").trim()
  return id && text ? { id, text } : null
}

/** `oz watch` で次に動く相手を指定する札。無指定は famulus。 */
const NEXT_MOVE_FLAG: Readonly<Record<string, NextMove>> = {
  "--famulus": "famulus",
  "--human": "human",
  "--counterparty": "counterparty",
}

/**
 * `oz watch <やること> [--human]` の引数を割る。
 *
 * **知らない札は読み飛ばさずに弾く。** 読み飛ばすと、打ち間違えた札が watch の本文から
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
    if (!subject) return yield* Effect.fail(new Error("中身が要る: oz watch <やること> [--human]"))
    return { subject, owner }
  })

const line = (p: ProposalRow) => `${short(p.id)}  ${STATUS_LABEL[p.status] ?? p.status}  ${p.summary}`

const card = (p: ProposalRow) =>
  [
    `id        : ${p.id}`,
    `状態      : ${STATUS_LABEL[p.status] ?? p.status}${p.deny_reason ? ` — ${p.deny_reason}` : ""}`,
    `作成      : ${p.created_at}   期限: ${p.expires_at}`,
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
      case "status": {
        const ledger = yield* Ledger
        const db = yield* Db
        const halt = yield* gov.readHalt
        // **枠は2つある。** 対話は claude-max、作業と調査は chatgpt-rmod。片方だけ見ていると
        // 「開いている」と出したまま取り込みが全部落ちる、が起こる。
        const nowMs = Date.now()
        const pools: string[] = []
        for (const pool of [CLAUDE_POOL, RMOD_POOL]) {
          const cd = yield* gov.quotaCooldown(pool, nowMs)
          pools.push(
            cd
              ? `枠 ${pool}/${cd.window}: クールダウン中(${new Date(cd.untilMs).toISOString()} まで)`
              : `枠 ${pool}: 開いている`,
          )
        }
        const t = yield* ledger.today()
        const pending = yield* proposals.list("proposed", 100)
        const day = dayRange(nowIso())
        // 自走が今日どれだけ使ったか。全体の内訳として出す(仕切りが効いているか人が見る唯一の場所)。
        const a = yield* db.get(
          "SELECT COUNT(*)n FROM ledger WHERE role = ?AND at >= ?AND at < ?",
          AUTONOMOUS_ROLE,
          day.startIso,
          day.endIso,
        )
        const notify = yield* Notify
        const discord = yield* Discord
        const dc = yield* discord.where()
        const last = yield* db.meta("tick:last")
        const lastActive = yield* db.meta("tick:last_active")
        // 記録が溜まっているか。**仕組みがあることと中身があることは別**で、
        // ここを出さないと「静かなのは用が無いからか、何も知らないからか」がユーザーに分からない。
        const mem = yield* db.get(
          `SELECT COUNT(*)n,
                  SUM(kind = 'import' AND content IS NOT NULL)imported
             FROM events WHERE content IS NOT NULL`,
        )
        return [
          halt ? `停止中: ${halt.reason}(${halt.at}) — oz resume で解除` : "停止: なし",
          ...pools,
          `${t.day}: run ${t.runs} 回(うち自走 ${Number(a?.n ?? 0)}/${BUDGET.autonomousRuns})` +
            ` / 入力 ${fmtTok(t.inTok)} 出力 ${fmtTok(t.outTok)}` +
            ` / 実費 $${t.usd.toFixed(4)}${t.unpriced > 0 ? ` / 単価未登録 ${t.unpriced} 件` : ""}`,
          // tick は黙って死ぬ。**最後に呼ばれた時刻**を出しておかないと、
          // 「静かなのは用が無いからか、止まっているからか」がユーザーに区別できない。
          last
            ? `tick: 最終 ${last}(最後に実際に動いたのは ${lastActive ?? "まだ無い"})`
            : "tick: まだ一度も回っていない — systemctl --user status open-zero-tick.timer",
          `DB: ${Number(mem?.n ?? 0)} 件(うち取り込み ${Number(mem?.imported ?? 0)} セッション)`,
          `承認待ち: ${pending.length} 件`,
          // 通知先が無いことは実行時に何も起こさない(黙って false になる)ので、ここで出さないと
          // 「静かなのは用が無いからか、宛先が空だからか」が分からない。
          notify.configured()
            ? `通知: 出せる${notify.canReply() ? " / 押し戻しも受けられる" : "(押し戻しは受けられない)"}`
            : "通知: 宛先が無い(.env の OPEN_ZERO_NTFY_TOPIC が空)",
          discord.configured()
            ? `Discord: 会話 ${place(dc.talk, dc.dm)} / 下書き ${place(dc.draft, dc.dm)} — リアクションも自由文も受けられる`
            : "Discord: 宛先が無い(.env の OPEN_ZERO_DISCORD_TOKEN が空)",
        ].join("\n")
      }

      case "attention": {
        const att = yield* Attention
        const d = yield* att.digest()
        const watches = yield* att.openWatches()
        return [
          `いま ${d.at}`,
          d.idle
            ? `次の tick は動かない(冷却 ${d.cooldownHours} 時間 / 前回の実働から ${Number.isFinite(d.sinceLastActiveHours) ? `${d.sinceLastActiveHours.toFixed(1)} 時間` : "まだ無い"})`
            : `次の tick は動く: ${d.reasons.join(" / ")}`,
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
          `確かめてから ${STALE_BELIEF_DAYS} 日以上たった事実(${d.staleBeliefs.length} 件)`,
          ...(d.staleBeliefs.length === 0
            ? ["  なし"]
            : d.staleBeliefs.map((b) => `  ${b.slot} = ${b.value}(${localStamp(b.valid_from, false)} から)`)),
        ].join("\n")
      }

      /**
       * tick が見ているものを、ユーザーの側から置く/畳む4本。
       *
       * 問いも watch も、**増やす経路はエージェントの道具にしかなく、減らす経路は答えるときしか無かった**。
       * 片方向しかない置き場は必ず溜まる。溜まった側は `openQuestions` の上限を埋めて、
       * 新しく立った問いを tick から押し出す(実測: open 38 件のうち tick が見ていたのは 20 件)。
       */
      case "answer": {
        const a = idAndText(rest)
        if (!a) return yield* Effect.fail(new Error("id と答えが要る: oz answer <id> <答え>"))
        const att = yield* Attention
        // ユーザーが打った答えは一次情報。**この経路だけは確認済みとして入れてよい。**
        const q = yield* att.answer(a.id, a.text, { confirmed: true })
        return `答えた: ${short(q.id)} ${q.question}\n  → ${q.answer}`
      }

      case "drop": {
        const a = idAndText(rest)
        if (!a) return yield* Effect.fail(new Error("id と理由が要る: oz drop <id> <理由>"))
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
        if (!rest[0]) return yield* Effect.fail(new Error("id が要る: oz unwatch <id>"))
        const att = yield* Attention
        const w = yield* att.closeWatch(rest[0])
        return `watch を閉じた: ${short(w.id)} ${w.subject}`
      }

      case "halt": {
        const reason = rest.join(" ").trim()
        if (!reason) return yield* Effect.fail(new Error("理由が要る: oz halt <理由>"))
        yield* gov.writeHalt(reason, nowIso())
        return `停止した: ${reason}\n自動では明けない。再開は oz resume。`
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
        if (!rest[0]) return yield* Effect.fail(new Error("id が要る: oz show <id>"))
        return card(yield* proposals.get(rest[0]))
      }

      case "approve": {
        if (!rest[0]) return yield* Effect.fail(new Error("id が要る: oz approve <id>"))
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
        if (!a) return yield* Effect.fail(new Error("id と理由が要る: oz deny <id> <理由>"))
        const r = yield* proposals.deny(a.id, a.text)
        return `却下した: ${short(r.id)} — ${a.text}`
      }

      case "recall": {
        const q = rest.join(" ").trim()
        if (!q) return yield* Effect.fail(new Error("検索語が要る: oz recall <語>"))
        const mem = yield* Memory
        return renderRecall(yield* mem.recall(q, 20))
      }

      /**
       * 事実の変遷を見る/書き換える。**上書きではなく区間を継ぐ**ので、
       * 「今なんなのか」と「あのとき何だったか」が両方残る。
       *   oz belief <slot>                    … 今の値と変遷
       *   oz belief <slot> <値> [--from ISO]  … 新しい値を確定(前の区間はそこで閉じる)
       */
      case "belief": {
        const mem = yield* Memory
        const slot = rest[0]
        if (!slot) return yield* Effect.fail(new Error("slot が要る: oz belief <slot> [新しい値]"))
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
          yield* mem.believe(slot, value, {
            ...(validFrom ? { validFrom } : {}),
            reason: "ユーザーが oz belief で更新した",
          })
        }

        const now = yield* mem.belief(slot)
        if (!now) return `${slot}: まだ確定していない`
        const hist = yield* mem.beliefHistory(slot)
        return [
          `${slot} = ${JSON.stringify(now.value)}`,
          `  ${localStamp(now.validFrom)} から(DB が知ったのは ${localStamp(now.updatedAt, false)})`,
          "",
          `変遷(${hist.length} 件)`,
          // **閉じた区間も消さずに出す。**「あのとき何だったか」に答えられるのがこの形の値打ち。
          ...hist.map((h) => {
            const span = h.validUntil === null ? "いまも" : `〜 ${localStamp(h.validUntil, false)}`
            const why = h.invalidatedReason === null ? "" : `  ← ${h.invalidatedReason}`
            return `  ${localStamp(h.validFrom, false)} ${span}  ${JSON.stringify(h.value)}${why}`
          }),
        ].join("\n")
      }

      case "dream": {
        // 何日ぶんかをまとめて見直す。**--dry は枠を使わない**ので、既定の確認手段はこちら。
        const dry = rest.includes("--dry")
        const days = Number(rest.find((a) => /^\d+$/.test(a)) ?? DREAM_DAYS)
        return yield* dream({ days, ...(dry ? { dry: true } : {}) })
      }

      case "cleanup": {
        // **消すほうは取り消せない**ので、既定の確認手段は --dry。
        const dry = rest.includes("--dry")
        const days = Number(rest.find((a) => /^\d+$/.test(a)) ?? CLEANUP_DAYS)
        return yield* cleanup({ days, ...(dry ? { dry: true } : {}) })
      }

      case "ws": {
        const list = yield* listWorkspaces
        return [`作業場(${list.length} 件)— ${runsRoot()}`, "", renderWorkspaces(list, Date.now())].join("\n")
      }

      case "selfdev": {
        // **中でゲートが通るところまでやる。** clone を置いただけの状態を「できた」と出すと、
        // 次の tick が依存の取得で持ち時間を全部使って、そこで切られる。
        return yield* selfdev(rest.includes("--fresh") ? { fresh: true } : {})
      }

      case "intake": {
        const intake = yield* Intake
        const dry = rest.includes("--dry")
        const n = Number(rest.find((a) => /^\d+$/.test(a)) ?? (dry ? 100 : 10))
        const refs = yield* intake.scan(n)

        // ── 選別だけ。**枠を1回も使わずに効き目が測れる**ので、既定の確認手段はこちら。
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
          // 途中で枠が閉じたら**そこで止めて、済んだぶんは残す**。
          // 全体を1トランザクションにすると、最後の1件の枠切れでそれまで取り込んだぶんまで消える。
          const r = yield* intake.ingest(ref).pipe(
            Effect.catchAll((e) => {
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
          ...(stopped ? ["", `途中で止めた: ${stopped}`, "残りは次の oz intake で続きから入る。"] : []),
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
    // 問いや watch を引いたときに**当たらなかった相手を偽って**報せることになる。
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
  const rt = runtime()
  try {
    // runPromise は失敗を FiberFailure で包んで投げてくる(message が "An error has occurred" になる)。
    // Exit で受けて cause を潰し、**元の失敗値そのもの**を見て文言を選ぶ。
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
