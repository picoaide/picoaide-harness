import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { Boxes, Settings2, SlidersHorizontal } from 'lucide-react'

// 应用中心的分区(2026-09-19 页面合并):原「应用平台」(`/app-platform`,并发/内存
// 限制项)并入本区成为「限制项」子页;「设置」子页承载应用访问域名(泛域名)等平台级配置。
//
// 与 usage/UsageLayout 的差别只有一处:**三个子页共用同一个权限点**
// (`capability:read` 读 / `capability:write` 写,与服务端 internal/router 的
// AdminRoute 申报一致),所以这里不做逐标签的权限过滤 —— 只读账号照样能看到三个
// 标签,页内的写控件各自缺席(见 Apps/Limits/Settings)。
interface AppCenterTab {
  to: string
  label: string
  icon: typeof Boxes
  /** 索引页必须精确匹配,否则 `/app-center/limits` 也会把「应用」点亮。 */
  end?: boolean
}

const TABS: AppCenterTab[] = [
  { to: '/app-center', label: '应用', icon: Boxes, end: true },
  { to: '/app-center/limits', label: '限制项', icon: SlidersHorizontal },
  { to: '/app-center/settings', label: '设置', icon: Settings2 },
]

export default function AppCenterLayout() {
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
