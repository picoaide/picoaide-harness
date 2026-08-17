/**
 * Generate connector definitions from the WorkBuddy connector marketplace
 * archive (the official `connectors-config.zip` layout: a `.codebuddy-connector/`
 * manifest plus `connectors/<id>/{cli.json,mcp.json,token-schema.json}`).
 *
 * Usage: node scripts/gen-defs.mjs <market-dir>
 *
 * Output: src/defs/cli.ts, token.ts, oauth.ts + src/defs/index.ts (static,
 * committed). Connectors that need a pre-registered OAuth client or a
 * server-side backend (WorkBuddy enterprise mode) are skipped with a notice.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const marketDir = process.argv[2] ?? '/tmp/opencode/wb-marketplace/extracted'
const connectorsDir = join(marketDir, 'connectors')
const manifest = JSON.parse(readFileSync(join(marketDir, '.codebuddy-connector', 'connectors.json'), 'utf-8'))
const meta = new Map(manifest.connectors.map((c) => [c.id, c]))

const SKIP_AUTH = new Set(['server-side', 'oneid-token', 'mcp'])
const GENERIC_URI_PATTERN = 'https?://[^\\s\\n\\r"\'<>]+'

const toLiteral = (value) => JSON.stringify(value, null, 2).replace(/\n/g, '\n      ')

function splitCommand(cmd) {
  if (typeof cmd !== 'string') return ['', []]
  const parts = cmd.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  return [parts[0] ?? '', parts.slice(1).map((p) => p.replace(/^"|"$/g, ''))]
}

/** Resolve a per-platform value to the linux command string. */
function resolvePlatform(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.linux ?? value.darwin ?? value.win32 ?? Object.values(value)[0]
  return undefined
}

function parseMcpServers(id, servers, warnings) {
  const list = []
  for (const [serverName, s] of Object.entries(servers)) {
    const type = s.type ?? (s.url ? 'streamableHttp' : 'stdio')
    if (type === 'sse') {
      warnings.push(`${id}/${serverName}: SSE transport unsupported, skipped`)
      continue
    }
    if (type === 'stdio' || type === 'command') {
      list.push({
        serverName,
        transport: 'stdio',
        command: s.command,
        args: s.args ?? [],
        ...(s.env ? { env: s.env } : {}),
        ...(s.staticEnv ? { env: { ...(s.env ?? {}), ...s.staticEnv } } : {}),
        ...(s.headers ? { headers: s.headers } : {}),
      })
    } else {
      list.push({
        serverName,
        transport: 'streamable-http',
        url: s.url,
        ...(s.headers ? { headers: s.headers } : {}),
      })
    }
  }
  return list
}

function defForCli(id, name, c, warnings) {
  const auth = Array.isArray(c.auth) ? c.auth[0] : c.auth
  const linuxCmd = resolvePlatform(auth?.linux ?? auth?.command)
  if (!linuxCmd) {
    warnings.push(`${id}: no linux auth command, skipped`)
    return null
  }
  const [command, args] = splitCommand(linuxCmd)
  const deviceFlow = c.authDeviceFlow
    ? {
        uriPattern: c.authDeviceFlow.uriPattern,
        ...(c.authDeviceFlow.codePattern ? { codePattern: c.authDeviceFlow.codePattern } : {}),
      }
    : { uriPattern: GENERIC_URI_PATTERN }
  const statusCmd = resolvePlatform(c.status?.linux ?? c.status?.command)
  const statusCheck = statusCmd ? { statusCommand: splitCommand(statusCmd)[0], statusArgs: splitCommand(statusCmd)[1] } : {}
  const init = resolvePlatform(c.init?.linux ?? c.init?.command)
  return {
    id,
    name,
    description: c.description_zh ?? c.description ?? '',
    authMode: 'cli',
    auth: {
      command,
      args,
      ...(init ? { installCommand: init } : {}),
      deviceFlow,
      ...(c.authWaitForExit !== undefined ? { authWaitForExit: c.authWaitForExit } : { authWaitForExit: true }),
      ...(c.authSuppressBrowser !== undefined ? { suppressBrowser: c.authSuppressBrowser } : { suppressBrowser: true }),
      ...statusCheck,
    },
    mcp: [],
  }
}

