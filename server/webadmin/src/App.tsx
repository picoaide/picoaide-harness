import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { Users, Settings2, BarChart3, Store, FolderOpen, LogOut, Globe, ScrollText, Network } from 'lucide-react'
import { me, logout, request, setOnUnauthorized } from './api'
import { Button } from './components/ui/button'
import { cn } from './lib/utils'
import Login from './pages/Login'
import UsersPage from './pages/Users'
import Departments from './pages/Departments'
import Gateway from './pages/Gateway'
import Marketplace from './pages/Marketplace'
import Knowledge from './pages/Knowledge'
import Audit from './pages/Audit'

// Usage 页含 VChart(约 2.6MB 未压缩),懒加载避免污染首屏(审计2026-E1)
const Usage = lazy(() => import('./pages/Usage'))

const nav = [
  { to: '/users', label: '用户', icon: Users },
  { to: '/departments', label: '部门', icon: Network },
  { to: '/gateway', label: '网关', icon: Settings2 },
  { to: '/usage', label: '用量', icon: BarChart3 },
  { to: '/knowledge', label: '知识库', icon: FolderOpen },
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

  useEffect(() => {
    // 审计 A5-M3: 会话过期由全局回调原地切回登录态(取代整页跳转)
    setOnUnauthorized(() => setAuthed(false))
    return () => setOnUnauthorized(null)
  }, [])

  useEffect(() => {
    me().then(
      () => setAuthed(true),
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
      <div className="flex h-screen">
        <aside className="flex w-48 flex-col border-r bg-muted/30">
          <div className="px-4 py-4 text-lg font-bold">PicoAide 管理</div>
          {baseURL && (
            <div className="flex items-center gap-1.5 px-4 pb-3 text-xs text-muted-foreground">
              <Globe className="h-3 w-3 shrink-0" />
              <a href={baseURL} target="_blank" rel="noreferrer" className="truncate hover:text-foreground" title={baseURL}>
                {baseURL}
              </a>
            </div>
          )}
          <nav className="flex-1 space-y-1 px-2">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  cn('flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent', isActive && 'bg-accent')
                }
              >
                <n.icon className="h-4 w-4" />
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-destructive"
              onClick={async () => {
                try {
                  await logout()
                } finally {
                  try { sessionStorage.removeItem(BASE_URL_CACHE_KEY) } catch { /* ignore */ }
                  setAuthed(false)
                }
              }}
            >
              <LogOut className="h-4 w-4" /> 登出
            </Button>
          </div>
        </aside>
        <main className="flex-1 overflow-auto p-6">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Navigate to="/users" />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/departments" element={<Departments />} />
              <Route path="/gateway" element={<Gateway />} />
              <Route path="/usage" element={<Suspense fallback={<div className="text-muted-foreground">加载中…</div>}><Usage /></Suspense>} />
              <Route path="/knowledge" element={<Knowledge />} />
              <Route path="/marketplace" element={<Marketplace />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </BrowserRouter>
  )
}
