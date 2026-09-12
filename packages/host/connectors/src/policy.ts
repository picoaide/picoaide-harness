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
 *    `settings`) are injected into the child env;
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
 * Whether one environment key is refused in a server-issued definition.
 * Windows environment names are case-insensitive, so the comparison is
 * case-insensitive on every platform (a definition that sends `Path` must be
 * rejected exactly like `PATH`).
 * @param key - environment variable name.
 * @returns true when the key must be dropped (or the definition rejected).
 */
export function isDeniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
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
    if (key === '' || typeof value !== 'string') {
      rejected.push(key)
      continue
    }
    if (isDeniedEnvKey(key)) {
      rejected.push(key)
      continue
    }
    env[key] = value
  }
  return { env, rejected }
}

/** Credential field keys the connector itself declared (token form + settings). */
export function declaredCredentialKeys(def: ConnectorDef): Set<string> {
  const keys = new Set<string>()
  for (const field of [...def.tokenFields ?? [], ...def.settings ?? []]) {
    if (typeof field?.key === 'string' && field.key !== '') keys.add(field.key)
  }
  return keys
}

/**
 * Fingerprint of one stdio spawn request: `command`, `args` and the
 * definition-declared env. Credential-derived values are deliberately excluded
 * — a rotated access token must not invalidate a user's earlier approval (the
 * approval is about *what* runs, not about which token it receives).
 * @param command - executable.
 * @param args - argument vector.
 * @param env - sanitized definition env.
 * @returns a stable sha-256 hex digest.
 */
export function stdioApprovalFingerprint(command: string, args: readonly string[], env: Record<string, string>): string {
  const sortedEnv = Object.fromEntries(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return createHash('sha256')
    .update(JSON.stringify({ command, args: [...args], env: sortedEnv }))
    .digest('hex')
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
        if (options.denyProtectedEnv === true && isDeniedEnvKey(key)) return `env 覆盖了受保护的键: ${key}`
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
