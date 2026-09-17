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
 *   - 长度上限 2048(2026-09-17,S12-02):与 Go 相同按 **UTF-8 字节** 计数;
 *   - 必须能解析成 URL、协议 http/https、userinfo 里有公钥、路径最后一段是正整数;
 *   - **主机名先归一化再判定**(2026-09-16 修复轮 1,F-06/F-12):去尾点
 *     (`localhost.` = `localhost`)、小写、把 WHATWG 认可的 IPv4 数字写法
 *     (`127.1` / `2130706433` / `0177.0.0.1` / `017700000001` / `0x7f000001` /
 *     `0x7f.0.0.1`)折算成点分四段 —— 这些写法在客户端**全部解析到 127.0.0.1**;
 *     前导 0 且含 8/9(如 `08.0.0.1`)= 八进制解析失败,**与 Go 一样拒绝**
 *     (2026-09-17,S10-4);
 *   - **端口必须是 1-65535**(2026-09-16 修复轮 1,F-14):`:0` / `:99999` 这类端口
 *     服务端放行但客户端 `@sentry/node` 会把 transport 换成"不发任何事件"的空实现,
 *     且只打一行 console.warn —— 属"配置必然不工作且不可见";
 *   - **硬拒绝** 环回(localhost / *.localhost / 127.0.0.0/8 / ::1)、链路本地
 *     (含 169.254/16 与 224.0.0.0/24 链路本地多播)、云 metadata(169.254.169.254、
 *     100.100.100.200、fd00:ec2::/64)、unspecified、IPv4-mapped 写法
 *     (`::ffff:a.b.c.d` 解包后走同一套 IPv4 规则)、数字写法非法的"像 IP 的主机名"
 *     (如 `0.0.0.0.0`);
 *   - **SDK 可解析性**(2026-09-17,S10-2):接受面必须等于"客户端 SDK 真能解析的
 *     形状"(@sentry/utils 的 DSN_REGEX + validateDsn)。除主机 ASCII-only(IDN 与
 *     IPv6 字面量一条都解析不了)外,2026-09-17 修复轮 2 补齐了另外五个位置:
 *     公钥/私钥字符集(`\w+` / `\w*`)、userinfo 里多出的 `@`、空端口(`host:`)、
 *     大写协议(`HTTPS://`)、项目 ID 末尾的 `/`(SDK 会把它解析成空 projectId);
 *   - **项目 ID 取原文路径的前导数字**(2026-09-17 修复轮 2,P3):与 SDK 的
 *     `projectId.match(/^\d+/)` 同构(`/1abc` ⇒ 1、`/1%2F2` ⇒ 1),但前导数字必须
 *     落在 int64 且 > 0(BigInt 精确比较;`Number()` 在 22 位以上溢出成 1e22/
 *     Infinity 而误收,`Number.isSafeInteger` 又会在 16~19 位误拒);
 *   - **路径前缀保持原文转义**(2026-09-17 修复轮 2,端点):`/%2e%2e/1` 的 ingest
 *     端点是 `/%2e%2e/api/1/store/` —— 与 SDK 的 `getBaseApiEndpoint`(path 取自原始
 *     串)一致,也不会把 `../` 交给 HTTP 客户端去规范化;
 *   - **路径前缀里不许有 `?`/`#`**(2026-09-17 修复轮 5,r4v 复核):接受面不只是
 *     "SDK 解析得了",还要"SDK 真发得出去"。`/1?x=/2`、`/1#/2` 这类 makeDsn 能成功,
 *     但拼出的 envelope URL 被 @sentry/node 的 `new URL(...)` 按 `?`/`#` 截断,
 *     实际请求的 pathname 丢掉 `/api/<项目ID>/envelope/` 段(连带 sentry_key)⇒ 拒;
 *   - **userinfo 与 host 按位置分别判定**(2026-09-17 修复轮 2):Go 的
 *     `net/url.validUserinfo` 是正向白名单(≥0x80 与 `<` `>` `"` `[` `]` 全拒),
 *     host 则只查 ASCII 空白/控制与 `` ` `` `{` `}` `|` `\` `^`;
 *   - **去首尾空白与客户端同口径**(2026-09-17 修复轮 2):用 ECMAScript 的
 *     `String.trim()`(客户端 `initSentry` 用的就是它),Go 侧镜像同一集合;
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
/** 显式端口为空(`host:` / `[::1]:`;2026-09-17,S10-2 修复轮 2)。 */
export const DSN_EMPTY_PORT_MESSAGE =
  '错误上报 DSN 的端口不能为空(: 后面必须跟 1-65535 的数字,不用端口就整个省略):客户端 Sentry SDK 解析不了空端口,保存后一个事件都发不出去'
/** 协议大小写(`HTTPS://`;2026-09-17,S10-2 修复轮 2)。 */
export const DSN_SCHEME_CASE_MESSAGE =
  '错误上报 DSN 的协议必须小写(http:// 或 https://):客户端 Sentry SDK 只接受小写协议,HTTPS:// 会被判为非法,保存后一个事件都发不出去'
