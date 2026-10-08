/**
 * 标准 MCP 配置（`mcpServers`）→ 规范连接器定义。
 *
 * 口径与**服务端** `server/internal/serverstore/connector_mcp_servers.go` 逐条对齐
 * （那边是落库的唯一权威：客户端只认规范形状，`parseServerConnectors` 是既有的
 * 信任边界，不新增第二条解析路径）。本模块只服务于管理端"从 JSON 导入"这一个
 * 入口：管理员粘一份厂商文档给的标准配置，页面把它翻成规范定义填进表单。
 *
 * 为什么需要翻译：标准配置里只有 serverName → 配置的映射，而我们的定义要多两个
 * 协议词 —— `serverName` 决定工具命名空间 `mcp__<serverName>__<tool>`，`transport`
 * 区分 stdio 与远程。认证那一侧刻意**不加任何字段**：符合 MCP 规范的服务器会在
 * 401 里自述授权服务器（RFC 9728 → RFC 8414 → 动态注册），所以模式取 `auto`
 * （"该鉴权鉴权"），连接那一刻由客户端按端点决定。
 *
 * 未登记的键一律**报错而不是忽略**：`{"url":…,"header":{…}}`（少写一个 s）被静默丢掉
 * 的表现是"保存成功但行为不对"，正是这个功能要消灭的体验。
 */

/** 单个 server 项上允许出现的键。 */
const SERVER_KEYS = new Set(['type', 'url', 'headers', 'command', 'args', 'env'])

/** 规范 ConnectorDef 的顶层键：出现它们说明这份 JSON 不是标准形状。 */
const RESERVED_TOP_KEYS = new Set([
  'authMode', 'auth', 'tokenFields', 'settings', 'examples', 'icon', 'name', 'description', 'mcp',
])

/** 标准配置的 type 写法 → 我们的 transport（`sse` 故意不支持，见下）。 */
const TRANSPORT_ALIASES: Record<string, 'streamable-http' | 'stdio'> = {
  streamableHttp: 'streamable-http',
  'streamable-http': 'streamable-http',
  streamable_http: 'streamable-http',
  http: 'streamable-http',
  stdio: 'stdio',
}

/** `Object.hasOwn` 的兼容写法（本包的 TS lib 目标低于 ES2022）。 */
function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把一份 JSON 解析结果翻成规范定义。
 * @param input - 已 `JSON.parse` 的输入。
 * @returns 规范定义对象；输入不是标准 MCP 配置形状时返回 `null`（调用方按规范定义处理）。
 * @throws 输入**是**标准形状但内容不合法时抛错，错误文案点名具体 server 与键。
 */
export function standardMcpServersToDefinition(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null
  if (Array.isArray(input.mcp)) return null
  const servers = mcpServersOf(input)
  if (servers === null) return null
  const names = Object.keys(servers).sort()
  if (names.length === 0) throw new Error('标准 MCP 配置里没有 server')
  const entries = names.map((name) => {
    const raw = servers[name]
    if (!isRecord(raw)) throw new Error(`MCP server「${name}」的配置必须是对象`)
    return canonicalEntry(name, raw)
  })
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'mcpServers' || hasOwn(servers, key)) continue
    out[key] = value
  }
  out.authMode = 'auto'
  out.mcp = entries
  return out
}

/** 取出 serverName → 项 的映射：优先 `mcpServers` 包装，其次把顶层当映射（裸写法）。 */
function mcpServersOf(top: Record<string, unknown>): Record<string, unknown> | null {
  if (hasOwn(top, 'mcpServers')) {
    const wrapped = top.mcpServers
    if (!isRecord(wrapped)) throw new Error('mcpServers 必须是对象（serverName → 配置）')
    return wrapped
  }
  for (const key of Object.keys(top)) {
    if (RESERVED_TOP_KEYS.has(key)) return null
  }
  const values = Object.values(top)
  if (values.length === 0) return null
  // 裸映射：每一项都得像一条 server 配置，否则交给规范定义那条路去解析。
  return values.every((value) => isRecord(value) && (typeof value.url === 'string' || typeof value.command === 'string'))
    ? top
    : null
}

/** 一条标准项 → `mcp[]` 的一项。 */
function canonicalEntry(name: string, raw: Record<string, unknown>): Record<string, unknown> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
    throw new Error(`MCP server 名「${name}」不合法（小写字母/数字/连字符，以字母数字开头，≤64 字符）`)
  }
  const unknown = Object.keys(raw).filter((key) => !SERVER_KEYS.has(key)).sort()
  if (unknown.length > 0) {
    throw new Error(`MCP server「${name}」含不支持的键 ${unknown.join('、')}（支持 type/url/headers/command/args/env）`)
  }
  const declaredType = raw.type
  if (declaredType !== undefined && typeof declaredType !== 'string') {
    throw new Error(`MCP server「${name}」的 type 必须是字符串`)
  }
  let transport = declaredType === undefined ? '' : TRANSPORT_ALIASES[declaredType]
  if (declaredType !== undefined && transport === undefined) {
    // `sse` 明确不支持：客户端只实现了 stdio 与 streamable-http，把它当远程端点
    // 接进来只会得到一个说不清原因的连接失败。
    throw new Error(`MCP server「${name}」的 type「${declaredType}」不支持（支持 streamableHttp/http/stdio）`)
  }
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (transport === '') {
    if (command !== '' && url !== '') throw new Error(`MCP server「${name}」同时给了 url 与 command，无法判断传输`)
    if (command !== '') transport = 'stdio'
    else if (url !== '') transport = 'streamable-http'
    else throw new Error(`MCP server「${name}」缺少 url 或 command`)
  }
  if (transport === 'streamable-http') {
    if (url === '') throw new Error(`MCP server「${name}」声明为 streamable-http 但没有 url`)
    if (command !== '') throw new Error(`MCP server「${name}」声明为 streamable-http 却带了 command`)
    return {
      serverName: name,
      transport,
      url: raw.url,
      ...(hasOwn(raw, 'headers') ? { headers: raw.headers } : {}),
    }
  }
  if (command === '') throw new Error(`MCP server「${name}」声明为 stdio 但没有 command`)
  if (url !== '') throw new Error(`MCP server「${name}」声明为 stdio 却带了 url`)
  return {
    serverName: name,
    transport,
    command: raw.command,
    ...(hasOwn(raw, 'args') ? { args: raw.args } : {}),
    ...(hasOwn(raw, 'env') ? { env: raw.env } : {}),
  }
}
