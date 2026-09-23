/**
 * 能力管理动作的**跨端命名空间对拍**（2026-09 现场 P1 的根因防线）。
 *
 * ## 这条 P1 的成因
 *
 * 市场页/智能体页把**组织共享库（员工上传、审批通过）** 的行并进同一张列表并打
 * `channel:'org'`，但卡片上每个按钮仍打**市场命名空间**的 URL。服务端两个命名空间
 * 各带渠道守卫，对越渠道的行**正确**返回 404「技能不存在」：
 *   - 市场：`serverstore.GetSkill` 要求 `apps.channel='market'`
 *     （`internal/serverstore/skills.go`；上下架另有 marketplace-8 守卫）；
 *   - 组织：`sharedskills.orgSkillApp` / `agentshare.orgAgentApp` 要求 `'org'`。
 * 现场 20 次 404 全落在市场命名空间，而正确的 `/shared-skills/...` **零请求**。
 *
 * ## 本用例怎么判（读**两边的源码**，不用任何夹具）
 *
 * - 前端侧：`./capability-endpoints` 的**动作表本身**（逐 action × 逐 channel 调
 *   builder，而不是另写一份期望字面量）；
 * - 服务端侧：`server/internal/router/router.go` 的**生产路由声明**（从
 *   `NamespaceServer` 常量 → `srv := r.Group(NamespaceServer)` → `sg := srv.Group("/admin")`
 *   → `authed := sg.Group("")` 逐级推导前缀，任何一环断链即抛错），
 *   外加四个 handler 包的路由镜像（`marketplace` / `sharedskills` / `agentshare`
 *   的 `RegisterAdminRoutes`，防"测试树与生产树不一致"那类历史缺陷）。
 *
 * 判据：**每个动作在每一渠道下的 URL + 动词都必须命中生产路由表**；组织渠道拿不到
 * 端点的动作必须返回 `null`（调用方不得渲染入口），**绝不允许回落市场前缀**。
 *
 * ## 变异验证（实跑，见交付报告）
 *
 * 摘掉 channel 判断（动作表所有 builder 无条件用市场前缀）⇒ 第 2/5 条必红
 * （组织行的 URL 前缀与所属 channel 不符，且 `/skills/<org 名>` 这类 URL 的动词/
 * 路径组合与组织端点对不上）。把 `org: () => null` 改成回落到市场端点 ⇒ 第 5 条必红。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMIN_API } from './api-paths'
import {
  AGENT_ENDPOINTS,
  CAPABILITY_ROOTS,
  FILE_SUFFIXES,
  GRANT_SUFFIXES,
  SKILL_ENDPOINTS,
  agentRequest,
  grantsBase,
  ownerTransferRequest,
  previewFileBase,
  skillRequest,
  type CapabilityKind,
  type CapabilityRef,
  type CapabilityRequest,
} from './capability-endpoints'

// ---------------------------------------------------------------------------
// 定位服务端真源（不写死路径：从 cwd 向上找服务端标记，与
// src/pages/app-center/opens-contract-parity.spec.ts 同款）
// ---------------------------------------------------------------------------

function findServerDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'internal', 'router', 'router.go'))) return dir
    if (existsSync(join(dir, 'server', 'internal', 'router', 'router.go'))) return join(dir, 'server')
    dir = resolve(dir, '..')
  }
  throw new Error(
    `找不到服务端源码根（cwd=${process.cwd()}）：本用例读 Go 路由声明对拍，找不到真源必须红`,
  )
}

const SERVER_DIR = findServerDir()

const ROUTER_GO = join(SERVER_DIR, 'internal', 'router', 'router.go')
const MIRRORS = {
  /** 市场技能 + 市场智能体（/api/server/admin/skills 与 /agents）。 */
  marketplace: join(SERVER_DIR, 'internal', 'marketplace', 'admin.go'),
  /** 组织共享技能（/api/server/admin/shared-skills）。 */
  sharedskills: join(SERVER_DIR, 'internal', 'sharedskills', 'routes.go'),
  /** 组织共享智能体（/api/server/admin/agent-presets）。 */
  agentshare: join(SERVER_DIR, 'internal', 'agentshare', 'routes.go'),
} as const

