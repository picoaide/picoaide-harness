import { describe, expect, it } from 'vitest'
import { NAV_ENTRIES, isNavVisible, landingPath, visibleNav, type NavEntry } from './nav'
import type { MeUser } from './rbac'

// P2-43: nav 声明的 perms 必须被真正消费——服务端 /me 下发的 permissions
// 是可见性唯一依据(auditor = audit:read + usage:read + user:read)。

// **Go 真源的硬编码副本**(server/internal/serverauth/rbac.go 的 AllPermissions)。
// 刻意不写 `NAV_ENTRIES.flatMap(n => n.perms)`——那种自引用让「超管看到全部条目」
// 恒真,权限常量漂移(前端声明一个 Go 端根本不存在的权限点)就再也抓不到:
// 2026-09-12 实测 `error-monitoring:read` 在 rbac.go:43 被删除后,该页对
// **包括 super_admin 在内**的全部角色不可见,而测试依旧全绿。
// 若 Go 端增删权限点,这里必须同步修改——这正是本测试要产生的摩擦。
const GO_ALL_PERMISSIONS = [
  'user:read', 'user:write',
  'dept:read', 'dept:write',
  'auth:read', 'auth:write',
  'gateway:read', 'gateway:write',
  'usage:read', 'report:write', 'report:read',
  'market:read', 'market:write',
  'capability:read', 'capability:write',
  'connector:read', 'connector:write',
  'audit:read', 'audit:retention:write',
  'portal:read', 'portal:write',
  'server-info:read',
]

const superAdmin: MeUser = { role: 'super_admin', permissions: GO_ALL_PERMISSIONS }
const auditor: MeUser = { role: 'auditor', permissions: ['audit:read', 'usage:read', 'user:read'] }
const employee: MeUser = { role: 'user', permissions: [] }

const paths = (user: MeUser | null) => visibleNav(user).map((n) => n.to)

describe('导航权限过滤(P2-43)', () => {
  it('NAV_ENTRIES 声明的每个权限点都存在于 Go 权限全集(常量漂移守卫)', () => {
    const declared = [...new Set(NAV_ENTRIES.flatMap((n) => n.perms ?? []))].sort()
    expect(declared.filter((p) => !GO_ALL_PERMISSIONS.includes(p))).toEqual([])
  })

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
    expect(paths({ role: 'auditor', permissions: ['capability:read'] })).toEqual(['/capabilities'])
    expect(paths({ role: 'auditor', permissions: ['market:read'] })).toEqual(['/capabilities'])
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
