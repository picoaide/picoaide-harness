/**
 * Server-issued connector definition policy (FIX-02 P0 / FIX-19 P1).
 *
 * The connector catalog is delivered by the gateway (`bootstrap.connectors[]`)
 * and is NOT a trusted configuration source: whoever controls the server (or a
 * webadmin session with `connector:write`) decides which executable runs on
 * every employee machine and which environment it receives. The product
 * decision therefore keeps server-issued stdio MCP servers, but:
 *
 * 1. every `(command, args, env)` first spawn requires a LOCAL confirmation
 *    whose fingerprint is persisted per user (see `approvals.ts`);
 * 2. `mcp[].env` may never override the process bootstrap variables
 *    (`PATH`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `DSH_*`,
 *    `ELECTRON_*`, …) — those are the ones that turn "run this MCP server"
 *    into "run arbitrary code in the host process' environment";
 * 3. only credential fields the connector itself declared (`tokenFields` /
 *    `settings`) are injected into the child env — and only when their name
 *    survives the same denylist as `mcp[].env` (residual A: a field called
 *    `NODE_OPTIONS` used to be injected verbatim while the local confirmation
 *    showed only the `mcp[].env` keys);
 * 4. `serverName` is shape-checked and streamable-http URLs pass the shared
 *    outbound policy (`outbound.ts`).
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { ConnectorDef, ConnectorMcp } from './types.ts'
import { assertOutboundUrlAllowed, isOutboundUrlAllowed } from './outbound.ts'

/** Server-name contract (matches the server-side `connectorServerNameRe`). */
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Connector id contract (the server enforces the same shape). */
export const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Auth modes the runtime understands (mirrors `ConnectorAuthMode`). */
export const CONNECTOR_AUTH_MODES: readonly string[] = ['oauth', 'device', 'token', 'server-side']

/**
 * Environment keys a connector definition may never set. They are either
 * interpreter/loader hooks (`PATH`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`,
 * `LD_LIBRARY_PATH`, `PYTHONPATH`, `BASH_ENV`) or product-owned state
 * (`DSH_*`, `ELECTRON_*`). `HTTP(S)_PROXY` is included because the host's own
 * outbound guard is proxy-aware: a definition that could set the proxy could
 * route every later request through a host it chooses.
 *
 * conn-5 (audit R7): the COMMAND-HOOK family is included as well. These are not
 * loader hooks — they are values that make an already-approved, innocuous
 * command line shell out on its own (`git diff` with `GIT_EXTERNAL_DIFF`, a
 * JVM/Dotnet/Perl/Ruby child with `JAVA_TOOL_OPTIONS` / `DOTNET_STARTUP_HOOKS` /
 * `PERL5OPT` / `RUBYOPT`, `GCONV_PATH` for any glibc child). Measured in R7:
 * approving `git diff` executed the shell payload in `GIT_EXTERNAL_DIFF`. This
 * list can never be exhaustive (the prompt also discloses the VALUES, which is
 * the root fix), but it removes the family a definition would reach for first.
 *
 * F-6 (audit R7 round 2): the pager/editor "selector" family is deliberately NOT
 * in this list — see `CONFIRMATION_ONLY_ENV_KEYS` below. Denying it was measured
 * to be worse than the harm: `sanitizeMcpEnv` dropped those keys SILENTLY on the
 * local-injection path and the catalog parser dropped the whole row, so a
 * legitimate connector became unusable and the user never learned why.
 *
 * N-3 (audit R7 round 3): "not denied by NAME" is not "not dangerous" — the same
 * family is a real command hook (`EDITOR` / `GIT_EDITOR` shell out with NO TTY,
 * which is exactly how an MCP stdio child runs; measured end to end). The tier is
 * therefore only open to a single plain program name: see
 * `isCommandTemplateEnvKey` / `isSafeCommandTemplateValue`. A value that would be
 * concatenated into a shell command line, or that names an interpreter, is
 * refused exactly like a denied key.
 *
 * The two lists must stay DISJOINT and every change to either one must be
 * mirrored by the server (`server/internal/serverstore/connectors.go`), which the
 * repo-side drift guard pins for both tiers.
 */
