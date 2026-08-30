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
