/**
 * DB の検査。append-only が SQL 側で強制されていることを、アプリを経由せずに直接叩いて確かめる。
 * (アプリが行儀よく書いているだけなら、別経路が一つ増えた時点で不変条件は消える)
 */

import { test } from "bun:test"
import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { Db } from "../src/services/Db.ts"
import { Memory, renderRecall } from "../src/services/Memory.ts"
import { withHarness } from "./helpers.ts"

test("events は DELETE できない(トリガが ABORT する)", async () => {
  await withHarness(async (h) => {
    const id = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        return yield* mem.remember({ content: "歯医者は水曜の18時" })
      }),
    )

    const e = await h.fail(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.run("DELETE FROM events WHERE id = ?", id)
      }),
    )
    assert.equal((e as { _tag: string })._tag, "DbFailed")
    assert.match((e as { message: string }).message, /append-only/)

    const n = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        return yield* mem.count
      }),
    )
    assert.equal(n, 1)
  })
})

test("events の UPDATE は content := NULL(抹消)だけ通る", async () => {
  await withHarness(async (h) => {
    const id = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        return yield* mem.remember({ content: "書き換え禁止" })
      }),
    )

    // 内容の差し替えは拒否。
    const e = await h.fail(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.run("UPDATE events SET content = ?WHERE id = ?", '"別の話"', id)
      }),
    )
    assert.equal((e as { _tag: string })._tag, "DbFailed")

    // provenance を変えると監査の根拠が失われるため、メタデータも変更できない。
    const e2 = await h.fail(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.run("UPDATE events SET source = 'system' WHERE id = ?", id)
      }),
    )
    assert.equal((e2 as { _tag: string })._tag, "DbFailed")

    // 内容は見えなくできても、監査履歴は残る。
    const after = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const db = yield* Db
        yield* mem.redact(id, "本人の依頼")
        const row = yield* db.get("SELECT content FROM events WHERE id = ?", id)
        const r = yield* db.get("SELECT kind, supersedes FROM events WHERE kind = 'redact'")
        return { content: row?.content, redact: r }
      }),
    )
    assert.equal(after.content, null)
    assert.equal(after.redact?.supersedes, id)
  })
})

test("recall は trigram で部分一致する(日本語が分かち書きなしで引ける)", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ content: "明日の会議資料をレビューする" })
        yield* mem.remember({ content: "牛乳を買う" })
        return yield* mem.recall("会議資料")
      }),
    )
    assert.equal(rows.length, 1)
    assert.match(String(rows[0]?.content), /会議資料/)
  })
})

/**
 * 入力はモデルを呼ぶ前に DB へ落ちる。除外しないと自分が今言われたことを過去の記録として読む
 * — 「最近疲れてる」の 49 秒後に「それ昨日も言ってる」と返す事故が実際に起きた。
 * 索引に入れない手(自走側の `text: ""`)は対話の入力には使えないので、検索の側で外す。
 */
test("recall は今のターンの入力を過去の記録として返さない", async () => {
  await withHarness(async (h) => {
    const { withSelf, withoutSelf } = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        // 本当に過去にある記録。同じ本文だと dedupe が畳むので、別の言い回しにする。
        yield* mem.remember({ kind: "observe", content: { said: "先週から疲れが抜けない" } })
        // 今このターンで受け取った入力。DB には残るが、検索の根拠にしてはいけない。
        const now = yield* mem.remember({
          kind: "observe",
          content: { said: "最近ちょっと疲れてるんだよね" },
        })
        return {
          withSelf: yield* mem.recall("疲れ"),
          withoutSelf: yield* mem.recall("疲れ", 10, now),
        }
      }),
    )
    assert.equal(withSelf.length, 2, "除外しなければ今の入力も当たる")
    assert.equal(withoutSelf.length, 1, "今の入力は根拠から外れる")
    assert.match(String(withoutSelf[0]?.content), /先週から疲れが抜けない/, "残るのは本当の過去だけ")
  })
})

test("2文字の日本語(会議・予定)も引ける — trigram の窓から外れる帯を LIKE で拾う", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ content: "明日の会議は14時から" })
        yield* mem.remember({ content: "牛乳を買う" })
        return yield* mem.recall("会議")
      }),
    )
    assert.equal(rows.length, 1)
    assert.match(String(rows[0]?.content), /14時/)
  })
})

