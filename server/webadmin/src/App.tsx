import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link } from 'react-router-dom'
import { Users, Settings2, KeyRound, BarChart3, Store, LogOut, Globe, ScrollText, Network, ShieldCheck, ChevronRight, SearchX, Server, Bug, Plug, Menu, X, Palette, Lock, Eye } from 'lucide-react'
import { me, logout, request, setOnUnauthorized, ADMIN_API, CLIENT_API } from './api'
import { Button } from './components/ui/button'
import { cn } from './lib/utils'
import { isAuditor, roleLabel, type MeUser } from './lib/rbac'
import { PasswordDialog } from './components/password-dialog'
import { MFASettingsDialog } from './components/mfa-settings-dialog'
import { BRAND_LOGO_URL } from './lib/brand-assets'
import Login from './pages/Login'

// 路由级懒加载(性能优化 2026-P):各页面拆成独立 JS chunk,首屏只加载
// 当前路由页面;其余页面(含各自依赖)在导航时按需加载,降低首屏体积。
const UsersPage = lazy(() => import('./pages/Users'))
const Departments = lazy(() => import('./pages/Departments'))
const Gateway = lazy(() => import('./pages/Gateway'))
const Auth = lazy(() => import('./pages/Auth'))
const ErrorMonitoring = lazy(() => import('./pages/ErrorMonitoring'))
const Audit = lazy(() => import('./pages/Audit'))
const ServerInfo = lazy(() => import('./pages/ServerInfo'))
// 2026-09-02:「市场 · 技能」与「能力中心」合并为单入口(与客户端 IA 对齐)。
const CapabilityCenter = lazy(() => import('./pages/CapabilityCenter'))
const Connectors = lazy(() => import('./pages/Connectors'))
const Brand = lazy(() => import('./pages/Brand'))

// Usage 相关页含 VChart(约 2.6MB 未压缩),懒加载避免污染首屏(审计2026-E1)。
// 用量中心(2026-09 重构):子导航布局 + 6 个二级页。
const UsageLayout = lazy(() => import('./pages/usage/UsageLayout'))
const UsageOverview = lazy(() => import('./pages/usage/Overview'))
const UsageDepartments = lazy(() => import('./pages/usage/Departments'))
const UsageMembers = lazy(() => import('./pages/usage/Members'))
const UsageMemberDetail = lazy(() => import('./pages/usage/MemberDetail'))
const UsageModels = lazy(() => import('./pages/usage/Models'))
const UsageLogs = lazy(() => import('./pages/usage/Logs'))
const UsageQuota = lazy(() => import('./pages/usage/Quota'))
const UsageReports = lazy(() => import('./pages/usage/Reports'))

// 权限点常量(与服务端 serverauth/rbac.go 对齐; 前端仅作导航可见性)。
const PERM_AUTH_READ = 'auth:read'
const PERM_BRAND_READ = 'brand:read'
const PERM_GATEWAY_READ = 'gateway:read'
const PERM_ERRMON_READ = 'error-monitoring:read'
const PERM_USAGE_READ = 'usage:read'
const PERM_MARKET_READ = 'market:read'
const PERM_CAP_READ = 'capability:read'
const PERM_CONNECTOR_READ = 'connector:read'
const PERM_SERVERINFO_READ = 'server-info:read'
const PERM_AUDIT_READ = 'audit:read'

interface NavEntry {
  to: string
  label: string
  icon: any
  section: '管理' | '运维' | '审计'
  perms?: string[]
}

const nav: NavEntry[] = [
  // 管理分区(super_admin 专属; auditor 无这些权限)
  { to: '/users', label: '用户', icon: Users, section: '管理' },
  { to: '/departments', label: '部门', icon: Network, section: '管理' },
  { to: '/auth', label: '认证', icon: KeyRound, section: '管理', perms: [PERM_AUTH_READ] },
  { to: '/brand', label: '品牌', icon: Palette, section: '管理', perms: [PERM_BRAND_READ] },
  // 运维分区(super_admin)
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

// 审计 A5-L7: 页面运行时异常不再白屏整树卸载,展示错误与重载入口
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="text-lg font-semibold text-destructive">页面出错了</div>
          <div className="max-w-md text-sm text-muted-foreground">{this.state.error.message}</div>
          <Button size="sm" variant="outline" onClick={() => { this.setState({ error: null }); window.location.reload() }}>
            重新加载
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}

