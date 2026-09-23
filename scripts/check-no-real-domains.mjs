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
 *   4. **提交信息**：`git log <base>..HEAD --format=%B`。base 的解析顺序与"取不到 base"
 *      时的处置写在 `resolveCommitBase` / `commitRangeFindings` 的头注释里 —— 2026-09-23
 *      审计 R3-C C-4：CI gate 的 depth-1 检出曾让这条判据**恒为空跑**（解析不到 base ⇒
 *      退化成"只看 HEAD"= PR 上那条 merge commit，中间提交信息里的域名看不见，而输出
 *      照打 `零命中 ✅`）。
 *
 * 判据 1 是主判据（精确、零假设）；判据 2 补"没有协议前缀的值位"（`DOMAIN=<host>`、
 * `"server_url": "<host>"`、文档表格与正文里的裸主机名）；
 *
 * **范围声明（认账，不假装全覆盖）**：IPv6 字面量、非 ASCII（IDN）域名、以及"冷门 TLD 的
 * 无协议裸值位"不在判据内。判据 1 对 TLD 无限制，所以这些东西一旦以 URL 形态出现仍然会被拦。
 *
 * ## 两条硬约束
 *
 * - **守卫自身不得内嵌任何客户域名**（否则它变成新的泄漏点）：本文件的负例语料一律
 *   **运行时随机生成**（`syntheticHostname` / `syntheticPublicIpv4`，见 `selfTest`），
 *   示例一律用 `example.com` 保留命名空间与 RFC 5737 文档网段。**运行时拼接不算豁免**
 *   （2026-09-23 审计 G-9：拼接真实串仍然把字符串逐段留在了公开仓源码里）。
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
 * 退出码：0 = 零命中；1 = 有命中（含自证失败）；2 = 用法错误；
 *         3 = **判据没能完成**（提交信息区间看不到历史，或**扫描面为 0 个文件**）——
 *             这不是"零命中"，处置见 `commitRangeFindings` 与主流程的 emptySurface 分支。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * 本守卫的扫描面：**已跟踪 + 未跟踪且未被忽略**的文件。
 *
 * 为什么必须是这个口径（2026-09-23 三轮审计 R3-C C-5）：`AGENTS.md` 把本守卫写成
 * 「改任何含渠道/域名/URL 的文件或写提交信息**之前**，先跑」，而旧实现只读
 * `git ls-files`（= 只扫索引）—— 作者按那句话在 `git add` **之前**跑，新建文件对守卫
 * 根本不存在，得到"零命中 ✅"，下一步 `git add -A && git commit` 就把域名带进公开历史。
 * 同仓的 `check-no-leftover-mutants.mjs` 早就用 `--cached --others --exclude-standard`
 * 处理过同一个时机（变异体被 `git add -A` 扫进提交的真实事故），所以这不是取舍而是漏改。
 *
 * `--exclude-standard` 让 `.gitignore` / `.git/info/exclude` 里的本地产物照旧不被扫
 * （它们不可能进提交，扫了只会制造误报）。
 * @param root - 仓库根（或任意目录）。
 * @returns 相对路径列表。
 */
function trackedFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 30,
    })
    return out.split('\0').filter(Boolean)
  } catch (error) {
    console.error(`check-no-real-domains: 读不到 ${root} 的扫描面（\`git ls-files --cached --others\` 失败）：${error.message}`)
    process.exit(2)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 自证（防假绿）：负例语料一律**运行时随机生成**的合成目标
//
// 为什么是"随机生成"而不是"写死一个假串"、更不是"拼接一个真串"：
//   - 写死的假串迟早会撞上某个真实注册（或被人当成"这就是那个客户域名"的证据）；
//   - 拼接真串（旧实现，2026-09-23 审计 G-9）**只是骗过守卫自己的扫描**，
//     字符串仍然逐段存在于公开仓源码里 —— 四段十进制 IP 更是明文数字字面量。
//     `AGENTS.md` 铁律 0 对此没有豁免：任何位置、任何形态都不允许。
//   - 负例真正需要的性质只有两条：**必然未登记**、**公网形态**。随机标签 + 显式
//     断言"不在允许集合内"恰好给出这两条，且每次运行的目标都不同。
// ─────────────────────────────────────────────────────────────────────────────

/** 合成负例用的随机标签（源码里没有完整域名/IP，只有一个 8 位十六进制片段）。 */
function syntheticLabel() {
  return `audit-${randomUUID().replace(/-/gu, '').slice(0, 8)}`
}

/**
 * 合成主机名：随机标签 + 一个**非保留、非白名单**的 TLD（`.com`）。
 *
 * 每次运行都不同 ⇒ 必然未登记；`.com` 不在 `SPECIAL_SUFFIXES`（RFC 2606/6761）
 * 也不在 `ALLOWED_DOMAINS` ⇒ 必须被判红。
 *
 * @returns {string} 形如 `<随机标签>.com`（源码里不留任何可直接匹配的主机名 token）
 */
function syntheticHostname() {
  return `${syntheticLabel()}.com`
}

/**
 * 合成公网形态 IPv4：循环随机抽样直到 `!ipv4Allowed(ip)`。
 *
 * 负例要的是"一个公网形态且不在允许集合内的地址"，不需要（也不允许）任何真实
 * 地址。抽样上限只是防死循环 —— 命中保留/登记网段的概率极低（256 次全中的概率
 * 可以忽略），真的耗尽时返回 `null`，调用处的断言会 fail-loud 而不是悄悄放行。
 *
 * @returns {string|null} 公网形态地址；抽样耗尽时为 null。
 */
function syntheticPublicIpv4() {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const octets = [
      1 + Math.floor(Math.random() * 223), // 1..223：跳过 0/224+（"本网络"/组播/保留/广播）
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      1 + Math.floor(Math.random() * 254), // 1..254：避开 .0/.255 形态
    ]
    const candidate = octets.join('.')
    if (!ipv4Allowed(candidate)) return candidate
  }
  return null
}

