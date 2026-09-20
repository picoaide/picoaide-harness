#!/usr/bin/env node
/**
 * 客户/部署域名**前向守卫**（2026-09-20 新增）。
 *
 * ## 为什么需要它
 *
 * `AGENTS.md` 早写明「真实客户/部署域名与主机名**永不**出现」——但此前**只有人工
 * `git grep`**，而且那条规则自己的示例写法把真实域名写进了条文，于是"自检"永远命中
 * 规则自己，等于没有守卫。历史提交信息里也真的进过客户域名与预发/生产主机名。
 * 本脚本把那条规则变成**判据**：改仓库里任何文件、写任何提交信息，都不可能再悄悄带进一个
 * 未登记的域名。
 *
 * ## 判据（白名单式：**未登记的 host 一律报错**）
 *
 *   1. `git ls-files` 的每个已跟踪文件里，所有 `https?://<host>` 的 host（**对 TLD 无限制**）；
 *   2. 裸主机名形态（没有协议前缀的 `label(.label)+.TLD`，TLD 受 `BARE_ALWAYS_TLDS` 约束）；
 *   3. URL authority 里的公网 IPv4（私有/保留/文档网段与已登记地址之外的一律报错）；
 *   4. **提交信息**：`git log <base>..HEAD --format=%B`（base 取不到时退化为最近 1 条并打印提示）。
 *
 * 判据 1 是主判据（精确、零假设）；判据 2 补"没有协议前缀的值位"（`DOMAIN=<host>`、
 * `"server_url": "<host>"`、文档表格与正文里的裸主机名）；
 *
 * **范围声明（认账，不假装全覆盖）**：IPv6 字面量、非 ASCII（IDN）域名、以及"冷门 TLD 的
 * 无协议裸值位"不在判据内。判据 1 对 TLD 无限制，所以这些东西一旦以 URL 形态出现仍然会被拦。
 *
 * ## 两条硬约束
 *
 * - **守卫自身不得内嵌任何客户域名**（否则它变成新的泄漏点）：本文件的合成样串一律
 *   **运行时拼接**（见 `selfTest`），示例一律用 `example.com` 保留命名空间。
 * - **输出默认脱敏**：CI 日志是公开的，守卫若把命中的 host 原样打在日志里，等于换了个
 *   地方泄漏（本仓已有"外部命令输出必须先捕获、脱敏、再打印"的先例）。本地排障用
 *   `--unmasked`。
 *
 * ## 白名单怎么加
 *
 * `ALLOWED_DOMAINS` 是**登记式**白名单，按分组写明理由（分组名即理由）。**新增外部域名
 * 必须显式登记理由**；客户自有域名、被投递/测试环境主机名**一律不得登记**——正确处置是
 * 把该域名从仓库里移除（渠道/客户身份属于私有仓 `picoaide/channels`）。
 *
 * 用法：node scripts/check-no-real-domains.mjs [--root <dir>] [--unmasked] [--json]
 *                                            [--selftest] [--no-commit-range]
 * 退出码：0 = 零命中；1 = 有命中（含自证失败）；2 = 用法错误。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// 白名单（集中在这一处；分组名即"登记理由"）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按分组登记的**注册域**（允许其全部子域）。写注册域而不是逐个 host，是为了让
 * 依赖/文档类第三方域名只占一行。
 *
 * 新增条目 = 一次显式决定：写明它属于哪一组、为什么与客户身份无关。
 * **客户自有域名、被投递/测试环境主机名不得登记**（那类域名要先从仓库移除）。
 */