function defForToken(id, name, c, tokenSchema, warnings) {
  const fields = (tokenSchema?.fields ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type === 'password' || f.type === 'secret' ? 'password' : 'text',
    ...(f.required !== undefined ? { required: f.required } : {}),
  }))
  if (!fields.length && !c.mcp) {
    warnings.push(`${id}: no token fields and no mcp, skipped`)
    return null
  }
  const servers = c.mcp ? parseMcpServers(id, c.mcp.mcpServers, warnings) : []
  if (!fields.length && !servers.length) {
    warnings.push(`${id}: nothing to register, skipped`)
    return null
  }
  return {
    id,
    name,
    description: tokenSchema?.description ?? c.description_zh ?? '',
    authMode: 'token',
    ...(fields.length ? { tokenFields: fields } : {}),
    mcp: servers,
  }
}

function defForOAuth(id, name, c, warnings) {
  const servers = parseMcpServers(id, c.mcp.mcpServers, warnings)
  if (!servers.length) {
    warnings.push(`${id}: no supported mcp servers, skipped`)
    return null
  }
  const first = servers[0]
  const discoveryUrl = first.url
  return {
    id,
    name,
    description: c.description_zh ?? c.description ?? '',
    authMode: 'oauth',
    auth: {
      discoveryUrl,
      clientId: '',
      authorizeUrl: '',
      tokenUrl: '',
      redirectUri: 'http://127.0.0.1/callback',
      pkce: true,
      publicClient: true,
      scopes: 'offline_access',
    },
    mcp: servers,
  }
}

const out = { cli: [], token: [], oauth: [], skipped: [] }
const warnings = []

for (const dir of readdirSync(connectorsDir).sort()) {
  const base = join(connectorsDir, dir)
  if (!existsSync(join(base, '.codebuddy-connector')) && !existsSync(join(base, 'cli.json')) && !existsSync(join(base, 'mcp.json')) && !existsSync(join(base, 'token-schema.json'))) continue
  const m = meta.get(dir)
  const name = m?.name ?? dir
  const authMode = m?.auth_mode
  const cli = existsSync(join(base, 'cli.json')) ? JSON.parse(readFileSync(join(base, 'cli.json'), 'utf-8')) : null
  const mcp = existsSync(join(base, 'mcp.json')) ? JSON.parse(readFileSync(join(base, 'mcp.json'), 'utf-8')) : null
  const tokenSchema = existsSync(join(base, 'token-schema.json')) ? JSON.parse(readFileSync(join(base, 'token-schema.json'), 'utf-8')) : null

  if (cli) {
    const def = defForCli(dir, name, cli, warnings)
    if (def) out.cli.push(def)
    else out.skipped.push(dir)
  } else if (tokenSchema || authMode === 'token') {
    const def = defForToken(dir, name, { ...m, mcp }, tokenSchema, warnings)
    if (def) out.token.push(def)
    else out.skipped.push(dir)
  } else if (mcp) {
    if (SKIP_AUTH.has(authMode)) {
      out.skipped.push(`${dir} (auth_mode=${authMode}, needs pre-registered client/server backend)`)
      continue
    }
    const def = defForOAuth(dir, name, { ...m, mcp }, warnings)
    if (def) out.oauth.push(def)
    else out.skipped.push(dir)
  } else {
    out.skipped.push(`${dir} (no cli/mcp/token config)`)
  }
}

const defsDir = join(process.cwd(), 'src', 'defs')
mkdirSync(defsDir, { recursive: true })
// One file per connector (mirrors the hand-written sales-easy.ts / dingtalk.ts).
for (const def of [...out.cli, ...out.token, ...out.oauth]) {
  writeFileSync(join(defsDir, `${def.id}.ts`), `import type { ConnectorDef } from '../types.ts'\n\n/** ${def.name} connector (generated from the WorkBuddy connector marketplace). */\nexport const def: ConnectorDef = ${JSON.stringify(def, null, 2)}\n`)
}
const varName = (id) => {
  let name = id.replace(/[^a-zA-Z0-9_]/g, '_')
  if (/^[0-9]/.test(name)) name = `_${name}`
  return name
}
const entries = [...out.cli, ...out.token, ...out.oauth].map((d) => `import { def as ${varName(d.id)}Def } from './${d.id}.ts'`)
writeFileSync(join(defsDir, 'index.ts'), `import type { ConnectorDef } from '../types.ts'\n${entries.join('\n')}\n\n/** All marketplace-generated connector definitions. */\nexport const marketplaceDefs: ConnectorDef[] = [\n${[...out.cli, ...out.token, ...out.oauth].map((d) => `  ${varName(d.id)}Def,`).join('\n')}\n]\n`)

console.log(`cli=${out.cli.length} token=${out.token.length} oauth=${out.oauth.length} skipped=${out.skipped.length}`)
for (const w of warnings) console.log(`  ! ${w}`)
for (const s of out.skipped) console.log(`  - ${s}`)
