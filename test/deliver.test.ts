import assert from "node:assert/strict"
import { test } from "vitest"
import { wakeDelivery, wakePendingDelivery } from "../src/deliver.ts"

test("配送workerを無効にした検査ではsystemdを呼ばない", async () => {
  let called = false
  const started = await wakeDelivery(false, async () => {
    called = true
  })
  assert.equal(started, false)
  assert.equal(called, false)
})

test("配送workerはpollと別の一時unitをno-blockで起動する", async () => {
  let command: { file: string; args: readonly string[]; timeout: number } | undefined
  const started = await wakeDelivery(true, async (file, args, options) => {
    command = { file, args, timeout: options.timeout }
  })
  assert.equal(started, true)
  assert.equal(command?.file, "systemd-run")
  assert.ok(command?.args.includes("--no-block"))
  assert.ok(command?.args.includes("--unit=famulus-deliver"))
  assert.equal(command?.args.at(-2), process.execPath)
  assert.equal(command?.args.at(-1), "src/deliver.ts")
  assert.equal(command?.timeout, 5_000)
})

test("既に配送workerが動いている場合は呼び出し側を失敗させない", async () => {
  const started = await wakeDelivery(true, async () => {
    throw new Error("Unit famulus-deliver.service already exists")
  })
  assert.equal(started, false)
})

test("配送workerの起動障害は呼び出し側へ返す", async () => {
  await assert.rejects(
    () =>
      wakeDelivery(true, async () => {
        throw new Error("Failed to connect to bus")
      }),
    /connect to bus/,
  )
})

test("配送対象がある場合だけ独立workerを起動する", async () => {
  let calls = 0
  const exec = async () => {
    calls++
  }
  assert.equal(await wakePendingDelivery(true, async () => false, exec), false)
  assert.equal(calls, 0)
  assert.equal(await wakePendingDelivery(true, async () => true, exec), true)
  assert.equal(calls, 1)
})