/**
 * 自证走的是**与扫描完全同一套** candidatesInLine/isAllowedCandidate，
 * 不是另写一份"看起来对"的判断 —— 否则自证绿了、守卫本身坏了也看不出来。
 *
 * @returns {string[]} 失败原因（空数组 = 通过）
 */
function selfTest() {
  const failures = []
  const syntheticHost = syntheticHostname()
  const syntheticUrl = `https://${syntheticHost}/updates/manifest`
  const syntheticIp = syntheticPublicIpv4()
  const expect = (condition, message) => { if (!condition) failures.push(message) }

  // 语料前置断言：负例必须"必然未登记/不在允许集合内"，否则判据会变成假绿
  // （白名单放行）或假红（守卫判对了、用例判错了）。
  expect(!isAllowedHost(syntheticHost), `合成主机名落进了白名单（随机标签撞车）：${syntheticHost}`)
  expect(
    syntheticIp !== null && !ipv4Allowed(syntheticIp),
    `未能在 256 次抽样内生成"不在允许集合内的公网形态地址"：${String(syntheticIp)}`,
  )

  // 负例 1（URL）：合成客户域名必须被判红（URL 判据与裸主机名判据都会命中，故断言"至少一条且来自 URL"）。
  const urlHits = candidatesInLine(syntheticUrl).filter(hit => !isAllowedCandidate(hit))
  expect(
    urlHits.some(hit => hit.host === syntheticHost && hit.why === 'URL'),
    `合成 URL 负例未被判红：${syntheticUrl}`,
  )

  // 负例 2（裸主机名，值位）：`DOMAIN=<host>` 形态必须被判红。
  const bareHits = candidatesInLine(`DOMAIN=${syntheticHost}`).filter(hit => !isAllowedCandidate(hit))
  expect(bareHits.some(hit => hit.host === syntheticHost), `合成裸主机名负例未被判红：${syntheticHost}`)

  // 负例 3（公网 IPv4）：随机生成的公网形态地址必须被判红（IP 只在 URL authority
  // 里判，见 candidatesInLine 注释）。地址是随机的、且上面已断言不在允许集合内。
  if (syntheticIp !== null) {
    const ipHits = candidatesInText(`server_url = https://${syntheticIp}/api`, 'deploy.sh')
      .filter(hit => !isAllowedCandidate(hit))
    expect(ipHits.some(hit => hit.host === syntheticIp), `合成公网 IP 负例未被判红：${syntheticIp}`)
  }

  // 负例 4（提交信息路径）：同一条合成串在 message 扫描里也必须红。
  const messageHits = candidatesInText(`deploy: point client at ${syntheticHost}`, 'COMMIT_EDITMSG')
    .filter(hit => !isAllowedCandidate(hit))
  expect(messageHits.length >= 1, '合成提交信息负例未被判红')

  // 负例 5（守 2026-09-20 新加的「多段公共后缀自身不是主机名」跳过规则）：两段式后缀
  // 本身不再判红（否则守卫扫到自己的 `MULTI_LABEL_SUFFIXES` 语料就红，实测 EXIT=1），
  // **但三段式主机名必须照旧判红** —— 判据不能靠"新规则看起来只跳过后缀"，必须实测
  // 两个方向；标签同样是随机生成的合成标签（与上面同样的理由：不留任何真实身份）。
  const cnSuffixBare = ['com', '.cn'].join('')
  const cnHostBare = `${syntheticLabel()}.${cnSuffixBare}`
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

  // 脱敏自证：命中输出不得原样回显 host（本轮语料是随机的，就用本轮的随机标签当判据）。
  const masked = maskHost(syntheticHost)
  const syntheticFirstLabel = syntheticHost.split('.')[0]
  expect(!masked.includes(syntheticFirstLabel), `脱敏输出仍含原始标签：${masked}`)
  expect(masked !== syntheticHost, `脱敏输出与原始 host 相同：${masked}`)
  expect(masked.endsWith('.com'), `脱敏输出应保留 TLD：${masked}`)
  return failures
}

