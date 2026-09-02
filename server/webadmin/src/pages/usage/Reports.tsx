import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Switch } from '../../components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { PageHeader } from '../../components/page-header'
import { Send, Plus, Pencil, Trash2, RefreshCw } from 'lucide-react'

interface Subscription {
  id: number
  name: string
  enabled: boolean
  hook_url: string
  last_run_at?: string
  last_error: string
}

// 报表订阅:月度用量报表(上月:总费用/请求/模型TOP/用户TOP/部门汇总)推送到企业 webhook
export default function UsageReports() {
  const [subs, setSubs] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState<Subscription | null>(null)
  const [form, setForm] = useState({ name: '', hook_url: '', enabled: true })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [resultMsg, setResultMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const d = await request<{ subscriptions: Subscription[] }>(`${ADMIN_API}/report-subscriptions`)
      setSubs(d.subscriptions ?? [])
    } catch (e: any) {
      setError(e.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', hook_url: '', enabled: true })
    setDialogOpen(true)
  }

  const openEdit = (s: Subscription) => {
    setEditing(s)
    setForm({ name: s.name, hook_url: s.hook_url, enabled: s.enabled })
    setDialogOpen(true)
  }

  const save = async () => {
    if (busy) return
    if (form.name.trim() === '') { setError('订阅名称必填'); return }
    if (!/^https?:\/\//.test(form.hook_url.trim())) { setError('推送地址必须是 http(s) URL'); return }
    setBusy('save')
    setError('')
    try {
      const body = JSON.stringify({ name: form.name.trim(), hook_url: form.hook_url.trim(), enabled: form.enabled })
      if (editing) {
        await request(`${ADMIN_API}/report-subscriptions/${editing.id}`, { method: 'PUT', body })
      } else {
        await request(`${ADMIN_API}/report-subscriptions`, { method: 'POST', body })
      }
      setDialogOpen(false)
      await load()
    } catch (e: any) {
      setError(e.message || '保存失败')
    } finally {
      setBusy('')
    }
  }

  const remove = async (s: Subscription) => {
    if (busy) return
    if (!window.confirm(`删除订阅「${s.name}」?`)) return
    setBusy(`del:${s.id}`)
    setError('')
    try {
      await request(`${ADMIN_API}/report-subscriptions/${s.id}`, { method: 'DELETE' })
      await load()
    } catch (e: any) {
      setError(e.message || '删除失败')
    } finally {
      setBusy('')
    }
  }

  const testPush = async (s: Subscription) => {
    if (busy) return
    setBusy(`test:${s.id}`)
    setError('')
    setResultMsg('')
    try {
      const d = await request<{ period: string }>(`${ADMIN_API}/report-subscriptions/${s.id}/test`, { method: 'POST' })
      setResultMsg(`推送成功(${d.period} 报表)已发送到 ${s.name}`)
    } catch (e: any) {
      setError(`测试推送失败: ${e.message || '未知'}`)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="报表订阅"
        desc="每月自动生成上月用量汇总(总费用/请求数/模型TOP/用户TOP/部门汇总)并推送到企业 webhook(钉钉/企微/飞书机器人等);补跑规则:上月未推送则次月 1 日后自动补发"
      />
      {error && <div className="text-sm text-destructive">{error}</div>}
      {resultMsg && <div className="text-sm text-emerald-600">{resultMsg}</div>}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">订阅列表</CardTitle>
          <Button size="sm" onClick={openCreate}><Plus className="h-3.5 w-3.5" /> 新建订阅</Button>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-64 w-full" /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>推送地址</TableHead>
                  <TableHead className="w-16">启用</TableHead>
                  <TableHead>上次推送</TableHead>
                  <TableHead>最近错误</TableHead>
                  <TableHead className="w-40">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subs.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="max-w-64 truncate font-mono text-xs text-muted-foreground" title={s.hook_url}>{s.hook_url}</TableCell>
                    <TableCell>
                      <Switch
                        checked={s.enabled}
                        aria-label={`启用 ${s.name}`}
                        onCheckedChange={async (v) => {
                          try {
                            await request(`${ADMIN_API}/report-subscriptions/${s.id}`, {
                              method: 'PUT',
                              body: JSON.stringify({ name: s.name, hook_url: s.hook_url, enabled: v }),
                            })
                            await load()
                          } catch (e: any) { setError(e.message || '操作失败') }
                        }}
                      />
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{s.last_run_at ? s.last_run_at.replace('T', ' ').slice(0, 16) : '—'}</TableCell>
                    <TableCell className="max-w-48 truncate text-xs text-destructive" title={s.last_error}>{s.last_error || '—'}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void testPush(s)}>
                          <Send className="h-3.5 w-3.5" /> {busy === `test:${s.id}` ? '推送中…' : '测试'}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openEdit(s)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button size="sm" variant="outline" onClick={() => void remove(s)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {subs.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无订阅,点击右上角「新建订阅」</TableCell></TableRow>}
              </TableBody>
            </Table>
          )}
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3" />
            每月 1 日起自动生成上月报表并推送;失败会在下月补跑时重试(每订阅独立记录最近错误)
          </div>
        </CardContent>
      </Card>

      {/* 新建/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) setDialogOpen(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑订阅' : '新建订阅'}</DialogTitle>
            <DialogDescription>推送目标:企业机器人 webhook(钉钉/企业微信/飞书自定义机器人地址)</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="rs-name">订阅名称</Label>
              <Input id="rs-name" placeholder="如:管理层月报群" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rs-url">推送地址(webhook URL)</Label>
              <Input id="rs-url" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." value={form.hook_url} onChange={(e) => setForm({ ...form, hook_url: e.target.value })} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} aria-label="启用订阅" />
              <Label>启用(停用后不再自动推送)</Label>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button size="sm" onClick={save} disabled={!!busy}>{busy ? '保存中…' : '保存'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
