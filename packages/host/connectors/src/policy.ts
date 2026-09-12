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
])

/** Denied env-key prefixes (product-owned namespaces). */
const DENIED_ENV_PREFIXES: readonly string[] = ['DSH_', 'ELECTRON_', 'PICOAIDE_']

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
 * @param key - environment variable name.
 * @returns true when the key must be dropped (or the definition rejected).
 */
export function isDeniedEnvKey(key: string): boolean {
  const upper = normalizeEnvKey(key).toUpperCase()
  if (upper === '') return true
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
    if (typeof value !== 'string' || isDeniedEnvKey(key)) {
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
        if (options.denyProtectedEnv === true && isDeniedEnvKey(key)) return `env 键不被允许（受保护或为空）: ${JSON.stringify(key)}`
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