/** 公钥/私钥字符集不在 SDK 正则内(2026-09-17,S10-2 修复轮 2)。 */
export const DSN_KEY_CHARS_MESSAGE =
  "错误上报 DSN 的公钥(与可选的私钥)只能是字母、数字或下划线:客户端 Sentry SDK 的正则是 \\w,含 '-'、'.'、'%' 等字符或 userinfo 里多出的 '@' 都会让 SDK 解析失败,保存后一个事件都发不出去"
export const DSN_KEY_MESSAGE = '错误上报 DSN 缺少公钥(格式:{协议}://{公钥}@{主机}/{项目ID})'
export const DSN_PROJECT_MESSAGE = '错误上报 DSN 的项目 ID 必须是正整数(格式:{协议}://{公钥}@{主机}/{项目ID})'
/**
 * `?`/`#` 出现在项目 ID 段之前(即落在路径前缀里);2026-09-17,S10-2 修复轮 5。
 *
 * 修复轮 3 把项目 ID/前缀放宽成 authority 之后的整段剩余(含 query/fragment)以对齐
 * SDK 的 `split('/').pop()`,但那只保证"SDK 解析得了",不保证"事件送得到":
 * `https://key@host/1?x=/2` 让 SDK 的 path 变成 `1?x=`、项目 ID 变成 2,基端点拼成
 * `https://host/1?x=/api/2/envelope/?sentry_key=…`;@sentry/node 的 `transports/http.js`
 * 是 `new URL(options.url)` 后发 `pathname+search` —— pathname 只剩 `/1`,查询串里的
 * `/api/2/envelope/` 对路由不可见,`sentry_key` 一并被吞。保存仍回 200 {ok:true},
 * 后台永远空白(= S10-2 要消灭的"零上报假绿")。
 */
export const DSN_PROJECT_QUERY_MESSAGE =
  '错误上报 DSN 的 ? 或 # 出现在最后一个 / 之前:客户端 SDK 会把 ? / # 之后的内容当成项目 ID,拼出的请求路径里 /api/{项目ID}/envelope/ 段会被查询串/锚点吞掉(连带 sentry_key),保存后一个事件都发不出去;请删掉 ? / # 及其后的内容,或把它挪到项目 ID 之后'
/** 长度上限(2026-09-17,S12-02:此前 TS 侧没有上限判定,Go 侧另有专文案)。 */
export const DSN_TOO_LONG_MESSAGE =
  '错误上报 DSN 过长(上限 2048 字符):DSN 只含协议/公钥/主机/项目 ID,正常不会超过这个长度'
/** 主机形态 SDK 解析不了(IDN/IPv6;2026-09-17,S10-2)。 */
export const DSN_UNSUPPORTED_HOST_MESSAGE =
  '错误上报 DSN 的主机名只支持 ASCII 域名或 IPv4 地址:客户端 Sentry SDK 解析不了中文域名(IDN)与 IPv6 字面量,保存后一个事件都发不出去'

