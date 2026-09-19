#!/usr/bin/env node
/**
 * 旧模型零残留扫描（§13 判据 3 的"三分法"，W4 波次的机器判据）。
 *
 * **旧模型**（2026-09-19 定案废弃）= 员工用浏览器打开 `https://<app_id>.<应用基域>/`，
 * 平台用「一次性换票」把身份换成应用子域 Cookie，应用还有一档 `access=public` 匿名面，
 * 服务端 wasm 还能通过 `ai.chat` 调模型。新模型 = 应用只在桌面客户端内、以自定义协议
 * 打开；身份只来自员工 bearer；`access` 只剩 `login|whitelist`；AI 由客户端 AI loop
 * 提供（服务端 `ai.chat` 删除）。
 *
 * 三分法（R1-TST-10 / R2T-4 订正，原实现"过宽/过窄"）：
 *   1. **业务代码必须零命中** ⇒ 任一命中即 exit 1（打印文件:行:内容）；
 *   2. **测试夹具 / 历史文档进显式白名单**（每条规则带理由，命中仍然打印，标 `[WL]`）；
 *   3. **未跟踪文件也要查**（`git grep` 只覆盖已跟踪文件；本仓有并发编辑史）；
 *   4. `git grep` 的 rc≥2（路径不存在 / 正则错）**不得当通过** —— 那是门禁自己坏了。
 *
 * 用法：node scripts/wasm/check-old-model-residue.mjs [--all] [--json <path>]
 * 退出码：0 = 业务代码零命中；1 = 有业务命中或扫描本身失败。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const SHOW_ALL = args.includes('--all')
const JSON_OUT = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
/** 每个分类最多打印多少条命中（--all 时全打）。 */
const PER_CATEGORY_LIMIT = 40

/**
 * 旧模型概念 → 正则（**业务代码零容忍**）。
 * 每条都对应设计文档里的具体删除面，不写"泛化的坏味道"（那种规则会被迫加白名单到失效）。
 */
const CATEGORIES = [
  {
    key: 'app-subdomain',
    label: '旧的应用子域 / 主机门控',
    // 标识符一律加词边界：`SessionMax`/`TicketTTL` 这类短标识符不加边界会命中
    // 无关的复合名（实测 `TicketTTL` 命中 `mfaTicketTTL` —— 那是**管理员 MFA 挑战
    // 票据**，与应用换票毫无关系；R1-L4-2）。
    source: '\\bPICOAI_APPS_BASE_DOMAIN\\b|\\bAPPS_BASE_DOMAIN\\b|\\bapps_base_domain\\b|\\bwasm_apps_base_domain_change\\b|\\bAppsBaseDomain\\b|\\bAppBaseDomain\\b|\\bbaseDomainHolder\\b|\\bBaseDomain\\b|\\bParseBaseDomain\\b|\\bInspectAppBaseDomain\\b|\\bHostGate\\b|\\bhostgate\\b|\\bMatchHost\\b|\\bIsProbePath\\b|\\bSelfOrigin\\b',
  },
  {
    key: 'ticket',
    label: '换票 / 应用会话包',
    source: 'app-ticket|\\bticketURL\\b|\\bTicketPage\\b|\\bTicketSubmit\\b|\\bTicketTTL\\b|\\bAppSessionTTL\\b|\\bSessionMax[A-Za-z]*\\b|\\bWasmSession\\b|\\bapp_sessions\\b|\\bemployee_sessions\\b|\\banonlimit\\b|\\bAnonLimit\\b|\\blegacyAnonymous\\b|\\bwriteRedirectPage\\b|\\bcleanRequestURI\\b|\\bsecureRequest\\b|\\bmainOriginNow\\b|\\btrustedProxiesFromEnv\\b',
  },
  {
    key: 'entry-url',
    label: 'entry_url 入口链接',
    source: '\\bentry_url\\b|\\bEntryURL\\b|\\bEntryUrl\\b',
  },
  {
    key: 'access-public',
    label: '应用源 access=public（匿名面）',
    source: 'access["\']?\\s*[:=]\\s*["\']?public|\\bAccessPublic\\b|\\bdemo-public\\b',
  },
  {
    key: 'server-aichat',
    label: '服务端 ai.chat 能力（改由客户端 AI loop 提供）',
    source: '\\baichat\\b|ai\\.chat|\\bMethodAIChat\\b|\\bcallAIChat\\b|capapi\\.AI\\b|\\bAIChatParams\\b|\\bAIChatResult\\b|\\bAIChatToken\\b|\\bAIChatBudget\\b|\\bAITokenTTL\\b|\\bAITokenRenewBefore\\b',
  },
]