const ALLOWED_DOMAINS = {
  // 本产品公开面（官网、更新服务器、公开仓）。
  '本产品公开面': [
    'picoaide.com',
  ],
  // 保留命名空间（RFC 2606/6761）：`example.com`、`.test`、`.invalid`、`.localhost`
  // 以及内网后缀 `.local` / `.internal` 由 SPECIAL_SUFFIXES 兜住，这里只列其余变体。
  '占位符与保留变体': [
    'example.cn', 'example.org.cn', 'example.co.uk',
  ],
  // 代码托管 / 包管理 / 构建分发（依赖与 CI 的公开面）。
  '代码托管与包管理': [
    'github.com', 'githubusercontent.com', 'githubassets.com', 'github.io',
    'npmjs.org', 'npmjs.com', 'npmmirror.com', 'yarnpkg.com', 'nodejs.org',
    'ghcr.io', 'docker.io', 'docker.com', 'gitlab.com', 'shields.io',
    'star-history.com', 'opencollective.com', 'tidelift.com', 'patreon.com', 'polar.sh',
  ],
  // 语言/规范/文档（第三方规范与库文档）。
  '语言规范与第三方文档': [
    'w3.org', 'ecma-international.org', 'tc39.es', 'yaml.org', 'gnu.org', 'opensource.org',
    'contributor-covenant.org', 'wikipedia.org', 'mozilla.org', 'schema.org', 'sqlite.org',
    'golang.org', 'go.dev', 'gopkg.in', 'google.golang.org', 'modernc.org', 'uber.org',
    'mongodb.org', 'rsc.io', 'rust-lang.org', 'crates.io', 'python.org', 'pypi.org',
    'electronjs.org', 'chromium.org', 'developer.chrome.com', 'code.visualstudio.com',
    'microsoft.com', 'visualstudio.com', 'aka.ms', 'vercel.com', 'astro.build', 'netlify.com',
    'cloudflare.com', 'cloudflare-dns.com', 'mermaid.js.org', 'langium.org', 'chevrotain.io',
    'lodash.com', 'underscorejs.org', 'jquery.org', 'openjsf.org', 'feross.org',
    'marijnhaverbeke.nl', 'paulmillr.com', 'engelschall.com', 'pinstripes.io', 'koishi.chat',
    'tldrlegal.com', 'stackoverflow.com', 'bugzilla.mozilla.org', 'creativecommons.org',
    'iana.org', 'sentry.io',
    'agent-plugins.org', 'shadcn.com', 'app.nextchat.dev', 'nextchat.dev', 'quantumnous.com',
  ],
  // 模型/推理服务商与可观测服务（产品内置目录、定价表、渠道同步面会合法引用）。
  '模型与推理服务商': [
    'deepseek.com', 'openai.com', 'anthropic.com', 'claude.com', 'x.ai', 'z.ai',
    'google.com', 'google.dev', 'googleapis.com', 'googleblog.com', 'google.internal',
    'azure.com', 'azuremarketplace.microsoft.com', 'amazon.com', 'amazonaws.com',
    'alibabacloud.com', 'aliyun.com', 'volcengine.com', 'tencentcloud.com', 'tencent.com',
    'mistral.ai', 'fireworks.ai', 'moonshot.ai', 'kimi.ai', 'together.ai', 'sambanova.ai',
    'nebius.com', 'openrouter.ai', 'deepgram.com', 'elevenlabs.io', 'cerebras.ai', 'groq.com',
    'perplexity.ai', 'cohere.com', 'deepinfra.com', 'meta.ai', 'meta.com', 'bfl.ai',
    'recraft.ai', 'runwayml.com', 'reducto.ai', 'soniox.com', 'wandb.ai', 'langfuse.com',
    'litellm.ai', 'lunary.ai', 'newapi.pro', 'publicai.co', 'libertai.io', 'aimlapi.com',
    'anyscale.com', 'nscale.com', 'ovh.net', 'tensormesh.ai', 'artificialanalysis.ai',
    'darkbloom.dev', 'databricks.com', 'oracle.com', 'exa.ai',
  ],
  // 产品内置连接器/集成所指向的第三方 SaaS 公开端点（官网文档同样公开列出）。
  '第三方集成公开端点': [
    'xiaoshouyi.com', 'feishu.cn', 'qq.com', 'dingtalk.com', 'glitchtip.com',
    'deepwiki.com', 'cloud.google.com', 'mcp.cloudflare.com', 'cloudflarestorage.com',
  ],
  // 主机解析 / SSRF 测试语料里的 token（对抗输入被拆碎后的残片，不是任何人的域名）。
  '畸形语料与占位主机（对抗输入残片）': [
    'mple.com', 'ample.com', 'tmple.com', 'nmple.com', 'ple.com', 'e.com', 'u200bmple.com',
    'u00adholder.com', 'u200bholder.com', 'xn--exmple-cua.com', 'xn--fsqu00a.xn--fiqs8s',
    'your-domain.com', 'your.domain.com', 'x.changeme.com', 'host.com', 'secret.com',
    'todo.com', 'mytest.com', 'localhost.net', 'electron.net', 'git.selfhost.com',
    'metadata.goog', 'alias.co', 'acme.com', 'site.com',
  ],
  // 代码标识符假阳性（**不是主机名**）：`.org` 恰好与 `cfg` 配置对象的属性同名，
  // 本仓实测唯一一处（`scripts/glitchtip-ops-check.mjs` 的 `cfg.org`）。
  '代码标识符假阳性（非主机名）': [
    'cfg.org',
  ],
  // 安全测试夹具里长期使用的**真实注册域名**（与任何客户无关，仅作"外部主机"占位）。
  '安全测试夹具（与客户无关）': [
    'evil.com', 'evil.net', 'real.com', 'self.com', 'localhost.com', 'mycompany.com',
    'placeholder.com', 'x.com', 'baidu.com', 'gvt1.com',
  ],
}

