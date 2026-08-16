import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { Users, Settings2, BarChart3, Store, FolderOpen, LogOut, Globe, ScrollText } from 'lucide-react'
import { me, logout, request } from './api'
import { Button } from './components/ui/button'
import { cn } from './lib/utils'
import Login from './pages/Login'
import UsersPage from './pages/Users'
import Gateway from './pages/Gateway'
import Usage from './pages/Usage'
import Marketplace from './pages/Marketplace'
import Knowledge from './pages/Knowledge'
import Audit from './pages/Audit'

const nav = [
  { to: '/users', label: '用户', icon: Users },
  { to: '/gateway', label: '网关', icon: Settings2 },
  { to: '/usage', label: '用量', icon: BarChart3 },
  { to: '/knowledge', label: '知识库', icon: FolderOpen },
  { to: '/marketplace', label: '商城', icon: Store },
  { to: '/audit', label: '审计', icon: ScrollText },
]

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [baseURL, setBaseURL] = useState('')

  useEffect(() => {
    me().then(
      () => setAuthed(true),
      () => setAuthed(false)
    )
  }, [])

  useEffect(() => {
    if (!authed) return
    request('/api/admin/gateway')
      .then((g) => setBaseURL(g?.server_base_url ?? ''))
      .catch(() => setBaseURL(''))
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
                  setAuthed(false)
                }
              }}
            >
              <LogOut className="h-4 w-4" /> 登出
            </Button>
          </div>
        </aside>
        <main className="flex-1 overflow-auto p-6">
          <Routes>
            <Route path="/" element={<Navigate to="/users" />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/gateway" element={<Gateway />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/marketplace" element={<Marketplace />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="*" element={<Navigate to="/users" />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
