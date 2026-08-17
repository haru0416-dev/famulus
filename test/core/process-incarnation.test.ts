import assert from "node:assert/strict"
import { test } from "vitest"
import {
  currentProcessIncarnation,
  incarnationLiveness,
  type ProcessReader,
} from "../../src/core/process-incarnation.ts"

const stat = (pid: number, state: string, ticks: string): string =>
  `${pid} (name with ) inside) ${state} ${Array(18).fill("0").join(" ")} ${ticks} 0 0`

const reader = (files: Record<string, string>): ProcessReader => ({
  readText: (path) => {
    if (!(path in files)) throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" })
    return files[path] as string
  },
  readLink: () => "pid:[42]",
  hostname: () => "host",
})

test("process名に括弧があってもstart ticksを読む", () => {
  const r = reader({
    "/etc/machine-id": "machine\n",
    "/proc/sys/kernel/random/boot_id": "boot\n",
    "/proc/7/stat": stat(7, "T", "12345"),
  })
  assert.deepEqual(currentProcessIncarnation(r, 7), {
    hostId: "machine",
    bootId: "boot",
    pidNamespace: "pid:[42]",
    pid: 7,
    startTicks: "12345",
    hostname: "host",
  })
})

test("停止中はalive、PID再利用と旧bootはdead、別hostはunknown", () => {
  const current = {
    hostId: "machine",
    bootId: "boot",
    pidNamespace: "pid:[42]",
    pid: 7,
    startTicks: "12345",
    hostname: "host",
  }
  const r = reader({ "/proc/7/stat": stat(7, "T", "12345") })
  assert.deepEqual(incarnationLiveness(current, current, r), { kind: "alive", state: "T" })
  assert.deepEqual(incarnationLiveness({ ...current, startTicks: "9" }, current, r), {
    kind: "dead",
    proof: "start-mismatch",
  })
  assert.deepEqual(incarnationLiveness({ ...current, bootId: "old" }, current, r), {
    kind: "dead",
    proof: "old-boot",
  })
  assert.equal(incarnationLiveness({ ...current, hostId: "remote" }, current, r).kind, "unknown")
})

test("消滅PIDとzombieをdeadとして証明する", () => {
  const current = {
    hostId: "machine",
    bootId: "boot",
    pidNamespace: "pid:[42]",
    pid: 7,
    startTicks: "12345",
    hostname: "host",
  }
  assert.deepEqual(incarnationLiveness(current, current, reader({})), {
    kind: "dead",
    proof: "pid-absent",
  })
  assert.deepEqual(incarnationLiveness(current, current, reader({ "/proc/7/stat": stat(7, "Z", "12345") })), {
    kind: "dead",
    proof: "terminated-state",
  })
})
