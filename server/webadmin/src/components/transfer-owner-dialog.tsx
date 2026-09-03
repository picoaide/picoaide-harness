import { useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'

/**
 * 归属转移弹窗(2026-09-02,统一复用):
 * PUT /api/server/admin/apps/:kind/:app_id/owner —— 市场技能管理页与
 * 能力中心组织审批页共用同一实现。归属只约束「谁能续传新版本」;
 * 转移后旧负责人不能再上传,新负责人获得续传权(版本须递增),服务端审计。
 */
export function TransferOwnerDialog({
  open,
  kind,
  name,
  displayName,
  currentOwner,
  onClose,
  onSaved,
}: {
  open: boolean
  kind: 'skill' | 'agent'
  name: string
  displayName?: string
  currentOwner: string
  onClose: () => void
  onSaved: () => void
}) {
  const [owner, setOwner] = useState(currentOwner)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 打开时重置为当前归属(组件常驻,state 需跟随 open 同步)。
  const [lastOpen, setLastOpen] = useState(false)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setOwner(currentOwner)
      setError('')
      setBusy(false)
    }
  }

  const transfer = async () => {
    const target = owner.trim()
    if (target === '' || busy) return
    setBusy(true)
    setError('')
    try {
      await request(`${ADMIN_API}/apps/${kind}/${encodeURIComponent(name)}/owner`, {
        method: 'PUT',
        body: JSON.stringify({ owner: target }),
      })
      onSaved()
      onClose()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>转移归属</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          将「{displayName || name}」的维护权转移给新负责人:原负责人不能再上传新版本,新负责人获得续传权(版本须递增)。
        </p>
        <Input
          value={owner}
          onChange={e => { setOwner(e.target.value) }}
          placeholder="新归属人用户名"
          aria-label="新归属人用户名"
        />
        {error !== '' && <div className="text-sm text-destructive">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={busy || owner.trim() === ''} onClick={() => { void transfer() }}>
            {busy ? '处理中…' : '确认转移'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