/**
 * 后缀白名单：命中即放行（用于保留命名空间与"任意子域都算占位符"的命名空间）。
 * 之所以按后缀而不是注册域：`a.example`、`harness.example` 这类占位符的"注册域"就是
 * 保留字 `example` 本身，按注册域匹配会漏。
 */
const SPECIAL_SUFFIXES = [
  'example', 'example.com', 'example.cn', 'example.org', 'example.net', 'example.org.cn',
  'test', 'invalid', 'localhost', 'local', 'internal',
]

/**
 * 裸形态（没有 `https://` 前缀的主机名）**只扫与代码标识符无冲突的 TLD**。
 *
 * 为什么不全扫：裸 token 的绝大多数命中是代码标识符/属性链/文件名，而不是主机名 ——
 * 本仓实测 `rect.top`、`logger.info`、`c.in`、`assets.store`、`d.auth.me`、`node.cy`、
 * `r.group`、`defaults.run`、`comment.id`、`ci-channels.sh`、`PicoAide Harness.app`
 * 分别把 `.top` `.info` `.in` `.store` `.me` `.cy` `.group` `.run` `.id` `.sh` `.app`
 * 这些真实 TLD 变成了假红（合计 200+ 处）。给每个冲突 token 开豁免等于把白名单养肥，
 * 那正是本仓已登记的"假绿"模式之一。
 *
 * 所以裸形态只覆盖**客户/部署域名最常见的落点**：`.com` `.net` `.org` `.cn` `.vip`
 * `.xyz` `.tech` `.io` `.co` `.cc` `.tv` `.gg`（`.sh`/`.app` 因脚本扩展名与 macOS
 * 应用包扩展名冲突，裸形态也不扫）。其余 TLD 的裸形态**不扫**——它们的真实使用形态是
 * URL，由判据 1 覆盖（判据 1 对 TLD 没有任何限制）。代价认账：`server_url: x.acme.dev`
 * 这种"无协议 + 冷门 TLD"的裸值位抓不到。
 */
const BARE_ALWAYS_TLDS = new Set(['com', 'net', 'org', 'cn', 'vip', 'xyz', 'tech', 'io', 'co', 'cc', 'tv', 'gg'])