/**
 * 自证：**文件扫描面**的端到端行为（2026-09-23 三轮审计 R3-C C-5 / 六处形态③ 的回归判据）。
 *
 * 为什么必须端到端（spawn 真进程 + 真 git 仓库）：C-5 的失效形态是"守卫照样打印
 * `零命中 ✅`、照样 exit 0"，判据只能钉在**退出码**与**那句 ✅ 出不出现**上 ——
 * 把 `trackedFiles` 的 `--others` 去掉这种改法在任何纯函数层面都看不出来。
 *
 * 五个样本（合成仓库建在系统临时目录、跑完删；域名一律 `syntheticLabel()` 运行时生成）：
 *   ① 已跟踪文件里带合成域名        → EXIT=1（对照：这一形态本来就该红）
 *   ② **未跟踪且未被忽略**的新文件   → EXIT=1（C-5 本体：旧实现 EXIT=0 + 零命中 ✅）
 *   ③ 未跟踪但**被 .gitignore 忽略** → EXIT=0 且打印 `零命中`（证明排除表仍被尊重）
 *   ④ 空 git 仓库（扫描面 0）        → EXIT=3 且**不打印** `零命中 ✅`（六处形态③ 本体）
 *   ⑤ 干净仓库（只有占位符域名）      → EXIT=0 且打印 `零命中`（正例：正常流程不被判红）
 *
 * 子进程带 `SELFTEST_CHILD_ENV=1`（避免自证递归）。
 *
 * @returns 自证失败项列表（空 = 通过）。
 */
function selfTestScanSurface() {
  const failures = []
  const expect = (ok, message) => {
    if (!ok) failures.push(message)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'cnrd-surface-'))
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'guard-selftest',
    GIT_AUTHOR_EMAIL: 'guard-selftest@example.invalid',
    GIT_COMMITTER_NAME: 'guard-selftest',
    GIT_COMMITTER_EMAIL: 'guard-selftest@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const runGuard = target => spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--root', target, '--no-commit-range'],
    {
      encoding: 'utf8',
      env: { ...process.env, [SELFTEST_CHILD_ENV]: '1', GITHUB_EVENT_PATH: '', GITHUB_BASE_REF: '', GITHUB_ACTIONS: '', CI: '' },
    },
  )
  /** 建一个只有 `keep.txt` 的已提交仓库，返回其路径。 */
  const buildRepo = (dir, extra) => {
    mkdirSync(dir)
    git(dir, ['init', '-q', '-b', 'main', '.'])
    writeFileSync(join(dir, 'keep.txt'), 'clean\n')
    if (extra !== undefined) extra(dir)
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'init'])
  }
  const host = syntheticHostname()
  try {
    const tracked = join(scratch, 'tracked')
    buildRepo(tracked, dir => writeFileSync(join(dir, 'README.md'), `server_url = https://${host}/api\n`))
    const trackedCase = runGuard(tracked)
    expect(trackedCase.status === 1, `样本①（已跟踪文件带域名）应为 EXIT=1，实得 ${trackedCase.status}`)
    expect((trackedCase.stderr ?? '').includes('[DOMAIN]'), '样本① 没有报出已跟踪文件里的域名')

    const untracked = join(scratch, 'untracked')
    buildRepo(untracked)
    writeFileSync(join(untracked, 'new-note.md'), `server_url = https://${host}/api\n`)
    const untrackedCase = runGuard(untracked)
    expect(untrackedCase.status === 1,
      `样本②（**未跟踪未忽略**的新文件带域名）应为 EXIT=1（C-5 本体），实得 ${untrackedCase.status}`
      + `\n    stdout: ${(untrackedCase.stdout ?? '').trim().split('\n').slice(-2).join(' | ')}`)
    expect((untrackedCase.stderr ?? '').includes('[DOMAIN]'), '样本② 没有报出未跟踪文件里的域名（扫描面仍只覆盖索引）')
    expect(!(untrackedCase.stdout ?? '').includes('零命中'), '样本② 有命中时不得打印 `零命中 ✅`')

    const ignored = join(scratch, 'ignored')
    buildRepo(ignored, dir => writeFileSync(join(dir, '.gitignore'), 'local-only/\n'))
    mkdirSync(join(ignored, 'local-only'))
    writeFileSync(join(ignored, 'local-only', 'scratch.md'), `server_url = https://${host}/api\n`)
    const ignoredCase = runGuard(ignored)
    expect(ignoredCase.status === 0,
      `样本③（未跟踪但被 .gitignore 忽略）应为 EXIT=0（排除表必须被尊重），实得 ${ignoredCase.status}`
      + `\n    stderr: ${(ignoredCase.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`)
    expect((ignoredCase.stdout ?? '').includes('零命中'), '样本③ 应打印 `零命中`')

    const empty = join(scratch, 'empty')
    mkdirSync(empty)
    git(empty, ['init', '-q', '-b', 'main', '.'])
    const emptyCase = runGuard(empty)
    expect(emptyCase.status === 3,
      `样本④（空 git 仓库 = 扫描面 0）应为 EXIT=3（fail-loud），实得 ${emptyCase.status}`
      + `\n    stdout: ${(emptyCase.stdout ?? '').trim().split('\n').slice(-2).join(' | ')}`)
    expect(!(emptyCase.stdout ?? '').includes('零命中'), '样本④ 扫描面为 0 时**不得**打印 `零命中 ✅`')
    expect((emptyCase.stderr ?? '').includes('扫描面为'), '样本④ 的处置说明应点名"扫描面为 0 个文件"')

    const clean = join(scratch, 'clean')
    buildRepo(clean, dir => writeFileSync(join(dir, 'README.md'), 'server_url = https://harness.example.com/api\n'))
    const cleanCase = runGuard(clean)
    expect(cleanCase.status === 0, `样本⑤（干净仓库）应为 EXIT=0，实得 ${cleanCase.status}`
      + `\n    stderr: ${(cleanCase.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`)
    expect((cleanCase.stdout ?? '').includes('零命中'), '样本⑤ 完成检查时应打印 `零命中`')
  } catch (error) {
    failures.push(`扫描面自证的夹具构建失败：${error?.message ?? String(error)}`)
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判据结论
    }
  }
  return failures
}

