/**
 * 生文字列の regex は引用除去・$IFS・コマンド置換で回避されるので、トークン化と正規化の後に照合する。
 * best-effort の被害限定であり保証ではない。遮断の保証は承認と隔離に置く。
 */

export type GuardCategory = "security" | "operational"

export interface GuardVerdict {
  permission: "allow" | "deny"
  reason?: string
  category?: GuardCategory
  canonical?: string
}

interface DangerRule {
  id: string
  category: GuardCategory
  match: (tokens: string[], joined: string) => boolean
}

const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "python3",
  "node",
  "bun",
  "perl",
  "ruby",
  "eval",
])

function expandWhitespaceVars(input: string): string {
  return input
    .replace(/\$\{IFS\}/g, " ")
    .replace(/\$IFS/g, " ")
    .replace(/\$\{IFS:0:1\}/g, " ")
}

function flattenCommandSubstitution(input: string): string {
  let prev: string
  let cur = input
  do {
    prev = cur
    cur = cur.replace(/\$\(([^()]*)\)/g, " $1 ")
  } while (cur !== prev)
  cur = cur.replace(/`([^`]*)`/g, " $1 ")
  return cur
}

/** 引用符に隣接する文字は bash と同じく1語に結合する(r''m や "r"m を rm として読む)。 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let cur = ""
  let i = 0
  let sawContent = false
  const push = () => {
    if (sawContent) tokens.push(cur)
    cur = ""
    sawContent = false
  }
  while (i < input.length) {
    const ch = input.charAt(i)
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      sawContent = true
      while (i < input.length && input[i] !== quote) {
        cur += input.charAt(i)
        i++
      }
      i++
      continue
    }
    if (ch === "\\") {
      if (i + 1 < input.length) {
        cur += input.charAt(i + 1)
        sawContent = true
        i += 2
        continue
      }
      i++
      continue
    }
    if (/\s/.test(ch)) {
      push()
      i++
      continue
    }
    // ( ) { } も分離しないと、`(rm` を rm と見なせずサブシェルで回避される。
    if (
      ch === "|" ||
      ch === "&" ||
      ch === ";" ||
      ch === ">" ||
      ch === "<" ||
      ch === "(" ||
      ch === ")" ||
      ch === "{" ||
      ch === "}"
    ) {
      push()
      tokens.push(ch)
      i++
      continue
    }
    cur += ch
    sawContent = true
    i++
  }
  push()
  return tokens
}

function base(cmd: string): string {
  const noPath = cmd.split("/").pop() ?? cmd
  return noPath
}

// basename で判定するので網羅はできない。保証は OS 層のサンドボックスが持つ。
const SECRET_EXCEPTIONS = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"])

const CREDENTIAL_BASENAMES = new Set([
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
  ".pgpass",
])

export function isSecretPath(path: string): boolean {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean)
  const name = (parts[parts.length - 1] ?? "").toLowerCase()
  const parent = parts[parts.length - 2]?.toLowerCase()
  if (name.length === 0) return false
  if (SECRET_EXCEPTIONS.has(name)) return false
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name) && !name.endsWith(".pub")) return true
  if (/\.(pem|p12|pfx|jks|keystore)$/.test(name)) return true
  if (name.endsWith(".key")) return true
  if (CREDENTIAL_BASENAMES.has(name)) return true
  if (name === "credentials" && parent === ".aws") return true
  if (/^secrets?\.(json|ya?ml|toml)$/.test(name)) return true
  return false
}

const RULES: DangerRule[] = [
  {
    id: "rm-recursive-force",
    category: "security",
    match: (t) => {
      const idx = t.findIndex((x) => base(x) === "rm")
      if (idx === -1) return false
      const flags = t.slice(idx + 1).filter((x) => x.startsWith("-"))
      const chars = flags.join("")
      return /r/i.test(chars) && /f/i.test(chars)
    },
  },
  {
    id: "rm-root-or-home",
    category: "security",
    match: (t) => {
      const idx = t.findIndex((x) => base(x) === "rm")
      if (idx === -1) return false
      return t.slice(idx + 1).some((x) => x === "/" || x === "/*" || x === "~" || x === "~/" || x === "$HOME")
    },
  },
  {
    id: "find-delete",
    category: "security",
    match: (t) => t.some((x) => base(x) === "find") && t.some((x) => x === "-delete" || x === "-exec"),
  },
  {
    id: "dd-to-device",
    category: "security",
    match: (t) => t.some((x) => base(x) === "dd") && t.some((x) => /^of=\/dev\//.test(x)),
  },
  {
    id: "mkfs",
    category: "security",
    match: (t) => t.some((x) => base(x).startsWith("mkfs")),
  },
  {
    id: "git-destructive",
    category: "security",
    match: (t) => {
      const gi = t.findIndex((x) => base(x) === "git")
      if (gi === -1) return false
      const rest = t.slice(gi + 1).join(" ")
      return (
        /\bpush\b[^|;]*(--force\b|-f\b|\+)/.test(rest) ||
        /\breset\b[^|;]*--hard\b/.test(rest) ||
        /\bclean\b[^|;]*-[a-z]*f/.test(rest)
      )
    },
  },
  {
    id: "remote-pipe-to-interpreter",
    category: "security",
    match: (t) => {
      const hasFetch = t.some((x) => ["curl", "wget", "fetch"].includes(base(x)))
      if (!hasFetch) return false
      const pipeIdx = t.indexOf("|")
      if (pipeIdx === -1) return false
      return t.slice(pipeIdx + 1).some((x) => INTERPRETERS.has(base(x)))
    },
  },
  {
    id: "sudo",
    category: "security",
    match: (t) => t.some((x) => base(x) === "sudo"),
  },
  {
    // beforeReadFile だけでは cat .env で迂回される。引用内の言及も拾う偽陽性は承認待ちで人間が拾う。
    id: "secret-file-arg",
    category: "security",
    match: (t) => t.some((x) => !x.startsWith("-") && isSecretPath(x)),
  },
  {
    id: "chmod-777-root",
    category: "security",
    match: (t) => {
      const ci = t.findIndex((x) => base(x) === "chmod")
      if (ci === -1) return false
      const rest = t.slice(ci + 1)
      return rest.some((x) => /^-?R/.test(x)) && rest.some((x) => x === "/" || x === "/*")
    },
  },
]

// Cursor には beforeFileEdit フックが無く plan mode も書き込めるので、reviewer の読み取り専用は
// この shell ガードと runReview の差分検査(forbidden-delta)の2段で強制する。

function commandHeads(tokens: string[]): string[] {
  const WRAPPERS = new Set(["env", "nohup", "nice", "time", "xargs", "timeout", "stdbuf"])
  const heads: string[] = []
  let expectHead = true
  for (const tok of tokens) {
    if (tok === "|" || tok === "&" || tok === ";") {
      expectHead = true
      continue
    }
    if (tok === ">" || tok === "<") continue
    if (!expectHead) continue
    const b = base(tok)
    if (WRAPPERS.has(b)) continue
    if (b.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok) || /^\d+[smhd]?$/.test(tok)) continue
    heads.push(b)
    expectHead = false
  }
  return heads
}

const REVIEWER_FILE_MUTATORS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "tee",
  "truncate",
  "ln",
  "chmod",
  "chown",
  "rsync",
  "dd",
  "patch",
  "install",
])

const REVIEWER_GIT_MUTATORS = new Set([
  "add",
  "commit",
  "push",
  "checkout",
  "switch",
  "restore",
  "reset",
  "clean",
  "merge",
  "rebase",
  "stash",
  "apply",
  "cherry-pick",
  "revert",
  "am",
  "rm",
  "mv",
  "tag",
])

const REVIEWER_PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "cargo", "gem"])
const REVIEWER_PKG_MUTATING_SUBCOMMANDS = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "upgrade",
  "link",
  "publish",
])

/** 読み取り(grep/cat/git diff)と検証(bun test 等)は通す。 */
const REVIEWER_RULES: DangerRule[] = [
  {
    id: "reviewer-redirect",
    category: "operational",
    // fd 複製(2>&1)と /dev/null 等への破棄は書き込まないので通す。`bun test 2>&1` を止めないため。
    match: (t) => {
      const SAFE_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"])
      for (let i = 0; i < t.length; i++) {
        if (t[i] !== ">") continue
        let j = i + 1
        while (t[j] === ">") j++
        const target = t[j]
        if (target === undefined) break
        if (target === "&") {
          // `>&word` は stdout と stderr をファイル word へ書くので、fd 複製は & の次が数字か - のときだけ。
          const after = t[j + 1]
          if (after !== undefined && (/^\d+$/.test(after) || after === "-")) {
            i = j + 1
            continue
          }
          return true
        }
        if (SAFE_TARGETS.has(target)) {
          i = j
          continue
        }
        return true
      }
      return false
    },
  },
  {
    id: "reviewer-file-mutator",
    category: "operational",
    match: (t) => commandHeads(t).some((h) => REVIEWER_FILE_MUTATORS.has(h)),
  },
  {
    id: "reviewer-sed-inplace",
    category: "operational",
    match: (t) => {
      const si = t.findIndex((x) => base(x) === "sed" || base(x) === "perl")
      return si !== -1 && t.slice(si + 1).some((x) => /^-i/.test(x))
    },
  },
  {
    id: "reviewer-git-mutator",
    category: "operational",
    match: (t) => {
      const gi = t.findIndex((x) => base(x) === "git")
      if (gi === -1) return false
      const sub = t.slice(gi + 1).find((x) => !x.startsWith("-") && x !== ">" && x !== "<")
      return sub !== undefined && REVIEWER_GIT_MUTATORS.has(sub)
    },
  },
  {
    id: "reviewer-pkg-mutator",
    category: "operational",
    match: (t) => {
      const heads = commandHeads(t)
      for (const h of heads) {
        if (!REVIEWER_PKG_MANAGERS.has(h)) continue
        const hi = t.findIndex((x) => base(x) === h)
        const sub = t.slice(hi + 1).find((x) => !x.startsWith("-"))
        if (sub !== undefined && REVIEWER_PKG_MUTATING_SUBCOMMANDS.has(sub)) return true
      }
      return false
    },
  },
]

/** 未知の読み取り系ツール(SemSearch 等)を誤遮断しないよう denylist にする。 */
const REVIEWER_DENIED_TOOLS = new Set([
  "Write",
  "Edit",
  "StrReplace",
  "MultiStrReplace",
  "ApplyPatch",
  "CreateFile",
  "Delete",
  "DeleteFile",
  "MoveFile",
  "Rename",
])

/** SDK の customTools(submit_review 等)が MCP フックに現れるときのサーバー名。 */
export const CUSTOM_TOOLS_SERVER = "custom-user-tools"

/** Shell は evaluateCommand が評価する。 */
export function evaluateToolUse(toolName: string, opts: { role?: string } = {}): GuardVerdict {
  if (opts.role === "reviewer" && REVIEWER_DENIED_TOOLS.has(toolName)) {
    return { permission: "deny", reason: "reviewer-write-tool", category: "operational" }
  }
  return { permission: "allow" }
}

export function evaluateFileRead(filePath: string): GuardVerdict {
  if (isSecretPath(filePath)) {
    return { permission: "deny", reason: "secret-file-read", category: "security" }
  }
  return { permission: "allow" }
}

/** allowlist が undefined/null なら無制限、[] なら外部 MCP をすべて遮断する。 */
export function evaluateMcp(
  serverName: string,
  opts: { role?: string; allowlist?: string[] | null } = {},
): GuardVerdict {
  if (serverName === CUSTOM_TOOLS_SERVER) return { permission: "allow" }
  if (opts.role === "reviewer") {
    return { permission: "deny", reason: "reviewer-mcp", category: "operational" }
  }
  if (opts.allowlist != null && !opts.allowlist.includes(serverName)) {
    return { permission: "deny", reason: "mcp-not-allowlisted", category: "security" }
  }
  return { permission: "allow" }
}

export function evaluateCommand(command: string, opts: { role?: string } = {}): GuardVerdict {
  const canonical = flattenCommandSubstitution(expandWhitespaceVars(command))
  const tokens = tokenize(canonical)
  const joined = tokens.join(" ")
  const rules = opts.role === "reviewer" ? [...RULES, ...REVIEWER_RULES] : RULES
  for (const rule of rules) {
    if (rule.match(tokens, joined)) {
      return { permission: "deny", reason: rule.id, category: rule.category, canonical: joined }
    }
  }
  return { permission: "allow", canonical: joined }
}