test("recall の空クエリは引かない", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ content: "何か" })
        return yield* mem.recall("  ")
      }),
    )
    assert.deepEqual(rows, [])
  })
})

test("recall は FTS のクエリ構文をユーザー入力として解釈しない", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ content: "予定表" })
        return yield* mem.recall('予定" OR "*')
      }),
    )
    assert.ok(Array.isArray(rows))
  })
})

test("抹消したイベントは recall に出てこない", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const id = yield* mem.remember({ content: "口座番号は 1234567" })
        yield* mem.redact(id, "秘密")
        return yield* mem.recall("口座番号")
      }),
    )
    assert.deepEqual(rows, [])
  })
})

// ── 置き方(何が上位に来るか)の検査。
//
// 検索が「一致するか」だけを見ていた頃は、並びが `at DESC` = 一致した中の新着順だった。
// tick は起きるたびに長い自己言及を書くので、新しさだけでシステム記録が上位を占め、
// 探している事実を押し下げていた(`recall 予約` の上位10件のうち5件がシステム記録)。
// 引けるかどうかと同じくらい、何が先に見えるかが記憶の質を決める。

test("recall は関連度と層で並ぶ — 新しいだけのシステム記録が確定した事実を押し下げない", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.believe("dentist.next_appt", "歯医者の次回予約は8月12日18:00")
        yield* mem.remember({
          source: "system",
          content: { tick: "起動した。次回予約の件は動かない。次回予約について今は判断しない。" },
        })
        return yield* mem.recall("次回予約")
      }),
    )
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.kind, "belief", "確定した事実が先頭に来る")
    assert.equal(rows[1]?.source, "system", "システム記録は後ろに下がる")
  })
})

test("索引に入れなかった行は検索に出ない — DB には残る", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ content: "面談は9時から" })
        yield* mem.remember({ source: "system", content: { tickPrompt: "面談 面談 面談" }, text: "" })
        return { hits: yield* mem.recall("面談"), all: yield* mem.count }
      }),
    )
    assert.equal(out.all, 2, "DB(正本)からは消さない")
    // 除外した行が短いクエリの LIKE フォールバック経由で再び現れてはならない。
    assert.equal(out.hits.length, 1, "検索に出るのは索引を持つ1件だけ")
    assert.match(String(out.hits[0]?.text), /9時/)
  })
})

test("上書きした belief の旧版は『確定』として前に出ない", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.believe("dentist.next_appt", "歯医者の次回予約は8月12日")
        yield* mem.believe("dentist.next_appt", "歯医者の次回予約は8月13日")
        return yield* mem.recall("次回予約")
      }),
    )
    assert.equal(rows.length, 2, "旧版が DB から消えるわけではない")
    assert.equal(rows[0]?.is_current, 1, "今の値が先頭")
    assert.match(String(rows[0]?.text), /8月13日/)
    assert.equal(rows[1]?.is_current, 0)
    // 読む側が古い値を今の値と取り違えないよう、ラベルで分ける。
    assert.match(renderRecall(rows), /確定\(旧版\)/)
  })
})

test("同じ本文の繰り返しは畳まれる(1つの話題で枠を埋めない)", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        for (let i = 0; i < 5; i++) yield* mem.remember({ content: "はじめまして。あなたは誰？" })
        yield* mem.remember({ content: "はじめまして、と何度も訊かれている件" })
        return yield* mem.recall("はじめまして")
      }),
    )
    assert.equal(rows.length, 2, "同文5件は1件に畳まれる")
  })
})

test("recall の描画は JSON 構造を出さず、どの層の1行かを示す", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ source: "owner", content: { said: "歯医者は8月12日" } })
        return renderRecall(yield* mem.recall("歯医者"))
      }),
    )
    assert.doesNotMatch(out, /\{"said"/)
    assert.match(out, /owner\]/)
    assert.match(out, /歯医者は8月12日/)
  })
})

