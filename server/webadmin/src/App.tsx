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
        {/* 品牌暗色侧边栏 */}
        <aside className="flex w-56 flex-col bg-slate-900 text-slate-300">
          <div className="flex items-center gap-3 px-5 py-5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 shadow-md">
              <svg viewBox="0 0 32 32" className="h-5 w-5" fill="none" aria-hidden="true">
                <rect x="3" y="3" width="26" height="26" rx="7" fill="rgba(255,255,255,0.15)" stroke="white" strokeWidth="2" />
                <path d="M12 12 L20 16 L12 20 Z" fill="white" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-bold text-white">PicoAide</div>
              <div className="text-[11px] text-slate-400">企业 AI 管理后台</div>
            </div>
          </div>

          {baseURL && (
            <div className="mx-3 mb-4 flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-[11px] text-slate-400">
              <Globe className="h-3 w-3 shrink-0" />
              <a href={baseURL} target="_blank" rel="noreferrer" className="truncate hover:text-slate-200" title={baseURL}>{baseURL}</a>
            </div>
          )}

          <nav className="flex-1 space-y-1 px-3">
            <div className="px-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">管理中心</div>
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  cn(
                    'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all',
                    isActive
                      ? 'bg-gradient-to-r from-blue-600/90 to-cyan-600/70 font-medium text-white shadow-md'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-100',
                  )
                }
              >
                <n.icon className="h-4.5 w-4.5 h-[18px] w-[18px] shrink-0" />
                <span className="flex-1">{n.label}</span>
                <ChevronRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
              </NavLink>
            ))}
          </nav>

          <div className="border-t border-white/10 p-3">
            <div className="mb-2 flex items-center gap-2.5 rounded-lg bg-white/5 px-3 py-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-600 to-slate-700 text-xs font-semibold text-white">
                {adminName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-slate-200">{adminName}</div>
                <div className="flex items-center gap-1 text-[10px] text-slate-500"><ShieldCheck className="h-3 w-3" />超级管理员</div>
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
        <main className="flex-1 overflow-auto">
          {/* 顶部细条(品牌点缀) */}
          <div className="sticky top-0 z-10 h-1 w-full bg-gradient-to-r from-blue-600 via-cyan-500 to-blue-600" />
          <div className="mx-auto max-w-7xl p-6 lg:p-8">
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
