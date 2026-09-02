import { useEffect, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Badge } from './ui/badge'

// 0057: 管理员「安全设置」对话框 —— MFA(TOTP)开启/关闭。
// 开启: 主密码确认 → 展示二维码(otpauth:// URL)与密钥文本(双显示) →
// 用户输入前 6 位动态码完成启用; 关闭: 主密码 + 当前动态码双验。
export function MFASettingsDialog({ open, onOpenChange, onChanged }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onChanged: () => void
}) {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'view' | 'enable' | 'verify' | 'disable'>('view')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [secret, setSecret] = useState('')
  const [otpauthUrl, setOtpauthUrl] = useState('')
  const [ticket, setTicket] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const body = await request(`${ADMIN_API}/me/mfa`)
      setEnabled(!!body.enabled)
      if (body.enabled) setMode('view')
    } catch (err: any) {
      setError(err.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      setMode('view'); setPassword(''); setCode(''); setSecret(''); setTicket(''); setError('')
      void load()
    }
  }, [open])

  // otpauth URL → 二维码(Google Chart 死链风险高, 改用本地 canvas 手写 QR?
  // 不: webadmin 引入 qrcode 渲染库; 这里动态 import 保持主包轻量)。
  useEffect(() => {
    if (!otpauthUrl) { setQr(''); return }
    let cancelled = false
    import('qrcode').then((QRCode) => {
      if (cancelled) return
      QRCode.toDataURL(otpauthUrl, { width: 180, margin: 1 }).then((u) => { if (!cancelled) setQr(u) }).catch(() => { /* fallback text only */ })
    }).catch(() => { /* fallback text only */ })
    return () => { cancelled = true }
  }, [otpauthUrl])

  async function startEnable() {
    if (busy) return
    if (!password) { setError('请输入主密码'); return }
    setBusy(true); setError('')
    try {
      const body = await request(`${ADMIN_API}/me/mfa/enable`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      setSecret(body.secret)
      setOtpauthUrl(body.otpauth_url)
      setTicket(body.ticket)
      setCode('')
      setMode('verify')
    } catch (err: any) {
      setError(err.message || '开启失败')
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    if (busy) return
    if (code.trim().length !== 6) { setError('请输入 6 位动态码'); return }
    setBusy(true); setError('')
    try {
      await request(`${ADMIN_API}/me/mfa/verify`, {
        method: 'POST',
        body: JSON.stringify({ ticket, code: code.trim() }),
      })
      setEnabled(true); setMode('view'); setSecret(''); setOtpauthUrl(''); setTicket(''); setPassword(''); setCode('')
      onChanged()
    } catch (err: any) {
      setError(err.message || '验证失败')
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    if (busy) return
    if (!password || code.trim().length !== 6) { setError('请输入主密码与 6 位动态码'); return }
    setBusy(true); setError('')
    try {
      await request(`${ADMIN_API}/me/mfa/disable`, {
        method: 'POST',
        body: JSON.stringify({ password, code: code.trim() }),
      })
      setEnabled(false); setMode('view'); setPassword(''); setCode('')
      onChanged()
    } catch (err: any) {
      setError(err.message || '关闭失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>安全设置 · 双重验证(MFA)</DialogTitle>
          <DialogDescription>
            通过手机验证器(TOTP)动态码增强管理后台登录安全。开启后登录需两步验证。
          </DialogDescription>
        </DialogHeader>

        {loading && <p className="text-sm text-muted-foreground">加载中…</p>}

        {!loading && mode === 'view' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-sm">当前状态</span>
              {enabled
                ? <Badge>已开启</Badge>
                : <Badge variant="secondary">未开启</Badge>}
            </div>
            <div className="flex gap-2">
              {enabled ? (
                <Button variant="destructive" onClick={() => { setMode('disable'); setPassword(''); setCode(''); setError('') }}>
                  关闭双重验证
                </Button>
              ) : (
                <Button onClick={() => { setMode('enable'); setPassword(''); setCode(''); setError(''); setSecret(''); setOtpauthUrl('') }}>
                  开启双重验证
                </Button>
              )}
            </div>
          </div>
        )}

        {!loading && mode === 'enable' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>主密码确认</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoFocus autoComplete="current-password" placeholder="请输入当前密码" />
            </div>
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setMode('view')} disabled={busy}>取消</Button>
              <Button onClick={() => void startEnable()} disabled={busy}>{busy ? '处理中…' : '下一步'}</Button>
            </div>
          </div>
        )}

        {!loading && mode === 'verify' && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3">
              {qr ? (
                <img src={qr} alt="MFA 二维码" className="h-[180px] w-[180px] rounded-md border" />
              ) : (
                <div className="flex h-[180px] w-[180px] items-center justify-center rounded-md border text-xs text-muted-foreground">
                  二维码加载中(可直接使用下方密钥)
                </div>
              )}
              <div className="w-full rounded-md border bg-muted/40 p-2 text-center">
                <div className="text-[10px] text-muted-foreground">手动录入密钥(或扫码)</div>
                <code className="break-all font-mono text-[12px]">{secret}</code>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>输入验证器中的 6 位动态码</Label>
              <Input className="font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value)}
                autoFocus autoComplete="one-time-code" maxLength={6} placeholder="6 位数字"
                onKeyDown={(e) => { if (e.key === 'Enter') void verify() }} />
            </div>
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setMode('enable')} disabled={busy}>上一步</Button>
              <Button onClick={() => void verify()} disabled={busy}>{busy ? '验证中…' : '确认开启'}</Button>
            </div>
          </div>
        )}

        {!loading && mode === 'disable' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              关闭需要同时验证主密码与当前动态码(防止登录会话被劫持后自行关闭)。若已丢失验证器，请让其他超级管理员在「用户管理」为你重置 MFA。
            </p>
            <div className="space-y-1.5">
              <Label>主密码</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
            </div>
            <div className="space-y-1.5">
              <Label>当前动态码</Label>
              <Input className="font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={6} placeholder="6 位数字" />
            </div>
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setMode('view')} disabled={busy}>取消</Button>
              <Button variant="destructive" onClick={() => void disable()} disabled={busy}>{busy ? '关闭中…' : '确认关闭'}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
