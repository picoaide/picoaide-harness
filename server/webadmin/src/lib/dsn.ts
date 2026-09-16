/**
 * 错误上报 DSN 校验(webadmin 侧)。
 *
 * 权威实现在 Go:`server/internal/llmgateway/dsn.go`。本文件是**逐字镜像** ——
 * 两侧必须给出完全一致的 verdict 与中文文案,否则
 * `src/lib/dsn.corpus.test.ts`(读 `server/internal/llmgateway/testdata/dsn_corpus.json`)
 * 与 Go 侧 `dsn_parity_test.go`(读同一份 JSON)必有一侧变红。
 *
 * 为什么两端都要有:D2 定了"服务端权威 + webadmin 体验"双侧校验 ——
 * 绕过 webadmin 直接 PUT 必须被服务端拦住(权威);而管理员在页面上点保存时,
 * 坏 DSN 应该在**发请求之前**就被拒并给出中文提示(体验)。
 *
 * 规则(与 Go 一致):
 *   - 空串 = 未启用,直接放行(允许清空既有配置);
 *   - 必须能解析成 URL、协议 http/https、userinfo 里有公钥、路径最后一段是正整数;
 *   - **主机名先归一化再判定**(2026-09-16 修复轮 1,F-06/F-12):去尾点
 *     (`localhost.` = `localhost`)、小写、把 WHATWG 认可的 IPv4 数字写法
 *     (`127.1` / `2130706433` / `0177.0.0.1` / `017700000001` / `0x7f000001` /
 *     `0x7f.0.0.1`)折算成点分四段 —— 这些写法在客户端**全部解析到 127.0.0.1**;
 *   - **端口必须是 1-65535**(2026-09-16 修复轮 1,F-14):`:0` / `:99999` 这类端口
 *     服务端放行但客户端 `@sentry/node` 会把 transport 换成"不发任何事件"的空实现,
 *     且只打一行 console.warn —— 属"配置必然不工作且不可见";
 *   - **硬拒绝** 环回(localhost / *.localhost / 127.0.0.0/8 / ::1)、链路本地、
 *     云 metadata(169.254.169.254、100.100.100.200、fd00:ec2::/64)、unspecified、
 *     数字写法非法的"像 IP 的主机名"(如 `0.0.0.0.0`);
 *   - **只告警不拒绝** 私网(10/8、172.16/12、192.168/16、fc00::/7)与 http://
 *     —— 企业内网自建 GlitchTip 是合法主场景;
 *   - **不做 DNS 解析**(内网域名/离线部署是常态;与 Go 侧同一取舍)。
 *
 * 为什么不用 `new URL(trimmed)` 单独做解析:WHATWG 解析器对 `:99999`、
 * `:65536`、`0.0.0.0.0` 这类输入**直接抛错**,于是所有失败都被映射成"不是合法的
 * URL"这条泛化文案,而真实原因可能是端口越界/主机名数字写法非法 —— 与 Go 的
 * 宽松 `url.Parse` 也解读不一致(Go 能解析出主机与端口)。所以这里按 Go 的顺序
 * **手工解析 authority**,再对每一类失败给出各自的文案。
 */

/** 校验结论(与 Go 侧 ErrorReportingDSNVerdict 同名同值)。 */
export type ErrorReportingDsnVerdict = 'accept' | 'warn' | 'reject'

/** 拒绝文案(必须与 dsn.go 中的常量逐字一致)。 */
export const DSN_BLOCKED_MESSAGE =
  '错误上报 DSN 不能指向本机或云元数据地址(localhost/127.0.0.1/::1):客户端会把事件发往自己的电脑,永远收不到'
export const DSN_SCHEME_MESSAGE = '错误上报 DSN 必须以 http:// 或 https:// 开头'
export const DSN_MALFORMED_MESSAGE = '错误上报 DSN 不是合法的 URL(格式:{协议}://{公钥}@{主机}/{项目ID})'
export const DSN_HOST_MESSAGE = '错误上报 DSN 的主机名不是合法的域名或 IP 地址'
export const DSN_PORT_MESSAGE =
  '错误上报 DSN 的端口必须是 1-65535 的数字(:0 与越界端口不会被客户端 SDK 接受,事件一条都发不出去)'
export const DSN_KEY_MESSAGE = '错误上报 DSN 缺少公钥(格式:{协议}://{公钥}@{主机}/{项目ID})'
export const DSN_PROJECT_MESSAGE = '错误上报 DSN 的项目 ID 必须是正整数(格式:{协议}://{公钥}@{主机}/{项目ID})'

