/**
 * shellコマンドの危険性評価器(tokenize-and-canonicalize方式)。coder(Cursor SDK 実行)の
 * 実行前フックから呼ばれる。
 *
 * 生文字列のregexマッチは構造的に破られる(OSSエージェント11個の調査で10がquote除去/
 * $IFS展開/コマンド置換/base64|sh/代替破壊フラグの5クラスで突破。唯一耐えたのは
 * トークン化+正規化評価器)。ここではその最小版として: (1)shell-quote除去でトークン化、
 * (2)$IFS等の空白変数を正規化、(3)コマンド置換 $()/`` を再帰評価、(4)パイプ先の
 * インタプリタ検査、(5)正規化後の破壊パターン照合、を行う。
 *
 * 位置づけは best-effort の被害限定であり保証ではない。文字列フィルタへの過信が
 * human-in-the-loop を切らせるのが最悪の失敗形態なので、真の境界は承認と隔離の側に置く。
 * 各ルールの category: "security"=破壊的操作の遮断(best-effort)、
 * "operational"=浪費ループ等の運用フィルタ(doom-loop ガードは cursor.ts 側)。
 */

export type GuardCategory = "security" | "operational"

export interface GuardVerdict {
  permission: "allow" | "deny"
  /** deny時の理由(どのルールに当たったか)。監査・lineage記録用。 */
  reason?: string
  /** denyしたルールの分離ラベル。securityはbest-effortの被害限定。 */
  category?: GuardCategory
  /** 判定に使った正規化済みコマンド列(デバッグ用)。 */
  canonical?: string
}