/** DSN 长度上限(UTF-8 字节;与 Go `ErrorReportingDSNMaxLength` 同值)。 */
export const DSN_MAX_LENGTH = 2048

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

/**
 * 报告一个点分 IPv4 是否属于"必然不可用"的类别。
 *
 * 逐条对齐 Go:`net.IP.IsLoopback()`(127/8)、`util.IsBlockedOutboundIP`
 * (`IsLinkLocalUnicast` = 169.254/16、`IsLinkLocalMulticast` 的 IPv4 分支
 * **就是 224.0.0.0/24**、`IsUnspecified` = 0.0.0.0)加上 metadata 字面量表。
 * 2026-09-17(S12-02):多播此前完全没实现(Go reject / TS accept),
 * 抽成函数后 IPv4-mapped 解包也能复用同一套规则。
 */
function blockedIPv4(v4: number[]): boolean {
  if (v4[0] === 127) return true // 127.0.0.0/8
  if (v4[0] === 0 && v4[1] === 0 && v4[2] === 0 && v4[3] === 0) return true // unspecified
  if (v4[0] === 169 && v4[1] === 254) return true // 链路本地
  if (v4[0] === 224 && v4[1] === 0 && v4[2] === 0) return true // 链路本地多播(Go 只覆盖 224.0.0.0/24)
  const dotted = v4.join('.')
  return dotted === '169.254.169.254' || dotted === '100.100.100.200' || dotted === '169.254.170.2'
}

