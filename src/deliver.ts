#!/usr/bin/env bun
/** Discord の durable queue だけを配送する独立 oneshot。モデルも受信処理も持たない。 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as Effect from "effect/Effect"
import { configureApp, PROJECT_ROOT } from "./core/config.ts"
import { loadEnv } from "./core/env.ts"
import { run, runtime } from "./runtime.ts"
import { Discord } from "./services/Discord.ts"

type Execute = (file: string, args: readonly string[], options: { timeout: number }) => Promise<unknown>
const execute = promisify(execFile) as Execute

/**
 * poll / cycle の cgroup から配送を分離する。既に動いている unit への起動失敗は、そのworkerが
 * queue を処理中という意味なので呼び出し側の失敗にはしない。
 */
export async function wakeDelivery(enabled: boolean, exec: Execute = execute): Promise<boolean> {
  if (!enabled) return false
  try {
    await exec(
      "systemd-run",
      [
        "--user",
        "--collect",
        "--no-block",
        "--unit=famulus-deliver",
        `--working-directory=${PROJECT_ROOT}`,
        "--property=Nice=10",
        process.execPath,
        "src/deliver.ts",
      ],
      { timeout: 5_000 },
    )
    return true
  } catch (error) {
    if (/unit famulus-deliver(?:\.service)? already exists/i.test(String(error))) return false
    throw error
  }
}

const hasPending = () => run(Effect.flatMap(Discord, (discord) => discord.needsFlush()))

/** 配送・再調停の対象が無ければ一時unit自体を作らない。 */
export async function wakePendingDelivery(
  enabled: boolean,
  pending: () => Promise<boolean> = hasPending,
  exec: Execute = execute,
): Promise<boolean> {
  if (!enabled) return false
  return (await pending()) ? wakeDelivery(true, exec) : false
}

export async function deliver(): Promise<number> {
  loadEnv()
  configureApp()
  const rt = runtime()
  try {
    const flushed = await run(
      Effect.flatMap(Discord, (discord) => discord.flushQueued()),
      rt,
    )
    const failed = flushed.filter((outbound) => outbound.state !== "sent")
    if (failed.length > 0)
      throw new Error(
        `Discord配送失敗: ${failed.map((outbound) => `${outbound.id}:${outbound.state}`).join(", ")}`,
      )
    return flushed.length
  } finally {
    await rt.dispose()
  }
}

if (import.meta.main) console.log(`配送 ${await deliver()} 件`)
