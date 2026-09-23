import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAV_ENTRIES, isNavVisible, landingPath, visibleNav, type NavEntry } from './nav'
import type { MeUser } from './rbac'

// P2-43: nav 声明的 perms 必须被真正消费——服务端 /me 下发的 permissions
// 是可见性唯一依据(auditor = audit:read + usage:read + user:read)。
//
// ---------------------------------------------------------------------------
// 2026-09-23 第四轮审计 R4-D-3：权限全集**不再手抄**，改成**读 Go 真源**
// ---------------------------------------------------------------------------
//
// 此前这里是一份 `GO_ALL_PERMISSIONS` 手抄副本（旧注释写着"这正是本测试要产生的
// 摩擦"）。手抄不是判据：它只覆盖"前端声明一个 Go 端不存在的权限点"这**一个方向**，
// 而真实事故（`error-monitoring:read` 在 rbac.go 被删除后该页对**包括 super_admin
// 在内**的全部角色不可见、测试依旧全绿）恰好是另一个方向——两侧一起漂移时同样沉默。
//
// 现在解析 `server/internal/serverauth/rbac.go`（权限点常量块 +
// `AllPermissions`/`AuditorPermissions` 切片）并做**四向**对拍：
//   ① Go 常量块 ↔ `AllPermissions`：双向覆盖（新增常量忘了授权 ⇒ 红；切片引用一个
//      不存在的常量 ⇒ 红）；
//   ② `NAV_ENTRIES` 声明的 perms ⊆ Go 权限全集（前端声明 Go 不认的点 ⇒ 该页永不显示
//      = 上面那起事故的形态 ⇒ 红）；
//   ③ `lib/rbac.ts` 的每个 `PERM_*` 常量值都必须存在于 Go 全集（同一事故的第二个
//      入口：页面判定与导航 gate 用的是两份手抄表）；
//   ④ **前向守卫**：Go 全集里每个权限点必须要么被某个 NAV_ENTRIES gate，要么登记在
//      `PERM_WITHOUT_NAV_ENTRY`（附理由）—— 新增权限点时必须**显式决定**它在管理端
//      有没有入口，不能悄悄多出来。
//
// 读不到文件 / 解析出 0 条 ⇒ **throw**（fail-loud，不 skip；静默跳过等于关掉判据）。

/**
 * 定位服务端权限点真源 `server/internal/serverauth/rbac.go`。
 *
 * 不用 `import.meta.url`：jsdom 环境下它是 `http://localhost/...`。与
 * `pages/app-center/opens-contract-parity.spec.ts` 同款——从 cwd 向上找服务端标记。
 * @returns rbac.go 的绝对路径。
 */
function findRbacGo(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'internal', 'serverauth', 'rbac.go'))) {
      return join(dir, 'internal', 'serverauth', 'rbac.go')
    }
    if (existsSync(join(dir, 'server', 'internal', 'serverauth', 'rbac.go'))) {
      return join(dir, 'server', 'internal', 'serverauth', 'rbac.go')
    }
    dir = resolve(dir, '..')
  }
  throw new Error(
    `找不到服务端权限点真源 server/internal/serverauth/rbac.go（cwd=${process.cwd()}）：本用例读 Go 源码对拍，找不到真源必须红`,
  )
}

/**
 * 定位前端权限常量表 `src/lib/rbac.ts`（同样从 cwd 向上找，不依赖 import.meta.url）。
 * @returns rbac.ts 的绝对路径。
 */