/** 报告主机名是否属于"从客户端视角必然不可用"的类别。 */
function blockedHost(host: string): boolean {
  const lowered = host.toLowerCase()
  // RFC 6761:localhost 及其子域一律解析到环回。
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) return true
  if (['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'metadata.azure.com'].includes(lowered)) {
    return true
  }
  const v4 = parseIPv4(lowered)
  if (v4 !== null) return blockedIPv4(v4)
  const v6 = parseIPv6(lowered)
  if (v6 !== null) {
    const isZero = v6.every((b) => b === 0)
    if (isZero) return true // ::
    if (v6.slice(0, 15).every((b) => b === 0) && v6[15] === 1) return true // ::1
    if (hasPrefix(v6, [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10)) return true // fe80::/10
    if (hasPrefix(v6, AWS_IPV6_METADATA, 64)) return true // fd00:ec2::/64
    // 链路本地多播 ff02::/16(Go `net.IP.IsLinkLocalMulticast` 的 IPv6 分支)。
    if (v6[0] === 0xff && v6[1] === 0x02) return true
    // IPv4-mapped(::ffff:a.b.c.d):Go 的 `net.IP.To4()` 会先解包成 IPv4 再判定
    // (实测 [::ffff:100.100.100.200] 在 Go 侧是云 metadata 拒绝),所以这里必须
    // 解包后走**同一套** IPv4 规则(2026-09-17,S12-02)。
    if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) {
      return blockedIPv4([v6[12]!, v6[13]!, v6[14]!, v6[15]!])
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
    // fc00::/7(唯一本地地址)。IPv6 字面量在 sdkParseableHost 已被拒,这条只是
    // Go `net.IP.IsPrivate()` 的镜像,保留以免两侧规则表再漂移。
    return (v6[0]! & 0xfe) === 0xfc
  }
  return false
}

/**
 * 主机名是否是客户端 SDK 能解析的形态(与 Go `sdkParseableErrorReportingDSNHost` 同)。
 *
 * 2026-09-17(S10-2):`@sentry/utils` 的 DSN_REGEX 里 host 组是 `[\w.-]+`(ASCII-only),
 * 含冒号的 IPv6 字面量与 IDN(中文域名/全角写法)都让 makeDsn 返回 undefined,
 * SDK 因此连 transport 都不建、一个事件都发不出去。中文域名的合法部署方式是
 * punycode(`xn--…`)形态。
 */
function sdkParseableHost(host: string): boolean {
  if (host === '' || host.includes(':')) return false
  for (const ch of host) {
    const code = ch.codePointAt(0)!
    const allowed = (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)
      || code === 0x2d /* - */ || code === 0x5f /* _ */ || code === 0x2e /* . */
    if (!allowed) return false
  }
  return true
}

function reject(message: string): ErrorReportingDsnInspection {
  return { verdict: 'reject', message, scheme: '', host: '', projectId: '', publicKey: '', storeEndpoint: '' }
}

/**
 * 字符串的 UTF-8 字节长度。
 *
 * 2026-09-17(S12-02):Go 的长度上限判定是 `len(raw)` —— **字节**数而不是字符数,
 * 所以 TS 侧也必须按字节数,否则含中文域名的超长输入两侧结论会分叉
 * (Go 判"过长"、TS 继续往下走)。这里不用 `TextEncoder`:jsdom 环境未必提供。
 */
function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const ch of value) {
    const code = ch.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
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
  const rawScheme = matched[1]!
  const scheme = rawScheme.toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, message: DSN_SCHEME_MESSAGE }
  // S10-2 修复轮 2(2026-09-17):协议大小写。判定用原文 —— 下发给客户端的是原文,
  // 而 SDK 的 validateDsn 只认小写 protocol(`HTTPS://` ⇒ makeDsn undefined)。
  if (rawScheme !== scheme) return { ok: false, message: DSN_SCHEME_CASE_MESSAGE }
  const authority = matched[2]!
  // 按位置判定(GO 的 validUserinfo 与 encodeHost 规则不同 —— 见函数注释)。
  // 与 Go 一样按**最后一个** '@' 切分(userinfo 里的额外 '@' 留给 SDK 兼容性判定)。
  const at = authority.lastIndexOf('@')
  const userinfo = at < 0 ? '' : authority.slice(0, at)
  const hostport = at < 0 ? authority : authority.slice(at + 1)
  if (userinfoHasUnparsableChar(userinfo) || hostHasUnparsableChar(hostport)) {
    return { ok: false, message: DSN_MALFORMED_MESSAGE }
  }

  let host = ''
  let port = ''
  // 显式冒号但端口为空(`host:` / `[::1]:`;2026-09-17,S10-2 修复轮 2)—— Go 把它
  // 当成"没有端口",SDK 的 `(?::(\d+))?` 却需要数字。
  let emptyPort = false
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']')
    if (close < 0) return { ok: false, message: DSN_MALFORMED_MESSAGE }
    host = hostport.slice(1, close)
    const tail = hostport.slice(close + 1)
    if (tail !== '') {
      if (!tail.startsWith(':')) return { ok: false, message: DSN_MALFORMED_MESSAGE }
      port = tail.slice(1)
      emptyPort = port === ''
    }
  } else {
    const colon = hostport.lastIndexOf(':')
    if (colon >= 0) {
      host = hostport.slice(0, colon)
      port = hostport.slice(colon + 1)
      emptyPort = port === ''
    } else {
      host = hostport
    }
  }
  if (emptyPort) return { ok: false, message: DSN_EMPTY_PORT_MESSAGE }
  // Go `url.Parse` 对非数字端口直接报错(→ 泛化文案);数字端口才继续做范围判定。
  if (port !== '' && !/^[0-9]+$/.test(port)) return { ok: false, message: DSN_MALFORMED_MESSAGE }
  if (port !== '') {
    const value = Number(port)
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
      return { ok: false, message: DSN_PORT_MESSAGE }
    }
  }
  // 主机里的百分号转义按 Go `unescape(host, encodeHost)` 的规则解码(非 ASCII
  // 字节才允许转义),解码后的形态交给后面的形状/SDK 兼容性判定。
  const decodedHost = decodeHostEscapes(host)
  if (decodedHost === null) return { ok: false, message: DSN_MALFORMED_MESSAGE }
  host = decodedHost
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
  // S10-2 修复轮 2(2026-09-17):SDK 的 userinfo 正则 `(\w+)(?::(\w+)?)?@`。必须判
  // **原文**(`url.User.Username()`/`decodeURIComponent` 都会把 `ke%79` 解成 `key`,
  // 而 SDK 看到的是带 `%` 的原文,放行等于保存一个永远零上报的配置)。
  if (!sdkParseableUserinfo(userinfo)) return { ok: false, message: DSN_KEY_CHARS_MESSAGE }
  return { ok: true, value: { publicKey, host, port } }
}

