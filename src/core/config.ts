import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isKnownModel } from "../model/models.ts"

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "")

export class ConfigError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`設定が不正です:\n${issues.map((issue) => `- ${issue}`).join("\n")}`)
    this.name = "ConfigError"
    this.issues = issues
  }
}

export interface AppConfig {
  readonly rootDir: string
  readonly paths: {
    readonly dataDir: string
    readonly db: string
    readonly backups: string
    readonly runs: string
    readonly runCache: string
    readonly exportRoot: string
    readonly transcriptRoot: string
    readonly codexAuth: string
  }
  readonly timeZone: string
  readonly models: {
    readonly default: string
    readonly cycle: string
    readonly work: string
    readonly research: string
  }
  readonly cycle: {
    readonly timeoutMs: number
    readonly heartbeatMs: number
    readonly leaseTtlMs: number
    readonly unit: string
  }
  readonly governance: {
    readonly dailyRuns: number
    readonly autonomousRuns: number
  }
  readonly schedule: {
    readonly dailyDraftHour: number
    readonly dreamHour: number
    readonly cleanupHour: number
  }
  readonly cleanup: {
    readonly days: number
    readonly cacheMaxMb: number
  }
  readonly maintenance: {
    readonly backupKeep: number
  }
  readonly web: {
    readonly hostIntervalMs: number
    readonly searxngBase?: string
  }
  readonly discord: {
    readonly api: string
    readonly token?: string
    readonly ownerId?: string
    readonly channels: {
      readonly talk?: string
      readonly draft?: string
      readonly log?: string
    }
  }
  readonly runImage?: string
}

type Env = Readonly<Record<string, string | undefined>>

const text = (env: Env, key: string, fallback: string): string => {
  const value = env[key]?.trim()
  return value ? value : fallback
}

const optional = (env: Env, key: string): string | undefined => {
  const value = env[key]?.trim()
  return value ? value : undefined
}

const textAllowEmpty = (env: Env, key: string, fallback: string): string =>
  env[key] === undefined ? fallback : (env[key] as string).trim()

const integer = (
  env: Env,
  key: string,
  fallback: number,
  issues: string[],
  range: { readonly min: number; readonly max: number },
): number => {
  const raw = env[key]?.trim()
  if (raw === undefined || raw === "") return fallback
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    issues.push(`${key}: 10進整数が必要です`)
    return fallback
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    issues.push(`${key}: ${range.min}..${range.max} の範囲が必要です`)
    return fallback
  }
  return value
}

const absolutePath = (root: string, value: string, allowMemory = false): string => {
  if (allowMemory && value === ":memory:") return value
  return isAbsolute(value) ? value : resolve(root, value)
}

const endpoint = (
  env: Env,
  key: string,
  fallback: string,
  issues: string[],
  options: { readonly allowLoopbackHttp: boolean },
): string => {
  const value = text(env, key, fallback)
  try {
    const parsed = new URL(value)
    const loopback =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
    if (
      parsed.protocol !== "https:" &&
      !(options.allowLoopbackHttp && parsed.protocol === "http:" && loopback)
    )
      throw new Error("scheme")
    if (parsed.search || parsed.hash) throw new Error("query")
    parsed.pathname = parsed.pathname.replace(/\/$/, "")
    return parsed.toString().replace(/\/$/, "")
  } catch {
    issues.push(`${key}: HTTPS URLが必要です${options.allowLoopbackHttp ? "(loopback HTTPは可)" : ""}`)
    return fallback
  }
}

const optionalEndpoint = (
  env: Env,
  key: string,
  fallback: string,
  issues: string[],
  options: { readonly allowLoopbackHttp: boolean },
): string | undefined => {
  if (textAllowEmpty(env, key, fallback) === "") return undefined
  return endpoint(env, key, fallback, issues, options)
}