for (const f of [ROUTER_GO, ...Object.values(MIRRORS)]) {
  if (!existsSync(f)) {
    throw new Error(`对拍真源缺失：${f}（缺失是失败，不是跳过 —— 静默跳过等于把判据关掉）`)
  }
}

interface Route {
  method: string
  path: string
}

/** 取 `{` 与配对 `}` 之间的内容（注释里出现花括号时不会误判）。 */
function braceBody(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error(`括号不闭合（offset=${open}）`)
}

/** Go 函数体（找不到即抛错，不静默零命中）。 */
function funcBody(src: string, name: string): string {
  const m = new RegExp(`func\\s+${name}\\s*\\(`).exec(src)
  if (m === null) throw new Error(`Go 源码里找不到函数 ${name}（改名了？对拍真源必须更新）`)
  return braceBody(src, src.indexOf('{', m.index))
}

/** 路由模式 → 正则（`:name` 段匹配任意单段；路径其余部分逐字）。 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/:[A-Za-z_]\w*/g, '[^/]+')}$`)
}

function hit(routes: Route[], method: string, url: string): boolean {
  return routes.some((r) => r.method === method && patternToRegex(r.path).test(url))
}

function requireMatch(routes: Route[], method: string, url: string, where: string): void {
  expect(
    hit(routes, method, url),
    `${where} 里没有 ${method} ${url}（服务端未声明该路径/动词 ⇒ 前端一旦打过去就是 404）`,
  ).toBe(true)
}

// ---------------------------------------------------------------------------
// 生产路由表：internal/router/router.go（逐级推导前缀，任何一环断链即抛错）
// ---------------------------------------------------------------------------

const ROUTER = readFileSync(ROUTER_GO, 'utf8')

function must(pattern: RegExp, what: string): string {
  const m = pattern.exec(ROUTER)
  if (m === null) {
    throw new Error(`router.go 里找不到「${what}」（推导链断了：对拍用例必须更新，不能静默放行）`)
  }
  return m[1]!
}

const NAMESPACE_SERVER = must(/NamespaceServer\s*=\s*"([^"]+)"/, 'NamespaceServer 常量')
// srv 必须**就是** NamespaceServer 组，否则下面推导出的前缀是假的。
must(/srv\s*:?=\s*r\.Group\(\s*NamespaceServer\b/, 'srv := r.Group(NamespaceServer)')
const ADMIN_SEG = must(/sg\s*:?=\s*srv\.Group\(\s*"([^"]+)"/, 'sg := srv.Group("/admin")')
const ADMIN_BASE = NAMESPACE_SERVER + ADMIN_SEG
const ADMIN_GROUP_VAR = must(
  /(\w+)\s*:?=\s*sg\.Group\(\s*""/,
  'authed := sg.Group("")（会话内管理面的组变量）',
)

/** 生产路由树里的管理面路由（`AdminRoute(authed, …)` 全部声明）。 */
const PROD_ROUTES: Route[] = (() => {
  const routes: Route[] = []
  const re = /AdminRoute\(\s*(\w+)\s*,\s*"([A-Z]+)"\s*,\s*"([^"]*)"/g
  for (const m of ROUTER.matchAll(re)) {
    if (m[1] !== ADMIN_GROUP_VAR) continue
    routes.push({ method: m[2]!, path: ADMIN_BASE + m[3]! })
  }
  return routes
})()

/** 四个 handler 包的路由镜像（与生产树同前缀同路径；漂移即红）。 */
const MIRROR_ROUTES: Route[] = Object.values(MIRRORS).map((file) => {
  const src = readFileSync(file, 'utf8')
  const body = funcBody(src, 'RegisterAdminRoutes')
  const base = /base\s*:?=\s*"([^"]+)"/.exec(body)
  if (base === null) throw new Error(`${file} 的 RegisterAdminRoutes 里找不到 base := "…"`)
  const routes: Route[] = []
  const re = /AdminRoute\(\s*g\s*,\s*"([A-Z]+)"\s*,\s*"([^"]*)"/g
  for (const m of body.matchAll(re)) {
    routes.push({ method: m[1]!, path: base[1]! + m[2]! })
  }
  if (routes.length === 0) throw new Error(`${file} 的 RegisterAdminRoutes 没解析出任何路由`)
  if (!new RegExp(`g\\s*:?=\\s*r\\.Group\\(\\s*base`).test(body)) {
    throw new Error(`${file} 的 RegisterAdminRoutes 未把 base 挂进 g := r.Group(base, …)`)
  }
  return routes
}).flat()

/** 样例行：两渠道各一份（org 带版本 —— 组织库多数端点是版本级资源）。 */
const SAMPLE: Record<CapabilityKind, Record<'market' | 'org', CapabilityRef>> = {
  skill: {
    market: { channel: 'market', name: 'data-extract', version: '1.0.0' },
    org: { channel: 'org', name: 'codeql', version: '2.1.0' },
  },
  agent: {
    market: { channel: 'market', name: 'ppt-gen', version: '1.0.0' },
    org: { channel: 'org', name: 'ppt-gen', version: '2.1.0' },
  },
}

const TABLES = { skill: SKILL_ENDPOINTS, agent: AGENT_ENDPOINTS } as const

interface ActionBuilders {
  market: (ref: CapabilityRef) => CapabilityRequest | null
  org: (ref: CapabilityRef) => CapabilityRequest | null
}

/** 遍历动作表本身（而不是另写一份期望值）—— 新增动作会被自动纳入判据。 */
function* everyAction(): Generator<{
  kind: CapabilityKind
  action: string
  channel: 'market' | 'org'
  url: string
  method: string
  body?: string
}> {
  for (const kind of ['skill', 'agent'] as const) {
    const table = TABLES[kind] as unknown as Record<string, ActionBuilders>
    for (const [action, builders] of Object.entries(table)) {
      for (const channel of ['market', 'org'] as const) {
        const built = builders[channel](SAMPLE[kind][channel])
        if (built === null) continue
        yield { kind, action, channel, url: built.url, method: built.method, body: built.body }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// A. 真源可达性自证（解析器坏掉不能"零命中全绿"）
// ---------------------------------------------------------------------------

describe('跨端对拍 · 路由真源可达', () => {
  it('生产路由表解析出管理面路由，且含本次依赖的锚点', () => {
    expect(ADMIN_BASE).toBe(ADMIN_API)
    for (const anchor of [
      'PUT /api/server/admin/shared-skills/:name/enabled',
      'GET /api/server/admin/shared-skills/:name/grants',
      'GET /api/server/admin/shared-skills/:name/:version/preview',
      'GET /api/server/admin/shared-skills/:name/:version/file',
      'GET /api/server/admin/shared-skills/:name/:version/archive',
      'PUT /api/server/admin/agent-presets/:name/enabled',
      'GET /api/server/admin/agent-presets/:name/:version/preview',
      'POST /api/server/admin/skills/:name/normalize',
      'DELETE /api/server/admin/skills/:name',
      'POST /api/server/admin/agents/:name/enable',
      'PUT /api/server/admin/apps/:kind/:app_id/owner',
    ]) {
      expect(
        PROD_ROUTES.some((r) => `${r.method} ${r.path}` === anchor),
        `生产路由表缺少锚点 ${anchor}（解析器或真源有问题）`,
      ).toBe(true)
    }
    expect(PROD_ROUTES.length).toBeGreaterThan(50)
  })

  it('四个 handler 包的路由镜像解析出各自的组（漂移守卫的前置）', () => {
    for (const root of [
      '/api/server/admin/skills',
      '/api/server/admin/agents',
      '/api/server/admin/shared-skills',
      '/api/server/admin/agent-presets',
    ]) {
      expect(
        MIRROR_ROUTES.some((r) => r.path.startsWith(root + '/') || r.path === root),
        `镜像路由表里没有 ${root}（handler 包没挂这一组？）`,
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// B. 主判据：URL 前缀与 channel 一致 + 路径/动词真实存在
// ---------------------------------------------------------------------------

describe('跨端对拍 · 每个动作按行 channel 选命名空间', () => {
  it('前缀与 channel 的命名空间逐条一致（org 不得打 market 前缀，反之亦然）', () => {
    let checked = 0
    for (const { kind, action, channel, url } of everyAction()) {
      const expectedRoot = CAPABILITY_ROOTS[kind][channel]
      const otherRoot = CAPABILITY_ROOTS[kind][channel === 'org' ? 'market' : 'org']
      expect(
        url.startsWith(expectedRoot + '/') || url === expectedRoot,
        `${kind}.${action} 的 ${channel} 渠道 URL ${url} 不在 ${expectedRoot} 下`,
      ).toBe(true)
      expect(
        url.startsWith(otherRoot + '/'),
        `${kind}.${action} 的 ${channel} 渠道 URL ${url} 打到了另一个命名空间 ${otherRoot}`,
      ).toBe(false)
      expect(url.startsWith(ADMIN_API), `${kind}.${action} 应走管理面命名空间`).toBe(true)
      checked += 1
    }
    // 非空自证：动作表被真正遍历到（不是空循环全绿）。
    expect(checked).toBeGreaterThanOrEqual(15)
  })

  it('每个渠道的每条 URL + 动词都命中生产路由表（router.go）', () => {
    for (const { kind, action, channel, url, method } of everyAction()) {
      requireMatch(PROD_ROUTES, method, url, `生产路由表 ${kind}.${action}(${channel})`)
    }
  })

  it('同样命中四个 handler 包的路由镜像（测试树/生产树漂移守卫）', () => {
    for (const { kind, action, channel, url, method } of everyAction()) {
      requireMatch(MIRROR_ROUTES, method, url, `handler 包路由镜像 ${kind}.${action}(${channel})`)
    }
  })

  it('组织渠道：服务端没有的端点必须为 null，绝不回落市场前缀', () => {
    const orgSkill: CapabilityRef = SAMPLE.skill.org
    const orgAgent: CapabilityRef = SAMPLE.agent.org
    // 规范化只存在于市场技能。
    expect(skillRequest('normalize', orgSkill)).toBeNull()
    expect(skillRequest('normalize', SAMPLE.skill.market)).not.toBeNull()
    // 组织库没有元数据编辑与上传新版（新版本只能由员工重新上传）。
    for (const action of ['updateMeta', 'uploadVersion'] as const) {
      expect(skillRequest(action, orgSkill), `组织技能不应有 ${action} 端点`).toBeNull()
      expect(agentRequest(action, orgAgent), `组织智能体不应有 ${action} 端点`).toBeNull()
    }
    // 市场智能体没有归档下载端点（router 只声明 POST /agents/:name/archive = 上传新版）。
    // 这是**已知缺口**（预览弹窗「文件过大 → 下载归档」在市场智能体上会 404），
    // 用断言钉住：服务端一旦补上该路由，本用例变红并提示更新动作表。
    expect(agentRequest('archive', SAMPLE.agent.market)).toBeNull()
    expect(hit(PROD_ROUTES, 'GET', `${CAPABILITY_ROOTS.agent.market}/ppt-gen/archive`)).toBe(false)
    expect(hit(PROD_ROUTES, 'POST', `${CAPABILITY_ROOTS.agent.market}/ppt-gen/archive`)).toBe(true)
  })

  it('市场渠道没有管理面归档下载端点（既有缺口，钉住形态，勿以此为由回落命名空间）', () => {
    // 预览弹窗的「文件过大 → 下载归档」链接 = fileBase + '/archive'。市场两个命名空间
    // 都**只声明了 POST …/archive（上传新版）**，GET 未声明 ⇒ 该链接在超大文件分支会
    // 404。这是本次 P1 之外的既有缺口（现场证据里的 20 次 404 全在卡片按钮上），
    // 本用例把它钉住：谁补了 GET 路由，这里变红并提示同步动作表；谁想"顺手"回落到
    // 另一个命名空间，第 2/5 条会先红。
    for (const [kind, sample] of [
      ['skill', SAMPLE.skill.market],
      ['agent', SAMPLE.agent.market],
    ] as const) {
      const built = kind === 'skill' ? skillRequest('archive', sample) : agentRequest('archive', sample)
      expect(built, `市场${kind === 'skill' ? '技能' : '智能体'}不应有归档下载端点`).toBeNull()
      const root = CAPABILITY_ROOTS[kind].market
      expect(hit(PROD_ROUTES, 'GET', `${root}/${sample.name}/archive`)).toBe(false)
      expect(hit(PROD_ROUTES, 'POST', `${root}/${sample.name}/archive`)).toBe(true)
    }
  })

  it('组织渠道缺版本时不产出 URL（版本级资源不得退化成 name-only）', () => {
    const noVersion: CapabilityRef = { channel: 'org', name: 'codeql', version: '' }
    expect(skillRequest('preview', noVersion)).toBeNull()
    expect(skillRequest('file', noVersion)).toBeNull()
    expect(skillRequest('archive', noVersion)).toBeNull()
    expect(previewFileBase('skill', noVersion)).toBeNull()
    // 授权是 name-only（同名多版本共享）⇒ 有版本与否都必须可用。
    expect(grantsBase('skill', noVersion)).toBe(`${ADMIN_API}/shared-skills/codeql`)
  })
})

// ---------------------------------------------------------------------------
// C. 对话框基路径（授权 / 预览）——组件追加的后缀也必须命中真实路由
// ---------------------------------------------------------------------------

describe('跨端对拍 · 对话框基路径', () => {
  it('GrantDialog / ArchivePreviewDialog 追加的后缀与共享组件源码一致', () => {
    const grant = readFileSync(join(SERVER_DIR, 'webadmin', 'src', 'components', 'grant-dialog.tsx'), 'utf8')
    const preview = readFileSync(
      join(SERVER_DIR, 'webadmin', 'src', 'components', 'archive-preview-dialog.tsx'),
      'utf8',
    )
    // 组件是"基路径 + 后缀"的消费方：后缀一旦改名，本模块推导出的基路径就错位。
    expect(grant).toContain('${basePath}/grant`')
    expect(grant).toContain('${basePath}/grants`')
    expect(preview).toContain('${fileBase}/file?path=')
    expect(preview).toContain('${fileBase}/archive`')
    expect(GRANT_SUFFIXES.list).toBe('/grants')
    expect(GRANT_SUFFIXES.single).toBe('/grant')
    expect(FILE_SUFFIXES.file).toBe('/file')
    expect(FILE_SUFFIXES.archive).toBe('/archive')
  })

  it('两条渠道的授权基路径展开（GET/PUT /grants、PUT/DELETE /grant）全部命中生产路由', () => {
    for (const kind of ['skill', 'agent'] as const) {
      for (const channel of ['market', 'org'] as const) {
        const base = grantsBase(kind, SAMPLE[kind][channel])
        expect(base, `${kind}(${channel}) 的授权基路径`).not.toBeNull()
        requireMatch(PROD_ROUTES, 'GET', `${base}${GRANT_SUFFIXES.list}`, `授权读取 ${kind}(${channel})`)
        requireMatch(PROD_ROUTES, 'PUT', `${base}${GRANT_SUFFIXES.list}`, `授权整组替换 ${kind}(${channel})`)
        requireMatch(PROD_ROUTES, 'PUT', `${base}${GRANT_SUFFIXES.single}`, `单条授权 ${kind}(${channel})`)
        requireMatch(PROD_ROUTES, 'DELETE', `${base}${GRANT_SUFFIXES.single}`, `撤销授权 ${kind}(${channel})`)
      }
    }
  })

  it('两条渠道的预览基路径展开（GET /file、GET /archive）全部命中生产路由', () => {
    for (const kind of ['skill', 'agent'] as const) {
      for (const channel of ['market', 'org'] as const) {
        const ref = SAMPLE[kind][channel]
        const base = previewFileBase(kind, ref)
        expect(base, `${kind}(${channel}) 的文件基路径`).not.toBeNull()
        requireMatch(PROD_ROUTES, 'GET', `${base}${FILE_SUFFIXES.file}`, `单文件预览 ${kind}(${channel})`)
        // 归档链接:市场渠道没有该端点(已知缺口,上一条用例已钉住),组织渠道必须命中。
        const archive = kind === 'skill' ? skillRequest('archive', ref) : agentRequest('archive', ref)
        if (archive === null) continue
        requireMatch(PROD_ROUTES, 'GET', `${base}${FILE_SUFFIXES.archive}`, `归档下载 ${kind}(${channel})`)
      }
    }
  })

  it('归属转移与渠道无关（(kind,name) 级唯一入口 apps/:kind/:app_id/owner）', () => {
    for (const kind of ['skill', 'agent'] as const) {
      const r = ownerTransferRequest(kind, 'codeql')
      expect(r.method).toBe('PUT')
      requireMatch(PROD_ROUTES, 'PUT', r.url, `归属转移 ${kind}`)
    }
  })
})
