// RBAC 前端权限工具(设计 v3b): nav 与页面可见性由服务端下发的
// permissions 驱动——前端只是体验层, 服务端 RequirePermission 才是护栏。
// auditor 的只读模式在此收敛(横幅 + 隐藏写入口)。

export type Role = 'super_admin' | 'auditor' | 'user'

export interface MeUser {
  id?: number
  username?: string
  display_name?: string
  role?: Role
  permissions?: string[]
}

export function hasPerm(user: MeUser | null | undefined, perm: string): boolean {
  return !!user?.permissions?.includes(perm)
}

export function isAuditor(user: MeUser | null | undefined): boolean {
  return user?.role === 'auditor'
}

export function roleLabel(role?: Role): string {
  switch (role) {
    case 'super_admin': return '超级管理员'
    case 'auditor': return '审计员'
    case 'user': return '普通员工'
    default: return '用户'
  }
}

/** Nav 项声明: 需要的权限(任一命中)或直接角色判定。 */
export interface NavItem {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  /** 任意命中即可见; 缺省 = super_admin 专属(管理分区) */
  perms?: string[]
  /** 分区标题; 缺省 = 管理 */
  section?: '管理' | '运维' | '审计'
}

export function visibleFor(user: MeUser | null | undefined, item: NavItem): boolean {
  if (!user?.permissions) return false
  if (item.perms && item.perms.length > 0) {
    return item.perms.some((p) => user.permissions!.includes(p))
  }
  // 无 perms: super_admin 专属
  return user.role === 'super_admin'
}