/**
 * 自证：**提交信息区间判据的端到端行为**（2026-09-23 审计 R3-C C-4 的回归判据）。
 *
 * 为什么必须端到端（spawn 真进程）而不是只断言内部函数：C-4 的失效形态恰恰是
 * "守卫照样打印 `零命中 ✅`、照样 exit 0" —— 判据只能钉在**退出码**与**那句 ✅ 出不出
 * 现**上；把 fail-loud 改成"打一条 note"这种改法在内部函数层面看起来完全正常。
 *
 * 五个样本（合成仓库建在系统临时目录、跑完删；域名一律 `syntheticLabel()` 运行时
 * 生成，不进本文件源码 ⇒ 守卫自己也不会被自己判红）：
 *   ① 完整克隆 + 干净提交          → EXIT=0 且打印 `零命中`（正例：合法历史不能被判红）
 *   ② 完整克隆 + **中间**提交带域名 → EXIT=1（区间判据真的看得见中间那些提交）
 *   ③ depth-1 克隆 + CI 环境       → EXIT=3 且**不打印** `零命中 ✅`（C-4 本体：
 *      解析不到 base 时不许静默退化成"只看 HEAD"）
 *   ④ depth-1 克隆 + 无 CI 环境    → EXIT=3（同一处置，CI 检测不是逃生门）
 *   ⑤ 完整克隆但候选 ref 全被删掉  → EXIT=1（无 base 时退化为"全部可达提交"，是超集）
 *   ⑥ 事件载荷给的 base 必须真的被用上（这一对样本互相反证）：
 *      ⑥a 无任何 ref + `GITHUB_EVENT_PATH` 指向 base ⇒ 区间 = base..HEAD ⇒
 *         base **之前**那条带域名的提交**不该**被报（EXIT=0）；
 *      ⑥b 同一个仓库、不给事件载荷 ⇒ 退化为"全部可达提交" ⇒ 它**必须**被报（EXIT=1）。
 *      也就是说：把 `eventPayloadBaseSha` 从候选里删掉，⑥a 立刻变红。
 *
 * 子进程带 `SELFTEST_CHILD_ENV=1`（避免自证递归）。
 *
 * @returns 自证失败项列表（空 = 通过）。
 */
