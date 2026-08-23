import { useState } from 'react'
import { login } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { User, Lock, Loader2, ShieldCheck, Database, Cpu } from 'lucide-react'

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
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-[#0F172A]">
      {/* 数据网格背景(企业控制台氛围) */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(148,163,184,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.5) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      {/* 品牌光晕 */}
      <div className="pointer-events-none absolute -top-40 left-1/4 h-96 w-96 rounded-full bg-blue-600/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 right-1/4 h-96 w-96 rounded-full bg-cyan-500/10 blur-3xl" />

      <div className="relative z-10 w-[420px] rounded-xl border border-slate-700/60 bg-white p-8 shadow-[0_25px_60px_rgba(0,0,0,0.35)]">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex h-13 w-13 h-14 w-14 items-center justify-center rounded-lg border border-blue-200 bg-blue-50">
            <svg viewBox="0 0 32 32" className="h-8 w-8" fill="none" aria-hidden="true">
              <rect x="3" y="3" width="26" height="26" rx="7" fill="rgba(30,64,175,0.06)" stroke="#1E40AF" strokeWidth="2" />
              <path d="M12 12 L20 16 L12 20 Z" fill="#1E40AF" />
            </svg>
          </div>
          <h1 className="text-[22px] font-bold tracking-tight text-[#0F172A]">PicoAide 管理后台</h1>
          <p className="mt-1.5 text-[13px] text-slate-500">Enterprise AI Gateway · Admin Console</p>
        </div>

        {/* 能力徽标行(信任信号,契约:trust signals prominent) */}
        <div className="mb-6 grid grid-cols-3 gap-2 border-y border-slate-100 py-3">
          {[
            { icon: ShieldCheck, label: '本地认证' },
            { icon: Database, label: '密钥托管' },
            { icon: Cpu, label: '计量计费' },
          ].map(({ icon: I, label }) => (
            <div key={label} className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500">
              <I className="h-3.5 w-3.5 text-[#1E40AF]" />{label}
            </div>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="username" className="text-[13px] text-slate-700">用户名</Label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input id="username" className="pl-9" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus placeholder="请输入用户名" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-[13px] text-slate-700">密码</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
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

        <p className="mt-6 text-center text-[11px] text-slate-400">© 2026 PicoAide · Enterprise Internal Deployment</p>
      </div>
    </div>
  )
}
