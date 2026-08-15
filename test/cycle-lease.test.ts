import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { test } from "vitest"
import type { IncarnationLiveness, ProcessIncarnation } from "../src/core/process-incarnation.ts"
import { CycleLease, makeCycleLease } from "../src/services/CycleLease.ts"
import { Db, DbLive, type DbTx } from "../src/services/Db.ts"

const identity = (pid: number): ProcessIncarnation => ({
  hostId: "host",
  bootId: "boot",
  pidNamespace: "pid:[1]",
  pid,
  startTicks: String(pid * 10),
  hostname: `host-${pid}`,
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const readLine = async (stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
  return JSON.parse(text.trim()) as Record<string, unknown>
}

test("claim、heartbeat、releaseはfenceを維持し次claimで増加する", async () => {
  let now = 1_000
  let current = identity(1)
  let nextOwner = 0
  let liveness: IncarnationLiveness = { kind: "alive", state: "T" }
  const dbLayer = DbLive(":memory:")
  const leaseLayer = Layer.effect(
    CycleLease,
    makeCycleLease({
      current: () => current,
      liveness: () => liveness,
      now: () => now,
      ownerId: () => `owner-${++nextOwner}`,
      ttlMs: 100,
    }),
  )
  const rt = ManagedRuntime.make(Layer.provideMerge(leaseLayer, dbLayer))
  try {
    const first = await rt.runPromise(
      Effect.gen(function* () {
        const lease = yield* CycleLease
        const token = yield* lease.acquire()
        now = 900
        yield* lease.heartbeat(token)
        const row = yield* lease.status()
        return { token, row }
      }),
    )
    assert.equal(first.token.fence, 1)
    assert.equal(first.row.heartbeat_at_ms, 1_000)
    assert.equal(first.row.expires_at_ms, 1_100)

    current = identity(2)
    await assert.rejects(
      () => rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.acquire())),
      /CycleLeaseHeld/,
    )

    now = 1_200
    await assert.rejects(
      () => rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.acquire())),
      /CycleLeaseHeld/,
    )

    liveness = { kind: "unknown", reason: "cannot inspect" }
    await assert.rejects(
      () => rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.acquire())),
      /CycleLeaseRecoveryUncertain/,
    )

    liveness = { kind: "dead", proof: "pid-absent" }
    const second = await rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.acquire()))
    assert.equal(second.fence, 2)

    await assert.rejects(
      () => rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.heartbeat(first.token))),
      /CycleLeaseLost/,
    )
    await assert.rejects(
      () => rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.release(first.token))),
      /CycleLeaseLost/,
    )

    await rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.release(second)))
    current = identity(3)
    const third = await rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.acquire()))
    assert.equal(third.fence, 3)
  } finally {
    await rt.dispose()
  }
})

test("stale fenced transactionはdomain更新を一切行わない", async () => {
  let current = identity(1)
  let now = 1_000
  const dbLayer = DbLive(":memory:")
  const leaseLayer = Layer.effect(
    CycleLease,
    makeCycleLease({
      current: () => current,
      liveness: () => ({ kind: "dead", proof: "pid-absent" }),
      now: () => now,
      ownerId: () => `owner-${current.pid}`,
      ttlMs: 10,
    }),
  )
  const rt = ManagedRuntime.make(Layer.provideMerge(leaseLayer, dbLayer))
  try {
    const stale = await rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.acquire()))
    now = 2_000
    current = identity(2)
    const active = await rt.runPromise(Effect.flatMap(CycleLease, (lease) => lease.acquire()))

    await assert.rejects(
      () =>
        rt.runPromise(
          Effect.flatMap(CycleLease, (lease) =>
            lease.withFencedTransaction(stale, "stale write", (tx) =>
              tx.run("INSERT INTO schema_meta(key,value)VALUES('stale-write','yes')"),
            ),
          ),
        ),
      /CycleLeaseLost/,
    )
    await rt.runPromise(
      Effect.flatMap(CycleLease, (lease) =>
        lease.withFencedTransaction(active, "active write", (tx) =>
          tx.run("INSERT INTO schema_meta(key,value)VALUES('active-write','yes')"),
        ),
      ),
    )
    const values = await rt.runPromise(
      Effect.gen(function* () {
        const db = yield* Db
        return { stale: yield* db.meta("stale-write"), active: yield* db.meta("active-write") }
      }),
    )
    assert.deepEqual(values, { stale: undefined, active: "yes" })
  } finally {
    await rt.dispose()
  }
})

