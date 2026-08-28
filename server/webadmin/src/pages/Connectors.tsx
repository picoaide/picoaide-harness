import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Switch } from '../components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Plus, RefreshCw, Trash2, Pencil, Plug } from 'lucide-react'

interface ConnectorRow {
  id: string
  name: string
  description: string
  auth_mode: 'oauth' | 'device' | 'token' | 'server-side'
  definition: string
  enabled: boolean
  updated_at: string
  created_at: string
}

const AUTH_META: Record<ConnectorRow['auth_mode'], { label: string; variant: 'secondary' | 'outline' | 'success' | 'destructive' }> = {
  oauth: { label: 'OAuth', variant: 'outline' },
  device: { label: 'Device', variant: 'secondary' },
  token: { label: 'Token', variant: 'success' },
  'server-side': { label: '服务端', variant: 'secondary' },
}

const EMPTY_FORM = {
  id: '',
  name: '',
  description: '',
  auth_mode: 'token' as ConnectorRow['auth_mode'],
  definition: '{"tokenFields":[],"mcp":[{"serverName":"","transport":"streamable-http","url":""}]}',
}

function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function Connectors() {
  const [rows, setRows] = useState<ConnectorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState<ConnectorRow | 'new' | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [confirmDel, setConfirmDel] = useState<ConnectorRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await request<{ connectors: ConnectorRow[] }>('/api/admin/connectors')
      setRows(data.connectors ?? [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const openNew = () => {
    setEditing('new')
    setForm(EMPTY_FORM)
    setFormError('')
  }

  const openEdit = (row: ConnectorRow) => {
    setEditing(row)
    setForm({
      id: row.id,
      name: row.name,
      description: row.description,
      auth_mode: row.auth_mode,
      definition: row.definition,
    })
    setFormError('')
  }

  const toggleEnabled = async (row: ConnectorRow, enabled: boolean) => {
    if (busy !== '') return
    setBusy(row.id + '-enabled')
    setError('')
    try {
      await request(`/api/admin/connectors/${encodeURIComponent(row.id)}/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      })
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    if (busy !== '' || editing === null) return
    setFormError('')
    if (form.id.trim() === '' || form.name.trim() === '' || form.definition.trim() === '') {
      setFormError('编号/名称/定义 JSON 必填')
      return
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(form.id.trim())) {
      setFormError('编号须为小写字母/数字/连字符,且以字母数字开头')
      return
    }
    // 定义 JSON 预校验(服务端仍会校验,mcp 结构等)。
    try {
      JSON.parse(form.definition)
    } catch {
      setFormError('定义 JSON 格式错误')
      return
    }
    setBusy('save')
    setError('')
    try {
      const isNew = editing === 'new'
      const path = isNew ? '/api/admin/connectors' : `/api/admin/connectors/${encodeURIComponent(editing.id)}`
      await request(path, {
        method: isNew ? 'POST' : 'PUT',
        body: JSON.stringify({
          id: form.id.trim(),
          name: form.name.trim(),
          description: form.description.trim(),
          auth_mode: form.auth_mode,
          definition: form.definition,
          enabled: true,
        }),
      })
      setEditing(null)
      await load()
    } catch (err: any) {
      setFormError(err.message)
    } finally {
      setBusy('')
    }
  }

  const remove = async (row: ConnectorRow) => {
    if (busy !== '') return
    setBusy(row.id + '-del')
    setError('')
    try {
      await request(`/api/admin/connectors/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      setConfirmDel(null)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="连接器"
        desc="客户端连接器目录(服务端下发):增删改后客户端登录自动同步;凭证仍只存客户端本地"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => { void load() }}>
              <RefreshCw className="h-4 w-4" /> 刷新
            </Button>
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4" /> 新建连接器
            </Button>
          </>
        }
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <EmptyState icon={<Plug className="h-6 w-6" />} title="加载中…" desc="请稍候" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Plug className="h-6 w-6" />} title="暂无连接器" desc="创建第一个连接器后,客户端将自动同步" />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>编号</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>认证</TableHead>
                <TableHead>描述</TableHead>
                <TableHead>下发</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => {
                const meta = AUTH_META[row.auth_mode] ?? { label: row.auth_mode, variant: 'outline' as const }
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-sm">{row.id}</TableCell>
                    <TableCell className="whitespace-nowrap font-medium">{row.name}</TableCell>
                    <TableCell><Badge variant={meta.variant}>{meta.label}</Badge></TableCell>
                    <TableCell className="max-w-xs truncate">{row.description || '—'}</TableCell>
                    <TableCell>
                      <Switch
                        checked={row.enabled}
                        disabled={busy !== ''}
                        onCheckedChange={(v) => { void toggleEnabled(row, v) }}
                        aria-label={`下发 ${row.name}`}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{fmtTime(row.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(row)} title="编辑">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDel(row)} title="删除">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 创建/编辑 Dialog */}
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) { setEditing(null); setFormError('') } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? '新建连接器' : `编辑连接器: ${editing?.id}`}</DialogTitle>
            <DialogDescription>保存后客户端登录自动同步;凭证仍只存客户端本地,定义不含任何密钥</DialogDescription>
          </DialogHeader>
          {editing === 'new' && (
            <div className="space-y-1">
              <Label htmlFor="conn-id">编号(不可改,客户端按 id 匹配凭证)</Label>
              <Input id="conn-id" placeholder="如 feishu"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="conn-name">名称</Label>
            <Input id="conn-name" placeholder="如 飞书"
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="conn-desc">描述</Label>
            <Input id="conn-desc" placeholder="连接器功能说明(客户端卡片展示)"
              value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="conn-auth">认证方式</Label>
            <Select value={form.auth_mode} onValueChange={(v) => setForm({ ...form, auth_mode: v as ConnectorRow['auth_mode'] })}>
              <SelectTrigger id="conn-auth"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="oauth">OAuth(授权码+PKCE)</SelectItem>
                <SelectItem value="device">Device(设备码)</SelectItem>
                <SelectItem value="token">Token(表单)</SelectItem>
                <SelectItem value="server-side">服务端</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="conn-def">定义 JSON(与客户端 ConnectorDef 对齐)</Label>
            <Textarea id="conn-def" rows={12} spellCheck={false}
              className="font-mono text-xs"
              value={form.definition}
              onChange={(e) => setForm({ ...form, definition: e.target.value })}
              placeholder='{"auth":{...},"tokenFields":[{"key":"TOKEN","label":"Token","type":"password","required":true}],"examples":["..."],"mcp":[{"serverName":"x","transport":"streamable-http","url":"https://..."}]}'
            />
            <p className="text-xs text-muted-foreground">
              必含 mcp(非空,每项含 serverName);stdio 命令会在客户端本机执行,请仅使用可信命令。
            </p>
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setEditing(null); setFormError('') }}>取消</Button>
            <Button disabled={busy !== ''} onClick={() => { void save() }}>
              {busy === 'save' ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={confirmDel !== null} onOpenChange={(open) => { if (!open) setConfirmDel(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确定删除连接器「{confirmDel?.name}」吗？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            删除后客户端将不再下发该连接器(已连接的用户下次登录不恢复,现有本地凭证保留但不再使用)。
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirmDel(null)}>取消</Button>
            <Button variant="destructive" disabled={busy !== ''} onClick={() => { if (confirmDel) void remove(confirmDel) }}>
              {busy === confirmDel?.id + '-del' ? '删除中…' : '删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
