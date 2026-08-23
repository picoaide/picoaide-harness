import { useState } from 'react'
import { login } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { User, Lock, Loader2 } from 'lucide-react'

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
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* 背景光斑(企业品牌氛围) */}
      <div className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-blue-500/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-cyan-400/10 blur-3xl" />

      <div className="relative z-10 w-[400px] rounded-2xl border border-white/10 bg-white/95 p-8 shadow-2xl backdrop-blur">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-cyan-500 shadow-lg">
            <svg viewBox="0 0 32 32" className="h-8 w-8" fill="none" aria-hidden="true">
              <rect x="3" y="3" width="26" height="26" rx="7" fill="rgba(255,255,255,0.15)" stroke="white" strokeWidth="2" />
              <path d="M12 12 L20 16 L12 20 Z" fill="white" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">PicoAide 管理后台</h1>
          <p className="mt-2 text-sm text-slate-500">企业 AI 中台 · 使用超管账号登录</p>
        </div>

        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="username" className="text-slate-700">用户名</Label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input id="username" className="pl-10" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus placeholder="请输入用户名" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-slate-700">密码</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input id="password" type="password" className="pl-10" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="请输入密码" />
            </div>
          </div>
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
          )}
          <Button type="submit" className="w-full bg-gradient-to-r from-blue-600 to-cyan-500 py-2.5 text-base font-medium shadow-md transition-shadow hover:shadow-lg disabled:opacity-60" disabled={busy}>
            {busy ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />登录中…</>) : '登 录'}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-400">© 2026 PicoAide · 企业内网部署</p>
      </div>
    </div>
  )
}
