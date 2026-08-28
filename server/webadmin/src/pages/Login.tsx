import { useState } from 'react'
import { login } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { User, Lock, Loader2 } from 'lucide-react'

// 登录页 — Data-Dense Dashboard 企业风(契约:信赖蓝 + 深海军蓝 + Fira)
export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F9FAFB] p-4">
      <div className="w-full max-w-[400px] rounded-xl border border-border bg-white p-8 shadow-[0_8px_30px_rgba(15,17,21,0.06)]">
        <div className="mb-7 text-center">
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
          <Button type="submit" className="h-10 w-full text-[15px] font-semibold" disabled={busy}>
            {busy ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />登录中…</>) : '登 录'}
          </Button>
        </form>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">© 2026 PicoAide · Enterprise Internal Deployment</p>
      </div>
    </div>
  )
}