/**
 * userinfo 是否是客户端 SDK 能解析的形状(与 Go `sdkParseableErrorReportingDSNUserinfo` 同)。
 *
 * 2026-09-17(S10-2 修复轮 2):@sentry/utils 的 DSN_REGEX 里 userinfo 组是
 * `(?:(\w+)(?::(\w+)?)?@)`(`\w` = `[A-Za-z0-9_]`,ASCII-only)—— 公钥必须 `\w+`、
 * 可选私钥必须 `\w*`,多一个 '@' 也失配。入参是 DSN 原文里的 userinfo 段。
 */
function sdkParseableUserinfo(userinfo: string): boolean {
  const colon = userinfo.indexOf(':')
  const publicKey = colon < 0 ? userinfo : userinfo.slice(0, colon)
  const secret = colon < 0 ? null : userinfo.slice(colon + 1)
  if (!/^[A-Za-z0-9_]+$/.test(publicKey)) return false
  return secret === null || /^[A-Za-z0-9_]*$/.test(secret)
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
  // 前导 0(且不止一位)= 八进制(WHATWG 同,Go 权威也是 `strconv.ParseUint(label, 8, 64)`)。
  // 2026-09-17(S10-4):非八进制数字(如 08/09)**不能**回落到十进制 —— Go 在这里
  // 解析失败即 reject(`08.0.0.1` 的判定两端曾经相反:TS 放行成 8.0.0.1、Go 拒绝),
  // 页面预检因此对这类输入形同虚设。
  if (label.length > 1 && label.startsWith('0')) {
    if (!/^[0-7]+$/.test(label)) return null
    return Number.parseInt(label, 8)
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
 * 2026-09-17(S10-2):非 ASCII 码位在这里仍然放行 —— 它们由 sdkParseableHost 统一
 * 拒成"SDK 解析不了 IDN/IPv6"的专用文案(比泛化的"不是合法的域名或 IP 地址"
 * 更能说明为什么不工作);中文域名的合法部署方式是 punycode(`xn--…`)形态。 */
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
 * 按**客户端**的口径去首尾空白:原生 `String.prototype.trim()` 就是 ECMAScript 的
 * WhiteSpace + LineTerminator,与客户端 `initSentry` 里的 `dsn.trim()`
 * (packages/host/enterprise/src/error-reporting.ts)逐字同源。
 *
 * 2026-09-17(S10-2 修复轮 2):**不要**改用 Go `strings.TrimSpace` 的集合 —— 它多认
 * U+0085(NEL,ECMAScript 不剥)且不认 U+FEFF(BOM,ECMAScript 剥)。前者的后果是
 * 服务端把带 NEL 的串剥干净入库、客户端 trim 不掉 ⇒ SDK 一条都不发;后者曾让
 * `https://key@host.example/1\uFEFF` 在页面放行、服务端 400。Go 侧现在镜像这个
 * 集合(trimErrorReportingDSN)。
 */
function clientTrim(value: string): string {
  return value.trim()
}

/**
 * `url.Parse` 的字符级拒绝:`net/url` 对**任意位置**的 ASCII 控制字符
 * (0x00-0x1F / 0x7F)直接报 "invalid control character in URL" ⇒ 泛化文案。
 *
 * 2026-09-17(S10-2 修复轮 2):此前 TS 只在 authority 段检查控制字符,路径里的
 * 控制字符会落到"项目 ID 必须是正整数"(判定相同、文案不同);收窄 authority
 * 规则到按位置判定后,这条必须独立出来。
 */
function hasControlByte(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

/**
 * authority 里 Go `url.Parse` 会直接拒绝的字符(→ 泛化"不是合法的 URL"文案)。
 *
 * **按位置拆分**(2026-09-17,S10-2 修复轮 2):Go 的判定在 userinfo 与 host 两个
 * 位置完全不同 —— 收窄成 ASCII-only 时把 userinfo 一起放开了,制造了 14 条
 * "TS accept / Go reject"的新分歧(实测 `https://key\u00A0@host.example/1` 这类)。
 */

/** userinfo:镜像 Go `net/url.validUserinfo` 的**正向白名单**,其余一律拒。
 *
 * Go 的 `validUserinfo` 只放行 `[A-Za-z0-9]` 与 `-._:~!$&'()*+,;=%@`,所以
 * `\u00A0`/U+3000/U+FEFF/中文/emoji(≥0x80)**以及** `<`、`>`、`"`、`[`、`]` 都会让
 * `url.Parse` 报 "invalid userinfo"。 */
function userinfoHasUnparsableChar(userinfo: string): boolean {
  return !/^[A-Za-z0-9\-._:~!$&'()*+,;=%@]*$/.test(userinfo)
}

/** host[:port]:Go `unescape(host, encodeHost)` 拒绝 ASCII 空白与 `` ` `` `{` `}` `|` `\` `^`
 * (≥0x80 的码位它**不**检查 —— 那类由后面的主机形状判定与 SDK 兼容性闸门处理)。 */
function hostHasUnparsableChar(hostport: string): boolean {
  return /[\u0000-\u0020\u007f`{}|\\^]/.test(hostport)
}

/**
 * 按 Go `unescape(host, encodeHost)` 的规则解码主机里的百分号转义。
 *
 * 2026-09-17(S12-02):Go 的规则是"host 里的转义只能用来写非 ASCII 字节" ——
 * 转义必须合法,且首个十六进制位 ≥8(解码后 ≥0x80);只有 IPv6 zone 的 `%25`
 * 例外。`ho%41st` / `ho%20st` 这类编码 ASCII 的写法 Go 直接报
 * "invalid URL escape" ⇒ 泛化的"不是合法的 URL"文案;而 `ho%A0st`
 * (解码出 0xA0 字节)Go 是能解析的,此前的实现一律拒绝任何 `%`,把该值也拒了。
 *
 * @param host - authority 里的主机部分(不含 userinfo,IPv6 不含方括号)。
 * @returns 解码后的主机;违反 Go 规则时 null。
 */
function decodeHostEscapes(host: string): string | null {
  let out = ''
  for (let i = 0; i < host.length; i += 1) {
    const ch = host[i]!
    if (ch !== '%') {
      out += ch
      continue
    }
    const hex = host.slice(i + 1, i + 3)
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
    const byte = Number.parseInt(hex, 16)
    if (byte < 0x80 && `%${hex}` !== '%25') return null
    out += String.fromCharCode(byte)
    i += 2
  }
  return out
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
 * 由 DSN 推导 ingest 端点(与 Go `errorReportingStoreEndpoint` 同)。
 *
 * 2026-09-17(S10-3):字面 IPv6 主机的方括号必须补回 —— 解析阶段用的是裸主机名
 * (`Hostname()` 会剥掉方括号),直接拼接会得到 `https://2001:db8::1/api/1/store/`,
 * 连 Go 自己的 `http.NewRequest` 都构造失败("发送测试事件"永远走不到出站)。
 * 当前 IPv6 已在 SDK 兼容性闸门被拒(S10-2),这里是防御性对齐。
 */
export function buildStoreEndpoint(
  scheme: string,
  host: string,
  port: string,
  prefix: string,
  projectId: string,
): string {
  const bracketed = host.includes(':') ? `[${host}]` : host
  const portPart = port === '' ? '' : `:${port}`
  const prefixPart = prefix === '' ? '' : `/${prefix}`
  return `${scheme}://${bracketed}${portPart}${prefixPart}/api/${projectId}/store/`
}

/**
 * 校验并解析一个错误上报 DSN。空串 = 未启用(允许清空),直接 accept。
 */
export function inspectErrorReportingDsn(raw: string): ErrorReportingDsnInspection {
  // 2026-09-17(S10-2 修复轮 2):与客户端 `initSentry` 同一个 trim(ECMAScript),
  // 见 clientTrim 的注释。
  const trimmed = clientTrim(raw)
  if (trimmed === '') {
    return { verdict: 'accept', message: '', scheme: '', host: '', projectId: '', publicKey: '', storeEndpoint: '' }
  }
  // 长度上限(与 Go `len(raw) > ErrorReportingDSNMaxLength` 同,按 UTF-8 字节数):
  // 先于任何解析,避免用超长输入喂解析器。2026-09-17(S12-02):此前 TS 侧没有上限。
  if (utf8ByteLength(trimmed) > DSN_MAX_LENGTH) return reject(DSN_TOO_LONG_MESSAGE)
  // 控制字符(0x00-0x1F / 0x7F):Go 的 `url.Parse` 在**任何位置**都直接报错
  // ("invalid control character in URL")⇒ 泛化文案,与位置无关。
  if (hasControlByte(trimmed)) return reject(DSN_MALFORMED_MESSAGE)
  const parsed = parseDsnAuthority(trimmed)
  if (!parsed.ok) return reject(parsed.message)
  const { port } = parsed.value

  // 项目 ID 与路径前缀都取**原文剩余**(保留百分号转义),并且必须与 SDK 的
  // dsnFromString 切**同一段**:DSN_REGEX 的 `(.+)` 捕获的是 authority 之后那个 '/'
  // 之后的整段(**query/fragment 在内**),再 `split('/')` 取 pop;端点 path 也来自它。
  // 2026-09-17(S10-2 修复轮 3,r3v 复核):此前只取 '?'/'#' 之前的路径,于是
  // `https://key@host/1?x=/2`、`/1#/2` 在页面记项目 1、客户端 SDK 却记 2。
  const rest = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(trimmed)![3]!
  const pathOnly = rest.split(/[?#]/)[0]!
  const hashAt = rest.indexOf('#')
  const fragment = hashAt < 0 ? '' : rest.slice(hashAt + 1)
  // Go 的 setPath/setFragment 走 unescape(非法转义 ⇒ 解析失败 ⇒ 泛化文案);
  // query 不在此列(Go 不在解析期解码它,语料有对拍)。
  if (hasMalformedEscape(pathOnly) || hasMalformedEscape(fragment)) return reject(DSN_MALFORMED_MESSAGE)
  // SDK 的 `(.+)` 从首个 '/' 之后开始捕获(没有这个 '/' 时整条正则失配 ⇒ undefined),
  // 且 `.` **不匹配行终止符** ⇒ 截断到第一个 \n/\r/U+2028/U+2029。\n\r 已被
  // hasControlByte 拦下,这里真正生效的是 U+2028/U+2029(不截断会与 Go 分歧)。
  let remainder = rest.startsWith('/') ? rest.slice(1) : ''
  const lineTerminator = remainder.search(/[\n\r\u2028\u2029]/)
  if (lineTerminator >= 0) remainder = remainder.slice(0, lineTerminator)
  // 与 `lastPath.split('/')` 同构:末段是空串(`/1/`)⇒ SDK 的 projectId 为 `""`,
  // validateDsn 判缺失 ⇒ 与下方"没有前导数字"一起落到 DSN_PROJECT_MESSAGE。
  const segments = remainder.split('/')
  const projectSegment = segments[segments.length - 1]!
  const prefix = segments.length > 1 ? segments.slice(0, -1).join('/') : ''
  // 2026-09-17(S10-2 修复轮 5,r4v 复核):`?`/`#` 落在路径前缀里 ⇒ 拒。
  // 判据与 Go 的 `splitErrorReportingDSNRemainder`(errErrorReportingDSNProjectQuery)
  // 逐字同构 —— 等价说法:首个 `?`/`#` 出现在**最后一个 '/' 之前**。这类 DSN 的
  // makeDsn 能成功(修复轮 3 因此放行),但 @sentry/node 对新 URL 取
  // `pathname+search` 发请求,pathname 里已不含 `/api/<项目ID>/envelope/`。
  // 项目 ID 段自身带 `?`/`#`(`/1?x=2`)不受影响:那种写法 prefix 为空。
  if (/[?#]/.test(prefix)) return reject(DSN_PROJECT_QUERY_MESSAGE)
  // 前导数字(SDK:`projectId.match(/^\d+/)`);没有前导数字 ⇒ SDK 拿到的 projectId
  // 过不了 `validateDsn` 的 `^\d+$`(`%31`/`+1`/`abc` 都在这条线上被拒)。
  const projectId = /^[0-9]+/.exec(projectSegment)?.[0] ?? ''
  if (projectId === '' || projectIdOutOfRange(projectId)) return reject(DSN_PROJECT_MESSAGE)

  const host = normalizeHost(parsed.value.host)
  if (host === null) {
    return reject(parsed.value.host === '' ? DSN_MALFORMED_MESSAGE : DSN_HOST_MESSAGE)
  }
  if (blockedHost(host)) return reject(DSN_BLOCKED_MESSAGE)
  // 2026-09-17(S10-2):客户端 SDK 可解析性(IDN/IPv6)—— 与 Go 同序:blocked 在前,
  // 环回/metadata 的 IPv6 写法仍给出更准确的"不能指向本机"文案。
  if (!sdkParseableHost(host)) return reject(DSN_UNSUPPORTED_HOST_MESSAGE)

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(trimmed)![1]!.toLowerCase()
  const warnings: string[] = []
  if (scheme === 'http') warnings.push(DSN_PLAIN_HTTP_MESSAGE)
  if (privateHost(host)) warnings.push(DSN_PRIVATE_MESSAGE)

  return {
    verdict: warnings.length > 0 ? 'warn' : 'accept',
    message: warnings.join('；'),
    scheme,
    host,
    projectId,
    publicKey: parsed.value.publicKey,
    storeEndpoint: buildStoreEndpoint(scheme, host, port, prefix, projectId),
  }
}

/** 路径/片段里是否有非法百分号转义(Go 的 `unescape` 会直接报错)。 */
function hasMalformedEscape(value: string): boolean {
  return /%(?![0-9a-fA-F]{2})/.test(value)
}

/**
 * 项目 ID 是否超出 Go `strconv.ParseInt(digits, 10, 64)` 的范围(或为 0)。
 *
 * 2026-09-17(S10-2 修复轮 2,P3):此前用 `Number(projectId) > 0` —— 22 位以上会
 * 溢出成 `1e22`、1900 位变成 `Infinity`,两者都 `> 0`,于是页面放行而服务端
 * (`strconv.Atoi` 溢出)拒绝。改用 BigInt 精确比较 int64 上界(TS 的
 * `Number.isSafeInteger` 只到 2^53,会在 16-19 位区间误拒服务端接受的 ID)。
 */
function projectIdOutOfRange(digits: string): boolean {
  const value = BigInt(digits)
  return value <= 0n || value > 9223372036854775807n
}

/** 保存前校验:不通过时返回可直接展示的中文提示。 */
export function validateErrorReportingDsn(raw: string): { ok: true } | { ok: false; message: string } {
  const inspection = inspectErrorReportingDsn(raw)
  if (inspection.verdict === 'reject') return { ok: false, message: inspection.message }
  return { ok: true }
}