/** 告警文案(顺序固定:先 http 后私网;"；" 连接)。 */
export const DSN_PLAIN_HTTP_MESSAGE = '使用 http:// 明文传输:仅当内网自建且无法启用 TLS 时才可用'
export const DSN_PRIVATE_MESSAGE = '该地址属于内网私有网段:仅当客户端能访问该内网地址时才可用(内网自建场景合法)'

/** 一次校验的完整结论。 */
export interface ErrorReportingDsnInspection {
  verdict: ErrorReportingDsnVerdict
  /** reject 时是拒绝原因;warn 时是告警文案;accept 时为空串。 */
  message: string
  scheme: string
  /** 主机名(不含端口、不含 userinfo)。 */
  host: string
  projectId: string
  publicKey: string
  /** 由 DSN 推导的 ingest 端点(不含 userinfo)。 */
  storeEndpoint: string
}

function parseIPv4(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length === 0 || parts.length > 4) return null
  const nums: number[] = []
  for (const part of parts) {
    if (part.length === 0) return null
    if (!/^[0-9]+$/.test(part)) return null
    const n = Number(part)
    if (!Number.isSafeInteger(n) || n < 0) return null
    nums.push(n)
  }
  // 与 Go net.ParseIP 一致:1~4 段,最后一段的取值范围随段数放宽。
  const limits = [null, 0xffffffff, 0xffffff, 0xffff, 0xff]
  const last = nums[nums.length - 1]!
  if (last > (limits[nums.length] as number)) return null
  for (let i = 0; i < nums.length - 1; i += 1) {
    if (nums[i]! > 0xff) return null
  }
  const [a = 0, b = 0, c = 0, d = 0] = nums.length === 1
    ? [(last >>> 24) & 0xff, (last >>> 16) & 0xff, (last >>> 8) & 0xff, last & 0xff]
    : nums.length === 2
      ? [nums[0]!, (last >>> 16) & 0xff, (last >>> 8) & 0xff, last & 0xff]
      : nums.length === 3
        ? [nums[0]!, nums[1]!, (last >>> 8) & 0xff, last & 0xff]
        : [nums[0]!, nums[1]!, nums[2]!, nums[3]!]
  return [a, b, c, d]
}

/** 解析 IPv6(含 `::` 缩写与尾部 IPv4 形式)为 16 字节;不是 IPv6 时返回 null。 */
function parseIPv6(value: string): number[] | null {
  let text = value
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  if (!text.includes(':')) return null
  // 去掉 zone id(fe80::1%eth0)。
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)

  // 尾部 IPv4 形式(::ffff:127.0.0.1)折算成两个 16 位组,再按纯 IPv6 解析。
  const lastColon = text.lastIndexOf(':')
  if (lastColon < 0) return null
  const tailText = text.slice(lastColon + 1)
  if (tailText.includes('.')) {
    const v4 = parseIPv4(tailText)
    if (v4 === null) return null
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16)
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16)
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const parseGroups = (input: string): number[] | null => {
    if (input === '') return []
    const out: number[] = []
    for (const group of input.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
      out.push(Number.parseInt(group, 16))
    }
    return out
  }
  const head = parseGroups(halves[0] ?? '')
  if (head === null) return null
  let back: number[] = []
  if (halves.length === 2) {
    const parsedBack = parseGroups(halves[1] ?? '')
    if (parsedBack === null) return null
    back = parsedBack
  }
  const total = head.length + back.length
  if (halves.length === 1) {
    if (total !== 8) return null
  } else if (total > 7) {
    // "::" 至少要压缩掉一组。
    return null
  }
  const fill = new Array<number>(8 - total).fill(0)
  const all = [...head, ...fill, ...back]
  if (all.length !== 8) return null
  const bytes: number[] = []
  for (const word of all) {
    bytes.push((word >> 8) & 0xff, word & 0xff)
  }
  return bytes
}

/** 字节前缀判定(IPv6 网段)。 */
function hasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  let remaining = bits
  for (let i = 0; i < prefix.length && remaining > 0; i += 1) {
    const take = Math.min(8, remaining)
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff
    if ((bytes[i]! & mask) !== (prefix[i]! & mask)) return false
    remaining -= take
  }
  return true
}

const AWS_IPV6_METADATA = [0xfd, 0x00, 0x0e, 0xc2, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]

