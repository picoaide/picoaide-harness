// 侧栏导航声明 + 可见性过滤(P2-43)。
//
// 背景:nav 条目早就声明了 `perms`,但 App 只按 role/section 过滤,`perms` 从未被读
// → 服务端 /me 下发 permissions 里明确允许的页面(auditor 的 user:read/usage:read)
// 在侧栏看不到,而横幅却写「可查看日志/用量/用户列表」。
//
// 规则:以服务端下发的 permissions 为唯一依据(前端只是体验层,服务端
// RequirePermission 才是护栏);某条目声明多个权限点时命中任一即可见。
// 未声明 perms 的条目 fail-closed(仅超管可见),防止以后新增页面漏声明。
import {
  Users, Settings2, KeyRound, BarChart3, Store, ScrollText, Network, Server, Bug, Plug,
  type LucideIcon,
} from 'lucide-react'
import type { MeUser } from './rbac'

// 权限点常量(与服务端 serverauth/rbac.go 对齐; 前端仅作导航可见性)。
export const PERM_USER_READ = 'user:read'
export const PERM_DEPT_READ = 'dept:read'
export const PERM_AUTH_READ = 'auth:read'
export const PERM_GATEWAY_READ = 'gateway:read'
export const PERM_ERRMON_READ = 'error-monitoring:read'
export const PERM_USAGE_READ = 'usage:read'
export const PERM_MARKET_READ = 'market:read'
export const PERM_CAP_READ = 'capability:read'
export const PERM_CONNECTOR_READ = 'connector:read'
export const PERM_SERVERINFO_READ = 'server-info:read'
export const PERM_AUDIT_READ = 'audit:read'

export interface NavEntry {
  to: string
  label: string
  icon: LucideIcon
  section: '管理' | '运维' | '审计'
  /** 可见所需权限点(任一命中即可);缺省 = 仅超管可见(fail-closed)。 */
  perms?: string[]
}

export const NAV_ENTRIES: NavEntry[] = [
  // 管理分区(super_admin 专属; auditor 仅有 user:read 只读)
  { to: '/users', label: '用户', icon: Users, section: '管理', perms: [PERM_USER_READ] },
  { to: '/departments', label: '部门', icon: Network, section: '管理', perms: [PERM_DEPT_READ] },
  { to: '/auth', label: '认证', icon: KeyRound, section: '管理', perms: [PERM_AUTH_READ] },
  // 运维分区(super_admin; auditor 仅有 usage:read)
  { to: '/gateway', label: '网关', icon: Settings2, section: '运维', perms: [PERM_GATEWAY_READ] },
  { to: '/error-monitoring', label: '错误监控', icon: Bug, section: '运维', perms: [PERM_ERRMON_READ] },
  { to: '/usage', label: '用量中心', icon: BarChart3, section: '运维', perms: [PERM_USAGE_READ] },
  // 2026-09-02:合并「市场 · 技能」与「能力中心」为单入口(客户端同构)。
  { to: '/capabilities', label: '能力中心', icon: Store, section: '运维', perms: [PERM_MARKET_READ, PERM_CAP_READ] },
  { to: '/connectors', label: '连接器', icon: Plug, section: '运维', perms: [PERM_CONNECTOR_READ] },
  { to: '/server-info', label: '服务器信息', icon: Server, section: '运维', perms: [PERM_SERVERINFO_READ] },
  // 审计分区(auditor + super_admin 只读)
  { to: '/audit', label: '审计日志', icon: ScrollText, section: '审计', perms: [PERM_AUDIT_READ] },
]

/** 单个条目是否对当前用户可见。 */
export function isNavVisible(entry: NavEntry, user: MeUser | null | undefined): boolean {
  const granted = user?.permissions
  if (Array.isArray(granted)) {
    if (!entry.perms || entry.perms.length === 0) return user?.role === 'super_admin'
    return entry.perms.some((p) => granted.includes(p))
  }
  // 服务端未下发 permissions(旧版本/异常):退回角色判定,至少不放大可见面。
  if (user?.role === 'super_admin') return true
  if (user?.role === 'auditor') return entry.section === '审计'
  return false
}

/** 按服务端权限过滤后的导航(P2-43)。 */
export function visibleNav(user: MeUser | null | undefined): NavEntry[] {
  return NAV_ENTRIES.filter((n) => isNavVisible(n, user))
}

/** 登录落地页:审计员优先审计日志(只读主视图),否则第一个可见条目。 */
export function landingPath(user: MeUser | null | undefined): string {
  const visible = visibleNav(user)
  if (user?.role === 'auditor' && visible.some((n) => n.to === '/audit')) return '/audit'
  return visible[0]?.to ?? '/users'
}