export function parseConfig(env: Env = process.env, rootDir: string = PROJECT_ROOT): AppConfig {
  const issues: string[] = []
  const root = resolve(rootDir)
  const dataDir = absolutePath(root, text(env, "OPEN_ZERO_DATA", ".data"))
  const timeoutMs = integer(env, "OPEN_ZERO_CYCLE_TIMEOUT_MS", 420_000, issues, { min: 1_000, max: 540_000 })
  const heartbeatMs = integer(env, "OPEN_ZERO_CYCLE_HEARTBEAT_MS", 30_000, issues, {
    min: 1_000,
    max: 300_000,
  })
  const leaseTtlMs = integer(env, "OPEN_ZERO_CYCLE_LEASE_TTL_MS", 90_000, issues, {
    min: 3_000,
    max: 900_000,
  })
  if (leaseTtlMs < heartbeatMs * 3) issues.push("OPEN_ZERO_CYCLE_LEASE_TTL_MS: heartbeatの3倍以上が必要です")

  const timeZone = text(env, "OPEN_ZERO_TZ", Intl.DateTimeFormat().resolvedOptions().timeZone)
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0)
  } catch {
    issues.push("OPEN_ZERO_TZ: IANAタイムゾーンが必要です")
  }

  const model = text(env, "OPEN_ZERO_MODEL", "gpt-5.6-sol")
  const models = {
    default: model,
    cycle: text(env, "OPEN_ZERO_CYCLE_MODEL", model),
    work: text(env, "OPEN_ZERO_WORK_MODEL", "gpt-5.6-luna"),
    research: text(env, "OPEN_ZERO_RESEARCH_MODEL", "gpt-5.6-luna"),
  }
  for (const [key, id] of [
    ["OPEN_ZERO_MODEL", models.default],
    ["OPEN_ZERO_CYCLE_MODEL", models.cycle],
    ["OPEN_ZERO_WORK_MODEL", models.work],
    ["OPEN_ZERO_RESEARCH_MODEL", models.research],
  ] as const) {
    if (!isKnownModel(id)) issues.push(`${key}: GPT model idが必要です: ${id}`)
  }
  const discordToken = optional(env, "OPEN_ZERO_DISCORD_TOKEN")
  const discordOwnerId = optional(env, "OPEN_ZERO_DISCORD_OWNER_ID")
  const discordTalk = optional(env, "OPEN_ZERO_DISCORD_CH_TALK")
  const discordDraft = optional(env, "OPEN_ZERO_DISCORD_CH_DRAFT")
  const discordLog = optional(env, "OPEN_ZERO_DISCORD_CH_LOG")
  const runImage = optional(env, "OPEN_ZERO_RUN_IMAGE")
  const codexHome = absolutePath(root, text(env, "CODEX_HOME", resolve(homedir(), ".codex")))
  const searxngBase = optionalEndpoint(env, "OPEN_ZERO_SEARXNG", "http://127.0.0.1:8888", issues, {
    allowLoopbackHttp: true,
  })
  const config: AppConfig = {
    rootDir: root,
    paths: {
      dataDir,
      db: absolutePath(root, text(env, "OPEN_ZERO_DB", resolve(dataDir, "open-zero.db")), true),
      backups: absolutePath(root, text(env, "OPEN_ZERO_BACKUPS", resolve(dataDir, "backups"))),
      runs: absolutePath(root, text(env, "OPEN_ZERO_RUNS", resolve(dataDir, "runs"))),
      runCache: absolutePath(root, text(env, "OPEN_ZERO_RUN_CACHE", resolve(dataDir, "run-cache"))),
      exportRoot: absolutePath(root, text(env, "OPEN_ZERO_EXPORT_ROOT", resolve(dataDir, "claude-export"))),
      transcriptRoot: absolutePath(
        root,
        text(env, "OPEN_ZERO_TRANSCRIPT_ROOT", resolve(homedir(), ".claude/projects")),
      ),
      codexAuth: absolutePath(root, text(env, "OPEN_ZERO_CODEX_AUTH", resolve(codexHome, "auth.json"))),
    },
    timeZone,
    models,
    cycle: {
      timeoutMs,
      heartbeatMs,
      leaseTtlMs,
      unit: textAllowEmpty(env, "OPEN_ZERO_CYCLE_UNIT", "open-zero-cycle.service"),
    },
    governance: {
      dailyRuns: integer(env, "OPEN_ZERO_DAILY_RUNS", 2_000, issues, { min: 1, max: 1_000_000 }),
      autonomousRuns: integer(env, "OPEN_ZERO_AUTONOMOUS_RUNS", 500, issues, { min: 1, max: 1_000_000 }),
    },
    schedule: {
      dailyDraftHour: integer(env, "OPEN_ZERO_DAILY_HOUR", 20, issues, { min: 0, max: 23 }),
      dreamHour: integer(env, "OPEN_ZERO_DREAM_HOUR", 4, issues, { min: 0, max: 23 }),
      cleanupHour: integer(env, "OPEN_ZERO_CLEANUP_HOUR", 4, issues, { min: 0, max: 23 }),
    },
    cleanup: {
      days: integer(env, "OPEN_ZERO_CLEANUP_DAYS", 14, issues, { min: 1, max: 3_650 }),
      cacheMaxMb: integer(env, "OPEN_ZERO_CACHE_MAX_MB", 2_048, issues, { min: 1, max: 1_000_000 }),
    },
    maintenance: {
      backupKeep: integer(env, "OPEN_ZERO_BACKUP_KEEP", 7, issues, { min: 1, max: 10_000 }),
    },
    web: {
      hostIntervalMs: integer(env, "OPEN_ZERO_HOST_INTERVAL_MS", 1_000, issues, { min: 0, max: 300_000 }),
      ...(searxngBase ? { searxngBase } : {}),
    },
    discord: {
      api: endpoint(env, "OPEN_ZERO_DISCORD_API", "https://discord.com/api/v10", issues, {
        allowLoopbackHttp: true,
      }),
      ...(discordToken ? { token: discordToken } : {}),
      ...(discordOwnerId ? { ownerId: discordOwnerId } : {}),
      channels: {
        ...(discordTalk ? { talk: discordTalk } : {}),
        ...(discordDraft ? { draft: discordDraft } : {}),
        ...(discordLog ? { log: discordLog } : {}),
      },
    },
    ...(runImage ? { runImage } : {}),
  }

  if (config.governance.autonomousRuns > config.governance.dailyRuns)
    issues.push("OPEN_ZERO_AUTONOMOUS_RUNS: OPEN_ZERO_DAILY_RUNS以下が必要です")
  if (issues.length > 0) throw new ConfigError(issues)
  return config
}

let current: AppConfig | undefined

/** Validate and install the process-wide deployment config before constructing runtime services. */
export function configureApp(env: Env = process.env, rootDir: string = PROJECT_ROOT): AppConfig {
  current = parseConfig(env, rootDir)
  return current
}

export function appConfig(): AppConfig {
  current ??= parseConfig()
  return current
}
