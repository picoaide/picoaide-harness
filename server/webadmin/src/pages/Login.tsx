import { useEffect, useState } from 'react'
import { login } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { User, Lock, Loader2, KeyRound, Network, ShieldCheck, LogOut } from 'lucide-react'

// 登录页 — DSH 风格;认证方式独立选择(local/ldap/openid/oidc),按后台启用显示
interface AuthMethod {
  name: string
  configured: boolean
}

const METHOD_META: Record<string, { label: string; desc: string; icon: any }> = {
  local: { label: '本地账号', desc: '用户名 + 密码', icon: KeyRound },
  ldap: { label: 'LDAP', desc: '企业目录认证', icon: Network },
  openid: { label: 'OpenID', desc: '浏览器跳转登录', icon: ShieldCheck },
  oidc: { label: 'OIDC', desc: '浏览器跳转登录', icon: ShieldCheck },
}

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [methods, setMethods] = useState<AuthMethod[]>([])
  const [method, setMethod] = useState('local')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 登录前拉取启用的认证方式(未认证端点 /api/admin/auth/methods)
  useEffect(() => {
    fetch('/api/admin/auth/methods')
      .then((r) => r.json())
      .then((d) => {
        const ms: AuthMethod[] = (d?.methods ?? []).filter((m: AuthMethod) => m?.name)
        setMethods(ms)
        if (ms.length > 0) setMethod(ms[0].name)
      })
      .catch(() => setMethods([{ name: 'local', configured: true }]))
  }, [])

  const current = methods.find((m) => m.name === method)
  const isPassword = method === 'local' || method === 'ldap'
  const isBrowser = method === 'openid' || method === 'oidc'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!current?.configured) return
    if (!isPassword) return
    setBusy(true)
    setError('')
    try {
      await login(username, password)
      onLoggedIn()
    } catch (err: any) {
      setError(err.message || '登录失败')
    } finally {
      setBusy(false)
    }
  }

  // 浏览器跳转登录(OpenID/OIDC)
  function browserLogin() {
    if (!current?.configured) return
    window.location.href = `/api/auth/${method}/login`
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F9FAFB] p-4">
      <div className="w-full max-w-[420px] rounded-xl border border-border bg-white p-6 shadow-[0_8px_30px_rgba(15,17,21,0.06)] sm:p-8">
        <div className="mb-6 text-center">
          {/* 品牌 mark:黑 tile(DSH 客户端一致) */}
          <div className="brand-tile mx-auto mb-4 h-14 w-14">
            <svg viewBox="0 0 1254 1254" className="h-8 w-8" fill="none" aria-hidden="true">
              <g transform="translate(627 627) scale(1.25) translate(-627 -627)">
                <path d="M 334 409 C 300 409 273 431 273 466 V 548 C 273 582 254 607 220 620 C 254 633 273 658 273 692 V 775 C 273 810 300 843 334 843" stroke="#FFFFFF" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M 920 409 C 954 409 981 431 981 466 V 548 C 981 582 1000 607 1034 620 C 1000 633 981 658 981 692 V 775 C 981 810 954 843 920 843" stroke="#FFFFFF" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="435" y1="627" x2="817" y2="627" stroke="#FFFFFF" strokeWidth="20" strokeLinecap="round" />
                <circle cx="435" cy="627" r="65" fill="#FFFFFF" />
                <circle cx="817" cy="627" r="65" fill="#FFFFFF" />
              </g>
            </svg>
          </div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">PicoAide 管理后台</h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground">Enterprise AI Gateway · Admin Console</p>
        </div>

        {/* 认证方式列表(按后台启用情况显示) */}
        {methods.length > 1 && (
          <div className="mb-5 grid grid-cols-2 gap-2">
            {methods.map((m) => {
              const meta = METHOD_META[m.name] ?? { label: m.name, desc: '', icon: KeyRound }
              const I = meta.icon
              const active = m.name === method
              return (
                <button
                  key={m.name}
                  type="button"
                  disabled={!m.configured}
                  onClick={() => { setMethod(m.name); setError('') }}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                    active
                      ? 'border-primary/50 bg-accent'
                      : m.configured
                        ? 'hover:bg-muted'
                        : 'cursor-not-allowed opacity-50'
                  }`}
                >
                  <I className="h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{meta.label}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{m.configured ? meta.desc : '未配置'}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {isPassword && (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username" className="text-[13px] text-foreground">用户名</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="username" className="pl-9" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus placeholder="请输入用户名" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-[13px] text-foreground">密码</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="password" type="password" className="pl-9" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="请输入密码" />
              </div>
            </div>
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600">{error}</div>
            )}
            <Button type="submit" className="h-10 w-full text-[15px] font-semibold" disabled={busy || !current?.configured}>
              {busy ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />登录中…</>) : '登 录'}
            </Button>
          </form>
        )}

        {isBrowser && (
          <div className="space-y-4">
            {!current?.configured && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600">
                该认证方式未配置,请联系管理员
              </div>
            )}
            <Button className="h-10 w-full text-[15px] font-semibold" disabled={!current?.configured} onClick={browserLogin}>
              <LogOut className="mr-2 h-4 w-4 rotate-180" />跳转 {METHOD_META[method]?.label ?? method} 登录
            </Button>
          </div>
        )}

        <p className="mt-6 text-center text-[11px] text-muted-foreground">© 2026 PicoAide · Enterprise Internal Deployment</p>
      </div>
    </div>
  )
}