/** 报告主机名是否属于"从客户端视角必然不可用"的类别。 */
function blockedHost(host: string): boolean {
  const lowered = host.toLowerCase()
  // RFC 6761:localhost 及其子域一律解析到环回。
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) return true
  if (['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'metadata.azure.com'].includes(lowered)) {
    return true
  }
  const v4 = parseIPv4(lowered)
  if (v4 !== null) {
    if (v4[0] === 127) return true // 127.0.0.0/8
    if (v4[0] === 0 && v4[1] === 0 && v4[2] === 0 && v4[3] === 0) return true // unspecified
    if (v4[0] === 169 && v4[1] === 254) return true // 链路本地
    const dotted = v4.join('.')
    if (dotted === '169.254.169.254' || dotted === '100.100.100.200' || dotted === '169.254.170.2') return true
    return false
  }
  const v6 = parseIPv6(lowered)
  if (v6 !== null) {
    const isZero = v6.every((b) => b === 0)
    if (isZero) return true // ::
    if (v6.slice(0, 15).every((b) => b === 0) && v6[15] === 1) return true // ::1
    if (hasPrefix(v6, [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10)) return true // fe80::/10
    if (hasPrefix(v6, AWS_IPV6_METADATA, 64)) return true // fd00:ec2::/64
    // IPv4-mapped(::ffff:127.0.0.1)按内嵌 IPv4 再判一次。
    if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) {
      const mapped = [v6[12]!, v6[13]!, v6[14]!, v6[15]!]
      if (mapped[0] === 127 || (mapped[0] === 169 && mapped[1] === 254)) return true
      if (mapped[0] === 0 && mapped[1] === 0 && mapped[2] === 0 && mapped[3] === 0) return true
    }
    return false
  }
  return false
}

/** 报告主机名是否是私网字面 IP(RFC 1918 + ULA);域名一律 false。 */
function privateHost(host: string): boolean {
  const lowered = host.toLowerCase()
  const v4 = parseIPv4(lowered)
  if (v4 !== null) {
    if (v4[0] === 10) return true
    if (v4[0] === 172 && v4[1]! >= 16 && v4[1]! <= 31) return true
    if (v4[0] === 192 && v4[1] === 168) return true
    return false
  }
  const v6 = parseIPv6(lowered)
  if (v6 !== null) {
    // fc00::/7(唯一本地地址)
    return (v6[0]! & 0xfe) === 0xfc
  }
  return false
}

function reject(message: string): ErrorReportingDsnInspection {
  return { verdict: 'reject', message, scheme: '', host: '', projectId: '', publicKey: '', storeEndpoint: '' }
}

/** 手工解析出的 authority(`{userinfo}@{host}:{port}`)。 */
interface ParsedAuthority {
  /** 百分号解码后的公钥;缺 userinfo 时为空串。 */
  publicKey: string
  /** 归一化后的主机名(IPv6 不含方括号)。 */
  host: string
  /** 显式端口(空串 = 默认端口)。 */
  port: string
}

/**
 * 按 Go `url.Parse` 的顺序手工解析 DSN 的 authority。
 *
 * @param raw - 已 trim 的 DSN 全文。
 * @returns 解析结果;语法层面不可解析时返回错误文案。
 */