export const DENIED_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'COMSPEC',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  // ---- command-hook family (conn-5) ----
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_ASKPASS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  // `BROWSER` is the one selector that stays denied: its value is a command
  // TEMPLATE (with `%s` substitution) that consumers such as Python's
  // `webbrowser` and the `xdg-open` family EXECUTE, i.e. a command hook in
  // disguise — and a headless MCP child has no browser to select.
  'BROWSER',
  // `LESSOPEN` / `LESSCLOSE` are the same shape of hook one `less` invocation
  // away: `less` runs them as a command template (`%s` / `%t` substitution)
  // before/after reading a FILE argument. Measured (R7 round 3, N-3 equivalent
  // channel): `LESSOPEN='|sh -c "id > flag" %s' less <file>` executes in a
  // piped, TTY-less process — i.e. in the exact shape of an MCP stdio child —
  // so this is NOT a pager selector that F-6's value tier could cover; it is a
  // hard command hook like `BROWSER`.
  'LESSOPEN',
  'LESSCLOSE',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'DOTNET_STARTUP_HOOKS',
  'GCONV_PATH',
  'MAVEN_OPTS',
  'GRADLE_OPTS',
  'SBT_OPTS',
  'NODE_REPL_EXTERNAL_MODULE',
])

/**
 * Denied env-key prefixes (product-owned namespaces).
 *
 * `GIT_CONFIG_KEY_` / `GIT_CONFIG_VALUE_` are indexed (`_0` … `_N`) and are the
 * documented way to inject arbitrary git configuration into a child — including
 * `core.sshCommand` and `core.pager`, which are command hooks. A prefix covers
 * every index (conn-5).
 *
 * Keep this list ALPHABETICAL: the repo-side drift guard compares it against the
 * server's copy positionally (`TestConnectorDeniedEnvKeysMatchClientPolicy` sorts
 * only the server side), so a non-alphabetical order here reads as drift.
 */
