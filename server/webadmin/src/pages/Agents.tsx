import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { TransferOwnerDialog } from '../components/transfer-owner-dialog'
import { CapabilityLockPanel } from '../components/capability-lock-panel'
import { GrantDialog } from '../components/grant-dialog'
import { ArchivePreviewDialog, ArchivePreviewData } from '../components/archive-preview-dialog'
import { Download, UserCog, Bot, Upload, Lock } from 'lucide-react'

interface AgentRow {
  name: string
  title?: string
  version?: string
  description?: string
  author?: string
  enabled: boolean
  quality?: string
  downloads?: number
  changelog?: string
  /** 0059: 官方属性(蓝标, 仅管理员可上传)。 */
  official?: boolean
  /** 来源渠道: market(市场直上架) || org(员工上传审批后)。 */
  channel?: 'market' | 'org'
}

/**
 * 市场智能体管理(G4,2026-09-04):与市场技能同构的管理面——
 * 上架(登记→上传归档,preset.yml 包内即真相)/上传新版/预览/授权/归属/上下架。
 * 端点: GET|POST /agents、POST /agents/:name/archive、PUT|DELETE /agents/:name、
 * POST /agents/:name/enable、GET /agents/:name/{preview,file,grants}、
 * PUT|DELETE /agents/:name/grant、PUT /agents/:name/grants。
 */
