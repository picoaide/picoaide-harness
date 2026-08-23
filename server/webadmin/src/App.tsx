import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { Users, Settings2, BarChart3, Store, LogOut, Globe, ScrollText, Network, ShieldCheck, ChevronRight } from 'lucide-react'
import { me, logout, request, setOnUnauthorized } from './api'
import { Button } from './components/ui/button'
import { cn } from './lib/utils'
import Login from './pages/Login'
import UsersPage from './pages/Users'
import Departments from './pages/Departments'
import Gateway from './pages/Gateway'
import Marketplace from './pages/Marketplace'
import Audit from './pages/Audit'

// Usage 页含 VChart(约 2.6MB 未压缩),懒加载避免污染首屏(审计2026-E1)
const Usage = lazy(() => import('./pages/Usage'))

const nav = [
  { to: '/users', label: '用户', icon: Users },
  { to: '/departments', label: '部门', icon: Network },
  { to: '/gateway', label: '网关', icon: Settings2 },
  { to: '/usage', label: '用量', icon: BarChart3 },
  { to: '/marketplace', label: '商城', icon: Store },
  { to: '/audit', label: '审计', icon: ScrollText },
]

// 审计 A5-L7: 页面运行时异常不再白屏整树卸载,展示错误与重载入口
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
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
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6">
      <div className="text-lg font-semibold">404 页面不存在</div>
      <div className="text-sm text-muted-foreground">请从左侧导航进入对应功能</div>
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
    const g = await request('/api/admin/gateway')
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

  useEffect(() => {
    // 审计 A5-M3: 会话过期由全局回调原地切回登录态(取代整页跳转)
    setOnUnauthorized(() => setAuthed(false))
    return () => setOnUnauthorized(null)
  }, [])

  useEffect(() => {
    me().then(
      (body) => { setAuthed(true); setAdminName(body?.user?.display_name || body?.user?.username || '管理员') },
      () => setAuthed(false)
    )
  }, [])

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
      <div className="flex h-screen bg-background">
        {/* 品牌深海军蓝侧边栏(#0F172A 契约色) */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-[#0F172A] text-slate-300">
          <div className="flex items-center gap-3 px-5 pb-5 pt-6">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-blue-400/40 bg-blue-500/15">
              <svg viewBox="0 0 32 32" className="h-5 w-5" fill="none" aria-hidden="true">
                <rect x="3" y="3" width="26" height="26" rx="7" fill="rgba(59,130,246,0.18)" stroke="#60A5FA" strokeWidth="2" />
                <path d="M12 12 L20 16 L12 20 Z" fill="#93C5FD" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-bold tracking-tight text-white">PicoAide</div>
              <div className="text-[10px] font-medium uppercase tracking-widest text-slate-500">Admin Console</div>
            </div>
          </div>

          {baseURL && (
            <div className="mx-4 mb-4 flex items-center gap-1.5 rounded-md border border-slate-700/60 bg-slate-800/50 px-2.5 py-1.5 text-[10px] text-slate-400">
              <Globe className="h-3 w-3 shrink-0 text-slate-500" />
              <a href={baseURL} target="_blank" rel="noreferrer" className="truncate font-mono hover:text-slate-200" title={baseURL}>{baseURL}</a>
            </div>
          )}

          <nav className="flex-1 space-y-0.5 px-3">
            <div className="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Management</div>
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  cn(
                    'group relative flex items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors duration-150',
                    isActive
                      ? 'bg-blue-500/15 font-medium text-white'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {/* 激活左侧蓝条(swiss 垂直线) */}
                    {isActive && <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-blue-400" />}
                    <n.icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{n.label}</span>
                    <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-50" />
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="border-t border-slate-800 p-3">
            <div className="mb-2 flex items-center gap-2.5 rounded-md bg-slate-800/40 px-2.5 py-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-[11px] font-semibold text-blue-200">
                {adminName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-slate-200">{adminName}</div>
                <div className="flex items-center gap-1 text-[9px] text-slate-500"><ShieldCheck className="h-2.5 w-2.5" />SUPER ADMIN</div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-center text-slate-400 hover:bg-white/5 hover:text-red-400"
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
          {/* 顶部品牌渐变细条(3px,蓝→青) */}
          <div className="sticky top-0 z-20 h-0.5 shrink-0 bg-gradient-to-r from-[#1E40AF] via-[#3B82F6] to-[#D97706]" />
          <div className="mx-auto w-full max-w-[1440px] flex-1 p-6 lg:p-7">
            <ErrorBoundary>
              <Routes>
                <Route path="/" element={<Navigate to="/users" />} />
                <Route path="/users" element={<UsersPage />} />
                <Route path="/departments" element={<Departments />} />
                <Route path="/gateway" element={<Gateway />} />
                <Route path="/usage" element={<Suspense fallback={<div className="text-muted-foreground">加载中…</div>}><Usage /></Suspense>} />
                <Route path="/marketplace" element={<Marketplace />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </BrowserRouter>
  )
}