test("transaction callbackはasyncとhandle漏出を拒否してrollbackする", async () => {
  const rt = ManagedRuntime.make(DbLive(":memory:"))
  let leaked: DbTx | undefined
  try {
    await assert.rejects(
      () =>
        rt.runPromise(
          Effect.flatMap(Db, (db) =>
            db.withImmediateTransaction("async callback", ((tx: DbTx) => {
              tx.run("INSERT INTO schema_meta(key,value)VALUES('async-write','yes')")
              leaked = tx
              return Promise.resolve("bad")
            }) as never),
          ),
        ),
      /synchronous/,
    )
    const value = await rt.runPromise(Effect.flatMap(Db, (db) => db.meta("async-write")))
    assert.equal(value, undefined)
    assert.throws(() => leaked?.run("SELECT 1"), /no longer active/)

    for (const control of ["END", ";; /* hidden */ COMMIT", "-- hidden\nROLLBACK", "SAVEPOINT nested"]) {
      await assert.rejects(
        () =>
          rt.runPromise(
            Effect.flatMap(Db, (db) =>
              db.withImmediateTransaction("transaction control", (tx) => {
                tx.run("INSERT OR REPLACE INTO schema_meta(key,value)VALUES('control-write','yes')")
                tx.run(control)
              }),
            ),
          ),
        /transaction control SQL is not allowed/,
      )
      assert.equal(await rt.runPromise(Effect.flatMap(Db, (db) => db.meta("control-write"))), undefined)
    }

    for (const leaking of [
      "PRAGMA query_only=ON",
      "PRAGMA ignore_check_constraints=ON",
      "ATTACH DATABASE ':memory:' AS leaked",
      "VACUUM",
    ]) {
      await assert.rejects(
        () =>
          rt.runPromise(
            Effect.flatMap(Db, (db) =>
              db.withImmediateTransaction("connection state", (tx) => tx.run(leaking)),
            ),
          ),
        /SQL is not allowed/,
      )
    }
    await rt.runPromise(Effect.flatMap(Db, (db) => db.setMeta("still-writable", "yes")))

    await assert.rejects(
      () =>
        rt.runPromise(
          Effect.flatMap(Db, (db) =>
            db.withImmediateTransaction("reentrant public API", (tx) => {
              tx.run("INSERT OR REPLACE INTO schema_meta(key,value)VALUES('reentrant-write','yes')")
              Effect.runSync(db.run("END"))
            }),
          ),
        ),
      /public DB API cannot run/,
    )
    assert.equal(await rt.runPromise(Effect.flatMap(Db, (db) => db.meta("reentrant-write"))), undefined)

    await assert.rejects(
      () =>
        rt.runPromise(
          Effect.flatMap(Db, (db) =>
            db.withImmediateTransaction("outer", () =>
              Effect.runSync(db.withImmediateTransaction("nested", () => undefined)),
            ),
          ),
        ),
      /public DB API cannot run/,
    )

    // biome-ignore lint/suspicious/noThenProperty: adversarial fixture for callable thenables
    const callableThenable = Object.assign(() => undefined, { then: () => undefined })
    await assert.rejects(
      () =>
        rt.runPromise(
          Effect.flatMap(Db, (db) =>
            db.withImmediateTransaction("callable thenable", (() => callableThenable) as never),
          ),
        ),
      /synchronous/,
    )
  } finally {
    await rt.dispose()
  }
})

test("実プロセスで停止中ownerを奪わず終了後だけ高いfenceで回復する", async () => {
  const root = mkdtempSync(join(tmpdir(), "oz-cycle-lease-"))
  const path = join(root, "lease.db")
  const fixture = join(import.meta.dirname, "fixtures", "cycle-lease-probe.ts")
  const spawn = (mode: "hold" | "once") =>
    Bun.spawn([process.execPath, fixture, path, "150", mode], { stdout: "pipe", stderr: "pipe" })
  const owner = spawn("hold")
  try {
    const first = await readLine(owner.stdout)
    assert.equal(first.ok, true)
    assert.equal(first.fence, 1)

    process.kill(owner.pid, "SIGSTOP")
    await wait(250)
    const contender = spawn("once")
    const blocked = await readLine(contender.stdout)
    assert.equal(await contender.exited, 2)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.tag, "CycleLeaseHeld")

    process.kill(owner.pid, "SIGKILL")
    assert.notEqual(await owner.exited, 0)
    const recovery = spawn("once")
    const recovered = await readLine(recovery.stdout)
    assert.equal(await recovery.exited, 0)
    assert.equal(recovered.ok, true)
    assert.equal(recovered.fence, 2)
  } finally {
    try {
      process.kill(owner.pid, "SIGKILL")
    } catch {}
    await owner.exited
    rmSync(root, { recursive: true, force: true })
  }
})
