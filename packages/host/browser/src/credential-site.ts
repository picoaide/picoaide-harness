import { domainToASCII } from 'node:url'

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
 *
 * 2026-09-19：非 http(s) 文档（客户端内部协议、about:、file: …）**没有** http(s)
 * origin ⇒ 自动填充在这类页面上**不适用**：本模块一律派生不出站点、闸门如实降级。
 * 判据只看"是不是 http(s)"，**不含任何写死的协议名**（渠道参数化后协议名是运行期
 * 值，写死就会漏掉渠道自己的 scheme）。
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
/**
 * 扩展档之一：词边界 / 连字符分隔（大小写不敏感，因此 `HOSTNAME` 这种 env 风格
 * 的键也算地址键）。camelCase 另立一条**大小写敏感**的规则，否则 `/uri/i` 又会
 * 把 `security` 判成地址键（B1 的原始缺陷形态）。
 */
const SITE_FIELD_LOOKS_LIKE_ADDRESS_WORD = /(?:^|[_-])(?:base[_-]?)?(?:hostname|url|uri|site|host|origin|endpoint|address)(?:$|[_-])/iu
/** 扩展档之二：camelCase（`serverUrl` / `apiEndpoint` / `hostName`）。 */
const SITE_FIELD_LOOKS_LIKE_ADDRESS_CAMEL = /(?:hostName|Url|Uri|Site|Hostname|Host|Origin|Endpoint|Address|URL|URI)$/u

/**
 * 地址形状的优先级：0 = 与 base 同档的地址键，1 = 扩展拼法的地址键，
 * 2 = 其它（`SITE_FIELD_HINT_NONE`）。档内仍按 key 排序。
 */
function siteFieldHint(key: string): number {
  if (SITE_FIELD_HINT_STRONG.test(key)) return 0
  if (SITE_FIELD_LOOKS_LIKE_ADDRESS_WORD.test(key) || SITE_FIELD_LOOKS_LIKE_ADDRESS_CAMEL.test(key)) return 1
  return SITE_FIELD_HINT_NONE
}

/** 不像地址的键：既不优先，也不做裸主机归一。 */
const SITE_FIELD_HINT_NONE = 2

/**
 * http/https 的 origin；其它一律 `null`（`about:blank` 的 origin 是字符串
 * `"null"`，不能当成可比对的站点）。裸主机名不在这里归一 —— 见
 * {@link bareHostOrigin}，它只用于键名明确像地址的字段。
 *
 * 2026-09-19：任何非 http(s) 的自定义协议（例如客户端自己的应用源 scheme）都
 * **不是** http(s)，因此这里一律返回 `null`。这条不是遗漏而是边界：这类页面没有
 * http(s) origin、也没有 cookie，「凭据属于哪个站点」无从谈起 ⇒ 自动填充不适用，
 * 只能如实降级（见 {@link isFillableSiteURL} 与 tools.ts 里那条可读的拒绝文案）。
 */
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
 * 该 URL 能否作为凭据自动填充的站点基准（**只有 http/https**）。
 *
 * 存在的意义是让"应用协议下自动填充不适用"这条边界有一个**命名的**判据，而不是
 * 散落在若干 `=== null` 里：任何非 http(s) 文档都不是可填充站点 —— 既不会被当成某个连接器的绑定站点（不误绑），也不会因为
 * "派生不出站点"而抛错（不误炸）。调用方看到 `false` 时应当**如实降级**：拒绝注入
 * 并给出可读理由，而不是回落到"按当前标签页注入"。
 * @param value - 候选站点 URL（部署声明或凭据字段里的值）。
 * @returns true = http(s)，可作为站点基准。
 */
