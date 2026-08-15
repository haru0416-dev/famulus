import { readFileSync, readlinkSync } from "node:fs"
import { hostname } from "node:os"

export interface ProcessIncarnation {
  readonly hostId: string
  readonly bootId: string
  readonly pidNamespace: string
  readonly pid: number
  readonly startTicks: string
  readonly hostname: string
}

export type IncarnationLiveness =
  | { readonly kind: "alive"; readonly state: string }
  | {
      readonly kind: "dead"
      readonly proof: "old-boot" | "pid-absent" | "start-mismatch" | "terminated-state"
    }
  | { readonly kind: "unknown"; readonly reason: string }

export interface ProcessReader {
  readonly readText: (path: string) => string
  readonly readLink: (path: string) => string
  readonly hostname: () => string
}

const systemReader: ProcessReader = {
  readText: (path) => readFileSync(path, "utf8"),
  readLink: (path) => readlinkSync(path),
  hostname,
}

const procState = (text: string): { readonly state: string; readonly startTicks: string } => {
  const close = text.lastIndexOf(")")
  if (close < 0) throw new Error("missing process name terminator")
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  const startTicks = fields[19]
  if (!state || !startTicks || !/^\d+$/.test(startTicks)) throw new Error("malformed /proc stat")
  return { state, startTicks }
}

const text = (reader: ProcessReader, path: string): string => {
  const value = reader.readText(path).trim()
  if (!value) throw new Error(`empty process identity: ${path}`)
  return value
}

export const currentProcessIncarnation = (
  reader: ProcessReader = systemReader,
  pid: number = process.pid,
): ProcessIncarnation => ({
  hostId: text(reader, "/etc/machine-id"),
  bootId: text(reader, "/proc/sys/kernel/random/boot_id"),
  pidNamespace: reader.readLink("/proc/self/ns/pid"),
  pid,
  startTicks: procState(reader.readText(`/proc/${pid}/stat`)).startTicks,
  hostname: reader.hostname(),
})

export const incarnationLiveness = (
  owner: ProcessIncarnation,
  current: ProcessIncarnation,
  reader: ProcessReader = systemReader,
): IncarnationLiveness => {
  if (owner.hostId !== current.hostId) return { kind: "unknown", reason: "owner is on another host" }
  if (owner.bootId !== current.bootId) return { kind: "dead", proof: "old-boot" }
  if (owner.pidNamespace !== current.pidNamespace)
    return { kind: "unknown", reason: "owner is in another PID namespace" }
  try {
    const state = procState(reader.readText(`/proc/${owner.pid}/stat`))
    if (state.startTicks !== owner.startTicks) return { kind: "dead", proof: "start-mismatch" }
    if (state.state === "Z" || state.state === "X" || state.state === "x")
      return { kind: "dead", proof: "terminated-state" }
    return { kind: "alive", state: state.state }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === "ENOENT" || code === "ESRCH") return { kind: "dead", proof: "pid-absent" }
    return { kind: "unknown", reason: String(error) }
  }
}
