import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { LayoutDashboard, Network, Users, Cpu, ScrollText, WalletCards, CalendarClock } from 'lucide-react'

const TABS = [
  { to: '/usage', label: '总览', icon: LayoutDashboard, end: true },
  { to: '/usage/depts', label: '部门用量', icon: Network },
  { to: '/usage/members', label: '成员用量', icon: Users },
  { to: '/usage/models', label: '模型分析', icon: Cpu },
  { to: '/usage/logs', label: '请求日志', icon: ScrollText },
  { to: '/usage/quota', label: '配额与预算', icon: WalletCards },
  { to: '/usage/reports', label: '报表订阅', icon: CalendarClock },
]

// 用量中心子导航:6 个二级页统一样式,每页只聚焦一个主题
export default function UsageLayout() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
        {TABS.map((t) => (
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