const DENIED_ENV_PREFIXES: readonly string[] = ['DSH_', 'ELECTRON_', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_', 'PICOAIDE_']

/**
 * Env keys that are NOT denied but are handed to the LOCAL confirmation with
 * their VALUES disclosed — the "selector" family (F-6, audit R7 round 2).
 *
 * Each of these names a program the child would show output with (`PAGER`,
 * `GIT_PAGER`) or edit a file with (`EDITOR`, `VISUAL`, `GIT_EDITOR`,
 * `GIT_SEQUENCE_EDITOR`). They are ordinary CLI configuration — `GIT_PAGER=cat`
 * is the standard way to keep a git child non-interactive — and the harm of
 * denying them is asymmetric: the definition is dropped silently, so the user's
 * connector disappears with no explanation instead of getting a decision to
 * make. The channel is covered by FIX-02's local confirmation, whose value
 * disclosure (conn-5) shows exactly what the child will receive.
 *
 * Membership here is a *commitment*, machine-checked on both sides:
 *  - nothing in this list may appear in `DENIED_ENV_KEYS` (the two tiers are
 *    disjoint — see `tests/connector-env-selector-keys.spec.ts`);
 *  - the server mirrors this list (`connectorConfirmationOnlyEnvKeys`), so a
 *    denylist edit cannot silently move a key between tiers.
 */
export const CONFIRMATION_ONLY_ENV_KEYS: ReadonlySet<string> = new Set([
  'PAGER',
  'GIT_PAGER',
  'EDITOR',
  'VISUAL',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
])

/**
 * Characters a command-template VALUE may consist of (N-3, audit R7 round 3).
 *
 * The pager/editor tier above was opened on the theory that these names select a
 * PROGRAM. That is only true for a value that IS one program name: every consumer
 * of `EDITOR` / `GIT_EDITOR` / `GIT_SEQUENCE_EDITOR` (and of `PAGER`, once a TTY
 * exists) runs the value through `sh -c`, so `EDITOR=sh -c "…"` is a shell
 * command line in disguise and no amount of key-level disclosure changes that
 * (the NAME looks like harmless editor configuration). The gate is therefore on
 * the VALUE:
 *
 *  - ASCII letters/digits plus `_ . / \ : + -` only — no whitespace of any kind
 *    (space, tab, newline, NBSP, U+2000…), and none of `; $ | & < > ( ) { } [ ]`
 *    `* ? ! ~ # %` backtick or quote. Whitespace is what turns one argv[0] into a
 *    command LINE (`vim -c …`, `sh -c …`, `sh ''`), `%` is the `%s` template
 *    substitution, and `; | & $ \`` are the shell's own operators.
 *  - the basename (after the last `/` or `\`) must not be a known command
 *    INTERPRETER: `EDITOR=sh` is still a single plain token, but git then runs
 *    the file it "edits" through the shell, so the approved command executes
 *    attacker-writable CONTENT instead of an editor. Nobody configures a pager or
 *    editor as `sh`/`python`; refusing those basenames costs no real use case.
 *
 * Consequences on both paths, deliberately fail-loud rather than silent:
 *  - server catalog: `mcpDefinitionProblem` refuses the whole definition with a
 *    message naming the key and the value (the admin sees why);
 *  - local injection: `sanitizeMcpEnv` reports the key in `rejected`.
 *
 * The server mirrors this constant exactly (`connectorCommandTemplateAllowedChars`
 * in `server/internal/serverstore/connectors.go`), pinned by
 * `TestConnectorCommandTemplatePolicyMatchesClientPolicy`.
 */
export const SELECTOR_VALUE_ALLOWED_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./\\:+-'

/**
 * Program basenames that INTERPRET a file/stdin as code (N-3 layer 2).
 *
 * These pass the character gate (they are one plain token) but are never a
 * legitimate pager/editor: `GIT_EDITOR=sh` makes the approved `git commit` run
 * the edited file as a shell script. Kept as a small, explicit list (same list
 * on the server, machine-checked) — the character gate is the real boundary; this
 * only closes the "single token that is an interpreter" spelling.
 */
export const SELECTOR_INTERPRETER_TOKENS: readonly string[] = [
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'csh', 'tcsh', 'fish', 'busybox',
  'cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32',
  'python', 'perl', 'ruby', 'node', 'nodejs', 'php', 'lua', 'tclsh', 'osascript',
]

/**
 * Whether one lowercased basename is a known interpreter (N-3 layer 2).
 *
 * Matched on the name WITHOUT a Windows `.exe` suffix and with an optional
 * version suffix (`python3.12`, `bash5`, `perl5.36`, `lua5.4`, `node.exe`) —
 * those spellings are the same interpreter, and an exact-match list would be the
 * "change one character and it walks through" mistake this round is about.
 * @param base - lowercased basename of the value.
 * @returns true when the value names an interpreter.
 */
function isInterpreterBasename(base: string): boolean {
  const name = base.endsWith('.exe') ? base.slice(0, -'.exe'.length) : base
  return SELECTOR_INTERPRETER_TOKENS.some(token =>
    name === token || (name.startsWith(token) && /^[0-9.]*$/.test(name.slice(token.length))))
}

/**
 * Whether one env key names something whose VALUE a consumer executes as a
 * command (rather than a value that merely configures one).
 *
 * The explicit tier is honoured first, then the whole `*PAGER` / `*EDITOR`
 * spelling family: enumerating six keys was the round-2 mistake — the same hook
 * exists as `MANPAGER` / `SYSTEMD_PAGER` / `SVN_EDITOR` / `HGEDITOR` / …
 * (measured: `MANPAGER='sh -c "…"' man ls` executes once a TTY exists), so the
 * gate follows the SHAPE of the name, not a list that the next spelling escapes.
 * @param key - environment variable name as the definition declared it.
 * @returns true when the value must be a single plain program name.
 */
export function isCommandTemplateEnvKey(key: string): boolean {
  const upper = normalizeEnvKey(key).toUpperCase()
  if (upper === '') return false
  if (CONFIRMATION_ONLY_ENV_KEYS.has(upper)) return true
  return upper.endsWith('PAGER') || upper.endsWith('EDITOR')
}

/**
 * Basename of a program value, lowercased (`C:\tools\Vim.EXE` → `vim.exe`).
 * @param value - the declared value.
 * @returns the last path segment.
 */
function commandTemplateBaseName(value: string): string {
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return (cut >= 0 ? value.slice(cut + 1) : value).toLowerCase()
}

/**
 * Whether a value may be handed to a command-template key (N-3).
 * @param value - the definition-supplied value.
 * @returns true only for one plain program name.
 */
export function isSafeCommandTemplateValue(value: string): boolean {
  if (value === '') return false
  for (const char of value) {
    if (!SELECTOR_VALUE_ALLOWED_CHARS.includes(char)) return false
  }
  const base = commandTemplateBaseName(value)
  return base !== '' && !isInterpreterBasename(base)
}

/**
 * Whether one `mcp[].env` pair is refused: a denied name, or a command-template
 * name carrying a value that is not a single plain program (N-3).
 * @param key - environment variable name.
 * @param value - the paired value (already known to be a string).
 * @returns true when the pair must not reach a child.
 */
export function isDeniedEnvEntry(key: string, value: string): boolean {
  if (isDeniedEnvKey(key)) return true
  return isCommandTemplateEnvKey(key) && !isSafeCommandTemplateValue(value)
}

/**
 * Normalize one environment key name before it is compared with the denylist.
 *
 * Windows environment names are case-insensitive AND no legitimate name carries
 * surrounding whitespace, so `"PATH "`, `"NODE_OPTIONS\t"` and `"\tDSH_HOME"`
 * are the same variable as `PATH` / `NODE_OPTIONS` / `DSH_HOME` for every
 * consumer that trims. Trimming here is what keeps those spellings out of the
 * child environment (residual B).
 * @param key - environment variable name as the definition declared it.
 * @returns the name without surrounding whitespace.
 */
export function normalizeEnvKey(key: string): string {
  // 先剥"不可见格式字符"再 trim(2026-09-13 审计 R4,与 Go 侧 connectorEnvKeyNormalize
  // 逐条对齐):`\uFEFFNODE_OPTIONS` / `NODE\u200B_OPTIONS` 这类键 JS 的 trim() 只剥
  // 空白、Go 的 unicode.IsSpace 也不认 U+FEFF —— 两边口径不同就会出现"管理端保存
  // 成功、客户端静默丢弃"(或反向放行)。集合与 Go 侧同一份:
  // U+00AD / U+180E / U+200B–U+200F / U+202A–U+202E / U+2060–U+2064 / U+2066–U+206F / U+FEFF
  return key.replace(/[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '').trim()
}

/**
 * Whether one environment key is refused in a server-issued definition.
 * The comparison is case-insensitive on every platform (a definition that sends
 * `Path` must be rejected exactly like `PATH`) and is made on the TRIMMED name,
 * so a whitespace variant cannot slip past. A blank name is never a usable
 * environment variable and is refused as well.
 *
 * A name CONTAINING `=` is refused outright, trailing included (R6). `=` is the
 * `NAME=VALUE` separator of the process environment, so such a "name" is not a
 * name: libuv renders the child environment as `NAME=VALUE` and a key that
 * itself carries `=` shifts that boundary. The definition can therefore name ANY
 * variable it likes — `{"NODE_OPTIONS=<payload>//": ""}` reaches the child as
 * `NODE_OPTIONS=<payload>//=` — and this is measured, not theoretical: with a
 * real `spawn`, the `--import=data:` payload in such a key executes in the child
 * (the appended `=` lands in a trailing comment) while the plain `NODE_OPTIONS`
 * spelling is refused by the denylist. A trailing `=` is also invisible in the
 * local approval prompt, which lists key NAMES. Both the server catalog parser
 * (reject the definition, fail-loud) and the runtime whitelist (drop the key)
 * go through this one predicate.
 *
 * A name containing NUL is refused too (conn-6, audit R7). Node rejects a whole
 * env map whose key carries a null byte
 * (`ERR_INVALID_ARG_VALUE … must be a string without null bytes`), so the
 * pre-fix behaviour was a definition-triggered, self-inflicted registration
 * failure: the key passed the parser, the whitelist and the prompt, and then
 * blew up `spawn`. Not RCE (libuv copies `NAME=VALUE` with `strlen`, so a NUL
 * cannot split off a second variable), but an impossible name must never reach
 * a child. Refused BEFORE the invisible-character stripper runs, so the check
 * cannot be defeated by a normalizer that happens to drop the byte.
 * @param key - environment variable name.
 * @returns true when the key must be dropped (or the definition rejected).
 */
export function isDeniedEnvKey(key: string): boolean {
  const normalized = normalizeEnvKey(key)
  const upper = normalized.toUpperCase()
  if (upper === '') return true
  if (normalized.includes('=')) return true
  if (normalized.includes('\0')) return true
  return DENIED_ENV_KEYS.has(upper) || DENIED_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))
}