export function isFillableSiteURL(value: string | null | undefined): boolean {
  return httpOriginOf(value) !== null
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
 * 选值顺序（**前两步用 base 的地址键判据，第三步是 base 的兜底，后三步才是新增
 * 的扩展拼法**，这样"base 能绑定的记录"永远先由 base 的规则裁决）：
 *
 *  1. base 地址键上的显式 http(s) 地址；
 *  2. base 地址键上**文字形态就是主机**的裸值（`app.example.com`、
 *     `10.0.0.5:8000`、`glitchtip.corp.example/api`）—— base 在这里派生不出
 *     origin，所以只会把原本绑不上的记录**新增**为可绑定（E1 能力）；
 *  3. 其余键上的显式 http(s) 地址（base 的原兜底，键序与 base 完全一致）；
 *  4. 扩展拼法键（camelCase / `hostname` / 连字符）上文字形态是主机的裸值；
 *  5. 全部地址形状键上的单标签裸值（`glitchtip`、`glitchtip:8000`，内网自部署）——
 *     放最后，因为 `n/a`/`changeme`/`-` 这类占位符也能被归一成 `http://n`。
 *     扩展拼法键上的**显式 URL 不单列一步**：它们本就在第 3 步的键序里，
 *     单列既是死分支（R5 实测 200k 组命中 0），也会改写 base 的显式 URL 取舍。
 *
 * 与 base 的差异**只有两处**，且都是"新增可绑定 / 更信任地址键"的方向：
 *  - 第 2 步：base 地址键上的**裸主机**现在可以绑定（base 派生不出 → 落到第 3 步）；
 *  - 第 4~5 步：扩展拼法键在 base 里只是普通键，现在享受地址键待遇（仅限裸主机）。
 * 其余情形（尤其是两个 base 地址键之间的取舍）与 base **逐条一致**，
 * 且没有任何记录会从"可绑定"变成"不可绑定"（R2/R3/R4 复核：60k+ 随机差分里
 * `baseNonNull → null = 0`，4218 组强档键两两对拍胜出键完全相同）。
 * @param fields - 凭据字段（`ConnectorCredential.fields`）。
 * @returns 第一个可用 origin，或 `null`。
 */
export function siteOriginFromFields(fields: Record<string, string> | undefined): string | null {
  if (fields === undefined) return null
  const entries = Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  // base 的排序：地址键（词边界判据）优先，其余按键名字典序。
  const baseRanked = entries
    .map(([key, value]) => ({ key, value, strong: SITE_FIELD_HINT_STRONG.test(key) }))
    .sort((a, b) => (Number(b.strong) - Number(a.strong)) || a.key.localeCompare(b.key))
  // 扩展拼法键（base 不认、我们认的那一批），按键名字典序。
  const extended = entries
    .filter(([key]) => !SITE_FIELD_HINT_STRONG.test(key) && siteFieldHint(key) !== SITE_FIELD_HINT_NONE)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => a.key.localeCompare(b.key))

  const explicitIn = (list: readonly { value: string }[]): string | null => {
    for (const entry of list) {
      const origin = httpOriginOf(entry.value)
      if (origin !== null) return origin
    }
    return null
  }
  const hostIn = (list: readonly { value: string }[], allowSingleLabel: boolean): string | null => {
    for (const entry of list) {
      if (!looksLikeHostText(entry.value, allowSingleLabel)) continue
      const origin = bareHostOrigin(entry.value)
      if (origin !== null) return origin
    }
    return null
  }

  const strong = baseRanked.filter((entry) => entry.strong)
  const rest = baseRanked.filter((entry) => !entry.strong)
  // 最后一遍覆盖**所有**地址形状键（含 base 地址键）：单标签内网名没有竞争者时
  // 仍然可用（`{server_url:'glitchtip:8000'}` 必须能绑定）。
  const addressShaped = [...strong, ...extended]
  // `extended` 的显式 URL 不单列一遍：它们本就在 `rest` 里且同按键名字典序，
  // 单列是**死分支**（R5 实测 200k 组命中 0），而且"扩展拼法优先于普通键"会
  // 改写 base 的显式 URL 取舍。扩展拼法只在下面两步里拿到 base 拿不到的能力。
  return explicitIn(strong)
    ?? hostIn(strong, false)
    ?? explicitIn(rest)
    ?? hostIn(extended, false)
    ?? hostIn(addressShaped, true)
}

/**
 * 保留名标签（RFC 2606 / RFC 6761 的示例域 + 常见占位词）：任何一级命中都不可信。
 *
 * 只在单标签分支查否表是不够的 —— `placeholder.com`、`your-domain.com`、
 * `changeme.example` 这类**带点拼写**会整个绕过（R5 审计实测 32/33 组顶掉了
 * 真站点 URL，而 `.com`/`.bar` 是真实 TLD，拒绝文案还会把它当导航指令给模型）。
 */
const RESERVED_HOST_LABELS = new Set([
  'invalid', 'test',
  'changeme', 'todo', 'none', 'null', 'nan', 'undefined', 'placeholder', 'password', 'secret', 'host',
  'your-domain', 'yourdomain', 'your-host', 'yourhost', 'my-domain', 'mydomain', 'domain', 'foo', 'bar',
])
/**
 * 保留 TLD（RFC 2606/6761）。
 *
 * `.example` **刻意不在**否表里：企业内网常拿它当占位域名（本模块的用例也这么
 * 写），且它永不解析 ⇒ 误绑也是 fail-closed，而否掉它会把 `glitchtip.corp.example`
 * 这类记录推回 base 的兜底（真的换绑到别的显式 URL）。`example.com/net/org/edu`
 * 这类二级保留域仍被下面拦掉。
 */
const RESERVED_TLDS = new Set(['invalid', 'test'])

