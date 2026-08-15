import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { CycleLease, makeCycleLease } from "../../src/services/CycleLease.ts"
import { DbLive } from "../../src/services/Db.ts"

const [path, ttlText, mode] = process.argv.slice(2)
if (!path || !ttlText || !mode) throw new Error("usage: cycle-lease-probe.ts DB TTL_MS hold|once")

const leaseLayer = Layer.effect(CycleLease, makeCycleLease({ ttlMs: Number(ttlText) }))
const runtime = ManagedRuntime.make(Layer.provideMerge(leaseLayer, DbLive(path)))

try {
  const token = await runtime.runPromise(Effect.flatMap(CycleLease, (lease) => lease.acquire()))
  console.log(JSON.stringify({ ok: true, fence: token.fence, ownerId: token.ownerId }))
  if (mode === "hold") {
    setInterval(() => undefined, 1_000)
    await new Promise<void>(() => undefined)
  } else {
    await runtime.runPromise(Effect.flatMap(CycleLease, (lease) => lease.release(token)))
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, tag: (error as { _tag?: unknown })._tag, message: String(error) }))
  process.exitCode = 2
} finally {
  await runtime.dispose()
}