export interface SanitizedEnv {
  /** Keys that survived the whitelist, in insertion order. */
  env: Record<string, string>
  /** Keys that were dropped because they are denied (diagnostics). */
  rejected: string[]
}

/**
 * Whitelist one `mcp[].env` map: string values only, denied keys dropped.
 * @param raw - the definition's env map (untrusted).
 * @returns the sanitized env plus the rejected key names.
 */
export function sanitizeMcpEnv(raw: unknown): SanitizedEnv {
  const env: Record<string, string> = {}
  const rejected: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { env, rejected: raw === undefined ? [] : ['<not-an-object>'] }
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Blank/whitespace-only and denied names both land here: `isDeniedEnvKey`
    // trims before it compares, so `"PATH "` cannot become a second spelling.
    // N-3: a command-template key whose value is a shell command line lands here
    // too — the name is reported in `rejected`, so the drop is never silent.
    if (typeof value !== 'string' || isDeniedEnvEntry(key, value)) {
      rejected.push(key)
      continue
    }
    env[key] = value
  }
  return { env, rejected }
}

/** One credential input as the definition declares it (shape is untrusted). */
interface DeclaredCredentialField {
  key?: unknown
}

/**
 * Every credential field the definition declares, `tokenFields` first.
 * Non-array groups are ignored: the runtime must never throw on a malformed
 * locally injected definition (the catalog boundary checks what it must).
 * @param def - the connector definition.
 * @returns the declared fields in declaration order.
 */