function findRbacTs(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'src', 'lib', 'rbac.ts'))) return join(dir, 'src', 'lib', 'rbac.ts')
    if (existsSync(join(dir, 'webadmin', 'src', 'lib', 'rbac.ts'))) {
      return join(dir, 'webadmin', 'src', 'lib', 'rbac.ts')
    }
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到前端权限常量表 src/lib/rbac.ts（cwd=${process.cwd()}）`)
}

const RBAC_GO_PATH = findRbacGo()
const RBAC_GO = readFileSync(RBAC_GO_PATH, 'utf8')
const RBAC_TS = readFileSync(findRbacTs(), 'utf8')

/**
 * Go 权限点常量块：`PermXxx = "value"` ⇒ `{ PermXxx: 'value' }`。
 * @param src - rbac.go 全文。
 * @returns 常量名 → 权限点字符串。
 */
function goPermConstants(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/\b(Perm[A-Za-z0-9]*)\s*=\s*"([^"]+)"/gu)) {
    out.set(m[1]!, m[2]!)
  }
  if (out.size === 0) {
    throw new Error(`${RBAC_GO_PATH} 里解析不到任何权限点常量（形态变了？对拍必须 fail-loud）`)
  }
  return out
}

/**
 * Go 权限切片（`AllPermissions` / `AuditorPermissions`）⇒ 权限点**值**列表（保留声明顺序）。
 * @param src - rbac.go 全文。
 * @param varName - 切片变量名。
 * @param consts - {@link goPermConstants} 的结果（切片里写的是常量**名**）。
 * @returns 权限点字符串列表。
 */
function goPermSlice(src: string, varName: string, consts: Map<string, string>): string[] {
  const m = new RegExp(`var\\s+${varName}\\s*=\\s*\\[\\]string\\s*\\{`).exec(src)
  if (m === null) throw new Error(`${RBAC_GO_PATH} 里找不到切片 ${varName}（改名了？对拍真源必须同步）`)
  const open = src.indexOf('{', m.index)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error(`${RBAC_GO_PATH} 里 ${varName} 的花括号不闭合`)
  const out: string[] = []
  for (const rawLine of src.slice(open + 1, end).split('\n')) {
    const line = rawLine.replace(/\/\/.*$/u, '').trim()
    if (line === '') continue
    for (const token of line.split(',')) {
      const name = token.trim()
      if (name === '') continue
      const value = consts.get(name)
      if (value === undefined) {
        throw new Error(`${varName} 引用了未声明的权限常量 ${name}（Go 真源自身不一致）`)
      }
      out.push(value)
    }
  }
  if (out.length === 0) throw new Error(`${RBAC_GO_PATH} 的 ${varName} 解析出 0 条（对拍必须 fail-loud）`)
  return out
}

/**
 * 前端 `lib/rbac.ts` 的 `PERM_*` 常量：`export const PERM_X = 'value'`。
 * @param src - rbac.ts 全文。
 * @returns 常量名 → 权限点字符串。
 */
function tsPermConstants(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/export const (PERM_[A-Z0-9_]+)\s*=\s*'([^']+)'/gu)) {
    out.set(m[1]!, m[2]!)
  }
  if (out.size === 0) {
    throw new Error('前端 lib/rbac.ts 里解析不到任何 PERM_* 常量（形态变了？对拍必须 fail-loud）')
  }
  return out
}

const GO_PERM_CONSTANTS = goPermConstants(RBAC_GO)
const GO_ALL_PERMISSIONS = goPermSlice(RBAC_GO, 'AllPermissions', GO_PERM_CONSTANTS)
const GO_AUDITOR_PERMISSIONS = goPermSlice(RBAC_GO, 'AuditorPermissions', GO_PERM_CONSTANTS)
const TS_PERM_CONSTANTS = tsPermConstants(RBAC_TS)

/** nav gate 用到的权限点并集（来自 NAV_ENTRIES 的声明，不是另抄一份清单）。 */
const NAV_GATED_PERMISSIONS = [...new Set(NAV_ENTRIES.flatMap((n) => n.perms ?? []))]

/**
 * **刻意不进侧栏**的权限点（前向守卫的登记表）。
 *
 * 判据：Go 全集里每个权限点都必须出现在 `NAV_ENTRIES` 的 perms 里，或者登记在这里并
 * 写明为什么管理端不需要独立入口。新增一个权限点时本用例会红，直到有人显式决定它属于
 * 哪一类——这正是"权限点漂移没有任何判据能发现"要补的那道闸。
 */
const PERM_WITHOUT_NAV_ENTRY: Record<string, string> = {
  'user:write': '写面：用户页（user:read 进入）内的动作，页内 hasPermission 收敛',
  'dept:write': '写面：部门页（dept:read 进入）内的动作',
  'auth:write': '写面：认证页（auth:read 进入）内的动作',
  'gateway:write': '写面：网关页 / 网关文件页（gateway:read 进入）内的动作',
  'report:write': '写面：用量中心「报表订阅」子页内的动作',
  'report:read': '报表订阅列表是「用量中心」的子页（入口由 usage:read 覆盖）',
  'market:write': '写面：能力中心（市场）的审批/授权动作',
  'capability:write': '写面：能力中心/应用中心的处置动作',
  'connector:write': '写面：连接器页（connector:read 进入）内的动作',
  'audit:retention:write': '写面：审计页（audit:read 进入）内的保留策略卡片',
  'portal:read': '门户页无独立管理入口（相关配置在「服务器信息」页）',
  'portal:write': '写面：门户配置动作',
}

const superAdmin: MeUser = { role: 'super_admin', permissions: GO_ALL_PERMISSIONS }
const auditor: MeUser = { role: 'auditor', permissions: GO_AUDITOR_PERMISSIONS }
const employee: MeUser = { role: 'user', permissions: [] }

const paths = (user: MeUser | null) => visibleNav(user).map((n) => n.to)

describe('权限点真源对拍(R4-D-3 · 读 server/internal/serverauth/rbac.go)', () => {
  it('Go 真源解析自证：非空、无重复、常量块 ↔ AllPermissions 双向覆盖', () => {
    // 解析器坏掉时不能"零命中全绿"（上面的解析函数已 throw，这里是第二道自证）。
    expect(GO_PERM_CONSTANTS.size).toBeGreaterThan(0)
    expect(GO_ALL_PERMISSIONS.length).toBeGreaterThan(0)
    expect(new Set(GO_ALL_PERMISSIONS).size, 'AllPermissions 不得重复授权').toBe(GO_ALL_PERMISSIONS.length)
    // 声明了权限点常量却没进 AllPermissions ⇒ 该权限点在服务端永不成立（连超管也没有）。
    const missing = [...GO_PERM_CONSTANTS.values()].filter((p) => !GO_ALL_PERMISSIONS.includes(p)).sort()
    expect(missing, `这些权限点常量未进 AllPermissions：${missing.join(', ')}`).toEqual([])
  })

  it('NAV_ENTRIES 声明的每个权限点都存在于 Go 权限全集(常量漂移守卫)', () => {
    // 事故形态：前端 gate 在一个 Go 端不存在的权限点上 ⇒ 该页对**包括 super_admin
    // 在内**的全部角色不可见（2026-09-12 的 `error-monitoring:read`）。
    const declared = [...NAV_GATED_PERMISSIONS].sort()
    expect(declared.filter((p) => !GO_ALL_PERMISSIONS.includes(p))).toEqual([])
  })

  it('lib/rbac.ts 的 PERM_* 常量值全部都存在于 Go 全集（第二个手抄入口）', () => {
    const unknown = [...TS_PERM_CONSTANTS.entries()]
      .filter(([, value]) => !GO_ALL_PERMISSIONS.includes(value))
      .map(([name, value]) => `${name}=${value}`)
      .sort()
    expect(unknown, `前端权限常量在 Go 真源里不存在（用它判定的页面会静默不可达）：${unknown.join(', ')}`).toEqual([])
  })

  it('Go 权限点必须显式决定管理端入口（新增/删除权限点的前向守卫）', () => {
    // 新增一个权限点 ⇒ 本用例红，直到有人显式决定它属于哪一类：
    //   ① 给某个 NAV_ENTRIES 当 gate；② 登记进 PERM_WITHOUT_NAV_ENTRY 并写明理由。
    const unregistered = GO_ALL_PERMISSIONS.filter(
      (p) => !NAV_GATED_PERMISSIONS.includes(p) && !(p in PERM_WITHOUT_NAV_ENTRY),
    ).sort()
    expect(
      unregistered,
      `Go 新增了权限点但没有管理端入口登记（改 NAV_ENTRIES 或补 PERM_WITHOUT_NAV_ENTRY）：${unregistered.join(', ')}`,
    ).toEqual([])
    // 反向：登记表里不得留 Go 端已删除的权限点（删点后登记表必须同步收缩）。
    const stale = Object.keys(PERM_WITHOUT_NAV_ENTRY).filter((p) => !GO_ALL_PERMISSIONS.includes(p)).sort()
    expect(stale, `PERM_WITHOUT_NAV_ENTRY 里有 Go 端已不存在的权限点：${stale.join(', ')}`).toEqual([])
  })
})

describe('导航权限过滤(P2-43)', () => {

  it('超管看到全部条目', () => {
    expect(paths(superAdmin)).toEqual(NAV_ENTRIES.map((n) => n.to))
  })

  it('超管能看到错误监控页(权限点从 error-monitoring:read 改回 server-info:read)', () => {
    // 回归:该条目曾 gate 在 rbac.go 已删除的 `error-monitoring:read` 上,
    // 导致 super_admin 的 granted 也不含它 → 页面无任何入口。
    const actual = NAV_ENTRIES.find((n) => n.to === '/error-monitoring')!
    expect(isNavVisible(actual, superAdmin)).toBe(true)
    // 改前形态的直接复现:同一个超管、同一条目,只把 perms 换回废弃常量
    // ⇒ isNavVisible 恒 false(这就是缺陷本身)。
    const retired: NavEntry = { ...actual, perms: ['error-monitoring:read'] }
    expect(isNavVisible(retired, superAdmin)).toBe(false)
  })

  it('审计员看到服务端允许的用户/用量/审计三页(不再只按 section 过滤)', () => {
    expect(paths(auditor)).toEqual(['/users', '/usage', '/audit'])
  })

  it('审计员看不到需要写/未授权页面', () => {
    const visible = paths(auditor)
    expect(visible).not.toContain('/departments')
    expect(visible).not.toContain('/gateway')
    expect(visible).not.toContain('/auth')
    expect(visible).not.toContain('/connectors')
    expect(visible).not.toContain('/server-info')
    expect(visible).not.toContain('/error-monitoring')
  })

  it('普通员工无任何可见条目', () => {
    expect(paths(employee)).toEqual([])
  })

  it('多权限点条目命中任一即可见(能力中心 market:read | capability:read)', () => {
    // capability:read 同时 gate「能力中心」与「应用中心」(读权限复用同一点,
    // 写入要 capability:write);market:read 只 gate 能力中心 —— 下面两条断言正是这条边界。
    expect(paths({ role: 'auditor', permissions: ['capability:read'] })).toEqual(['/capabilities', '/app-center'])
    expect(paths({ role: 'auditor', permissions: ['market:read'] })).toEqual(['/capabilities'])
  })

  it('应用中心页:capability:read 可见、普通员工不可见', () => {
    const entry = NAV_ENTRIES.find((n) => n.to === '/app-center')!
    expect(isNavVisible(entry, superAdmin)).toBe(true)
    expect(isNavVisible(entry, { role: 'auditor', permissions: ['capability:read'] })).toBe(true)
    expect(isNavVisible(entry, employee)).toBe(false)
  })

  it('网关文件页:gateway:read 可见,只读角色(无该权限点)不可见', () => {
    // 2026-09-22 新增条目（运维分区）：读占用/明细走 `gateway:read`（与
    // router.go 里 GET /gateway/files[/summary] 的申报同一点），删除/清理走
    // `gateway:write` —— 页面内另做写面收敛（GatewayFiles.tsx 的 canWrite）。
    const entry = NAV_ENTRIES.find((n) => n.to === '/gateway-files')!
    expect(entry.section).toBe('运维')
    expect(entry.perms).toEqual(['gateway:read'])
    expect(isNavVisible(entry, superAdmin)).toBe(true)
    expect(isNavVisible(entry, { role: 'auditor', permissions: ['gateway:read'] })).toBe(true)
    expect(isNavVisible(entry, auditor)).toBe(false) // auditor = audit/usage/user:read
    expect(isNavVisible(entry, employee)).toBe(false)
  })

  it('侧栏没有两条同图标入口(「应用平台」并入「应用中心」后的回归)', () => {
    // 2026-09-19 页面合并:此前 `/app-center` 与 `/app-platform` 两个条目同用 Boxes
    // 图标 —— 侧栏看着是两个入口、实际是同一类东西。合并后限制项/设置是应用中心的
    // 子页(路由表见 App.tsx),侧栏只留一条;`/app-platform` 只剩老书签重定向。
    const byIcon = new Map<unknown, string>()
    const dups: string[] = []
    for (const n of NAV_ENTRIES) {
      const seen = byIcon.get(n.icon)
      if (seen !== undefined) dups.push(`${seen} / ${n.to}`)
      else byIcon.set(n.icon, n.to)
    }
    expect(dups).toEqual([])
    expect(NAV_ENTRIES.map((n) => n.to)).not.toContain('/app-platform')
  })

  it('未声明 perms 的条目 fail-closed(仅超管可见)', () => {
    const legacy: NavEntry = { to: '/secret', label: '秘密', icon: NAV_ENTRIES[0]!.icon, section: '运维' }
    // 直接验证规则:服务端有权限集时,无 perms 声明只放行超管
    expect(visibleNav({ role: 'auditor', permissions: ['usage:read'] }).some((n) => n.to === legacy.to)).toBe(false)
    expect(visibleNav(superAdmin).length).toBe(NAV_ENTRIES.length)
  })

  it('服务端未下发 permissions(旧版本)时退回角色判定,不放大可见面', () => {
    expect(paths({ role: 'super_admin' })).toEqual(NAV_ENTRIES.map((n) => n.to))
    expect(paths({ role: 'auditor' })).toEqual(['/audit'])
    expect(paths({ role: 'user' })).toEqual([])
    expect(paths(null)).toEqual([])
  })

  it('落地页取第一个可见条目;审计员优先审计日志', () => {
    expect(landingPath(superAdmin)).toBe('/users')
    expect(landingPath(auditor)).toBe('/audit')
    expect(landingPath({ role: 'auditor', permissions: ['usage:read'] })).toBe('/usage')
    expect(landingPath(employee)).toBe('/users')
  })
})
