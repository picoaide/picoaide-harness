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
  // 0057: 密码/MFA 自助管理所需状态。
  password_must_change?: boolean
  password_changeable?: boolean
  mfa_enabled?: boolean
  source?: string
}

export function isAuditor(user: MeUser | null | undefined): boolean {
  return user?.role === 'auditor'
}

// ---------------------------------------------------------------------------
// 权限点常量(与服务端 serverauth/rbac.go 对齐;前端只作导航与入口可见性)。
// 2026-09-13(审计 R7 webadmin-branding-3)从 lib/nav.ts 迁到这里:nav 的 perms
// 声明与页面的能力判定必须用**同一份**常量,免得两处各写一份字符串而漂移。
// ---------------------------------------------------------------------------
export const PERM_USER_READ = 'user:read'
export const PERM_USER_WRITE = 'user:write'
export const PERM_DEPT_READ = 'dept:read'
export const PERM_DEPT_WRITE = 'dept:write'
export const PERM_AUTH_READ = 'auth:read'
export const PERM_GATEWAY_READ = 'gateway:read'
export const PERM_USAGE_READ = 'usage:read'
export const PERM_MARKET_READ = 'market:read'
export const PERM_CAP_READ = 'capability:read'
/** 能力中心写面(审批/上下架/归属转移等处置动作;应用中心复用同一点,见 §13)。 */
export const PERM_CAP_WRITE = 'capability:write'
export const PERM_CONNECTOR_READ = 'connector:read'
export const PERM_SERVERINFO_READ = 'server-info:read'
export const PERM_AUDIT_READ = 'audit:read'
/** 报表订阅列表(hook_url 是凭据本体;服务端**刻意**不发给 auditor,见 rbac.go)。 */
export const PERM_REPORT_READ = 'report:read'

// 当前登录管理员的模块级快照:App 在 /me 成功后写入(见 App.tsx),页面用
// hasPermission 做"体验层"判定 —— 隐藏拿不到的入口、**不请求必然 403 的接口**。
// 服务端 RequirePermission 才是护栏,这里不是安全边界。
let currentAdmin: MeUser | null = null

/** 记录当前管理员(登录/刷新后由 App 调用;登出传 null)。 */
export function setCurrentAdmin(user: MeUser | null): void {
  currentAdmin = user
}

/** 读取当前管理员快照(未登录/尚未拉到时为 null)。 */
export function currentAdminUser(): MeUser | null {
  return currentAdmin
}

/**
 * 当前用户是否持有权限点 perm。
 *
 * 缺省返回 **true**(放行):服务端未下发 permissions(旧版本/异常)或页面在
 * App 之外被直接渲染(组件测试)时"不知道权限",此时不该凭空收权 —— 与
 * nav.isNavVisible 的退回分支同口径。服务端 RequirePermission 仍是唯一护栏;
 * 只有**明确**下发了权限集且其中不含该点时才返回 false。
 */
export function hasPermission(perm: string, user: MeUser | null | undefined = currentAdmin): boolean {
  const granted = user?.permissions
  if (!Array.isArray(granted)) return true
  return granted.includes(perm)
}

export function roleLabel(role?: Role): string {
  switch (role) {
    case 'super_admin': return '超级管理员'
    case 'auditor': return '审计员'
    case 'user': return '普通员工'
    default: return '用户'
  }
}