test("system 由来の記録はシステム記録と表示する", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ source: "system", content: "次回予約はまだ確認していない" })
        return renderRecall(yield* mem.recall("次回予約"))
      }),
    )
    assert.match(out, /システム記録/)
  })
})

test("belief は必ず belief イベントを根拠に持つ(resolved_from の FK)", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const db = yield* Db
        const eventId = yield* mem.believe("dentist.next_appt", "2026-08-12T18:00:00Z")
        const slot = yield* mem.belief("dentist.next_appt")
        const ev = yield* db.get("SELECT kind FROM events WHERE id = ?", eventId)
        return { eventId, slot, kind: ev?.kind }
      }),
    )
    assert.equal(out.kind, "belief")
    assert.equal(out.slot?.value, "2026-08-12T18:00:00Z")
    assert.equal(out.slot?.resolvedFrom, out.eventId)

    const e = await h.fail(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.run(
          `INSERT INTO belief_slots (slot, value, exposure, resolved_from, updated_at, valid_from)
           VALUES ('bogus', '"x"', 'private', 'no-such-event', '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z')`,
        )
      }),
    )
    assert.equal((e as { _tag: string })._tag, "DbFailed")
  })
})

test("belief は上書きされるが、履歴は events に残る", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.believe("home.city", "札幌")
        yield* mem.believe("home.city", "東京")
        const slot = yield* mem.belief("home.city")
        const rows = yield* mem.recent(10)
        return { slot, beliefs: rows.filter((r) => r.kind === "belief").length }
      }),
    )
    assert.equal(out.slot?.value, "東京")
    assert.equal(out.beliefs, 2)
  })
})

/**
 * 事実が変わったとき、古い値は消えず、区間として閉じる。
 *
 * ここが上書きだった頃は「転職活動中だった時期」そのものが DB から消えていた。
 * 今の値しか持たない DB は現在形の問いにしか答えられず、
 * 「去年の今ごろ何をしていたか」を聞かれると何も言えない。
 */
test("値が変わっても古い区間は残る — 今の値と、あの時点の値が両方引ける", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.believe("work.job_search", "転職活動中。複数社と面談している", {
          validFrom: "2026-03-01T00:00:00Z",
        })
        yield* mem.believe("work.job_search", "終わった。今の会社に残る", {
          validFrom: "2026-09-01T00:00:00Z",
          reason: "ユーザーが転職の終了を明言した",
        })
        return {
          now: yield* mem.belief("work.job_search"),
          past: yield* mem.beliefAsOf("work.job_search", "2026-05-01T00:00:00Z"),
          history: yield* mem.beliefHistory("work.job_search"),
        }
      }),
    )
    assert.match(String(out.now?.value), /今の会社に残る/)
    assert.equal(out.now?.validUntil, null, "今の値は区間が開いている")
    assert.equal(out.now?.validFrom, "2026-09-01T00:00:00Z")

    // 過去形の問いに答えられる。上書きしていたらここは今の値を返してしまう。
    assert.match(String(out.past?.value), /転職活動中/)
    assert.equal(out.past?.validUntil, "2026-09-01T00:00:00Z", "古い区間はそこで閉じている")
    assert.equal(out.past?.invalidatedReason, "ユーザーが転職の終了を明言した", "なぜ閉じたかが残る")

    assert.equal(out.history.length, 2)
  })
})

test("区間は半開 — 境界の瞬間はどちらか一方だけが主張する", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.believe("home.city", "札幌", { validFrom: "2026-01-01T00:00:00Z" })
        yield* mem.believe("home.city", "東京", { validFrom: "2026-06-01T00:00:00Z" })
        return {
          before: yield* mem.beliefAsOf("home.city", "2026-05-31T23:59:59Z"),
          at: yield* mem.beliefAsOf("home.city", "2026-06-01T00:00:00Z"),
          way: yield* mem.beliefAsOf("home.city", "2025-12-31T00:00:00Z"),
        }
      }),
    )
    assert.equal(out.before?.value, "札幌")
    assert.equal(out.at?.value, "東京", "境界のその瞬間からは新しい値")
    assert.equal(out.way, undefined, "確定より前のことは知らない — 推測で埋めない")
  })
})