export default function Agents() {
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [opError, setOpError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  // 上架登记
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createErr, setCreateErr] = useState('')
  // 上传版本
  const [uploadAgent, setUploadAgent] = useState<AgentRow | null>(null)
  const [uploadVersion, setUploadVersion] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  // 锁定管理(2026-09-04 从审批页迁入市场页)
  const [lockOpen, setLockOpen] = useState(false)
  // 编辑描述
  const [editAgent, setEditAgent] = useState<AgentRow | null>(null)
  const [editDesc, setEditDesc] = useState('')
  const [editErr, setEditErr] = useState('')
  // 预览 / 授权 / 归属
  const [preview, setPreview] = useState<ArchivePreviewData | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  const [previewName, setPreviewName] = useState('')
  const [grantAgent, setGrantAgent] = useState<AgentRow | null>(null)
  const [departments, setDepartments] = useState<GrantDept[]>([])
  interface GrantDept { id: number; name: string; parent_id: number }
  const [transferAgent, setTransferAgent] = useState<AgentRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [d, approvals] = await Promise.all([
        request(`${ADMIN_API}/agents`),
        request(`${ADMIN_API}/capabilities/approvals?status=approved&type=agent`).catch(() => ({ approvals: [] })),
      ])
      const merged: AgentRow[] = [...(d.agents ?? [])]
      for (const row of (approvals.approvals ?? []) as { name: string; version: string; display_name: string; description: string; author: string; downloads?: number; official?: boolean; quality?: string }[]) {
        merged.push({
          name: row.name, title: row.display_name || row.name, version: row.version,
          description: row.description, author: row.author, enabled: true,
          downloads: row.downloads ?? 0, official: row.official, quality: row.quality, channel: 'org',
        })
      }
      // 排序定案: 官方 → 精选 → score(calls*3+downloads) 降序 → 名称
      const score = (x: AgentRow): number => (x.downloads ?? 0)
      merged.sort((a, b) => {
        if (!!a.official !== !!b.official) return a.official ? -1 : 1
        if (!!(a.quality === 'featured') !== !!(b.quality === 'featured')) return a.quality === 'featured' ? -1 : 1
        if (score(a) !== score(b)) return score(b) - score(a)
        return a.name.localeCompare(b.name)
      })
      setAgents(merged)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    request(`${ADMIN_API}/departments`).then((d) => setDepartments(d.departments ?? [])).catch(() => { /* 授权对话框才用 */ })
  }, [load])

  const create = async () => {
    if (busy) return
    setCreateErr('')
    if (!createName.trim()) { setCreateErr('请填写智能体名'); return }
    setBusy('create-agent')
    try {
      await request(`${ADMIN_API}/agents`, {
        method: 'POST',
        body: JSON.stringify({ name: createName.trim(), description: createDesc.trim() }),
      })
      setCreateOpen(false)
      setCreateName('')
      setCreateDesc('')
      await load()
    } catch (err: any) {
      setCreateErr(err.message)
    } finally {
      setBusy(null)
    }
  }

  const toBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })

  const upload = async () => {
    if (!uploadAgent || uploadBusy) return
    setUploadErr('')
    if (!uploadFile) { setUploadErr('请选择归档包(.zip 或 .tar.gz,含 agent.cordis.yml + preset.yml)'); return }
    setUploadBusy(true)
    try {
      const archive = await toBase64(uploadFile)
      const body: Record<string, string> = { archive }
      if (uploadVersion.trim() !== '') body.version = uploadVersion.trim()
      await request(`${ADMIN_API}/agents/${encodeURIComponent(uploadAgent.name)}/archive`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setUploadAgent(null)
      setUploadVersion('')
      setUploadFile(null)
      await load()
    } catch (err: any) {
      setUploadErr(err.message)
    } finally {
      setUploadBusy(false)
    }
  }

  const openPreview = async (a: AgentRow) => {
    try {
      const d = await request(`${ADMIN_API}/agents/${encodeURIComponent(a.name)}/preview`)
      setPreview({ files: d.files ?? [], composition: d.composition ?? '', skill_md: d.composition ?? '' })
      setPreviewKey(`${a.name}-${Date.now()}`)
      setPreviewName(a.name)
    } catch (err: any) {
      setOpError(`预览失败:${err.message}`)
    }
  }

  const setEnabled = async (a: AgentRow, enabled: boolean) => {
    if (busy) return
    const key = `${enabled ? 'enable' : 'disable'}-${a.name}`
    setBusy(key)
    setOpError('')
    try {
      // 下架 = DELETE /agents/:name; 重新上架 = POST /agents/:name/enable
      await request(`${ADMIN_API}/agents/${encodeURIComponent(a.name)}${enabled ? '/enable' : ''}`, {
        method: enabled ? 'POST' : 'DELETE',
        body: undefined,
      })
      await load()
    } catch (err: any) {
      setOpError(`${enabled ? '上架' : '下架'}失败:${err.message}${a.version ? '' : '(可能尚未发布版本)'}`)
    } finally {
      setBusy(null)
    }
  }

  const saveEdit = async () => {
    if (!editAgent || busy) return
    setEditErr('')
    setBusy('edit-agent')
    try {
      await request(`${ADMIN_API}/agents/${encodeURIComponent(editAgent.name)}`, {
        method: 'PUT',
        body: JSON.stringify({ description: editDesc }),
      })
      setEditAgent(null)
      await load()
    } catch (err: any) {
      setEditErr(err.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="智能体市场"
        desc="官方智能体(蓝标) / 员工上传(审批后);授权制可见、归属约束续传"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setLockOpen(true)}>
              <Lock className="h-3.5 w-3.5" /> 锁定管理
            </Button>
            <Button size="sm" onClick={() => { setCreateOpen(true); setCreateErr('') }}>
              <Upload className="h-3.5 w-3.5" /> 上架智能体
            </Button>
          </>
        }
      />
      {opError && <div className="text-sm text-destructive">{opError}</div>}
      <Card>
        <CardHeader>
          <CardTitle>智能体(Agent)</CardTitle>
          <CardDescription>与技能同规则:归档直存数据库、包内 preset.yml 携带版本/描述/作者/分类、发布即已审核</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="flex items-center justify-between rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              <span>智能体加载失败:{error}</span>
              <Button size="sm" variant="outline" onClick={() => void load()}>重试</Button>
            </div>
          ) : loading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((a) => (
                <div key={a.name} className="group flex flex-col rounded-lg border bg-card p-4 transition-all duration-200 hover:border-[#1E40AF]/40 hover:shadow-md">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-50 text-[#1E40AF]">
                        <Bot className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{a.title || a.name}</div>
                        <div className="text-[11px] text-muted-foreground">{a.version ? `v${a.version}` : '尚未发布版本'} · {a.name}</div>
                      </div>
                    </div>
                    <span className="flex items-center gap-1.5">
                      {a.official && <Badge className="bg-[#1E40AF] text-white hover:bg-[#1E40AF]">官方</Badge>}
                      {a.quality === 'featured' && <Badge variant="secondary">精选</Badge>}
                      {a.channel === 'org' && <Badge variant="outline">员工上传</Badge>}
                      {a.enabled ? <Badge variant="success">上架</Badge> : <Badge variant="outline">已下架</Badge>}
                    </span>
                  </div>
                  <p className="mt-3 line-clamp-3 flex-1 text-xs leading-relaxed text-slate-500" title={a.description || undefined}>{a.description || '暂无描述'}</p>
                  <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-slate-500" title="归属人:首个成功发布者,只有归属人(及管理员)能更新">
                    <UserCog className="h-3 w-3 shrink-0" /><span className="truncate">归属 {a.official ? '官方' : (a.author || '未指定')}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
                    {a.quality && a.quality !== '' && <Badge variant="secondary" className="px-1 py-0 text-[10px]">{a.quality}</Badge>}
                    <span className="inline-flex items-center gap-1"><Download className="h-3 w-3" />下载 {a.downloads ?? 0}</span>
                  </div>
                  <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
                    <Button variant="outline" onClick={() => void openPreview(a)}>预览</Button>
                    <Button variant="outline" disabled={busy !== null} onClick={() => { setUploadAgent(a); setUploadVersion(''); setUploadFile(null); setUploadErr('') }}>上传新版</Button>
                    <Button variant="outline" onClick={() => { setEditAgent(a); setEditDesc(a.description ?? ''); setEditErr('') }}>编辑</Button>
                    <Button variant="outline" onClick={() => setTransferAgent(a)} title="转移归属(负责人)">归属</Button>
                    <Button variant="outline" onClick={() => setGrantAgent(a)}>授权</Button>
                    {a.enabled
                      ? <Button variant="destructive" disabled={busy !== null} onClick={() => void setEnabled(a, false)}>{busy === `disable-${a.name}` ? '下架中…' : '下架'}</Button>
                      : <Button variant="outline" disabled={busy !== null} onClick={() => void setEnabled(a, true)}>{busy === `enable-${a.name}` ? '上架中…' : '重新上架'}</Button>}
                  </div>
                </div>
              ))}
              {agents.length === 0 && (
                <div className="col-span-full">
                  <EmptyState icon={<Bot className="h-5 w-5 text-muted-foreground" />} title="暂无智能体" desc="点击「上架智能体」登记并上传归档包" />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 上架登记弹窗(先登记,再上传归档;版本来自 preset.yml) */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>上架智能体</DialogTitle>
            <DialogDescription>先登记名称与描述,随后上传归档包(agent.cordis.yml + preset.yml;版本/展示名/描述以包内为准)</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="agent-name">名称(唯一,不可修改)</Label>
              <Input id="agent-name" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="如 code-review-bot" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-desc">描述(展示文案)</Label>
              <Textarea id="agent-desc" rows={3} value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} />
            </div>
            {createErr && <div className="text-sm text-destructive">{createErr}</div>}
            <Button className="w-full" disabled={busy !== null} onClick={() => { void create() }}>{busy === 'create-agent' ? '处理中…' : '登记'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 上传版本弹窗 */}
      <Dialog open={!!uploadAgent} onOpenChange={(open) => { if (!open) setUploadAgent(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>上传新版 · {uploadAgent?.name}</DialogTitle>
            <DialogDescription>归档包要求顶层 agent.cordis.yml + preset.yml(版本必须高于当前最高版本;版本号以包内 preset.yml 为准,此处可留空)</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>归档包(.zip / .tar.gz)</Label>
              <input type="file" accept=".zip,.tar.gz,.gz" className="block w-full text-sm"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-upload-version">版本(可选,与 preset.yml 一致时填写)</Label>
              <Input id="agent-upload-version" value={uploadVersion} onChange={(e) => setUploadVersion(e.target.value)} placeholder="如 1.1.0" />
            </div>
            {uploadErr && <div className="text-sm text-destructive">{uploadErr}</div>}
            <Button className="w-full" disabled={uploadBusy} onClick={() => { void upload() }}>{uploadBusy ? '发布中…' : '发布'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 编辑描述弹窗 */}
      <Dialog open={!!editAgent} onOpenChange={(open) => { if (!open) setEditAgent(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑智能体 · {editAgent?.name}</DialogTitle>
            <DialogDescription>仅展示文案;版本/内容以归档包为准,归属经「归属」转移</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="agent-edit-desc">描述</Label>
              <Textarea id="agent-edit-desc" rows={4} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
            </div>
            {editErr && <div className="text-sm text-destructive">{editErr}</div>}
            <Button className="w-full" disabled={busy !== null} onClick={() => { void saveEdit() }}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      <CapabilityLockPanel open={lockOpen} onClose={() => setLockOpen(false)} />
      {preview && (
        <ArchivePreviewDialog
          openKey={previewKey}
          data={preview}
          mainTitle={`market · ${previewName}`}
          mainContent={preview.composition ?? ''}
          fileBase={`${ADMIN_API}/agents/${encodeURIComponent(previewName)}`}
          onClose={() => setPreview(null)}
        />
      )}
      {grantAgent && (
        <GrantDialog
          open={!!grantAgent}
          name={grantAgent.name}
          basePath={`${ADMIN_API}/agents/${encodeURIComponent(grantAgent.name)}`}
          departments={departments}
          onClose={() => setGrantAgent(null)}
          onSaved={() => { setGrantAgent(null); void load() }}
        />
      )}
      {transferAgent && (
        <TransferOwnerDialog
          open={!!transferAgent}
          kind="agent"
          name={transferAgent.name}
          displayName={transferAgent.title || transferAgent.name}
          currentOwner={transferAgent.author ?? ''}
          onClose={() => setTransferAgent(null)}
          onSaved={() => { setTransferAgent(null); void load() }}
        />
      )}
    </div>
  )
}