/** 公网 IPv4 白名单（文档/测试里长期使用的公共地址；保留与私有网段见 ipv4Allowed）。 */
const ALLOWED_PUBLIC_IPS = new Set([
  '8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', // 公共 DNS
  '1.2.3.4', // 文档/测试里最常用的"随便一个公网地址"
  '93.184.216.34', // example.com 的公开地址（文档/夹具引用它当"真实主机"）
  '100.100.100.200', // 云厂商元数据服务（SSRF 测试夹具的合法目标）
  '198.20.0.1', // 反代/端口扫描类测试夹具
  // 保留网段的**边界值**：SSRF/netguard 用例专门拿它们测"刚好在网段外一格的邻居"。
  '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '128.0.0.1',
  // IP 规范化用例的输入/期望值（八进制、去前导零后的形态）。
  '8.0.0.1', '1.0.0.0',
])

// ─────────────────────────────────────────────────────────────────────────────
// 扫描实现
// ─────────────────────────────────────────────────────────────────────────────

const MULTI_LABEL_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'co.uk', 'org.uk', 'ac.uk', 'co.jp', 'com.au',
  'com.br', 'com.tw', 'co.kr', 'com.hk', 'com.sg', 'co.in', 'com.mx', 'co.za', 'com.tr',
  'co.nz', 'co.il', 'pages.dev',
])

