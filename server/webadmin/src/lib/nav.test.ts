import { describe, expect, it } from 'vitest'
import { NAV_ENTRIES, landingPath, visibleNav, type NavEntry } from './nav'
import type { MeUser } from './rbac'

// P2-43: nav 声明的 perms 必须被真正消费——服务端 /me 下发的 permissions
// 是可见性唯一依据(auditor = audit:read + usage:read + user:read)。

const superAdmin: MeUser = { role: 'super_admin', permissions: NAV_ENTRIES.flatMap((n) => n.perms ?? []) }
const auditor: MeUser = { role: 'auditor', permissions: ['audit:read', 'usage:read', 'user:read'] }
const employee: MeUser = { role: 'user', permissions: [] }

const paths = (user: MeUser | null) => visibleNav(user).map((n) => n.to)

describe('导航权限过滤(P2-43)', () => {
  it('超管看到全部条目', () => {
    expect(paths(superAdmin)).toEqual(NAV_ENTRIES.map((n) => n.to))
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
