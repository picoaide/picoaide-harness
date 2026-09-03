import { useEffect, useState } from 'react'
import { login, loginMFA } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { User, Lock, Loader2, KeyRound, ShieldCheck } from 'lucide-react'
import { CLIENT_API } from '../api'
import { BRAND_LOGO_URL } from '../lib/brand-assets'

// 管理后台登录页 — v3b: 仅本地账号密码。
// SSO(OIDC/OpenID)与 LDAP 一律不进管理后台: 后台是本地账户唯一入口,
// 与员工客户端登录面完全隔离(服务端 AuthenticateConfiguredAdmin local-only)。
// 0057: 管理员开启 MFA 后为两步登录状态机(密码 → TOTP 动态码)。

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [step, setStep] = useState<'password' | 'mfa'>('password')
  const [ticket, setTicket] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // v3b §5.2: 登录页品牌跟随(公开端点)。
  const [brand, setBrand] = useState<{ display_name?: string; logo_url?: string; tagline?: string } | null>(null)

  useEffect(() => {
    fetch(`${CLIENT_API}/brand`).then((r) => r.json()).then((d: any) => {
      if (d?.enabled && d.login) setBrand(d.login)
    }).catch(() => { /* default */ })
  }, [])

  useEffect(() => {
    // 管理后台只允许本地账户: 无方式选择器, 直接聚焦用户名。
    if (step === 'password') {
      const el = document.getElementById('admin-username')
      if (el) el.focus()
    } else {
      const el = document.getElementById('admin-mfa-code')
      if (el) el.focus()
    }
  }, [step])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = await login(username, password)
      if (body?.mfa_required) {
        setTicket(body.mfa_ticket)
        setCode('')
        setStep('mfa')
        return
      }
      onLoggedIn()
    } catch (err: any) {
      setError(err.message || '登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function submitMFA(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await loginMFA(ticket, code.trim())
      onLoggedIn()
    } catch (err: any) {
      setError(err.message || '动态码验证失败')
    } finally {
      setBusy(false)
    }
  }

  // 兜底图形: 编译期从 brands/official/logo.svg 注入(见 ../lib/brand-assets),
  // 与客户端/门户同源; 禁止手写 SVG 几何或字母 P 等编造图形(旧版已退役)。
  const logo = brand?.logo_url ? (
    <img src={brand.logo_url} alt="logo" className="mx-auto mb-4 h-14 w-14 rounded-lg object-contain" />
  ) : (
    <img src={BRAND_LOGO_URL} alt="logo" className="mx-auto mb-4 h-14 w-14 object-contain" draggable={false} />
  )

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F9FAFB] p-4">
      <div className="w-full max-w-[420px] rounded-xl border border-border bg-white p-6 shadow-[0_8px_30px_rgba(15,17,21,0.06)] sm:p-8">
        <div className="mb-6 text-center">
          {logo}
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">{brand?.display_name || 'PicoAide'} 管理后台</h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground">Enterprise AI Gateway · Admin Console</p>
          {step === 'password' ? (
            <p className="mt-1 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
              <KeyRound className="h-3 w-3" />
              仅限本地账户登录（SSO/LDAP 不适用于管理后台）
            </p>
          ) : (
            <p className="mt-1 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
              <ShieldCheck className="h-3 w-3" />
              该账户已开启双重验证,请输入验证器动态码
            </p>
          )}
        </div>

        {step === 'password' ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="admin-username" className="text-[13px] text-foreground">用户名</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="admin-username" className="pl-9" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus placeholder="请输入用户名" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-password" className="text-[13px] text-foreground">密码</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="admin-password" type="password" className="pl-9" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="请输入密码" />
              </div>
            </div>
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600">{error}</div>
            )}
            <Button type="submit" className="h-10 w-full text-[15px] font-semibold" disabled={busy}>
              {busy ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />登录中…</>) : '登 录'}
            </Button>
          </form>
        ) : (
          <form onSubmit={submitMFA} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="admin-mfa-code" className="text-[13px] text-foreground">动态验证码</Label>
              <div className="relative">
                <ShieldCheck className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="admin-mfa-code" className="pl-9 font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="one-time-code" maxLength={6} placeholder="6 位数字" />
              </div>
            </div>
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600">{error}</div>
            )}
            <Button type="submit" className="h-10 w-full text-[15px] font-semibold" disabled={busy}>
              {busy ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />验证中…</>) : '验 证'}
            </Button>
            <button
              type="button"
              className="w-full text-center text-[12px] text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={() => { setStep('password'); setError(''); setCode('') }}
            >
              返回重新登录
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-[11px] text-muted-foreground">© 2026 PicoAide · Enterprise Internal Deployment</p>
      </div>
    </div>
  )
}