/** 裸主机名 token（`label(.label)+.TLD`；词边界避免切进更长的标识符）。 */
const HOST_TOKEN = /(?<![A-Za-z0-9_@$%.:-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+([A-Za-z]{2,24}))(?![A-Za-z0-9_-])/gu
/** URL authority（到 `/`、空白或引号为止；userinfo/端口在调用处剥掉）。 */
const URL_AUTHORITY = /https?:\/\/([^\s/?#"'`<>\\|]+)/gu

function registrableDomain(host) {
  const parts = host.split('.')
  if (parts.length < 2) return host
  const two = parts.slice(-2).join('.')
  return MULTI_LABEL_SUFFIXES.has(two) && parts.length >= 3 ? parts.slice(-3).join('.') : two
}

function matchesAllowedDomain(host) {
  for (const group of Object.values(ALLOWED_DOMAINS)) {
    for (const entry of group) {
      if (host === entry || host.endsWith(`.${entry}`)) return true
    }
  }
  return false
}

function isAllowedHost(host) {
  if (SPECIAL_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return true
  if (matchesAllowedDomain(host)) return true
  return matchesAllowedDomain(registrableDomain(host))
}

function isIpv4(token) {
  const parts = token.split('.')
  if (parts.length !== 4) return false
  return parts.every(part => part.length > 0 && part.length <= 3 && Number(part) <= 255 && String(Number(part)) === part)
}

/** 统一放行判定：IP 看网段白名单，域名看登记白名单 + 保留命名空间。 */
function isAllowedCandidate(candidate) {
  return candidate.kind === 'ip' ? ipv4Allowed(candidate.host) : isAllowedHost(candidate.host)
}

/** 私有/保留/文档/基准测试网段 —— 这些出现在仓库里没有客户身份含义。 */
function ipv4Allowed(ip) {
  if (ALLOWED_PUBLIC_IPS.has(ip)) return true
  const [a, b] = ip.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 192 && b === 0) return true // IETF 协议专用（含 TEST-NET-1 192.0.2.0/24）
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试 198.18.0.0/15
  if (a === 198 && b === 51) return true // TEST-NET-2
  if (a === 203 && b === 0) return true // TEST-NET-3
  if (a === 224 || a === 239 || a === 240 || a === 255) return true // 组播/保留/广播
  return false
}

/** 把一段自由文本里所有"看起来是主机名且未登记"的 token 就地脱敏（提交信息摘要用）。 */
function maskHostsInText(text) {
  return text.replace(HOST_TOKEN, (match, host) => (isAllowedHost(String(host).toLowerCase()) ? match : maskHost(host)))
}

/** 脱敏：TLD 保留（它不承载客户身份），其余标签各留前 2 字符。 */
function maskHost(host) {
  const labels = host.split('.')
  return labels
    .map((label, index) => {
      if (index === labels.length - 1) return label
      return label.length <= 2 ? `${label[0]}*` : `${label.slice(0, 2)}****`
    })
    .join('.')
}

/** 合法主机名形状（标签 + 字母 TLD）——用来把畸形语料（`example.123`、`example.com%00`）挡在 URL 判据外。 */
const HOSTNAME_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/u

/**
 * 单行里所有"候选 host"（含判定理由），供两个判据共用。
 *
 * IP 只从 **URL authority** 取：裸的 `1.0.0.0` 在本仓是版本号（实测 `publish-app.spec.ts`
 * 与 `registry_test.go` 各一处），裸 IPv4 判据会把版本号刷成假红；而部署机 IP 的真实
 * 出现形态就是 URL（`https://<ip>/…`、`server_url=https://<ip>`），URL 判据足够。
 *
 * @returns {Array<{ host: string, why: string, index: number, kind: 'host'|'ip' }>}
 */
function candidatesInLine(line) {
  const found = []
  for (const match of line.matchAll(URL_AUTHORITY)) {
    // `/([^\s/?#"'`<>\\|]+)/` 的捕获可能带尾随标点（`(https://example.org)`）、
    // IPv6 方括号、userinfo、端口、百分号编码 —— 逐段收敛到 host。
    let raw = match[1]
    if (raw.startsWith('[')) continue // IPv6 字面量：本守卫只判域名（见头注释的范围声明）
    raw = raw.match(/^[A-Za-z0-9._~%+@:-]*/u)?.[0] ?? ''
    const authority = (raw.split('@').pop() ?? '').replace(/\.+$/u, '')
    const host = authority.split(':')[0].toLowerCase()
    if (host === '') continue
    if (isIpv4(host)) found.push({ host, why: 'URL', index: match.index, kind: 'ip' })
    else if (HOSTNAME_SHAPE.test(host)) found.push({ host, why: 'URL', index: match.index, kind: 'host' })
  }
  for (const match of line.matchAll(HOST_TOKEN)) {
    const host = match[1].toLowerCase()
    const tld = match[2].toLowerCase()
    if (!BARE_ALWAYS_TLDS.has(tld)) continue
    if (isIpv4(host)) continue
    if (line[match.index - 1] === '{') continue // 模板插值 `${cfg.org}`：那是变量，不是主机名
    // 多段**公共后缀**自身不是主机名：本文件的 `MULTI_LABEL_SUFFIXES` 语料逐条列出
    // `.com.cn`/`.org.cn` 这类两段式后缀，而 `HOST_TOKEN` 会把 `org.cn` 读成
    // `label=org` + `TLD=cn` ⇒ 守卫扫自己就红了（2026-09-20 实测 EXIT=1）。
    // 这不是豁免：带真实标签的三段式主机名（`<label>` + 两段后缀）仍照常命中。
    if (MULTI_LABEL_SUFFIXES.has(host)) continue
    found.push({ host, why: '裸主机名', index: match.index, kind: 'host' })
  }
  return found
}

function candidatesInText(text, file) {
  const lines = text.split('\n')
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.includes('.')) continue
    const seen = new Set()
    for (const candidate of candidatesInLine(line)) {
      const key = `${candidate.kind}:${candidate.host}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ ...candidate, file, line: index + 1 })
    }
  }
  return found
}

function trackedFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 })
    return out.split('\0').filter(Boolean)
  } catch (error) {
    console.error(`check-no-real-domains: 读不到 ${root} 的已跟踪文件（\`git ls-files\` 失败）：${error.message}`)
    process.exit(2)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 自证（防假绿）：合成样串一律运行时拼接，源码里不出现完整客户域名
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 自证走的是**与扫描完全同一套** candidatesInLine/isAllowedCandidate，
 * 不是另写一份"看起来对"的判断 —— 否则自证绿了、守卫本身坏了也看不出来。
 *
 * @returns {string[]} 失败原因（空数组 = 通过）
 */
function selfTest() {
  const failures = []
  const [a, b, c, d, e] = ['har', 'ness.', 'mo', 'kahr', '.vip']
  const syntheticHost = `${a}${b}${c}${d}${e}` // 运行时拼接，源码里没有完整域名
  const syntheticUrl = `https://${syntheticHost}/updates/manifest`
  const syntheticIp = ['101', '42', '228', '128'].join('.')
  const expect = (condition, message) => { if (!condition) failures.push(message) }

  // 负例 1（URL）：合成客户域名必须被判红（URL 判据与裸主机名判据都会命中，故断言"至少一条且来自 URL"）。
  const urlHits = candidatesInLine(syntheticUrl).filter(hit => !isAllowedCandidate(hit))
  expect(
    urlHits.some(hit => hit.host === syntheticHost && hit.why === 'URL'),
    `合成 URL 负例未被判红：${syntheticUrl}`,
  )

  // 负例 2（裸主机名，值位）：`DOMAIN=<host>` 形态必须被判红。
  const bareHits = candidatesInLine(`DOMAIN=${syntheticHost}`).filter(hit => !isAllowedCandidate(hit))
  expect(bareHits.some(hit => hit.host === syntheticHost), `合成裸主机名负例未被判红：${syntheticHost}`)

  // 负例 3（公网 IPv4）：被投递环境 IP 必须被判红（IP 只在 URL authority 里判，见 candidatesInLine 注释）。
  const ipHits = candidatesInText(`server_url = https://${syntheticIp}/api`, 'deploy.sh')
    .filter(hit => !isAllowedCandidate(hit))
  expect(ipHits.some(hit => hit.host === syntheticIp), `合成公网 IP 负例未被判红：${syntheticIp}`)

  // 负例 4（提交信息路径）：同一条合成串在 message 扫描里也必须红。
  const messageHits = candidatesInText(`deploy: point client at ${syntheticHost}`, 'COMMIT_EDITMSG')
    .filter(hit => !isAllowedCandidate(hit))
  expect(messageHits.length >= 1, '合成提交信息负例未被判红')

  // 负例 5（守 2026-09-20 新加的「多段公共后缀自身不是主机名」跳过规则）：两段式后缀
  // 本身不再判红（否则守卫扫到自己的 `MULTI_LABEL_SUFFIXES` 语料就红，实测 EXIT=1），
  // **但带真实标签的三段式主机名必须照旧判红** —— 判据不能靠"新规则看起来只跳过后缀"，
  // 必须实测两个方向；串一律运行时拼接（与上面同样的理由：源码里不留完整域名）。
  const cnSuffixBare = ['com', '.cn'].join('')
  const cnHostBare = ['inn', 'er.', cnSuffixBare].join('')
  expect(
    candidatesInLine(`suffix ${cnSuffixBare}`).length === 0,
    `多段公共后缀自身被误判为主机名：${cnSuffixBare}`,
  )
  const cnHits = candidatesInLine(`DOMAIN=${cnHostBare}`).filter(hit => !isAllowedCandidate(hit))
  expect(cnHits.some(hit => hit.host === cnHostBare), `多段后缀下的三段式主机名被误放过：${cnHostBare}`)

  // 正例：白名单域与保留命名空间必须绿（否则守卫会把合法改动拦下来）。
  for (const host of ['harness.example.com', 'app.example.com', 'example.com', 'picoaide.com', 'release.picoaide.com', 'github.com', 'api.github.com', 'registry.npmjs.org', 'api.deepseek.com', 'a.test', 'metadata.google.internal', 'sub.localhost', 'doc.example']) {
    expect(isAllowedHost(host), `白名单域被误判为违规：${host}`)
  }
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '172.16.0.1', '203.0.113.7', '198.51.100.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '8.8.8.8', '1.1.1.1']) {
    expect(ipv4Allowed(ip), `保留/文档网段被误判为公网：${ip}`)
  }

  // 正例：属性链/标识符/畸形语料不得被当成主机名（"裸形态只扫无冲突 TLD + 跳过模板插值"）。
  for (const line of [
    'const y = rect.top - 1',
    'logger.info("x")',
    'value := c.in',
    'this.store.set(k, v)',
    'payload.user.name',
    'key: `${node.cx}-${node.cy}`',
    '# defaults.run.working-directory 已是 server/',
    'comment_id: comment.id,',
    'hostcap.callAIChat 与 capapi.AI 接口',
    '${cfg.org}/${cfg.project}/keys/',
    'curl --resolve x.<DOMAIN>:443:<IP> https://x.<DOMAIN>/',
    'PicoAide Harness.app/Contents/Resources/',
  ]) {
    const hits = candidatesInLine(line).filter(hit => !isAllowedCandidate(hit))
    expect(hits.length === 0, `代码属性链被误判为主机名：${line} ⇒ ${hits.map(hit => hit.host).join(',')}`)
  }

  // 白名单自证：条目不得重复（重复 = 悄悄加第二条理由的空间）、不得带通配/协议/大写。
  const seen = new Set()
  for (const [group, entries] of Object.entries(ALLOWED_DOMAINS)) {
    for (const entry of entries) {
      expect(!seen.has(entry), `白名单条目重复登记：${entry}`)
      seen.add(entry)
      expect(/^[a-z0-9.-]+$/u.test(entry), `白名单条目形状不合法（不得含通配/协议/大写）：${entry}（分组 ${group}）`)
    }
  }

  // 脱敏自证：命中输出不得原样回显 host。
  const masked = maskHost(syntheticHost)
  expect(!masked.includes(d), `脱敏输出仍含原始标签：${masked}`)
  expect(masked.endsWith(e), `脱敏输出应保留 TLD：${masked}`)
  return failures
}

// ─────────────────────────────────────────────────────────────────────────────
// 提交信息判据
// ─────────────────────────────────────────────────────────────────────────────

function commitRangeFindings(root, unmasked, notes) {
  const findings = []
  // base 候选：CI 的 PR base 优先（GitHub 只给分支名，需要拼 `origin/`），再退化到常见主线。
  const candidates = []
  const envBase = process.env.GITHUB_BASE_REF?.trim()
  if (envBase) candidates.push(`origin/${envBase}`, envBase)
  candidates.push('origin/master', 'origin/main', 'master', 'main')
  let base = null
  for (const candidate of candidates) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { cwd: root, stdio: 'ignore' })
      base = candidate
      break
    } catch {
      // 继续找下一个候选
    }
  }

  const collect = (args, label) => {
    let raw = ''
    try {
      raw = execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    } catch {
      notes.push(`提交信息检查跳过：\`git ${args.join(' ')}\` 不可用（可能不是 git 工作区或 base 不存在）`)
      return 0
    }
    const parts = raw.split('\0')
    let commits = 0
    for (let index = 0; index + 2 < parts.length; index += 3) {
      const sha = parts[index].trim()
      if (sha === '') continue
      commits += 1
      // 摘要里也可能直接写着域名 ⇒ 必须与 host 字段一起脱敏（file 判据不打印行内容，天然安全）。
      const subject = unmasked ? parts[index + 1] : maskHostsInText(parts[index + 1])
      const body = parts[index + 2]
      for (const hit of candidatesInText(body, 'COMMIT_EDITMSG')) {
        if (isAllowedCandidate(hit)) continue
        findings.push({
          scope: 'commit',
          where: `${sha.slice(0, 10)} ${subject.trim().slice(0, 80)}`,
          host: unmasked ? hit.host : maskHost(hit.host),
          why: hit.why,
          line: hit.line,
        })
      }
    }
    if (findings.length === 0) notes.push(`提交信息区间 ${label} 已检查（${commits} 条提交，0 命中）`)
    return commits
  }

  if (base !== null) {
    const range = `${base}..HEAD`
    const count = collect(['log', '--format=%H%x00%s%x00%B%x00', range], range)
    // `base == HEAD`（CI 上 push 到 master 时 actions/checkout 就是这个形态）⇒ 区间为空，
    // 但"刚推上去的那条提交"正需要检查 ⇒ CI 下退化为只查 HEAD 一条。
    if (count === 0 && (process.env.GITHUB_ACTIONS || process.env.CI)) {
      notes.push(`base(${base}) 与 HEAD 相同（push 到主线的典型形态）⇒ 追加检查 HEAD 这一条提交信息`)
      collect(['log', '-1', '--format=%H%x00%s%x00%B%x00', 'HEAD'], 'HEAD~0')
    }
    return findings
  }

  notes.push('取不到 base（origin/master 等均不可用）⇒ 退化为只检查最近 1 条提交信息')
  collect(['log', '-1', '--format=%H%x00%s%x00%B%x00', 'HEAD'], 'HEAD~0')
  return findings
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
let root = resolve(process.cwd())
let unmasked = false
let json = false
let selftestOnly = false
let skipCommitRange = false
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--root') {
    const value = argv[index + 1]
    if (value === undefined) {
      console.error('check-no-real-domains: --root 需要一个目录')
      process.exit(2)
    }
    root = resolve(value)
    index += 1
  } else if (arg === '--unmasked') unmasked = true
  else if (arg === '--json') json = true
  else if (arg === '--selftest') selftestOnly = true
  else if (arg === '--no-commit-range') skipCommitRange = true
  else {
    console.error(`check-no-real-domains: 未知参数 ${arg}`)
    process.exit(2)
  }
}

