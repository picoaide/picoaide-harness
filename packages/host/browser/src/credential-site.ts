/**
 * 凭据注入的站点绑定（2026-09-15 审计 BUG-03）。
 *
 * 背景：`browser_fill_credentials` 只按 connectorId 解析就把握着的用户名/口令
 * 写进**当前文档**。模型可以先把标签页开到任意站点（钓鱼页天然受益）再调用，
 * 凭据就落进了别人的登录框。tools.ts 里的闸门（`assertCredentialOrigin`）要求
 * 一个"该连接器自己的站点 origin"作为比对基准 —— 本模块是那个基准的**唯一**
 * 派生实现，由插件启动期（index.ts）接到凭证解析器上。
 *
 * 取值优先级（全部来自**部署侧/用户侧**的可信输入，绝无模型输入）：
 *  1. 显式配置 `credentialSites[connectorId]`（部署把它写进 profile 行配置，
 *     与登录页内置 server_url 同一层级）；
 *  2. 凭据自身字段里的 http(s) 地址 —— 自部署型连接器（例如 GLITCHTIP_BASE_URL
 *     "服务地址"）就是这样把站点告诉客户端的；键名像地址的优先，其余按字典序，
 *     保证同一份凭据每次得到同一个 origin（不随对象键序漂移）。
 *
 * 派生不出来就返回 `null`，闸门**拒绝注入**（fail-closed）：工具描述对外承诺的
 * 就是 "a connector record without a site URL is refused"。
 */

/**
 * 凭据里可能是"站点地址"的字段名。
 *
 * 判据分两层，因为**选值顺序**与**能否裸主机归一**是两件事：
 *
 *  - {@link SITE_FIELD_HINT_STRONG} 是引入裸主机归一之前（v2.7.5-beta.2）的
 *    判据**逐字保留**。它决定显式 URL 的优先顺序，因此必须与 base 完全一致：
 *    2026-09-16 R2 复核实测，把它放宽一个字符（`_` 改 `[_-]`、或把 `hostname`
 *    并进来）都会让 `{url:'https://real', HOSTNAME:'https://other'}`、
 *    `{server_url:'https://real','callback-url':'https://sso/cb'}` 这类记录
 *    静默换绑（20000 组随机差分里 768 组与 base 不同）。
 *  - {@link SITE_FIELD_LOOKS_LIKE_ADDRESS} 是**扩展**判据（camelCase、`hostname`、
 *    连字符分隔），只用于两件事：把地址键排在其它键之前、以及给裸主机名归一
 *    放行。它只**新增**可绑定的记录，不改变显式 URL 的取舍。
 *
 * 为什么必须保留词边界（2026-09-16 R9 审计 B1）：上一版把关键词表放宽成裸子串
 * （`/uri/` 也命中 `sec·URI·ty`），于是 `SECURITY_TOKEN` / `siteName` /
 * `website` / `callbackUrl` 被当成地址字段，一个口令形状的值就顶掉了连接器真正
 * 的站点（实测 `{SECURITY_TOKEN, SITE_URL}` 从 `https://real.example` 变成
 * `http://abc123def456`）。
 */
const SITE_FIELD_HINT_STRONG = /(?:^|_)(?:base_?)?(?:url|uri|site|host|origin|endpoint|address)(?:$|_)/iu
/** 地址形状的扩展拼法（含 camelCase 与 `hostname`）：排序与裸主机归一的放行判据。 */
const SITE_FIELD_LOOKS_LIKE_ADDRESS = /(?:^|[_-])(?:base[_-]?)?(?:hostname|url|uri|site|host|origin|endpoint|address)(?:$|[_-])|(?:Url|Uri|Site|Hostname|Host|Origin|Endpoint|Address|URL|URI)$/u

/**
 * 地址形状的优先级：0 = 与 base 同档的地址键，1 = 扩展拼法的地址键，
 * 2 = 其它（`SITE_FIELD_HINT_NONE`）。档内仍按 key 排序。
 */
function siteFieldHint(key: string): number {
  if (SITE_FIELD_HINT_STRONG.test(key)) return 0
  if (SITE_FIELD_LOOKS_LIKE_ADDRESS.test(key)) return 1
  return SITE_FIELD_HINT_NONE
}

/** 不像地址的键：既不优先，也不做裸主机归一。 */
const SITE_FIELD_HINT_NONE = 2

/** http/https 的 origin；其它一律 `null`（`about:blank` 的 origin 是字符串
 * `"null"`，不能当成可比对的站点）。裸主机名不在这里归一 —— 见
 * {@link bareHostOrigin}，它只用于键名明确像地址的字段。 */
export function httpOriginOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * 裸主机名 / 主机名+端口 / 主机名+路径 → origin。
 *
 * 用户在"服务地址"类字段里经常只填 `app.glitchtip.com`（内置 GlitchTip 模板
 * 与 webadmin 提示都这么教），`httpOriginOf` 会判 null，站点绑定因此永远失败、
 * `browser_fill_credentials` 对这类连接器永久不可用（2026-09-16 审计 E1）。
 * 只对**键名像地址**的字段做这次归一（调用点决定）；字段里允许单标签内网名
 * （`glitchtip:8000`），但**部署声明**（`credentialSites`）要求主机名含点或是
 * 回环地址，见 {@link credentialSiteOrigin}。
 * @param value - 字段原值。
 * @returns 归一后的 origin，或 null。
 */