/**
 * Whether the text the operator wrote really names a host.
 *
 * `bareHostOrigin` 的职责是"把它拼成 URL"，因此它会接受一串**数字**
 * （WHATWG 把 `134744072` 读成整数 IPv4 `8.8.8.8`、把 `010.0.0.1` 按八进制读成
 * `8.0.0.1`）、尾点、一位 TLD、带路径的单标签。这些值一旦被采信，绑定基准会指向
 * 一台**真实可达的公网主机**，而拒绝文案会把它当指令交给模型
 * （`navigate the tab to http://8.8.8.8 first`）⇒ 凭据可能被注入无关站点。
 *
 * 判据 = 结构规则（无 scheme/空白/`@`、主机部分非空且无尾点、无空标签、保留名、
 * 数值字面量）＋ **IDNA 归一化与 URL 解析回读一致性**。回读是纵深防御：`new URL`
 * 会把 `134744072` / `0x08080808` / `010.0.0.1` 读成别的 IPv4，也会把全角/零宽
 * 拼写折叠成 ASCII，所以**保留名否表与 TLD 判定都必须在 IDNA 形态上再跑一遍**
 * （只在原文上跑会被 `ｐｌａｃｅｈｏｌｄｅｒ.com` 这类同形拼写绕过 —— 2026-09-16 R6 审计）。
 * IDN 主机（`例子.中国` → `xn--fsqu00a.xn--fiqs8s`）仍然可用。
 * @param value - 字段原值。
 * @param allowSingleLabel - 是否接受 `glitchtip` / `glitchtip:8000` 这类内网单标签名（只给最后一遍）。
 * @returns 该值是否是"文字形态的主机"。
 */
function looksLikeHostText(value: string, allowSingleLabel: boolean): boolean {
  const trimmed = value.trim()
  if (trimmed === '' || /\s/u.test(trimmed) || trimmed.length > 260) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) || trimmed.startsWith('//') || trimmed.includes('@')) return false
  // `\` is a path separator in special URLs, so it must cut the host part too
  // (`evil\real.com` resolves to the host `evil` — R7 audit).
  if (trimmed.includes('\\')) return false
  const hostPort = trimmed.split(/[/?#]/u)[0] ?? ''
  const hostPart = hostPort.startsWith('[') ? hostPort : hostPort.replace(/:\d+$/u, '')
  // `%` (percent-encoding decodes to `.` / empty labels) and the IDNA
  // dot-equivalents (`。`/`．`/`｡`) rewrite the structure: refuse them rather
  // than bind a host the operator did not write (R7 audit).
  if (hostPart === '' || hostPart.endsWith('.') || /[%\u3002\uFF0E\uFF61]/u.test(hostPart)) return false
  const lower = hostPart.toLowerCase()
  // A bracketed IPv6 literal: the URL parser must echo it back unchanged.
  if (hostPart.startsWith('[')) {
    try {
      return new URL(`https://${hostPart}`).hostname === lower
    } catch {
      return false
    }
  }
  const labels = lower.split('.')
  if (labels.some((label) => label === '' || label.length > 63 || RESERVED_HOST_LABELS.has(label))) return false
  if (hostPart.length > 253) return false
  // Single-label intranet names are the LAST resort: a DNS label shape that is not
  // a numeric/hex/percent spelling (`134744072`, `0x08080808`, `010%2e0%2e0e1` are
  // all rewritten into another host by the URL parser) and not a placeholder in
  // ANY encoding (`ｐｌａｃｅｈｏｌｄｅｒ` IDNA-folds to `placeholder`).
  if (labels.length === 1) {
    if (!allowSingleLabel || hostPart.length < 2) return false
    if (!/^[\p{L}][\p{L}\p{N}-]*$/u.test(hostPart)) return false
    const ascii = domainToASCII(hostPart)
    if (ascii === '' || ascii !== lower || RESERVED_HOST_LABELS.has(ascii)) return false
    try {
      return new URL(`https://${ascii}`).hostname === ascii
    } catch {
      return false
    }
  }
  // A dotted-quad IPv4 is allowed only in its canonical form (no WHATWG rewrite).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostPart)) {
    return labels.every((label) => Number(label) <= 255 && (label === '0' || !label.startsWith('0')))
      && labels.some((label) => label !== '0')
  }
  // Any other value must read back exactly as written once IDNA-encoded.
  const ascii = domainToASCII(hostPart)
  if (ascii === '') return false
  let parsed: string
  try {
    parsed = new URL(`https://${ascii}`).hostname
  } catch {
    return false
  }
  if (parsed !== ascii.toLowerCase()) return false
  // Judge the denylist, the TLD and the reserved example domains on the ASCII /
  // IDNA form: that is the form the browser would actually resolve.
  const asciiLabels = parsed.split('.')
  // `localhost` is a real loopback NAME in the single-label branch, but as one
  // LABEL of a dotted name it is a placeholder — `localhost.com` / `x.localhost`
  // are registrable/rewritten hosts that must not outrank a real site URL
  // (R7 audit: removing it from the denylist regressed exactly these).
  if (asciiLabels.some((label) => label === 'localhost' || RESERVED_HOST_LABELS.has(label))) return false
  // The ASCII/IDNA form must satisfy the DNS size limits too (`é`×63 + `.com`
  // grows past 63 bytes per label).
  if (asciiLabels.some((label) => label === '' || label.length > 63) || parsed.length > 253) return false
  const tld = asciiLabels.at(-1) ?? ''
  if (RESERVED_TLDS.has(tld)) return false
  // `example.com` / `example.org.cn` / `example.co.uk` … (RFC 2606 文档保留域):
  // `example` 出现在**任何非末级**位置都视为占位（`glitchtip.corp.example`
  // 这类把 example 当 TLD 的内网命名不受影响）。
  if (asciiLabels.slice(0, -1).includes('example')) return false
  return /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/u.test(tld)
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