function selfTestCommitRange() {
  const failures = []
  const expect = (ok, message) => {
    if (!ok) failures.push(message)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'cnrd-selftest-'))
  // 隔离宿主 git 配置：自证要能在任何机器（含 CI/沙箱）上跑，不依赖 ~/.gitconfig。
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'guard-selftest',
    GIT_AUTHOR_EMAIL: 'guard-selftest@example.invalid',
    GIT_COMMITTER_NAME: 'guard-selftest',
    GIT_COMMITTER_EMAIL: 'guard-selftest@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const runGuard = (target, extraEnv) => spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--root', target],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        [SELFTEST_CHILD_ENV]: '1',
        // 逐样本显式给定，避免宿主环境（真 CI 的 GITHUB_* / 事件载荷）污染判据。
        GITHUB_EVENT_PATH: '',
        GITHUB_BASE_REF: '',
        GITHUB_ACTIONS: '',
        CI: '',
        ...extraEnv,
      },
    },
  )
  /**
   * 造一个"main → feature/x，两条提交"的合成 origin。
   * `middleMessage` 非空时，**中间那条**提交的信息带该串（文件内容始终干净 ⇒
   * 命中的必然是提交信息判据，不是 file 判据）。
   */
  const buildOrigin = (dir, middleMessage) => {
    mkdirSync(dir)
    git(dir, ['init', '-q', '-b', 'main', '.'])
    writeFileSync(join(dir, 'README.md'), 'base\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'base: init'])
    git(dir, ['checkout', '-q', '-b', 'feature/x'])
    writeFileSync(join(dir, 'note.txt'), 'x\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', middleMessage])
    writeFileSync(join(dir, 'note2.txt'), 'y\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'clean: follow-up commit'])
  }
  try {
    const cleanOrigin = join(scratch, 'origin-clean')
    buildOrigin(cleanOrigin, 'feat: middle commit without any host')
    const dirtyOrigin = join(scratch, 'origin-dirty')
    buildOrigin(dirtyOrigin, `deploy: point client at ${syntheticLabel()}.com`)

    const cleanFull = join(scratch, 'clean-full')
    const dirtyFull = join(scratch, 'dirty-full')
    const dirtyShallow = join(scratch, 'dirty-shallow')
    const dirtyOrphan = join(scratch, 'dirty-orphan')
    git(scratch, ['clone', '-q', '--branch', 'feature/x', `file://${cleanOrigin}`, cleanFull])
    git(scratch, ['clone', '-q', '--branch', 'feature/x', `file://${dirtyOrigin}`, dirtyFull])
    git(scratch, ['clone', '-q', '--depth', '1', '--branch', 'feature/x', `file://${dirtyOrigin}`, dirtyShallow])
    git(scratch, ['clone', '-q', '--branch', 'feature/x', `file://${dirtyOrigin}`, dirtyOrphan])
    // ⑤：完整克隆但把全部候选 ref（本地分支 + 远程跟踪）删掉 ⇒ resolveCommitBase 返回 null，
    // 而"不是浅克隆"这条退路必须仍然看见那条带域名的中间提交。
    git(dirtyOrphan, ['checkout', '-q', '--detach'])
    for (const ref of git(dirtyOrphan, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']).split('\n')) {
      const name = ref.trim()
      if (name !== '') git(dirtyOrphan, ['update-ref', '-d', name])
    }

    const cleanCase = runGuard(cleanFull, {})
    expect(cleanCase.status === 0, `样本①（完整克隆 + 干净提交）应为 EXIT=0，实得 ${cleanCase.status}`
      + `\n    stderr: ${(cleanCase.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`)
    expect((cleanCase.stdout ?? '').includes('零命中'), '样本① 完成检查时应打印 `零命中`')
    expect(!(cleanCase.stderr ?? '').includes('[DOMAIN]'), '样本① 干净历史被判出域名命中')

    const dirtyCase = runGuard(dirtyFull, {})
    const dirtyCaseAgain = runGuard(dirtyFull, {})
    expect(dirtyCase.status === 1, `样本②（完整克隆 + 中间提交带域名）应为 EXIT=1，实得 ${dirtyCase.status}`)
    expect((dirtyCase.stderr ?? '').includes('[DOMAIN]'), '样本② 没有报出提交信息里的域名')
    expect(!(dirtyCase.stdout ?? '').includes('零命中'), '样本② 有命中时不得打印 `零命中 ✅`')
    // 同一条样本跑两次：随机语料每次都不同，结论必须一致（防"只对某一次的随机标签生效"）。
    expect(dirtyCaseAgain.status === dirtyCase.status, '样本② 两次运行的结论不一致（判据依赖了随机语料）')

    const ciShallow = runGuard(dirtyShallow, { GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' })
    expect(ciShallow.status === 3, `样本③（depth-1 + CI）应为 EXIT=3（fail-loud），实得 ${ciShallow.status}`
      + `\n    stdout: ${(ciShallow.stdout ?? '').trim().split('\n').slice(-2).join(' | ')}`)
    expect(!(ciShallow.stdout ?? '').includes('零命中'), '样本③ 区间不可解析时**不得**打印 `零命中 ✅`（C-4 的失效形态）')
    expect((ciShallow.stderr ?? '').includes('fetch-depth'), '样本③ 的处置说明里应给出 CI 的修法（fetch-depth: 0）')
    expect((ciShallow.stderr ?? '').includes('--no-commit-range'), '样本③ 的处置说明里应给出显式逃生门（--no-commit-range）')

    const localShallow = runGuard(dirtyShallow, {})
    expect(localShallow.status === 3, `样本④（depth-1 + 非 CI）应为 EXIT=3，实得 ${localShallow.status}`)
    expect(!(localShallow.stdout ?? '').includes('零命中'), '样本④ 区间不可解析时不得打印 `零命中 ✅`')

    const orphanCase = runGuard(dirtyOrphan, {})
    expect(orphanCase.status === 1, `样本⑤（完整克隆 + 无任何候选 ref）应为 EXIT=1（退化为全部可达提交），实得 ${orphanCase.status}`)
    expect((orphanCase.stderr ?? '').includes('[DOMAIN]'), '样本⑤ 退化为"全部可达提交"后仍应报出域名')

    // ⑥：事件载荷（GitHub PR 的 pull_request.base.sha）必须真的被用上。
    // 夹具：base 那条提交**自己**带域名（在区间之外），区间内的提交干净。
    const eventOrigin = join(scratch, 'origin-event')
    mkdirSync(eventOrigin)
    git(eventOrigin, ['init', '-q', '-b', 'main', '.'])
    writeFileSync(join(eventOrigin, 'README.md'), 'base\n')
    git(eventOrigin, ['add', '-A'])
    git(eventOrigin, ['commit', '-q', '-m', 'base: init'])
    writeFileSync(join(eventOrigin, 'legacy.txt'), '1\n')
    git(eventOrigin, ['add', '-A'])
    git(eventOrigin, ['commit', '-q', '-m', `old: legacy client at ${syntheticLabel()}.com`])
    const eventBaseSha = git(eventOrigin, ['rev-parse', 'HEAD']).trim()
    git(eventOrigin, ['checkout', '-q', '-b', 'feature/x'])
    writeFileSync(join(eventOrigin, 'current.txt'), '2\n')
    git(eventOrigin, ['add', '-A'])
    git(eventOrigin, ['commit', '-q', '-m', 'clean: current work'])
    writeFileSync(join(eventOrigin, 'later.txt'), '3\n')
    git(eventOrigin, ['add', '-A'])
    git(eventOrigin, ['commit', '-q', '-m', 'clean: follow-up'])
    const eventClone = join(scratch, 'event-orphan')
    git(scratch, ['clone', '-q', '--branch', 'feature/x', `file://${eventOrigin}`, eventClone])
    git(eventClone, ['checkout', '-q', '--detach'])
    for (const ref of git(eventClone, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']).split('\n')) {
      const name = ref.trim()
      if (name !== '') git(eventClone, ['update-ref', '-d', name])
    }
    const eventPath = join(scratch, 'event.json')
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: eventBaseSha } } }))

    const eventCase = runGuard(eventClone, { GITHUB_EVENT_PATH: eventPath, GITHUB_ACTIONS: 'true', GITHUB_BASE_REF: 'main' })
    expect(eventCase.status === 0, `样本⑥a（事件载荷给了 base）应为 EXIT=0（base 之前的提交在区间之外），实得 ${eventCase.status}`
      + `\n    stderr: ${(eventCase.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ')}`)
    expect(!(eventCase.stderr ?? '').includes('[DOMAIN]'), '样本⑥a 把 base 之前那条提交也报了 ⇒ 事件载荷给的 base 没被用上')
    const noEventCase = runGuard(eventClone, {})
    expect(noEventCase.status === 1, `样本⑥b（同一仓库但不给事件载荷）应退化为"全部可达提交"并 EXIT=1，实得 ${noEventCase.status}`)
    expect((noEventCase.stderr ?? '').includes('[DOMAIN]'), '样本⑥b 退化扫描没有报出 base 之前那条带域名的提交（夹具失去判别力）')
  } catch (error) {
    failures.push(`区间判据自证的夹具构建失败：${error?.message ?? String(error)}`)
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判据结论
    }
  }
  return failures
}