function parseDsnAuthority(raw: string): { ok: true, value: ParsedAuthority } | { ok: false, message: string } {
  const matched = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(raw)
  if (matched === null) return { ok: false, message: DSN_MALFORMED_MESSAGE }
  const scheme = matched[1]!.toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, message: DSN_SCHEME_MESSAGE }
  const authority = matched[2]!
  // Go `url.Parse` 的字符级拒绝(空白/控制字符/非法转义等)—— 对齐见语料。
  if (authorityHasUnparsableChar(authority)) return { ok: false, message: DSN_MALFORMED_MESSAGE }
  // 最后一个 '@' 之前的才是 userinfo(公钥里允许含 ':' 的 secret 写法)。
  const at = authority.lastIndexOf('@')
  const userinfo = at < 0 ? '' : authority.slice(0, at)
  const hostport = at < 0 ? authority : authority.slice(at + 1)

  let host = ''
  let port = ''
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']')
    if (close < 0) return { ok: false, message: DSN_MALFORMED_MESSAGE }
    host = hostport.slice(1, close)
    const tail = hostport.slice(close + 1)
    if (tail !== '') {
      if (!tail.startsWith(':')) return { ok: false, message: DSN_MALFORMED_MESSAGE }
      port = tail.slice(1)
    }
  } else {
    const colon = hostport.lastIndexOf(':')
    if (colon >= 0) {
      host = hostport.slice(0, colon)
      port = hostport.slice(colon + 1)
    } else {
      host = hostport
    }
  }
  // Go `url.Parse` 对非数字端口直接报错(→ 泛化文案);数字端口才继续做范围判定。
  if (port !== '' && !/^[0-9]+$/.test(port)) return { ok: false, message: DSN_MALFORMED_MESSAGE }
  if (port !== '') {
    const value = Number(port)
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
      return { ok: false, message: DSN_PORT_MESSAGE }
    }
  }
  if (hostHasPercentEscape(hostport)) return { ok: false, message: DSN_MALFORMED_MESSAGE }
  let publicKey = userinfo
  const secretAt = userinfo.indexOf(':')
  if (secretAt >= 0) publicKey = userinfo.slice(0, secretAt)
  try {
    // Go 的 `u.User.Username()` 会做百分号解码,所以 `%20` 这类只有空白的名义
    // userinfo 必须被认成"没有公钥"(修复轮 1,F-12)。
    publicKey = decodeURIComponent(publicKey)
  } catch {
    return { ok: false, message: DSN_MALFORMED_MESSAGE }
  }
  if (publicKey.trim() === '') return { ok: false, message: DSN_KEY_MESSAGE }
  return { ok: true, value: { publicKey, host, port } }
}

/** 报告最后一个标签是否是数字(十进制或 0x 十六进制) —— WHATWG "ends in a number"。 */
function numericLastLabel(host: string): boolean {
  const labels = host.split('.')
  const last = labels[labels.length - 1] ?? ''
  if (last === '') return false
  if (last.startsWith('0x') || last.startsWith('0X')) return last.length > 2 && /^[0-9a-fA-F]+$/.test(last.slice(2))
  return /^[0-9]+$/.test(last)
}

/** 解析单个标签的数值(空/非法字符都返回 null)。 */
function parseIPv4NumberLabel(label: string): number | null {
  if (label === '') return null
  if (label.startsWith('0x') || label.startsWith('0X')) {
    if (label.length <= 2 || !/^[0-9a-fA-F]+$/.test(label.slice(2))) return null
    return Number.parseInt(label.slice(2), 16)
  }
  if (!/^[0-9]+$/.test(label)) return null
  // 前导 0(且不止一位)= 八进制(WHATWG 同);非法八进制数字(如 08)按规则先按
  // 十进制解析,解析不出再退回八进制 —— 这里保守地按十进制处理。
  if (label.length > 1 && label.startsWith('0')) {
    if (/^[0-7]+$/.test(label)) return Number.parseInt(label, 8)
    return Number.parseInt(label, 10)
  }
  return Number.parseInt(label, 10)
}

/**
 * 按 WHATWG 的 IPv4 数字规则解析 1-4 段主机名,返回点分四段字符串。
 *
 * @param host - 已小写、已去尾点的主机名。
 * @returns 点分四段;不合法时 null(客户端 `new URL` 对这类输入直接抛错)。
 */
function parseIPv4Number(host: string): string | null {
  const labels = host.split('.')
  if (labels.length === 0 || labels.length > 4) return null
  const values: number[] = []
  for (const label of labels) {
    const value = parseIPv4NumberLabel(label)
    if (value === null || !Number.isSafeInteger(value)) return null
    values.push(value)
  }
  for (const value of values.slice(0, -1)) {
    if (value > 0xff) return null
  }
  const last = values[values.length - 1]!
  const limit = 256 ** (5 - values.length)
  if (last >= limit) return null
  let total = last
  values.slice(0, -1).forEach((value, index) => {
    total += value * 256 ** (3 - index)
  })
  return [(total >>> 24) & 0xff, (total >>> 16) & 0xff, (total >>> 8) & 0xff, total & 0xff].join('.')
}

/** 域名的形状校验(不做 DNS);规则与 Go `validErrorReportingDSNHostname` 一致。
 *
 * 允许非 ASCII 码位(IDN 域名):改动前这类主机是被接受的(客户端 `new URL` 会自己
 * 做 punycode),收紧它会平白拒掉合法的中文/IDN 部署。 */
