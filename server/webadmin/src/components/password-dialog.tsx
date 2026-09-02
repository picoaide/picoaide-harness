import { useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'

// 0057: 管理员「修改自己密码」对话框(侧边栏入口 / 强制改密拦截共用)。
// force=true 时为强制改密拦截: 不可关闭, 完成后整页跳回登录(服务端已吊销
// 全部会话含当前)。
export function PasswordDialog({ open, onOpenChange, force, onDone }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  force?: boolean
  onDone: () => void
}) {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setOldPassword(''); setNewPassword(''); setConfirm(''); setError(''); setBusy(false)
  }

  async function submit() {
    if (busy) return
    if (newPassword.length < 10) { setError('新密码至少 10 位'); return }
    if (newPassword !== confirm) { setError('两次输入的新密码不一致'); return }
    if (newPassword === oldPassword) { setError('新密码不能与原密码相同'); return }
    setBusy(true)
    setError('')
    try {
      await request(`${ADMIN_API}/me/password`, {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      })
      reset()
      onDone()
    } catch (err: any) {
      setError(err.message || '修改失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!force) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{force ? '请先修改密码' : '修改密码'}</DialogTitle>
          <DialogDescription>
            {force
              ? '你的密码已被管理员重置，为保障账号安全需先设置新密码才能继续使用管理后台。'
              : '修改后你所有已登录的会话（含本会话）将被强制登出，需要用新密码重新登录。'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!force && (
            <div className="space-y-1.5">
              <Label>当前密码</Label>
              <Input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoFocus autoComplete="current-password" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>新密码（至少 10 位）</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="space-y-1.5">
            <Label>确认新密码</Label>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password"
              onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
          </div>
          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>
        <div className="flex justify-end gap-2">
          {!force && (
            <Button variant="outline" onClick={() => { reset(); onOpenChange(false) }} disabled={busy}>取消</Button>
          )}
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? '提交中…' : '确认修改'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
