import { useCallback, useEffect, useMemo, useState } from 'react'
import { request } from '../api'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { deptTreeOptions } from '../lib/utils'

interface Grant {
  grantee_type: string
  grantee: string
}

interface Dept {
  id: number
  parent_id: number
  name: string
}

interface GrantDialogProps {
  open: boolean
  name: string
  /** API 前缀:如 `/api/server/admin/shared-skills/${name}`(不含 grant/grants)。 */
  basePath: string
  departments: Dept[]
  onClose: () => void
  onSaved?: () => void
}

/**
 * 共享资源授权对话框(与商城技能授权同模型):部门多选整组替换 + 单用户
 * 授权/撤销。未授权用户不可见(严格默认);作者始终可见自己的。
 */
export function GrantDialog({ open, name, basePath, departments, onClose, onSaved }: GrantDialogProps) {
  const [grants, setGrants] = useState<Grant[]>([])
  const [grantGroups, setGrantGroups] = useState<string[]>([])
  const [grantTarget, setGrantTarget] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState('')
  const [grantSaving, setGrantSaving] = useState(false)

  const grantPath = `${basePath}/grant`
  const grantsPath = `${basePath}/grants`

  const openGrants = useCallback(async () => {
    setDialogError('')
    try {
      const data = await request(grantsPath)
      setGrants(data.grants ?? [])
      setGrantGroups((data.grants ?? []).filter((g: Grant) => g.grantee_type === 'group').map((g: Grant) => g.grantee))
      setGrantTarget('')
    } catch (err: any) {
      setDialogError(err.message)
    }
  }, [grantsPath])

  useEffect(() => {
    if (open) void openGrants()
  }, [open, openGrants])

  async function saveDeptGrants() {
    if (grantSaving || busy !== null) return
    if (!window.confirm('保存部门授权将覆盖该资源的全部部门授权(用户授权不受影响)。确定保存?')) return
    setGrantSaving(true)
    setDialogError('')
    try {
      await request(grantsPath, { method: 'PUT', body: JSON.stringify({ groups: grantGroups }) })
      onClose()
      onSaved?.()
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setGrantSaving(false)
    }
  }

  function toggleGroup(name: string) {
    setGrantGroups((prev) => (prev.includes(name) ? prev.filter((g) => g !== name) : [...prev, name]))
  }

  async function doGrant() {
    if (busy !== null || !grantTarget.trim()) return
    const isGroup = grantTarget.trim().startsWith('@')
    setDialogError('')
    setBusy('grant')
    try {
      await request(grantPath, {
        method: 'PUT',
        body: JSON.stringify(isGroup ? { group: grantTarget.trim().slice(1) } : { username: grantTarget.trim() }),
      })
      setGrantTarget('')
      await openGrants()
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function revokeGrant(g: Grant) {
    if (busy !== null) return
    if (!window.confirm(`撤销「${g.grantee}」的授权?`)) return
    setDialogError('')
    setBusy(`revoke-${g.grantee_type}-${g.grantee}`)
    try {
      await request(grantPath, {
        method: 'DELETE',
        body: JSON.stringify(g.grantee_type === 'group' ? { group: g.grantee } : { username: g.grantee }),
      })
      await openGrants()
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const deptOptions = useMemo(() => {
    const nameById = new Map(departments.map((d) => [d.id, d.name]))
    return deptTreeOptions(departments).map((o) => ({ ...o, name: nameById.get(o.id) ?? '' }))
  }, [departments])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>授权「{name}」</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {grants.length > 0 && (
            <div className="space-y-2 rounded-md border p-3">
              {grants.map((g) => (
                <div key={`${g.grantee_type}:${g.grantee}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={g.grantee_type === 'group' ? 'outline' : 'secondary'}>
                    {g.grantee_type === 'group' ? `@${g.grantee}` : g.grantee}
                  </Badge>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void revokeGrant(g)}>
                    {busy === `revoke-${g.grantee_type}-${g.grantee}` ? '撤销中…' : '撤销'}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {grants.length === 0 && (
            <div className="text-xs text-muted-foreground">未授权:所有用户均不可见(严格默认),请授权用户或部门组</div>
          )}
          <div className="space-y-1">
            <Label>部门(多选:一个资源可授权多个部门,成员共享无需重复上传)</Label>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
              {deptOptions.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={grantGroups.includes(o.name)} onChange={() => toggleGroup(o.name)} />
                  {o.label}
                </label>
              ))}
              {deptOptions.length === 0 && <div className="text-xs text-muted-foreground">暂无部门</div>}
            </div>
            <p className="text-xs text-muted-foreground">「保存部门授权」将覆盖该资源的全部部门授权(用户授权不受影响)</p>
            <Button size="sm" variant="outline" className="mt-1 w-full" disabled={grantSaving || busy !== null} onClick={() => void saveDeptGrants()}>
              {grantSaving ? '保存中…' : '保存部门授权'}
            </Button>
          </div>
          <div className="space-y-1">
            <Label htmlFor="grant-user">用户名(单个,可选)</Label>
            <Input id="grant-user" placeholder="如 alice" value={grantTarget} onChange={(e) => setGrantTarget(e.target.value)} />
          </div>
          {dialogError && <div className="text-sm text-destructive">{dialogError}</div>}
          <Button className="w-full" disabled={!grantTarget.trim() || grantSaving || busy !== null} onClick={() => void doGrant()}>
            {busy === 'grant' ? '处理中…' : '添加用户授权'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
