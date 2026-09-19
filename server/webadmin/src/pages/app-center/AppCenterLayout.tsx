import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { BarChart3, Boxes, SlidersHorizontal } from 'lucide-react'

// 应用中心的分区(2026-09-19 页面合并):原「应用平台」(`/app-platform`,并发/内存
// 限制项)并入本区成为「限制项」子页。
//
// 2026-09-19 WASM 客户端专属改造:原「设置」子页(应用访问域名/泛域名)整页删除 ——
// 应用只在桌面客户端内以 `picoaide-app://<app_id>/` 打开(契约
// `docs/decisions/2026-09-19-wasm-client-internal-origin.md` §2/§4.4/§4.5),
// 服务端的应用基域配置面(`wasm.apps_base_domain`、`/wasm-apps/domain`)随之删除,
// 子导航项与路由入口一并去掉。**被删的配置不再有任何替代入口**(不是搬到了别处),
// 因此在这里留一行说明,免得管理员反复找「应用域名」去哪了。
//
// 2026-09-19 第四节(W5,契约 §3 F14/F16):新增「运营看板」子页 —— 打开次数是
// **运营视图**(PV/UV/趋势/热门 TOP N),与「应用」页的处置动作是两类事:
// 混在一页里会让"看数据"和"改配置"互相挤占,也更容易把看板数字误读成列表属性。
//
// 与 usage/UsageLayout 的差别只有一处:**全部子页共用同一个权限点**
// (`capability:read` 读 / `capability:write` 写,与服务端 internal/router 的
// AdminRoute 申报一致),所以这里不做逐标签的权限过滤 —— 只读账号照样能看到三个
// 标签,页内的写控件各自缺席(见 Apps/Limits/OpensBoard)。
interface AppCenterTab {
  to: string
  label: string
  icon: typeof Boxes
  /** 索引页必须精确匹配,否则 `/app-center/limits` 也会把「应用」点亮。 */
  end?: boolean
}

const TABS: AppCenterTab[] = [
  { to: '/app-center', label: '应用', icon: Boxes, end: true },
  { to: '/app-center/opens', label: '运营看板', icon: BarChart3 },
  { to: '/app-center/limits', label: '限制项', icon: SlidersHorizontal },
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
      {/* 原「设置」子页的位置(2026-09-19)。这行说明是**有意保留**的:配置面删掉后
          界面上再无"应用域名/证书"字样,不说明会被读成"功能被藏起来了"。 */}
      <p className="text-[11px] text-muted-foreground" data-testid="app-center-client-only-note">
        应用只在桌面客户端内打开，不再需要应用域名与证书。
      </p>
      <Outlet />
    </div>
  )
}
