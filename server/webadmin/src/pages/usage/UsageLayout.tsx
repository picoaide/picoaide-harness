import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { LayoutDashboard, Network, Users, Cpu, ScrollText, Wallet, CalendarClock } from 'lucide-react'
import {
  PERM_DEPT_READ, PERM_REPORT_READ, PERM_USAGE_READ, PERM_USER_READ, hasPermission,
} from '../../lib/rbac'

// 每个标签声明它依赖的权限点(与服务端 internal/router 的 AdminRoute 声明一一对应)。
//
// 审计 R7 webadmin-branding-3:这张表原来是**静态**的 —— auditor(只有
// audit:read/usage:read/user:read)照样看到「部门用量」(要 dept:read)与
// 「报表订阅」(要 report:read,服务端**刻意**不给 auditor:列表里的 hook_url
// 是凭据本体,见 rbac.go),点进去首屏就是 403 空页。导航是体验层,权限是
// 服务端护栏;体验层不该把用户领到一个必然 403 的页面。
interface UsageTab {
  to: string
  label: string
  icon: typeof LayoutDashboard
  end?: boolean
  perm: string
}

const TABS: UsageTab[] = [
  { to: '/usage', label: '总览', icon: LayoutDashboard, end: true, perm: PERM_USAGE_READ },
  { to: '/usage/depts', label: '部门用量', icon: Network, perm: PERM_DEPT_READ },
  { to: '/usage/members', label: '成员用量', icon: Users, perm: PERM_USER_READ },
  { to: '/usage/models', label: '模型分析', icon: Cpu, perm: PERM_USAGE_READ },
  { to: '/usage/logs', label: '请求日志', icon: ScrollText, perm: PERM_USAGE_READ },
  { to: '/usage/balance', label: '余额', icon: Wallet, perm: PERM_USER_READ },
  { to: '/usage/reports', label: '报表订阅', icon: CalendarClock, perm: PERM_REPORT_READ },
]

// 用量中心子导航:每页只聚焦一个主题(2026-09-11:配额/预算下线,只剩「余额」)
export default function UsageLayout() {
  const tabs = TABS.filter((t) => hasPermission(t.perm))
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-colors',
                isActive ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )
            }
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  )
}