/**
 * 解析"提交信息区间"的 base（2026-09-23 审计 R3-C C-4 重写）。解析不到返回 null。
 *
 * 为什么重写：这条判据原先只有"`GITHUB_BASE_REF` 派生 + 主线名"两条路径，而 CI 的
 * gate checkout 是 depth-1（`ci.yml` 的 checkout 没有 `fetch-depth`）⇒ 四个候选
 * **全部解析失败**，于是它静默退化成"只看 HEAD"（PR 上就是那条 merge commit），
 * 中间那些提交信息里的域名一个都看不见。实测同一份历史：完整克隆 EXIT=1、
 * depth-1 克隆 EXIT=0 且打印 `零命中 ✅`。
 *
 * 解析顺序（前一条能解析就用）：
 *   1. **GitHub 事件载荷里的 sha**（PR = `pull_request.base.sha`，push = `before`）。
 *      它不依赖 ref 是否存在，只要对象在本地（`fetch-depth: 0` 保证在）——这是唯一
 *      能在 PR 上稳定拿到 base 的路径：PR 检出的 ref 是 `refs/pull/N/merge`，
 *      `origin/<base>` 往往根本不存在。
 *   2. `GITHUB_BASE_REF` 派生的四个 ref 形态。
 *   3. 常见主线 ref（origin/master / origin/main / master / main）。
 *
 * @param root - 仓库根。
 * @param notes - 输出用的提示收集器。
 * @returns 可用的 base（commit-ish）或 null。
 */
function resolveCommitBase(root, notes) {
  const candidates = []
  const eventSha = eventPayloadBaseSha(notes)
  if (eventSha !== null) candidates.push(eventSha)
  const envBase = process.env.GITHUB_BASE_REF?.trim()
  if (envBase) {
    candidates.push(`origin/${envBase}`, `refs/remotes/origin/${envBase}`, envBase, `refs/heads/${envBase}`)
  }
  candidates.push('origin/master', 'origin/main', 'master', 'main')
  for (const candidate of candidates) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { cwd: root, stdio: 'ignore' })
      return candidate
    } catch {
      // 继续找下一个候选
    }
  }
  return null
}