function declaredCredentialFields(def: ConnectorDef): DeclaredCredentialField[] {
  const fields: DeclaredCredentialField[] = []
  for (const group of [def.tokenFields, def.settings]) {
    if (!Array.isArray(group)) continue
    fields.push(...group as DeclaredCredentialField[])
  }
  return fields
}

/**
 * Credential field keys the connector itself declared (token form + settings).
 *
 * DECLARATION side of the env denylist (residual A): these names are injected
 * into the stdio child's environment, so a field that names a protected key
 * (`NODE_OPTIONS`, `PATH`, `DSH_*`, …) must never enter the set — otherwise the
 * definition would set a loader hook the approval prompt never mentions.
 * @param def - the connector definition.
 * @returns the injectable credential key names.
 */
export function declaredCredentialKeys(def: ConnectorDef): Set<string> {
  const keys = new Set<string>()
  for (const field of declaredCredentialFields(def)) {
    const key = field.key
    if (typeof key === 'string' && !isDeniedEnvKey(key)) keys.add(key)
  }
  return keys
}

/**
 * Env-key problem of the credential-field declarations (`tokenFields` /
 * `settings`) of a SERVER-issued definition, or null when they are usable.
 *
 * Deliberately narrow: only the injected NAME decides whether the child gets a
 * loader hook, so a declared name that the denylist refuses (a protected key,
 * any whitespace variant of one, or a blank name) makes the definition
 * unusable — the same strictness `mcpServerProblem` already applies to
 * `mcp[].env`. Other shape sloppiness is left to the existing behaviour so a
 * merely untidy definition does not vanish from the catalog.
 * @param def - the definition's credential-field groups.
 * @returns a human-readable reason, or null.
 */
export function credentialFieldProblem(def: Pick<ConnectorDef, 'tokenFields' | 'settings'>): string | null {
  for (const [group, fields] of [['tokenFields', def.tokenFields], ['settings', def.settings]] as const) {
    if (fields === undefined || !Array.isArray(fields)) continue
    for (const field of fields) {
      if (field === null || typeof field !== 'object' || Array.isArray(field)) continue
      const key = (field as { key?: unknown }).key
      if (typeof key === 'string' && isDeniedEnvKey(key)) {
        return `${group} 的 key 不被允许: ${JSON.stringify(key)}`
      }
    }
  }
  return null
}

/**
 * Fingerprint of one stdio spawn request: `command`, `args`, the
 * definition-declared `mcp[].env` (names AND values) and the credential field
 * NAMES the definition declares.
 *
 * Credential field VALUES are deliberately excluded — a rotated access token
 * must not invalidate a user's earlier approval (the approval is about *what*
 * runs, not about which token it receives). The credential field NAMES are
 * included: they decide which environment names the child receives, so a
 * re-issued definition that starts injecting a new name is a new decision (and
 * the names the local confirmation disclosed stay bound to the approval). A
 * definition that declares no credential field hashes exactly as it did before
 * this rule existed, so unchanged connectors are not re-prompted.
 *
 * Denied names never reach this function: callers pass the sanitized env and
 * the denylist-filtered credential keys.
 * @param command - executable.
 * @param args - argument vector.
 * @param env - sanitized definition env.
 * @param credentialKeys - injectable credential field names (denylist applied).
 * @returns a stable sha-256 hex digest.
 */