export function bareHostOrigin(
  value: string | null | undefined,
  options: { singleLabel?: boolean } = {},
): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || /\s/u.test(trimmed)) return null
  // A scheme-less value only; explicit schemes, protocol-relative URLs and
  // userinfo are either handled by httpOriginOf or must be refused. The scheme
  // check requires `://` (or a known opaque scheme) so `host:8443` — a port, not
  // a scheme — is still accepted.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) || /^(?:javascript|data|file|about|mailto):/iu.test(trimmed)
    || trimmed.startsWith('//') || trimmed.includes('@')) return null
  let url: URL
  try {
    url = new URL(`https://${trimmed}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host === '' || !/^[a-z0-9.\-:\[\]]+$/u.test(host)) return null
  // A single-label name is an intranet host in the field case; a deployment
  // declaration must look unambiguous, so nonsense like `not-a-url` falls
  // through to the credential fields.
  const singleLabel = !host.includes('.') && !isPrivateHost(host)
  if (singleLabel && options.singleLabel === false) return null
  // An IP literal (CGNAT 100.64/10, benchmark 198.18/15, private blocks, but
  // also a bare public address) is far more likely a directly-reached service
  // than a TLS one; defaulting them to https made the binding permanently
  // unreachable for http intranet addresses (2026-09-16 audit R5).
  const ipLiteral = host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)
  // `new URL` gives IDN/IPv4/IPv6/single-label a hostname; private/loopback/
  // single-label intranet names and IP literals default to http, public DNS
  // names to https. The refusal message tells the user what to do when the real
  // service uses the other scheme (scheme-less input cannot encode that choice).
  const scheme = isPrivateHost(host) || singleLabel || ipLiteral ? 'http' : 'https'
  return `${scheme}://${url.host.toLowerCase()}`
}

/** Loopback/private/link-local hosts, where plain http is the likely service. */
function isPrivateHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]'
    || /^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host) || /^169\.254\./u.test(host)
}

/**
 * 从连接器凭据的字段里挑出站点 origin。
 *
 * 三遍选值（顺序即优先级）：
 *  1. **地址形状键上的显式 http(s) 地址**。base 的地址键（词边界判据）在此完全
 *     同序；扩展拼法（camelCase / `hostname` / 连字符）也享受同一优先级，因为
 *     base 对"地址键优先于其它键"这件事本身就是这么定的，只是没识别这些拼法。
 *  2. **地址形状键上的裸主机名**（自部署模板教用户只填 `app.example.com`）
 *     —— base 在这里派生不出 origin，所以只会**新增**可绑定的记录。
 *  3. **其它键上的显式 http(s) 地址** —— base 的兜底，保持最后。
 *
 * 第 2 步排在第 3 步之前，是为了不让一个"非地址字段里的 URL"（例如
 * `{base_url:'glitchtip.corp.example', sentry_dsn:'https://…@sentry.io/1'}` 的
 * DSN）顶掉连接器真正的站点。**与 base 的差异只剩这两类**：地址键的裸主机名
 * 现在能绑定、扩展拼法现在与 base 地址键同档；两个 base 地址键之间的取舍
 * （含 110 组两两对拍）与 base 逐条一致，且没有任何记录会从"可绑定"变成
 * "不可绑定"（2026-09-16 R2 复核差分：20000 组里 baseNonNull→null = 0）。
 * @param fields - 凭据字段（`ConnectorCredential.fields`）。
 * @returns 第一个可用 origin，或 `null`。
 */
export function siteOriginFromFields(fields: Record<string, string> | undefined): string | null {
  if (fields === undefined) return null
  const entries = Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  // 键名像地址的排前面；同优先级按键名字典序（对象键序不参与，结果稳定）。
  const ranked = entries
    .map(([key, value]) => ({ key, value, hint: siteFieldHint(key) }))
    .sort((a, b) => (a.hint - b.hint) || a.key.localeCompare(b.key))
  for (const entry of ranked) {
    if (entry.hint === SITE_FIELD_HINT_NONE) continue
    const origin = httpOriginOf(entry.value)
    if (origin !== null) return origin
  }
  for (const entry of ranked) {
    if (entry.hint === SITE_FIELD_HINT_NONE) continue
    const origin = bareHostOrigin(entry.value)
    if (origin !== null) return origin
  }
  for (const entry of ranked) {
    if (entry.hint !== SITE_FIELD_HINT_NONE) continue
    const origin = httpOriginOf(entry.value)
    if (origin !== null) return origin
  }
  return null
}

/**
 * 站点绑定的期望 origin：显式配置优先，其次凭据字段。
 * @param credentialFields - 已存凭据的字段表（可为空）。
 * @param configured - `credentialSites[connectorId]`（部署显式声明的站点地址）。
 */
export function credentialSiteOrigin(
  credentialFields: Record<string, string> | undefined,
  configured: string | null | undefined,
): string | null {
  // A deployment declaration is user/operator written too: accept the same bare
  // host form there, otherwise the refusal message recommends `credentialSites`
  // while this function silently ignores exactly that value.
  return httpOriginOf(configured)
    ?? bareHostOrigin(configured, { singleLabel: false })
    ?? siteOriginFromFields(credentialFields)
}