/**
 * 从 GitHub 事件载荷里取 base sha（PR: `pull_request.base.sha`；push: `before`）。
 * 读不到 / 形状不合法 / 全零（新建分支的 push）都返回 null，由调用方继续走别的候选。
 * @param notes - 输出用的提示收集器。
 * @returns sha 字符串或 null。
 */
function eventPayloadBaseSha(notes) {
  const path = process.env.GITHUB_EVENT_PATH?.trim()
  if (!path) return null
  let payload
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    notes.push(`读不到 GitHub 事件载荷（${path}）⇒ 该路径这次不能提供 base`)
    return null
  }
  for (const sha of [payload?.pull_request?.base?.sha, payload?.before]) {
    if (typeof sha !== 'string') continue
    const value = sha.trim()
    if (!/^[0-9a-f]{7,40}$/u.test(value) || /^0+$/u.test(value)) continue
    return value
  }
  return null
}

/**
 * 是不是浅检出。`true`/`false`，判不出来返回 `null`（调用方按"不能证明完整"处理）。
 * @param root - 仓库根。
 * @returns 见上。
 */
function isShallowRepository(root) {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim() === 'true'
  } catch {
    return null
  }
}

/** `git log` 的三字段格式（sha / 摘要 / 正文），\0 分隔。 */
const COMMIT_LOG_FORMAT = '--format=%H%x00%s%x00%B%x00'

/**
 * 提交信息判据：返回 `{ findings, fatal }`。
 *
 * `fatal` 非 null = **这条判据没能完成**。"算不出范围"必须与"范围内没问题"分开
 * （2026-09-17 编排器 `--changed` 假绿是同一条原则）；调用方把 fatal 变成 fail-loud
 * 的退出码（3），而不是让 `零命中 ✅` 照打。
 *
 * 没有 base 时的三条处置（判据是"能不能证明覆盖了所有可能带域名的提交"）：
 *   - **非浅检出** ⇒ 扫**从 HEAD 可达的全部提交**。这是任何 `base..HEAD` 的超集，
 *     只会更严、不会漏检（代价是多扫一遍历史）；
 *   - **浅检出（或深浅未知）** ⇒ fatal：历史根本不在本地，任何"零命中"都是假的。
 *     CI 的处置 = gate 的 checkout 补 `fetch-depth: 0`（2026-09-23 起已加）；
 *     本地 = `git fetch --unshallow`；
 *   - 只想扫文件内容 = 显式传 `--no-commit-range`，**不是**静默降级。
 *
 * @param root - 仓库根。
 * @param unmasked - 是否原样打印 host（默认脱敏）。
 * @param notes - 输出用的提示收集器。
 * @returns `{ findings, fatal }`（fatal 为 null = 判据完成）。
 */