export function stdioApprovalFingerprint(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  credentialKeys: readonly string[] = [],
): string {
  const sortedEnv = Object.fromEntries(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const sortedKeys = [...new Set(credentialKeys)].sort()
  // The credential-key list is only folded in when the definition declares one:
  // a connector without credential fields is described exactly as before, so
  // its existing approval survives the upgrade instead of re-prompting every
  // user for an unchanged command.
  const payload = sortedKeys.length === 0
    ? { command, args: [...args], env: sortedEnv }
    : { command, args: [...args], env: sortedEnv, credentialKeys: sortedKeys }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Structural + policy problem of ONE `mcp[]` entry, or null when it is usable.
 *
 * `denyProtectedEnv` distinguishes the two callers: the catalog parser (a
 * SERVER-issued definition) rejects a row that names a protected env key
 * outright, while `registerMcp` only needs the entry to be structurally
 * sound — its env is whitelisted before it reaches a child, so a locally
 * injected definition that still carries `PATH` cannot smuggle it through.
 *
 * @param server - candidate entry (untrusted).
 * @param options.denyProtectedEnv - reject protected env keys (catalog parser).
 * @returns a human-readable reason, or null.
 */
export function mcpServerProblem(server: unknown, options: { denyProtectedEnv?: boolean } = {}): string | null {
  if (server === null || typeof server !== 'object' || Array.isArray(server)) return 'mcp 项不是对象'
  const entry = server as Record<string, unknown>
  const serverName = entry.serverName
  if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
    return `serverName 不合规: ${JSON.stringify(serverName)}`
  }
  const transport = entry.transport ?? 'stdio'
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    return `transport 不支持: ${JSON.stringify(entry.transport)}`
  }
  if (transport === 'streamable-http') {
    const url = entry.url
    if (typeof url !== 'string' || url === '') return 'streamable-http 缺少 url'
    if (!isOutboundUrlAllowed(url)) return `url 不在允许的出站范围内: ${url}`
  } else {
    const command = entry.command
    if (typeof command !== 'string' || command.trim() === '') return 'stdio 缺少 command'
    if (command.includes('\0')) return 'command 含 NUL'
    const args = entry.args
    if (args !== undefined) {
      if (!Array.isArray(args) || !args.every(item => typeof item === 'string')) return 'args 必须是字符串数组'
    }
    const env = entry.env
    if (env !== undefined) {
      if (env === null || typeof env !== 'object' || Array.isArray(env)) return 'env 必须是字符串映射'
      for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
        if (options.denyProtectedEnv === true) {
          if (isDeniedEnvKey(key)) return `env 键不被允许（受保护或为空）: ${JSON.stringify(key)}`
          // N-3: the selector tier is only open to a single plain program name.
          // The whole definition is refused (fail-loud) with the reason naming
          // both the key and the value, instead of silently dropping the pair.
          if (typeof value === 'string' && !isSafeCommandTemplateValue(value) && isCommandTemplateEnvKey(key)) {
            return `env.${key} 的值不是单个程序名（含空白/shell 元字符或命令解释器，会被当作命令模板执行）: ${JSON.stringify(value)}`
          }
        }
        if (typeof value !== 'string') return `env.${key} 必须是字符串`
      }
    }
  }
  const headers = entry.headers
  if (headers !== undefined) {
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return 'headers 必须是字符串映射'
    if (Object.values(headers as Record<string, unknown>).some(value => typeof value !== 'string')) {
      return 'headers 的值必须是字符串'
    }
  }
  return null
}

/**
 * Problem of the whole SERVER-issued definition (strict: protected env keys
 * are refused, not silently stripped).
 * @param mcp - the definition's `mcp` array.
 * @returns a human-readable reason, or null.
 */
export function mcpDefinitionProblem(mcp: unknown): string | null {
  if (!Array.isArray(mcp) || mcp.length === 0) return 'mcp 必须是非空数组'
  for (const server of mcp) {
    const problem = mcpServerProblem(server, { denyProtectedEnv: true })
    if (problem !== null) return problem
  }
  return null
}

/**
 * Resolve the outbound URL of a streamable-http entry (policy enforced).
 * @param server - the validated entry.
 * @returns the parsed, allowed URL.
 */
export function streamableHttpUrl(server: ConnectorMcp): URL {
  return assertOutboundUrlAllowed(server.url ?? '', `MCP 端点 ${server.serverName}`)
}
