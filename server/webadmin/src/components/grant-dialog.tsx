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
  /** API 前缀:如 `${ADMIN_API}/shared-skills/${name}`(不含 grant/grants)。 */
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
  // 写面闸门（2026-09-17 独立验证 R3）：`grants` 的初值是空数组，读取失败/未落地时
  // 页面照样渲染「未授权:所有用户均不可见(严格默认)」且「保存部门授权」可点 ⇒
  // `PUT {groups: []}` 会把该资源的**全部部门授权清空**。解锁条件必须是"授权列表真的读到了"。
  const [grantsLoaded, setGrantsLoaded] = useState(false)

  const grantPath = `${basePath}/grant`
  const grantsPath = `${basePath}/grants`

  // 5-1（2026-09-17 第二轮独立验证，P2）：**换了资源必须立刻清空上一份的授权**。
  //
  // 这个对话框是常挂载的（Capabilities 一直挂在树上，Marketplace 关闭时也留着 state），
  // 而 `grants`/`grantGroups` 只在请求成功后才被覆盖 —— 于是"打开 A（已加载完）→ 关闭 →
  // 打开 B（B 的列表还在路上）"的窗口里，界面显示的是 **A 的授权**，撤销按钮可点，
  // 实测发出的却是 `DELETE /skills/B/grant {"group":"A的部门"}`：把 A 的授权对象删到 B 上。
  //
  // 必须在**渲染期**同步归零，不能等 effect（effect 在绘制之后，会留下一帧旧数据可点）。
  // 这是 React 认可的"props 变化时调整 state"写法：条件成立才 setState，不会死循环。
  const [statePath, setStatePath] = useState(grantsPath)
  if (statePath !== grantsPath) {
    setStatePath(grantsPath)
    setGrants([])
    setGrantGroups([])
    setGrantTarget('')
    setDialogError('')
    setGrantsLoaded(false)
  }

  const openGrants = useCallback(async () => {
    setDialogError('')
    // 重新加载期间同样锁住写面：旧值不能当作"当前授权"用来覆盖。
    setGrantsLoaded(false)
    try {
      const data = await request(grantsPath)
      setGrants(data.grants ?? [])
      setGrantGroups((data.grants ?? []).filter((g: Grant) => g.grantee_type === 'group').map((g: Grant) => g.grantee))
      setGrantTarget('')
      setGrantsLoaded(true)
    } catch (err: any) {
      setDialogError(err.message)
      setGrantsLoaded(false)
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
    // 5-1:未读到本次资源的授权列表时,列表只可能来自上一份资源 —— 一律不许撤销。
    if (busy !== null || !grantsLoaded) return
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
          {grantsLoaded && grants.length > 0 && (
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
          {grantsLoaded && grants.length === 0 && (
            <div className="text-xs text-muted-foreground">未授权:所有用户均不可见(严格默认),请授权用户或部门组</div>
          )}
          {!grantsLoaded && !dialogError && (
            <div className="text-xs text-muted-foreground">授权列表加载中…</div>
          )}
          {!grantsLoaded && dialogError && (
            <div className="text-xs text-destructive">授权列表未加载成功,部门授权保存已锁定(避免用空列表覆盖现有授权)——请关闭对话框后重试</div>
          )}
          <div className="space-y-1">
            <Label>部门(多选:一个资源可授权多个部门,成员共享无需重复上传)</Label>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
              {deptOptions.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={grantGroups.includes(o.name)} disabled={!grantsLoaded} onChange={() => toggleGroup(o.name)} />
                  {o.label}
                </label>
              ))}
              {deptOptions.length === 0 && <div className="text-xs text-muted-foreground">暂无部门</div>}
            </div>
            <p className="text-xs text-muted-foreground">「保存部门授权」将覆盖该资源的全部部门授权(用户授权不受影响)</p>
            <Button size="sm" variant="outline" className="mt-1 w-full" disabled={grantSaving || busy !== null || !grantsLoaded} onClick={() => void saveDeptGrants()}>
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