// 审计 A5-L7: 未知路径给出 404 提示,不再静默跳回 /users(排障困难)
function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-50 text-[#1E40AF]">
        <SearchX className="h-7 w-7" />
      </div>
      <div className="space-y-1">
        <div className="text-lg font-semibold">404 页面不存在</div>
        <div className="text-sm text-muted-foreground">请从左侧导航进入对应功能</div>
      </div>
      <Link to="/users">
        <Button>返回用户管理</Button>
      </Link>
    </div>
  )
}

// 审计 A5-L11: 侧栏 server_base_url 只在 5 分钟内首次进入时拉取一次网关列表,
// 避免每次整页刷新都为单个链接重复拉取全量网关配置。
const BASE_URL_CACHE_KEY = 'picoaide.base_url'
const BASE_URL_CACHE_TTL = 5 * 60 * 1000

async function fetchBaseURL(): Promise<string> {
  try {
    const raw = sessionStorage.getItem(BASE_URL_CACHE_KEY)
    if (raw) {
      const cached = JSON.parse(raw) as { v: string; t: number }
      if (Date.now() - cached.t < BASE_URL_CACHE_TTL) return cached.v
    }
  } catch { /* 缓存损坏按未命中处理 */ }
  try {
    const g = await request(`${ADMIN_API}/gateway`)
    const v = g?.server_base_url ?? ''
    try { sessionStorage.setItem(BASE_URL_CACHE_KEY, JSON.stringify({ v, t: Date.now() })) } catch { /* ignore */ }
    return v
  } catch {
    return ''
  }
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [baseURL, setBaseURL] = useState('')
  const [adminName, setAdminName] = useState('')
  const [meUser, setMeUser] = useState<MeUser | null>(null)
  // v3b §5.2: webadmin 自身品牌跟随(登录后从 /api/brand 拉取)。
  const [brand, setBrand] = useState<{ login?: { display_name?: string; logo_url?: string; tagline?: string }; client?: { display_name?: string; tagline?: string } } | null>(null)
  // 移动端侧栏抽屉开关(< lg 断点;桌面 lg 固定展开)
  const [mobileNav, setMobileNav] = useState(false)
  // 0057 密码/MFA 自助管理
  const [pwdOpen, setPwdOpen] = useState(false)
  const [mfaOpen, setMfaOpen] = useState(false)
  const [forceChange, setForceChange] = useState(false)

  useEffect(() => {
    // 审计 A5-M3: 会话过期由全局回调原地切回登录态(取代整页跳转)
    setOnUnauthorized(() => {
      setAuthed(false)
      setForceChange(false)
    })
    return () => setOnUnauthorized(null)
  }, [])

  useEffect(() => {
    me().then(
      async (body) => {
        setAuthed(true)
        const u = body?.user as MeUser | undefined
        setMeUser(u ?? null)
        setAdminName(u?.display_name || u?.username || '管理员')
        // 0057: 管理员重置密码后强制改密拦截(完成前业务端点均被 403)。
        if (u?.password_must_change) setForceChange(true)
        // 品牌跟随: 公开端点(登录前也可用), 失败忽略(默认品牌)。
        try {
          const b = await request(`${CLIENT_API}/brand`) as { enabled?: boolean; login?: { display_name?: string; logo_url?: string; tagline?: string } }
          setBrand(b?.enabled ? b : null)
        } catch { /* default brand */ }
      },
      () => setAuthed(false)
    )
  }, [])

  // 可见 nav: 按角色权限过滤(体验层; 服务端 RequirePermission 为护栏)。
  const visibleNav = nav.filter((n) => {
    if (meUser?.role === 'super_admin') return true
    if (meUser?.role === 'auditor') return n.section === '审计'
    return false
  })

  // 落地页: 角色第一个有权限的分区。
  const landingPath = meUser?.role === 'auditor' ? '/audit' : nav[0]?.to ?? '/users'

  useEffect(() => {
    if (!authed) return
    let alive = true
    fetchBaseURL().then((v) => { if (alive) setBaseURL(v) })
    return () => { alive = false }
  }, [authed])

  if (authed === null) return <div className="flex h-screen items-center justify-center text-muted-foreground">加载中…</div>

  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />

  return (
    <BrowserRouter basename="/admin">
      {/* DSH 风:浅色界面 + 白色侧栏 + 黑 logo tile + 蓝 accent;移动端侧栏为抽屉 */}
      <div className="flex h-screen bg-background">
        {/* 遮罩(移动端抽屉打开时) */}
        {mobileNav && (
          <div
            className="fixed inset-0 z-30 bg-black/30 lg:hidden"
            onClick={() => setMobileNav(false)}
            aria-hidden="true"
          />
        )}

        {/* 侧边栏:桌面 lg 固定展开;移动端 fixed 抽屉 */}
        <aside
          className={cn(
            'z-40 flex w-60 shrink-0 flex-col border-r border-border bg-[#FFFFFF] transition-transform duration-200',
            // 桌面:常驻;移动:隐藏,抽屉开启时滑入
            'fixed inset-y-0 left-0 lg:static lg:translate-x-0',
            mobileNav ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex items-center gap-3 px-4 pb-4 pt-5">
            {/* 品牌 mark: 编译期注入 brands/official/logo.svg(黑 tile + 白花括号) */}
            <img src={BRAND_LOGO_URL} alt="logo" className="h-9 w-9 shrink-0 object-contain" draggable={false} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-bold tracking-tight text-foreground">{brand?.login?.display_name || 'PicoAide'}</div>
              <div className="text-[10px] font-medium text-muted-foreground">Admin Console</div>
            </div>
            {/* 移动端关闭按钮 */}
            <button
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted lg:hidden"
              onClick={() => setMobileNav(false)}
              aria-label="关闭导航"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {baseURL && (
            <div className="mx-3 mb-3 flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[10px] text-muted-foreground">
              <Globe className="h-3 w-3 shrink-0" />
              <a href={baseURL} target="_blank" rel="noreferrer" className="truncate font-mono hover:text-foreground" title={baseURL}>{baseURL}</a>
            </div>
          )}

          <nav className="flex-1 space-y-0.5 px-3 overflow-y-auto">
            {(['管理', '运维', '审计'] as const).map((section) => {
              const items = visibleNav.filter((n) => n.section === section)
              if (items.length === 0) return null
              return (
                <div key={section}>
                  <div className="px-3 pb-1.5 pt-1 text-[11px] font-semibold text-muted-foreground">{section}</div>
                  {items.map((n) => (
                    <NavLink
                      key={n.to}
                      to={n.to}
                      onClick={() => setMobileNav(false)}
                      className={({ isActive }) =>
                        cn(
                          'group relative flex items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors duration-150',
                          isActive
                            ? 'bg-accent font-semibold text-accent-foreground'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {/* 激活左侧 accent 蓝条(DSH 激活态语义) */}
                          {isActive && <span className="absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-primary" />}
                          <n.icon className="h-4 w-4 shrink-0" />
                          <span className="flex-1">{n.label}</span>
                          <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-50" />
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              )
            })}
          </nav>

          <div className="border-t border-border p-3">
            <div className="mb-2 flex items-center gap-2.5 rounded-md bg-muted/60 px-2.5 py-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                {adminName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-foreground">{adminName}</div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  {isAuditor(meUser) ? <Eye className="h-2.5 w-2.5" /> : <ShieldCheck className="h-2.5 w-2.5" />}
                  {roleLabel(meUser?.role)}
                </div>
              </div>
            </div>
              {/* 0057 密码/MFA 自助管理(任意管理角色; 服务端守卫 = 会话+CSRF+旧密码/动态码) */}
              <div className="mb-1.5 grid grid-cols-2 gap-1.5">
                <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => setPwdOpen(true)}>
                  <KeyRound className="h-3 w-3" /> 修改密码
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => setMfaOpen(true)}>
                  <ShieldCheck className="h-3 w-3" /> 安全设置
                </Button>
              </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-center text-muted-foreground hover:bg-muted hover:text-destructive"
              onClick={async () => {
                try {
                  await logout()
                } finally {
                  try { sessionStorage.removeItem(BASE_URL_CACHE_KEY) } catch { /* ignore */ }
                  setAuthed(false)
                }
              }}
            >
              <LogOut className="h-4 w-4" /> 退出登录
            </Button>
          </div>
        </aside>

        {/* 主内容区 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-auto">
          {/* auditor 只读横幅(体验提示; 服务端 403 兜底) */}
          {isAuditor(meUser) && (
            <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] font-medium text-amber-700">
              <Lock className="h-3.5 w-3.5" />
              当前为审计只读视图 —— 可查看日志/用量/用户列表, 所有修改已禁用
            </div>
          )}
          {/* 移动端顶部栏:汉堡菜单 + 标题(桌面隐藏) */}
          <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
            <button
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
              onClick={() => setMobileNav(true)}
              aria-label="打开导航"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2">
              <img src={BRAND_LOGO_URL} alt="logo" className="h-6 w-6 object-contain" draggable={false} />
              <span className="text-[15px] font-bold">PicoAide 管理</span>
            </div>
          </div>
          <div className="mx-auto w-full max-w-[1440px] flex-1 p-4 sm:p-6 lg:p-7">
            <ErrorBoundary>
              <Suspense fallback={<div className="flex h-full items-center justify-center text-muted-foreground">加载中…</div>}>
                <Routes>
                  <Route path="/" element={<Navigate to={landingPath} />} />
                  <Route path="/users" element={<UsersPage />} />
                  <Route path="/departments" element={<Departments />} />
                  <Route path="/gateway" element={<Gateway />} />
                  <Route path="/auth" element={<Auth />} />
                  <Route path="/brand" element={<Brand />} />
                  <Route path="/error-monitoring" element={<ErrorMonitoring />} />
                  <Route path="/usage" element={<UsageLayout />}>
                    <Route index element={<UsageOverview />} />
                    <Route path="depts" element={<UsageDepartments />} />
                    <Route path="members" element={<UsageMembers />} />
                    <Route path="members/:username" element={<UsageMemberDetail />} />
                    <Route path="models" element={<UsageModels />} />
                    <Route path="logs" element={<UsageLogs />} />
                    <Route path="quota" element={<UsageQuota />} />
                    <Route path="reports" element={<UsageReports />} />
                  </Route>
                  <Route path="/marketplace" element={<Navigate to="/capabilities?tab=market" replace />} />
                  <Route path="/capabilities" element={<CapabilityCenter />} />
                  <Route path="/connectors" element={<Connectors />} />
                  <Route path="/audit" element={<Audit />} />
                  <Route path="/server-info" element={<ServerInfo />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {/* 0057 密码/MFA 自助管理对话框 */}
      <PasswordDialog
        open={pwdOpen}
        onOpenChange={setPwdOpen}
        onDone={async () => {
          // 改密后服务端吊销全部会话(含当前) → 前端登出
          try { await logout() } catch { /* session already revoked */ }
          try { sessionStorage.removeItem(BASE_URL_CACHE_KEY) } catch { /* ignore */ }
          setAuthed(false)
          setForceChange(false)
        }}
      />
      <MFASettingsDialog open={mfaOpen} onOpenChange={setMfaOpen} onChanged={() => {
        // MFA 状态变化后刷新自身信息(安全设置菜单旁的徽章等)
        me().then((b) => setMeUser((b?.user as MeUser) ?? null)).catch(() => { /* ignore */ })
      }} />
      {/* 强制改密拦截(不可关闭): 完成改密后服务端吊销当前会话 → 回登录页 */}
      {forceChange && (
        <PasswordDialog
          open
          force
          onOpenChange={() => { /* noop: 拦截不可关闭 */ }}
          onDone={async () => {
            try { await logout() } catch { /* session already revoked */ }
            try { sessionStorage.removeItem(BASE_URL_CACHE_KEY) } catch { /* ignore */ }
            setForceChange(false)
            setAuthed(false)
          }}
        />
      )}
    </BrowserRouter>
  )
}