/** 扫描范围：`required` 缺任何一个都算门禁自己坏了（fail loud）。 */
const SCOPES = [
  { path: 'server/internal', required: true },
  { path: 'server/cmd', required: true },
  { path: 'server/webadmin/src', required: true },
  { path: 'server/.env.example', required: true },
  { path: 'server/docker-compose.yml', required: false },
  { path: 'server/Caddyfile.autocert', required: false },
  { path: 'server/Caddyfile.internal', required: false },
  { path: 'server/Caddyfile.manual', required: false },
  { path: 'server/demoapps', required: false },
  { path: 'server/skills/app-builder', required: false },
  { path: 'docs/deploy', required: true },
  { path: 'docs/wasm-app-authoring.md', required: false },
  { path: 'packages/client/wasm-apps/src', required: true },
  { path: 'packages/host/wasm-apps-host/src', required: true },
  // R2-L1-1（2026-09-20 主控裁定）：宿主企业包也持有应用中心面（目录代理 + wasm_app_* 工具），
  // 旧模型的 `entry_url` 曾在这里**活着**（绝对化分支 + 两组 spec 钉成预期）而门禁看不见 ⇒
  // 范围缺口。加入扫描面后 A 桶必须仍为 0（不为它放宽任何预算）。
  { path: 'packages/host/enterprise/src', required: true },
  { path: 'packages/host/browser/src', required: true },
  // 以下只在白名单里出现（历史/权威文档、发布说明、审计留痕）：扫描但不算业务命中。
  { path: 'docs/planning', required: false },
  { path: 'docs/decisions', required: false },
  { path: 'docs/releases', required: false },
]

/**
 * 白名单（**必须带理由**；只允许"测试夹具"与"历史/权威文档"两类，
 * 业务代码一律不可白名单 —— 否则这条判据会退化成"存在性断言"）。
 */
