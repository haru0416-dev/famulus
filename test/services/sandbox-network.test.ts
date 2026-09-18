import assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { test } from "vitest"
import { Db } from "../../src/services/Db.ts"
import { Proposals } from "../../src/services/Proposals.ts"
import { prepareSandboxNetwork } from "../../src/services/SandboxNetwork.ts"
import { withHarness } from "../helpers.ts"

test("公開通信はownerの承認と完全一致する操作だけに単回で許可される", async () => {
  await withHarness(async (h) => {
    const request = await h.run(prepareSandboxNetwork("npm install", "/tmp/approval-work"))
    assert.equal(request.approved, false)
    if (request.approved) throw new Error("unexpected approval")
    const duplicate = await h.run(prepareSandboxNetwork("npm install", "/tmp/approval-work"))
    assert.equal(duplicate.approved, false)
    if (!duplicate.approved) assert.equal(duplicate.id, request.id)
    await h.run(Effect.flatMap(Proposals, (p) => p.approve(request.id)))
    const permission = await h.run(prepareSandboxNetwork("npm install", "/tmp/approval-work"))
    assert.equal(permission.approved, true)
    if (!permission.approved) throw new Error("missing approval")
    assert.equal(
      (await h.run(prepareSandboxNetwork("npm install && curl example.com", "/tmp/approval-work"))).approved,
      false,
    )
    assert.equal((await h.run(prepareSandboxNetwork("npm install", "/tmp/other-work"))).approved, false)
    const outcomes = await Promise.allSettled([permission.approval.consume(), permission.approval.consume()])
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1)
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1)
    const next = await h.run(prepareSandboxNetwork("npm install", "/tmp/approval-work"))
    assert.equal(next.approved, false)
    if (!next.approved) assert.notEqual(next.id, request.id)
    await assert.rejects(
      () => h.run(Effect.flatMap(Db, (db) => db.run("DELETE FROM sandbox_network_uses"))),
      /immutable/,
    )
  })
})

test("承認後のpayload変更と期限切れは起動時にも拒否する", async () => {
  await withHarness(async (h) => {
    for (const mutation of ["payload", "expiry"] as const) {
      const command = `echo ${mutation}`
      const request = await h.run(prepareSandboxNetwork(command, "/tmp/approval-work"))
      if (request.approved) throw new Error("unexpected approval")
      await h.run(Effect.flatMap(Proposals, (p) => p.approve(request.id)))
      const permission = await h.run(prepareSandboxNetwork(command, "/tmp/approval-work"))
      if (!permission.approved) throw new Error("missing approval")
      await h.run(
        Effect.flatMap(Db, (db) =>
          mutation === "payload"
            ? db.run("UPDATE proposals SET payload='{}' WHERE id=?", request.id)
            : db.run("UPDATE proposals SET expires_at='2000-01-01T00:00:00Z' WHERE id=?", request.id),
        ),
      )
      await assert.rejects(() => permission.approval.consume())
      const used = await h.run(
        Effect.flatMap(Db, (db) =>
          db.get("SELECT 1 FROM sandbox_network_uses WHERE proposal_id=?", request.id),
        ),
      )
      assert.equal(used, undefined)
    }
  })
})

test("却下済みと承認actionの無い許可は使えず、別の実行には別の承認を要求する", async () => {
  await withHarness(async (h) => {
    const request = await h.run(prepareSandboxNetwork("echo ok", "/tmp/approval-work", "experiment-command"))
    if (request.approved) throw new Error("unexpected approval")
    await h.run(Effect.flatMap(Proposals, (p) => p.deny(request.id, "許可しない")))
    const next = await h.run(prepareSandboxNetwork("echo ok", "/tmp/approval-work", "experiment-command"))
    if (next.approved) throw new Error("denial bypassed")
    assert.notEqual(next.id, request.id)
    await h.run(
      Effect.flatMap(Db, (db) => db.run("UPDATE proposals SET status='approved' WHERE id=?", next.id)),
    )
    const forged = await h.run(prepareSandboxNetwork("echo ok", "/tmp/approval-work", "experiment-command"))
    if (!forged.approved) throw new Error("expected deferred authorization check")
    await assert.rejects(() => forged.approval.consume())
    assert.equal(
      (await h.run(prepareSandboxNetwork("echo ok", "/tmp/approval-work", "experiment-check"))).approved,
      false,
    )
  })
})