/** 破壊的と見なす正規化済みパターン。command名+フラグ/引数の意味で判定する。 */
interface DangerRule {
  id: string
  /** 分離ラベル。現行の破壊コマンド遮断ルールはすべて security。 */
  category: GuardCategory
  /** 正規化済みトークン列に対する述語。 */
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

/** $IFS や ${IFS} 等、bashが空白に展開する変数を空白へ正規化する(Class B)。 */
function expandWhitespaceVars(input: string): string {
  return input
    .replace(/\$\{IFS\}/g, " ")
    .replace(/\$IFS/g, " ")
    .replace(/\$\{IFS:0:1\}/g, " ")
}

/**
 * コマンド置換 $(...) と `...` を中身のコマンド文字列に平坦化して再帰評価対象にする(Class C)。
 * 実行はしない。ネストは内側から潰す。
 */
function flattenCommandSubstitution(input: string): string {
  let prev: string
  let cur = input
  // $(...) を最内から
  do {
    prev = cur
    cur = cur.replace(/\$\(([^()]*)\)/g, " $1 ")
  } while (cur !== prev)
  // バッククォート
  cur = cur.replace(/`([^`]*)`/g, " $1 ")
  return cur
}

/**
 * shell-quote を除去してトークン化する(Class A: r''m や "r"m のような分断引用を潰す)。
 * 引用符に隣接する文字は結合する(bashの語結合を模倣)。
 */
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
      sawContent = true // 空引用でも語の一部として扱う(r''m 対策)
      while (i < input.length && input[i] !== quote) {
        cur += input.charAt(i)
        i++
      }
      i++ // 閉じ引用をスキップ
      continue
    }
    if (ch === "\\") {
      // エスケープ: 次の1文字をリテラル結合
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
    // パイプ/リダイレクト/セパレータは独立トークンにする。
    // グルーピング ( ) { } も分離する — 空白なしで語に接着した `(rm` を
    // base()が `rm` と見なせずサブシェルバイパスになる実測(②着手ゲート 2026-07-10)。
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

/** basename(先頭パス除去)。/bin/rm → rm、./x → x。 */
function base(cmd: string): string {
  const noPath = cmd.split("/").pop() ?? cmd
  return noPath
}

// ---- 秘密ファイル判定(入口側データフェンス) ------------
//
// beforeReadFile denyの判定と、shell経由の読取バイパス(cat .env等)を閉じる
// secret-file-arg ルールで共用する。出口側リダクション(redact.ts)と対になる入口側。
// basename基準の保守的リスト — 網羅は不可能(best-effort)、真の境界はOS層サンドボックス。

/** 慣習的にテンプレート(実値を含まない)とされる例外。 */
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

/** パスが秘密ファイル(モデル文脈に入れてはならないもの)を指すか。 */
export function isSecretPath(path: string): boolean {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean)
  const name = (parts[parts.length - 1] ?? "").toLowerCase()
  const parent = parts[parts.length - 2]?.toLowerCase()
  if (name.length === 0) return false
  if (SECRET_EXCEPTIONS.has(name)) return false
  // .env / .env.local / prod.env など(テンプレート例外は上で除外済み)
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return true
  // SSH秘密鍵(公開鍵 .pub は許可)
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name) && !name.endsWith(".pub")) return true
  // 鍵・証明書ストア
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
      // curl/wget ... | sh|bash|python ...(Class D)
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
    // 秘密ファイルをshell経由で読む/触るバイパスを閉じる(実験08: beforeReadFile遮断
    // 単独ではcat .envで迂回できる)。引用文字列内の言及と区別できない(tokenizeが
    // quoteを剥がすのは意図的 — 回避耐性優先)ため偽陽性はあり得るが、denyは
    // approval parkingで人間が拾える。
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

// ---- reviewerロールの書き込みベクタ遮断 ----
//
// 背景: Cursorには beforeFileEdit フックが無く(afterFileEditのみ、SDKバンドル実地確認)、
// plan modeも読み取り専用ではない実測(2026-07-08)。TAKT式の事前ツール剥ぎ取りは不可能な
// ため、read-onlyロールは (1)このshellガード前段(best-effort)+(2)runReviewの
// no-writeバックストップ(forbidden-delta機械検出→レビュー無効化)の二層で強制する。
// ロールはH1実測どおり環境変数 FAMULUS_CODER_ROLE でフック子プロセスまで伝播する。

/** コマンド先頭のラッパー(env/nohup等)を剥いて実効コマンド頭を列挙する。 */
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
    if (WRAPPERS.has(b)) continue // 次の非フラグトークンを頭として見続ける
    if (b.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok) || /^\d+[smhd]?$/.test(tok)) continue // フラグ/env代入/timeout秒数
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

/** reviewerロール専用の追加denyルール。読み取り(grep/cat/git diff)と検証(bun test等)は通す。 */
const REVIEWER_RULES: DangerRule[] = [
  {
    id: "reviewer-redirect",
    category: "operational",
    // ファイルへの書き込みリダイレクトのみ遮断。fd複製(2>&1 → [2,>,&,1])と
    // /dev/null等への破棄は変異しないため許可(実運用でReviewerのbun test 2>&1
    // プローブを誤爆遮断した実測 2026-07-08 に基づく緩和)。
    match: (t) => {
      const SAFE_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"])
      for (let i = 0; i < t.length; i++) {
        if (t[i] !== ">") continue
        let j = i + 1
        while (t[j] === ">") j++ // ">>" は連続トークン
        const target = t[j]
        if (target === undefined) break
        if (target === "&") {
          // fd複製(2>&1 → [2,>,&,1])は&の次が数字/-のときのみ。
          // ">&word" はstdout+stderrをファイルwordへ書くbash構文なのでdeny
          // (Reviewer live probeでバイパス実証 2026-07-08)。
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

// ---- 拡張フックイベントの評価器 --------------------------------------------------
//
// best-effort。reviewer 系 deny の最終判定は forbidden-delta(レビュー後の差分検査)が持つ。

/**
 * reviewerロール時にpreToolUseでdenyする変異系tool_name(第0層)。
 * denylist方式: 未知の読み取り系ツール(SemSearch等)を誤遮断しないため。
 * 実測で観測済みのtool_nameは Read/Write/Shell/Delete(SDK dist)。防御的に別名も含む。
 */
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

/**
 * SDKのcustomTools(submit_review等)がMCPフックに現れるときのサーバー名
 * (SDK v1.0.23 dist実測: providerIdentifier="custom-user-tools")。
 */
export const CUSTOM_TOOLS_SERVER = "custom-user-tools"

/** preToolUse: reviewerは変異系ツールを実行前に剥ぎ取る。Shellはshellガード側で評価。 */
export function evaluateToolUse(toolName: string, opts: { role?: string } = {}): GuardVerdict {
  if (opts.role === "reviewer" && REVIEWER_DENIED_TOOLS.has(toolName)) {
    return { permission: "deny", reason: "reviewer-write-tool", category: "operational" }
  }
  return { permission: "allow" }
}

/** beforeReadFile: 秘密ファイルはロール不問でモデル文脈に入れない(入口側データフェンス)。 */
export function evaluateFileRead(filePath: string): GuardVerdict {
  if (isSecretPath(filePath)) {
    return { permission: "deny", reason: "secret-file-read", category: "security" }
  }
  return { permission: "allow" }
}

/**
 * beforeMCPExecution: MCPサーバー単位のゲート。
 * - 自前customTools(custom-user-tools = submit_review等の内部経路)は常に許可。
 * - reviewerは自前ツール以外の全MCPを遮断(最も厳しい)。
 * - executorは allowlist 設定時のみ列挙サーバーに限定(未設定=無制限、後方互換)。
 * @param opts.allowlist executorへのサーバーallowlist。undefined/null=無制限、[]=全外部MCP遮断。
 */
export function evaluateMcp(
  serverName: string,
  opts: { role?: string; allowlist?: string[] | null } = {},
): GuardVerdict {
  // 自前のcustomToolsは内部経路。ロール・allowlistに関わらず常に許可。
  if (serverName === CUSTOM_TOOLS_SERVER) return { permission: "allow" }
  if (opts.role === "reviewer") {
    return { permission: "deny", reason: "reviewer-mcp", category: "operational" }
  }
  if (opts.allowlist != null && !opts.allowlist.includes(serverName)) {
    return { permission: "deny", reason: "mcp-not-allowlisted", category: "security" }
  }
  return { permission: "allow" }
}

/**
 * コマンド文字列を評価する。denyに当たらなければallow。
 * @param command beforeShellExecution フックが渡す生コマンド文字列
 * @param opts.role 実行中runのロール(guard.sh が argv で渡す)。"reviewer" は書き込みベクタも遮断
 */
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