function commitRangeFindings(root, unmasked, notes) {
  const findings = []
  const collect = (args, label) => {
    let raw = ''
    try {
      raw = execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    } catch (error) {
      return { error: `\`git ${args.join(' ')}\` 执行失败：${error?.message ?? String(error)}` }
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
    return { commits }
  }

  const base = resolveCommitBase(root, notes)
  if (base !== null) {
    const range = `${base}..HEAD`
    const ranged = collect(['log', COMMIT_LOG_FORMAT, range], range)
    if (ranged.error !== undefined) return { findings, fatal: ranged.error }
    // `base == HEAD`（CI 上 push 到 master 时 actions/checkout 就是这个形态）⇒ 区间为空，
    // 但"刚推上去的那条提交"正需要检查 ⇒ CI 下追加检查 HEAD 一条。
    if (ranged.commits === 0 && (process.env.GITHUB_ACTIONS || process.env.CI)) {
      notes.push(`base(${base}) 与 HEAD 相同（push 到主线的典型形态）⇒ 追加检查 HEAD 这一条提交信息`)
      const single = collect(['log', '-1', COMMIT_LOG_FORMAT, 'HEAD'], 'HEAD~0')
      if (single.error !== undefined) return { findings, fatal: single.error }
    }
    return { findings, fatal: null }
  }

  const shallow = isShallowRepository(root)
  if (shallow === false) {
    notes.push('取不到 base，但该检出不是浅克隆 ⇒ 退化为扫描**从 HEAD 可达的全部提交**'
      + '（任何区间的超集，只会更严不会漏检）')
    const all = collect(['log', COMMIT_LOG_FORMAT, 'HEAD'], 'HEAD 可达的全部提交')
    if (all.error !== undefined) return { findings, fatal: all.error }
    return { findings, fatal: null }
  }

  return {
    findings,
    fatal: '取不到提交信息区间的 base，且该检出是浅克隆'
      + `（shallow=${shallow === null ? '未知（判不出来）' : 'true'}）⇒ 历史根本不在本地，`
      + '"零命中"会是假的。\n'
      + '  处置（三选一）：① CI 里给 gate 的 actions/checkout 补 `fetch-depth: 0`'
      + '（本仓 2026-09-23 起已有，这条就是防它被改回去的判据）；'
      + '② 本地浅克隆执行 `git fetch --unshallow`；'
      + '③ 确实只需要扫文件内容时显式传 `--no-commit-range`（跳过提交信息判据）。',
  }
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

/**
 * 自证子进程标记：`selfTestCommitRange()` 会 spawn 本脚本自己（端到端判据必须钉在
 * 退出码与那句 `零命中 ✅` 上），没有这个标记就会无限递归。**它只跳过"区间判据"
 * 的那段自证，不影响任何域名判据**，而且守卫会在输出里明说这一次自证被跳过
 * （见下面 notes 里的那条）—— 不允许静默。
 */
const SELFTEST_CHILD_ENV = 'CHECK_NO_REAL_DOMAINS_SELFTEST_CHILD'
const selftestChild = process.env[SELFTEST_CHILD_ENV] === '1'

const selfTestFailures = selfTest()
if (!selftestChild) selfTestFailures.push(...selfTestScanSurface())
if (!selftestChild) selfTestFailures.push(...selfTestCommitRange())
if (selfTestFailures.length > 0) {
  for (const failure of selfTestFailures) console.error(`  [SELFTEST] ${failure}`)
  console.error('\n守卫自证失败 ⇒ 守卫本身不可信（可能已被改坏或白名单被滥用）。修好它再谈扫描结果。')
  process.exit(1)
}
if (selftestOnly) {
  console.log('check-no-real-domains: 自证通过（合成负例被判红、白名单域与保留网段判绿'
    + `${selftestChild ? '；区间判据自证因 ' + SELFTEST_CHILD_ENV + '=1 跳过' : '、提交信息区间判据五样本'}）✅`)
  process.exit(0)
}

const notes = []
if (selftestChild) {
  notes.push(`自证子进程（${SELFTEST_CHILD_ENV}=1）⇒ 本次跳过"提交信息区间判据"的那段自证；域名判据不受影响`)
}
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

// 提交信息判据："没能完成"（fatal）与"有命中"是两种不同的红 —— 前者绝不能被
// 当成"零命中"（2026-09-23 审计 R3-C C-4 的失效形态就是这条路径静默降级）。
let commitFatal = null
if (skipCommitRange) {
  notes.push('提交信息判据被 --no-commit-range 显式跳过（只扫文件内容）')
} else {
  const commitScan = commitRangeFindings(root, unmasked, notes)
  findings.push(...commitScan.findings)
  commitFatal = commitScan.fatal
}

if (json) {
  console.log(JSON.stringify({
    root,
    scanned,
    findings,
    notes,
    commitRange: commitFatal === null ? 'checked' : 'incomplete',
    scanSurface: scanned === 0 ? 'empty' : 'checked',
  }, null, 2))
} else {
  console.log(`check-no-real-domains: 扫描 ${scanned} 个文件（已跟踪 + 未跟踪未忽略；root=${root}）`)
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
}

if (commitFatal !== null) {
  console.error(`\ncheck-no-real-domains: 提交信息判据**没能完成**（这不等于"零命中"）：\n  ${commitFatal}`)
}

// 扫描面为 0 = **判据没跑**，不是"零命中"（2026-09-23 三轮审计 R3-C C-5 的第③条：
// 空 git 仓库旧实现打印「扫描 0 个已跟踪文件」+「零命中 ✅」并 EXIT=0）。
// 与 C-4 的提交信息判据同一原则：算不出范围 / 扫不到文件，都必须与"范围内没问题"区分。
const emptySurface = scanned === 0
if (emptySurface) {
  console.error(
    '\ncheck-no-real-domains: 扫描面为 **0 个文件**（root=' + root + '）—— 拒绝把"什么都没扫到"当成"零命中"。\n'
    + '  扫描面 = `git ls-files --cached --others --exclude-standard`（已跟踪 + 未跟踪且未被忽略）。\n'
    + '  落到这里的常见原因：① --root 指到了空仓库/空目录（或不是仓库根）；'
    + '② 检出里一个文本文件都没有（二进制/子模块 gitlink 不算）；\n'
    + '  ③ CI 的 gate checkout 缺 `fetch-depth: 0`（本仓 ci.yml 已带，这条是防它被改回去的判据）。\n'
    + '  处置：确认 root 是仓库根、且工作树里真的有文件；确实只需要扫文件内容时加 `--no-commit-range`。',
  )
}

if (findings.length > 0) process.exit(1)
// 判据没跑完 ⇒ 不许打印"零命中 ✅"（C-4 的失效形态就是这一句 + exit 0）。
if (commitFatal !== null) process.exit(3)
if (emptySurface) process.exit(3)

if (!json) console.log('check-no-real-domains: 零命中 ✅')