test("閉じた区間の belief は検索で『確定』として前に出ない", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.believe("work.job_search", "転職活動中である", {
          validFrom: "2026-03-01T00:00:00Z",
        })
        yield* mem.believe("work.job_search", "転職はもう終わった", {
          validFrom: "2026-09-01T00:00:00Z",
        })
        return yield* mem.recall("転職")
      }),
    )
    const current = rows.filter((r) => r.is_current === 1)
    assert.equal(current.length, 1, "今の値は1本だけ")
    assert.match(String(current[0]?.text), /もう終わった/)
    // 古い値も残ってはいる。消さないが、今の事実の顔はさせない。
    assert.match(renderRecall(rows), /確定\(旧版\)/)
  })
})

test("同じ slot に閉じていない区間は2本並ばない(部分 UNIQUE が守る)", async () => {
  await withHarness(async (h) => {
    const e = await h.fail(
      Effect.gen(function* () {
        const mem = yield* Memory
        const db = yield* Db
        const id = yield* mem.believe("home.city", "札幌", { validFrom: "2026-01-01T00:00:00Z" })
        // 区間を閉じずに次を入れようとする = 現在値が2つある状態。ここで落ちなければならない。
        yield* db.run(
          `INSERT INTO belief_slots (slot, value, exposure, resolved_from, updated_at, valid_from)
           VALUES ('home.city', '"東京"', 'private', ?, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
          id,
        )
      }),
    )
    assert.equal((e as { _tag: string })._tag, "DbFailed")
  })
})

test("確かめてから時間が経った事実だけを拾える(陳腐化の検出)", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.believe("work.job_search", "転職活動中", { validFrom: "2026-01-01T00:00:00Z" })
        yield* mem.believe("home.city", "東京", { validFrom: "2026-08-01T00:00:00Z" })
        // 閉じた区間は「古い」ではなく「終わった」。聞き直す対象ではない。
        yield* mem.believe("phone.model", "旧機種", { validFrom: "2026-01-01T00:00:00Z" })
        yield* mem.believe("phone.model", "新機種", { validFrom: "2026-08-05T00:00:00Z" })
        return yield* mem.staleBeliefs("2026-06-01T00:00:00Z")
      }),
    )
    assert.deepEqual(
      out.map((b) => b.slot),
      ["work.job_search"],
      "古いまま開いている区間だけが挙がる",
    )
  })
})

test("gmail/web 由来は既定で taint が立つ", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        const db = yield* Db
        yield* mem.remember({ source: "gmail", content: "外部メール" })
        yield* mem.remember({ source: "owner", content: "本人の発話" })
        return yield* db.all("SELECT source, taint FROM events ORDER BY source")
      }),
    )
    assert.deepEqual(
      rows.map((r) => [r.source, r.taint]),
      [
        ["gmail", 1],
        ["owner", 0],
      ],
    )
  })
})

test("空白で区切った複数語は AND で絞る(フレーズ一致にしない)", async () => {
  await withHarness(async (h) => {
    const out = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ content: "エージェントの記憶をどう置くか。メモリの設計を考え直した。" })
        yield* mem.remember({ content: "エージェントの自走。tick を systemd timer で回す。" })
        return {
          both: yield* mem.recall("エージェント メモリ"),
          one: yield* mem.recall("エージェント"),
        }
      }),
    )
    // 語の間に空白を挟んだだけで 0 件になっていた。絞り込みたいときに使えないのが致命的だった。
    assert.equal(out.both.length, 1, "両方の語を含む行だけが残る")
    assert.match(String(out.both[0]?.text), /メモリの設計/)
    assert.equal(out.one.length, 2)
  })
})

test("3文字未満の語も、索引で引ける語と重ねて絞れる", async () => {
  await withHarness(async (h) => {
    const rows = await h.run(
      Effect.gen(function* () {
        const mem = yield* Memory
        yield* mem.remember({ content: "パフォーマンスの会議は14時から" })
        yield* mem.remember({ content: "パフォーマンスの計測結果をまとめた" })
        return yield* mem.recall("パフォーマンス 会議")
      }),
    )
    assert.equal(rows.length, 1)
    assert.match(String(rows[0]?.text), /14時/)
  })
})