function validHostnameShape(host: string): boolean {
  if (host.length > 253) return false
  return host.split('.').every((label) => {
    if (label === '' || label.length > 63) return false
    for (const ch of label) {
      const code = ch.codePointAt(0)!
      const ascii = (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)
        || code === 0x2d /* - */ || code === 0x5f /* _ */
      if (!ascii && code < 0x80) return false
    }
    return true
  })
}

/**
 * authority 里 Go `url.Parse` 会直接拒绝的字符(→ 泛化"不是合法的 URL"文案)。
 *
 * 与 Go 实测对齐(见语料):空白/控制字符在任何位置都拒绝;host 里
 * `` ` `` `{` `}` `|` `\` `^` 也拒绝。`"` `<` `>` 是例外 —— Go 会把它们并进 host,
 * 再由形状校验拒成"主机名不合法"(语料同侧对拍)。
 */
function authorityHasUnparsableChar(authority: string): boolean {
  return /[\s\u0000-\u001f\u007f`{}|\\^]/.test(authority)
}

/**
 * host 部分不允许任何 `%`(Go 实测:`ho%41st` / `ho%20st` / `ho%2est` 一律
 * "不是合法的 URL";userinfo 里的 `%` 反而允许,如 `ke%79@host` → 公钥 `key`)。
 */
function hostHasPercentEscape(hostport: string): boolean {
  const withoutBrackets = hostport.startsWith('[') ? hostport.slice(hostport.indexOf(']') + 1) : hostport
  const hostPart = hostport.startsWith('[') ? hostport.slice(0, hostport.indexOf(']') + 1) : withoutBrackets.split(':')[0]!
  return hostPart.includes('%')
}

/**
 * 归一化主机名:去尾点 + 小写 + IPv4 数字写法折算;形状不合法时返回 null。
 *
 * @param host - `url.Hostname()` 等价物(IPv6 已去方括号)。
 */
function normalizeHost(host: string): string | null {
  const trimmed = host.replace(/\.+$/, '').toLowerCase()
  if (trimmed === '') return null
  if (trimmed.includes(':')) return parseIPv6(trimmed) === null ? null : trimmed
  if (numericLastLabel(trimmed)) return parseIPv4Number(trimmed)
  return validHostnameShape(trimmed) ? trimmed : null
}

/**
 * 校验并解析一个错误上报 DSN。空串 = 未启用(允许清空),直接 accept。
 */
export function inspectErrorReportingDsn(raw: string): ErrorReportingDsnInspection {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { verdict: 'accept', message: '', scheme: '', host: '', projectId: '', publicKey: '', storeEndpoint: '' }
  }
  const parsed = parseDsnAuthority(trimmed)
  if (!parsed.ok) return reject(parsed.message)
  const { publicKey, port } = parsed.value

  // 路径最后一段 = 项目 ID(与 Go `splitErrorReportingDSNPath` 同)。
  const rest = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(trimmed)![3]!
  const pathOnly = rest.split(/[?#]/)[0]!
  const segments = pathOnly.split('/').filter((segment) => segment !== '')
  const projectId = segments.length > 0 ? segments[segments.length - 1]! : ''
  if (!/^[0-9]+$/.test(projectId) || Number(projectId) <= 0) return reject(DSN_PROJECT_MESSAGE)

  const host = normalizeHost(parsed.value.host)
  if (host === null) {
    return reject(parsed.value.host === '' ? DSN_MALFORMED_MESSAGE : DSN_HOST_MESSAGE)
  }
  if (blockedHost(host)) return reject(DSN_BLOCKED_MESSAGE)

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(trimmed)![1]!.toLowerCase()
  const warnings: string[] = []
  if (scheme === 'http') warnings.push(DSN_PLAIN_HTTP_MESSAGE)
  if (privateHost(host)) warnings.push(DSN_PRIVATE_MESSAGE)

  const prefix = segments.length > 1 ? `/${segments.slice(0, -1).join('/')}` : ''
  const portPart = port === '' ? '' : `:${port}`
  return {
    verdict: warnings.length > 0 ? 'warn' : 'accept',
    message: warnings.join('；'),
    scheme,
    host,
    projectId,
    publicKey,
    storeEndpoint: `${scheme}://${host}${portPart}${prefix}/api/${projectId}/store/`,
  }
}

/** 保存前校验:不通过时返回可直接展示的中文提示。 */
export function validateErrorReportingDsn(raw: string): { ok: true } | { ok: false; message: string } {
  const inspection = inspectErrorReportingDsn(raw)
  if (inspection.verdict === 'reject') return { ok: false, message: inspection.message }
  return { ok: true }
}