const WHITELIST = [
  { test: /_test\.go$/u, reason: 'Go 测试夹具/历史用例（业务实现不得命中）' },
  { test: /^docs\//u, reason: '文档（部署/作者/发布说明；命中=文案口径问题，不是业务实现）' },
  // 不可变历史迁移（主控 2026-09-19 裁定）：已上线的库都应用过它们 —— 改历史迁移会破坏
  // 部署与幂等，删它更荒谬（drop 由**后续**迁移负责，例如 0073 才 drop 0070 建的表）。
  // ⇒ 归 C（历史制品），但仍然打印，且**新增**迁移会另起一行提示人工复核（见下方 newMigrations）。
  { test: /^server\/internal\/serverstore\/migrations-pg\//u, reason: '不可变历史迁移（已应用；改动破坏幂等）' },
  { test: /\.md$/u, reason: 'Markdown 文档（同上）' },
  { test: /(^|\/)(tests?|__tests__)\//u, reason: '测试目录' },
  { test: /\.spec\.(ts|tsx|mjs|cjs|js)$/u, reason: '前端/Node 测试用例' },
  { test: /\.test\.(ts|tsx|mjs|cjs|js)$/u, reason: '前端/Node 测试用例' },
  { test: /^docs\/planning\/2026-09-17-wasm-app-platform/u, reason: '早期契约（正文已删，仅指针式提及）' },
  { test: /^docs\/planning\/2026-09-19-/u, reason: '本轮权威文档（提及旧概念是为了声明其删除）' },
  { test: /^docs\/decisions\//u, reason: '决策记录（作废横幅已加）' },
  { test: /^docs\/releases\//u, reason: '发布说明（W7 回改，台账 OPS-1/DAT-9 已登记）' },
  { test: /^docs\/AUDIT-/u, reason: '审计报告留痕（历史证据，不是活代码）' },
]

/** 报告里的相对路径（失败信息要能直接点开）。 */
const REL = path => path.replace(`${ROOT}/`, '')

const failures = []
const hits = []

function ok(message) {
  console.log(`  PASS ${message}`)
}

function bad(message) {
  failures.push(message)
  console.error(`  FAIL ${message}`)
}

function git(argv) {
  return spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function whitelistReason(path) {
  for (const rule of WHITELIST) {
    if (rule.test.test(path)) return rule.reason
  }
  return null
}

console.log('== 旧模型零残留（五桶：A 业务零命中 / B 契约型保留 / ANN 带标注的删除注释 / C 夹具与历史文档与不可变迁移 / D 生成物与演示内容；未跟踪文件也查）')

// ---- 范围自检（路径不存在 ⇒ git grep rc≥2 ⇒ 不得当通过）-------------------
// 存在性用**文件系统**判定：新包的 src/ 可能整目录还是未跟踪状态（本仓并发施工中），
// 此时 `git ls-files` 为空 —— 那不代表"范围缺失"，只代表文件还没进索引（另有未跟踪扫描）。
const present = []
for (const scope of SCOPES) {
  if (existsSync(resolve(ROOT, scope.path))) present.push(scope.path)
  else if (scope.required) bad(`扫描范围缺失：${scope.path}（门禁范围写错就等于没扫）`)
}
if (present.length === 0) {
  console.error('零残留扫描没有可扫描的范围 —— 拒绝把"扫不到"当成"零命中"')
  process.exit(1)
}
console.log(`  扫描范围（${present.length}）：${present.join(' ')}`)

// ---- 已跟踪文件：git grep（一次跑完，逐条分类）------------------------------
const combined = CATEGORIES.map(category => `(${category.source})`).join('|')
const grep = git(['grep', '-n', '-I', '-E', combined, '--', ...present])
if (grep.status !== 0 && grep.status !== 1) {
  bad(`git grep 失败（rc=${grep.status}）：${(grep.stderr ?? '').trim() || '无 stderr'} —— rc≥2 不得当通过`)
}
const tracked = grep.status === 0 ? grep.stdout.split('\n').filter(Boolean) : []

// ---- 未跟踪文件：git ls-files --others（本仓并发编辑史 ⇒ 新增文件常不在索引里） ----
const untrackedList = git(['ls-files', '--others', '--exclude-standard', '--', ...present])
if (untrackedList.status !== 0) {
  bad(`git ls-files --others 失败（rc=${untrackedList.status}）：${(untrackedList.stderr ?? '').trim()}`)
}
const untracked = (untrackedList.stdout ?? '').split('\n').filter(Boolean)
const untrackedHits = []
for (const file of untracked) {
  let text
  try {
    text = readFileSync(resolve(ROOT, file), 'utf8')
  } catch {
    continue
  }
  text.split('\n').forEach((line, index) => {
    for (const category of CATEGORIES) {
      if (new RegExp(category.source, 'u').test(line)) {
        untrackedHits.push({ file, line: index + 1, text: line.trim(), category: category.key, untracked: true })
        break
      }
    }
  })
}

// ---- 分类 -----------------------------------------------------------------
const records = []
for (const raw of tracked) {
  // git grep -n 输出形如 `path:line:content`（路径里可能含冒号 ⇒ 从前两个冒号切）
  const first = raw.indexOf(':')
  const second = raw.indexOf(':', first + 1)
  if (first < 0 || second < 0) continue
  const file = raw.slice(0, first)
  const line = Number(raw.slice(first + 1, second))
  const text = raw.slice(second + 1).trim()
  for (const category of CATEGORIES) {
    if (new RegExp(category.source, 'u').test(text)) {
      records.push({ file, line, text, category: category.key, untracked: false })
      break
    }
  }
}
records.push(...untrackedHits)

// ---------------------------------------------------------------------------
// 四桶分类（2026-09-19 主控订正：三分法 → 四类；B 桶有**显式标识 + 计数上限**）
//
//   A 业务代码零命中（**真判据，必须为 0**）—— W4 删除波次的完成判据。
//   B **契约型保留**：旧名字面量在某些位置**必须**存在才有意义 —— 拒绝/忽略清单
//     （`REMOVED_APP_CONFIG_FIELDS`）与 I6 的兼容读（历史 `access='public'` 按 login 执行）。
//     删掉它们 = 拒绝逻辑失效 / 兼容读失效，所以不能算残留；但**必须**有显式标识
//     （常量名 `REMOVED_|LEGACY_` 或同行/紧邻注释写"已废弃/历史"），且有**计数上限**
//     （防止有人把新残留塞进这个桶 —— 桶一旦无上限就等于白名单）。
//   C 夹具 / 历史文档白名单（逐条带理由；命中仍打印）。
//   D 生成物与非本泳道内容（go generate 产物、演示应用与技能内容）：单列交对应泳道，
//     不计入 A，但计数必须打印（审计一眼就能看见它们没被藏起来）。
//
// A 桶必须为 0；B 桶 ≤ 上限且每条带标识；C/D 只计数与抽样。
// ---------------------------------------------------------------------------
/** B 桶上限（可用 WASM_RESIDUE_CONTRACT_BUDGET 覆盖；调整必须是有意识的动作）。 */
// 预算 = 实测构成（client 13 + webadmin 7 + appcfg 13 = 33）；调整预算必须是有意识的动作，
// 并在 L4-status / 台账里写明理由（桶无上限就等于白名单）。
// 预算 = 实测构成（client 13 + webadmin 7 + appcfg 14 = 34）；调整预算必须是有意识的动作，
// 并在 L4-status / 台账里写明理由（桶无上限就等于白名单）。
//
// 2026-09-20 +1（主控裁决，13 → 14 / 总 33 → 34）：L7 把"判断 access 是否历史公开档位"
// 从 `appseed.go` 的**代码行**收进它的**归属模块** ——
//   `func IsLegacyPublicAccess(s string) bool { return Access(s) == AccessPublic }`
// 理由：①这是 W4 一次性磁盘资产改写（§9 的 A 方案）**必须**的历史取值判定，与 0074 迁移里的
// `'public'` 字面量同性质；②它是有意识的**归属修正**（历史取值长什么样只该由读侧口径的唯一
// 作者 `appcfg` 知道，`appseed` 不该知道），不是把新残留塞进桶。
// **下次再 +1 必须先给出同等强度的理由**（"加条注释就能进桶"= 逃生门，明确不做）。
const CONTRACT_BUDGET = Number(process.env.WASM_RESIDUE_CONTRACT_BUDGET ?? 34)

/** B 桶的显式标识（常量名或同行/紧邻注释的废弃标注）。 */
const CONTRACT_MARKER = /REMOVED_|LEGACY_|已废弃|历史|deprecated|2026-09-19|已不在契约|不再下发|不再有|已不存在|已删除|删除清单|冻结契约|迁移白名单|旧书签|旧 schema|兼容 shim|legacy/iu
const CONTRACT_DECLARATION = /(?:export\s+)?(?:const|let|var)\s+(?:REMOVED_|LEGACY_)[A-Z0-9_]*/u

/** D 桶：生成物与"非本泳道内容"（演示应用 / 技能内容，属 W4/W5 改写清单）。 */
const DERIVED_PREFIXES = ['server/demoapps/', 'server/skills/']
const GENERATED_NAME = /(?:^|\/)(?:generated|gen)\/|[_\-.]gen\.[a-z]+$/u
const GENERATED_ARTIFACTS = new Set(['limits.json', 'appcfg.json', 'limits.md', 'app-config.md'])
function isGenerated(file) {
  if (GENERATED_NAME.test(file)) return true
  const base = file.slice(file.lastIndexOf('/') + 1)
  if (!GENERATED_ARTIFACTS.has(base)) return false
  // 生成物（limits/appcfg）与同名手写文件靠目录区分：只有 limits/ 与 references/ 下才是产物。
  return /\/limits\//u.test(file) || /\/references\//u.test(file)
}
/**
 * B 桶的资格范围（按"契约型保留"的所在地枚举；其余一律 A）：
 *   · `client`   = 客户端应用中心包 —— `REMOVED_*_FIELDS` 拒绝清单与 I6 的兼容读；
 *   · `webadmin` = 管理端 —— 历史审计动作标签映射、已删配置面的说明、旧书签
 *                   `?access=public` 的**显式拒绝路径**（"不能静默当成全部"）。
 * 两个 scope 都只是"资格"：还必须**带显式标识**才进 B（见 CONTRACT_MARKER）。
 */
const CONTRACT_SCOPES = [
  { label: 'client', test: /^packages\/client\/wasm-apps\/src\//u },
  { label: 'webadmin', test: /^server\/webadmin\/src\//u },
  // 应用配置契约模块（I6 明文要求的东西都在这儿）：`AccessPublic`（"历史值，只读"）、
  // `login_required=false ⇒ access=public` 的旧 schema 映射、`AccessValues`（历史只读集合）、
  // `publicAccessRejected`（写侧拒绝的**结构化错误** —— 删了"写侧拒绝 public"就没有判据）。
  // 精确到 appcfg.go（主控裁定的 11 处；同目录 inherit.go 的 2 处讲同一件事但没有显式标注，
  // 按"必须有标识"的口径留在 A，需要时由属主补标注并显式上调预算）。
  { label: 'appcfg', test: /^server\/internal\/wasmapp\/appcfg\/appcfg\.go$/u },
]
function contractScopeOf(file) {
  const module = CONTRACT_MODULES.find(entry => entry.test.test(file))
  if (module !== undefined) return module.label
  return CONTRACT_SCOPES.find(scope => scope.test.test(file))?.label ?? null
}

/**
 * **文件级契约模块**（逐文件声明预算；主控 2026-09-19 裁定）。
 *
 * 与 scope 的区别：scope 里的文件仍要**逐行带标识**才进 B；文件级模块是**整文件**
 * 声明为契约面（I6 明文要求），因此整文件命中都算 B —— 但**每个文件有独立预算**，
 * 超出即红（把新残留塞进契约模块同样会被抓住），并且逐条打印文件:行供审计核对。
 */
const CONTRACT_MODULES = [
  {
    // R1-L4-4：资格是整个 appcfg 包 —— `appcfg.go` 的 11 处与 `inherit.go` 的
    // "基线里的历史 public 读侧按 login（`prev.Access = AccessLogin`）"是**同一个 I6 契约**，
    // 拆成两个文件只是为了可读性。
    test: /^server\/internal\/wasmapp\/appcfg\//u,
    label: 'appcfg',
    // 2026-09-20：13 → 14（`IsLegacyPublicAccess` —— W4 一次性改写的历史取值判定，
    // 归属模块化的结果；理由见下方 CONTRACT_BUDGET 注释）。
    budget: 14,
    reason: 'I6 明文要求的兼容面：AccessPublic（"历史值，只读"）/ `login_required=false ⇒ access=public` 的旧 schema 映射 / AccessValues（历史只读集合）/ publicAccessRejected（写侧拒绝的**结构化错误**）/ 基线历史 public 的读侧映射',
  },
]

/**
 * **ANN 桶**（R1-L4-3；口径 2026-09-20 经主控复核为**注释块级**）：仓库范围内"带删除/废弃标注的**注释**"——
 * 标注词允许来自**同一注释块的表头**（±25 行内的连续注释）："表头写『以下为历史/已删除…』
 * 覆盖块内各行"是注释的正常写法，收窄成"必须逐行自带标注词"只会用假精度换假绿。量具对每条
 * 命中标注 `[self]`（本行自带）还是 `[blk]`（块级继承），口径与实现一致、可自证。
 *
 * 为什么单列而不是算 A：A 的定义是"业务代码零命中"，而这些行恰恰是 **W4 的成果**
 * —— 例如 `publish.go`/`read.go`/`release.go` 的「⚠️ `entry_url` 已随 W4 从两侧删除」、
 * `abi.go` 的「服务端不再产生 `public`」、`cmd/server/main.go` 的「`WasmSession` 已随
 * W4 删除」。把它们当残留会让"删干净"反而永远达不到 A=0。
 *
 * 但它**不是**逃生门：①只有**注释行**（`//` `*` `/*` `#` `--` `<!--`）能进；②必须有
 * 显式标注词；③有**预算**（超出即红）；④逐条打印 `文件:行`+scope 构成供审计核对。
 * 变异判据：把某行的标注词去掉 ⇒ 该行**必须**回到 A（实测见 L4-status 的 M6）。
 */
const ANN_MARKER = /REMOVED_|LEGACY_|已废弃|历史|deprecated|2026-09-19|已不在契约|不再下发|不再有|已不存在|已删除|删除|删除清单|冻结契约|迁移白名单|旧书签|旧 schema|兼容 shim|legacy|已随|不再产生|不再提供|退役|退场|W4|\bW-?C\b/iu
// ANN 上限 = 2026-09-20 实测 65（W4 施工中；冻结期应重新基线化）。它拦的是"新残留披一条
// '已删除' 注释混进来"——要加就显式改这个数并说明。
const ANN_BUDGET = Number(process.env.WASM_RESIDUE_ANN_BUDGET ?? 65)

function isCommentLine(text) {
  return /^\s*(\/\/|\*|\/\*|#|--|<!--)/u.test(text)
}

function bucketOf(record) {
  if (DERIVED_PREFIXES.some(prefix => record.file.startsWith(prefix)) || isGenerated(record.file)) return 'D'
  if (whitelistReason(record.file) !== null) return 'C'
  // 文件级契约模块：整个包都是契约面（逐模块预算在下面单独查），不再要求逐行标识。
  if (CONTRACT_MODULES.some(entry => entry.test.test(record.file))) return 'B'

  // 标注文本 = 命中行 + 所在**连续注释块**（上下各 ≤25 行；`*` 续行也算注释）。
  const source = sourceCache.get(record.file) ?? []
  let annotations = record.text
  const isComment = line => isCommentLine(line) || /^\s*\*/u.test(line)
  for (let index = record.line - 2; index >= Math.max(0, record.line - 25); index -= 1) {
    const line = source[index] ?? ''
    if (!isComment(line)) break
    annotations += `\n${line}`
  }
  for (let index = record.line; index < Math.min(source.length, record.line + 25); index += 1) {
    const line = source[index] ?? ''
    if (!isComment(line)) break
    annotations += `\n${line}`
  }

  // scope 内（client / webadmin）：逐行带标识才进 B；另有 `REMOVED_/LEGACY_` 声明包裹的也算。
  if (contractScopeOf(record.file) !== null) {
    if (CONTRACT_MARKER.test(annotations)) return 'B'
    const above = source.slice(Math.max(0, record.line - 60), record.line)
    for (let index = above.length - 1; index >= 0; index -= 1) {
      if (CONTRACT_DECLARATION.test(above[index])) return 'B'
      if (/^\}/u.test(above[index])) break
    }
  }

  // ANN：注释行 + 显式删除/废弃标注（仓库范围）。位置在 B 之后 —— 已声明为契约面的行
  // 仍归 B（口径不变），ANN 只吸收"其余被标注的注释"。
  if (isCommentLine(record.text) && ANN_MARKER.test(annotations)) {
    // R2-L4-1：量具自描述 —— 标注词可能来自**本行**（self）或**同一注释块的表头**（blk，
    // ±25 行内的连续注释）。注释块级是注释的正常写法（表头写"以下为历史…"覆盖块内各行），
    // 两种都合法；但要能一眼看出这条凭什么进 ANN —— 报出来，别让人以为每行都自带标注。
    record.annScope = ANN_MARKER.test(record.text) ? 'self' : 'blk'
    return 'ANN'
  }
  return 'A'
}

const sourceCache = new Map()
function sourceLines(file) {
  if (!sourceCache.has(file)) {
    try {
      sourceCache.set(file, readFileSync(resolve(ROOT, file), 'utf8').split('\n'))
    } catch {
      sourceCache.set(file, [])
    }
  }
  return sourceCache.get(file)
}

const counted = new Map()
const buckets = { A: [], B: [], ANN: [], C: [], D: [] }
for (const record of records) {
  counted.set(record.category, (counted.get(record.category) ?? 0) + 1)
  const enriched = { ...record, reason: whitelistReason(record.file), source: sourceLines(record.file) }
  buckets[bucketOf(enriched)].push(enriched)
}

const labelOf = key => ({
  A: 'A 业务代码零命中（必须为 0）',
  B: `B 契约型保留（必须带标识；上限 ${CONTRACT_BUDGET}）`,
  ANN: `ANN 带删除/废弃标注的注释（注释块级：标注词可来自同行 [self] 或同块表头 [blk]；上限 ${ANN_BUDGET}）`,
  C: 'C 夹具 / 历史文档与不可变迁移',
  D: 'D 生成物 / 演示与技能内容（非本泳道）',
}[key])

console.log(`  五桶：A=${buckets.A.length}（必须为 0） B=${buckets.B.length}（上限 ${CONTRACT_BUDGET}）`
  + ` ANN=${buckets.ANN.length}（上限 ${ANN_BUDGET}） C=${buckets.C.length} D=${buckets.D.length}`
  + `${buckets.A.length === 0 ? '' : ' ← A 必须为 0（W4 未完成）'}`)

for (const key of ['B', 'ANN', 'A']) {
  const items = buckets[key]
  if (items.length === 0) continue
  const scopeMix = key === 'B' || key === 'ANN'
    ? `（${Object.entries(items.reduce((acc, record) => {
      const scope = contractScopeOf(record.file) ?? 'other'
      acc[scope] = (acc[scope] ?? 0) + 1
      return acc
    }, {})).map(([scope, count]) => `${scope}=${count}`).join(' ')}）`
    : ''
  console.log(`  -- ${labelOf(key)}：${items.length} 处${scopeMix}`)
  const shown = key === 'B' || key === 'ANN' || SHOW_ALL ? items : items.slice(0, PER_CATEGORY_LIMIT)
  for (const record of shown) {
    const tag = key === 'B' ? 'B' : key === 'ANN' ? `ANN/${record.annScope ?? 'blk'}` : 'HIT'
    console.error(`     [${tag}] ${record.file}:${record.line}: ${record.text.slice(0, 150)}`)
  }
  if (shown.length < items.length) {
    console.error(`     …（还有 ${items.length - shown.length} 处未列出；用 --all 看全）`)
  }
}
for (const key of ['C', 'D']) {
  if (buckets[key].length === 0) continue
  const files = new Set(buckets[key].map(record => record.file))
  console.log(`  -- ${labelOf(key)}：${buckets[key].length} 处 / ${files.size} 个文件（不拦门禁；抽样如下）`)
  for (const record of buckets[key].slice(0, 5)) {
    console.error(`     [${key}] ${record.file}:${record.line}: ${record.text.slice(0, 120)}`)
  }
}

// 历史迁移整体归 C，但**新增**迁移不能免检：用 git 状态列出本轮新增/未跟踪的迁移文件。
{
  const status = git(['status', '--porcelain', '--', 'server/internal/serverstore/migrations-pg'])
  const freshMigrations = (status.stdout ?? '').split('\n').filter(Boolean)
    .filter(line => /^(\?\?|A |AM|M\?)/u.test(line))
    .map(line => line.slice(3).trim())
  if (freshMigrations.length > 0) {
    console.log(`  [新迁移需人工复核] C 桶豁免的是**历史**迁移；以下迁移是本轮新增/未跟踪，请人工看一眼是否引入旧模型字面量：`)
    for (const file of freshMigrations) console.log(`     · ${file}`)
  }
}
console.log(`  未跟踪文件：${untracked.length} 个，其中命中 ${untrackedHits.length} 处`)
for (const category of CATEGORIES) {
  const total = counted.get(category.key) ?? 0
  if (total > 0) console.log(`    分类 ${category.key}: ${total}`)
}

if (JSON_OUT !== null) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(JSON_OUT, `${JSON.stringify({
    head: git(['rev-parse', 'HEAD']).stdout.trim(),
    buckets: { A: buckets.A, B: buckets.B, ANN: buckets.ANN, C: buckets.C, D: buckets.D },
    counts: { A: buckets.A.length, B: buckets.B.length, ANN: buckets.ANN.length, C: buckets.C.length, D: buckets.D.length },
    contractBudget: CONTRACT_BUDGET,
    annBudget: ANN_BUDGET,
    untracked,
  }, null, 2)}\n`)
  console.log(`  报告落盘：${JSON_OUT}`)
}

for (const module of CONTRACT_MODULES) {
  const inModule = buckets.B.filter(record => module.test.test(record.file))
  const byFile = Object.entries(inModule.reduce((acc, record) => {
    acc[record.file] = (acc[record.file] ?? 0) + 1
    return acc
  }, {})).map(([file, count]) => `${REL(file)}=${count}`).join(' ')
  if (inModule.length > module.budget) {
    bad(`契约模块 ${module.label} 的 B 桶条目 ${inModule.length} 处 > 预算 ${module.budget}：`
      + `契约模块不是无上限白名单（新残留塞进来会被这条抓住）。理由：${module.reason}`)
  } else {
    console.log(`  契约模块 ${module.label}（${inModule.length}/${module.budget} 处：${byFile}）—— ${module.reason}`)
  }
}
if (buckets.ANN.length > ANN_BUDGET) {
  bad(`ANN 桶（带删除/废弃标注的注释）${buckets.ANN.length} 处 > 上限 ${ANN_BUDGET}：`
    + `标注注释不是无上限白名单（新残留披一条"已删除"注释就会被这条抓住）；`
    + `如确为 W4 成果请显式调 WASM_RESIDUE_ANN_BUDGET 并说明。`)
}
if (buckets.B.length > CONTRACT_BUDGET) {
  bad(`B 桶（契约型保留）${buckets.B.length} 处 > 上限 ${CONTRACT_BUDGET}：很可能是把**新残留**塞进了这个桶`
    + `（桶无上限就等于白名单）。请逐条确认标识与理由，必要时显式调 WASM_RESIDUE_CONTRACT_BUDGET 并说明。`)
}
// B 桶条目**必须**带显式标识：bucketOf 只在标识成立时才给 B，这里再独立复核一遍
// （防御"标识判定被改宽但复核没跟上"），复核口径=命中行或所在注释块或上方常量声明。
const unmarkedB = buckets.B.filter((record) => {
  if (CONTRACT_MODULES.some(entry => entry.test.test(record.file))) return false
  const source = record.source ?? []
  const isComment = line => /^\s*(\/\/|\*|\/\*|#)/u.test(line)
  let near = record.text
  for (let index = record.line - 2; index >= Math.max(0, record.line - 25); index -= 1) {
    if (!isComment(source[index] ?? '')) break
    near += `\n${source[index]}`
  }
  for (let index = record.line; index < Math.min(source.length, record.line + 25); index += 1) {
    if (!isComment(source[index] ?? '')) break
    near += `\n${source[index]}`
  }
  if (CONTRACT_MARKER.test(near)) return false
  return !source.slice(Math.max(0, record.line - 60), record.line).some(line => CONTRACT_DECLARATION.test(line))
})
for (const record of unmarkedB) {
  bad(`B 桶条目缺少显式标识（常量名 REMOVED_/LEGACY_ 或"已废弃/历史"标注）：${record.file}:${record.line}`)
}

if (buckets.A.length > 0) {
  bad(`A 桶（业务代码）仍有旧模型残留 ${buckets.A.length} 处（W4 删除波次未完成；清单见上）`)
  process.exit(1)
}
if (failures.length > 0) process.exit(1)
ok(`业务代码零旧模型残留（A=0；B=${buckets.B.length} ≤ ${CONTRACT_BUDGET} 契约型保留；`
  + `ANN=${buckets.ANN.length} ≤ ${ANN_BUDGET} 带标注的删除注释；C=${buckets.C.length} 夹具/文档/历史迁移；D=${buckets.D.length} 生成物/演示与技能内容）`)
console.log('零残留扫描通过 ✅')