const selfTestFailures = selfTest()
if (selfTestFailures.length > 0) {
  for (const failure of selfTestFailures) console.error(`  [SELFTEST] ${failure}`)
  console.error('\n守卫自证失败 ⇒ 守卫本身不可信（可能已被改坏或白名单被滥用）。修好它再谈扫描结果。')
  process.exit(1)
}
if (selftestOnly) {
  console.log('check-no-real-domains: 自证通过（合成负例被判红、白名单域与保留网段判绿）✅')
  process.exit(0)
}

const notes = []
const findings = []
let scanned = 0
for (const file of trackedFiles(root)) {
  const absolute = resolve(root, file)
  let text
  try {
    text = readFileSync(absolute, 'utf8')
  } catch {
    continue // 子模块 gitlink / 已被删除但仍在索引里
  }
  if (text.includes('\0')) continue // 二进制
  scanned += 1
  for (const hit of candidatesInText(text, file)) {
    if (isAllowedCandidate(hit)) continue
    findings.push({
      scope: 'file',
      where: `${relative(root, absolute)}:${hit.line}`,
      host: unmasked ? hit.host : maskHost(hit.host),
      why: hit.why,
      line: hit.line,
    })
  }
}

if (!skipCommitRange) findings.push(...commitRangeFindings(root, unmasked, notes))

if (json) {
  console.log(JSON.stringify({ root, scanned, findings, notes }, null, 2))
} else {
  console.log(`check-no-real-domains: 扫描 ${scanned} 个已跟踪文件（root=${root}）`)
  for (const note of notes) console.log(`  · ${note}`)
}

if (findings.length > 0) {
  const shown = findings.slice(0, 150)
  for (const finding of shown) {
    console.error(`  [DOMAIN] ${finding.where}: ${finding.host}（${finding.why}；原串已脱敏，本地排障加 --unmasked）`)
  }
  if (findings.length > shown.length) console.error(`  … 另有 ${findings.length - shown.length} 处未打印`)
  console.error(`\n未登记的域名/主机名 ${findings.length} 处。处置：把该域名从仓库里移除（占位符用 \`example.com\`、`
    + '环境变量、或私有仓 `picoaide/channels`）；确属第三方依赖/文档的公开域名，才在 '
    + '`scripts/check-no-real-domains.mjs` 的 `ALLOWED_DOMAINS` 里**按分组登记理由**。'
    + '客户自有域名与被投递/测试环境主机名一律不得登记。')
  process.exit(1)
}

if (!json) console.log('check-no-real-domains: 零命中 ✅')
