import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Checkbox } from '../components/ui/checkbox'
import { Textarea } from '../components/ui/textarea'
import { Skeleton } from '../components/ui/skeleton'
import { cn } from '../lib/utils'

interface Folder {
  id: number
  name: string
  parent_id: number
}

interface Document {
  id: number
  folder_id: number
  title: string
  content_type: string
  size: number
  created_by: string
  status?: string
  error?: string
}

interface SearchHit {
  chunk_id: number
  doc_id: number
  title: string
  title_path: string
  content: string
  score: number
}

interface ImportStatus {
  pending: number
  processing: number
  ready: number
  error: number
  total: number
  embed_missing?: number
}

interface ImportErr {
  id: number
  title: string
  error: string
}

const CT_LABEL: Record<string, string> = { text: '文本', markdown: 'Markdown', docx: 'Word', pdf: 'PDF' }
const STATUS_LABEL: Record<string, string> = { pending: '待处理', processing: '处理中', ready: '就绪', error: '失败' }

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

export default function Knowledge() {
  const [folders, setFolders] = useState<Folder[]>([])
  const [selected, setSelected] = useState(0)
  const [docs, setDocs] = useState<Document[]>([])
  const [docTotal, setDocTotal] = useState(0)
  const [docsLoading, setDocsLoading] = useState(false)
  const [docPage, setDocPage] = useState(1)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [hitTotal, setHitTotal] = useState(0)
  const [hitPage, setHitPage] = useState(1)
  const [hitMode, setHitMode] = useState('lexical')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchFolder, setSearchFolder] = useState(0)
  const [error, setError] = useState('')

  const [folderDialog, setFolderDialog] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [uploadDialog, setUploadDialog] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [uploadFolder, setUploadFolder] = useState(0)
  const [zipDialog, setZipDialog] = useState(false)
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [zipFolder, setZipFolder] = useState(0)
  const [importMsg, setImportMsg] = useState('')
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null)
  const [importErrors, setImportErrors] = useState<ImportErr[]>([])
  const [grantDialog, setGrantDialog] = useState(false)
  const [grantFolder, setGrantFolder] = useState<Folder | null>(null)
  const [grantTarget, setGrantTarget] = useState('')
  const [grantGroups, setGrantGroups] = useState<string[]>([])
  const [deptChecked, setDeptChecked] = useState<string[]>([])
  const [savingGrants, setSavingGrants] = useState(false)
  const [departments, setDepartments] = useState<{ id: number; name: string; parent_id: number }[]>([])
  const [grantUsers, setGrantUsers] = useState<string[]>([])

  const [editDialog, setEditDialog] = useState(false)
  const [editId, setEditId] = useState(0)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [embedModel, setEmbedModel] = useState('')

  const loadFolders = useCallback(async () => {
    try {
      const data = await request('/api/admin/kb/folders')
      setFolders(data.folders)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  const loadDocs = useCallback(async (p: number, folderId: number) => {
    setDocsLoading(true)
    try {
      const data = await request(`/api/admin/kb/documents?folder_id=${folderId}&page=${p}&size=20`)
      setDocs(data.documents)
      setDocTotal(data.total)
      setDocPage(p)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setDocsLoading(false)
    }
  }, [])

  const loadImportStatus = useCallback(async () => {
    try {
      const data = await request('/api/admin/kb/import-status')
      setImportStatus(data.status)
      setImportErrors(data.errors ?? [])
    } catch {
      // polling must not flap the error banner
    }
  }, [])

  const loadEmbedModel = useCallback(async () => {
    try {
      const data = await request('/api/admin/kb/embedding-model')
      setEmbedModel(data.model ?? '')
    } catch {
      // silent: vector search is optional
    }
  }, [])

  async function saveEmbedModel() {
    try {
      await request('/api/admin/kb/embedding-model', {
        method: 'PUT',
        body: JSON.stringify({ model: embedModel.trim() }),
      })
      setError('')
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function reindexEmbeddings() {
    if (!window.confirm('重建向量索引?现有向量将清空并在后台重新生成。')) return
    try {
      await request('/api/admin/kb/embedding-reindex', { method: 'POST' })
    } catch (err: any) {
      setError(err.message)
    }
  }

  const loadDepartments = useCallback(async () => {
    try {
      const d = await request('/api/admin/departments')
      setDepartments(d.departments ?? [])
    } catch { /* 部门可选 */ }
  }, [])

  useEffect(() => { loadFolders(); loadImportStatus(); loadEmbedModel(); loadDepartments() }, [loadFolders, loadImportStatus, loadEmbedModel, loadDepartments])
  useEffect(() => { loadDocs(1, selected) }, [loadDocs, selected])
  // poll while uploads are still being extracted (H1: pending OR in-flight —
  // a row claimed by a worker is 'processing', not 'pending', so stopping on
  // pending==0 would freeze the progress panel mid-extraction)
  useEffect(() => {
    if (!importStatus || (importStatus.pending <= 0 && (importStatus.processing ?? 0) <= 0)) return
    const t = setInterval(loadImportStatus, 2000)
    return () => clearInterval(t)
  }, [importStatus, loadImportStatus])

  const searching = query.trim() !== ''

  async function importZip() {
    if (!zipFile) return
    setImporting(true)
    const fd = new FormData()
    fd.append('file', zipFile)
    fd.append('folder_id', String(zipFolder))
    setImportMsg('')
    try {
      const data = await request('/api/admin/kb/import-zip', { method: 'POST', body: fd })
      setImportMsg(`已接受 ${data.accepted} 个文件,跳过 ${data.skipped?.length ?? 0} 个`)
      setZipDialog(false)
      setZipFile(null)
      loadImportStatus()
      loadDocs(1, selected)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  async function retryDoc(id: number) {
    try {
      await request(`/api/admin/kb/documents/${id}/retry`, { method: 'POST' })
      loadImportStatus()
      loadDocs(docPage, selected)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function doSearch(p?: number, folderId?: number) {
    setSearchBusy(true)
    try {
      const target = p ?? hitPage
      const fid = folderId ?? searchFolder
      const params = new URLSearchParams({ q: query })
      if (target > 1) params.set('page', String(target))
      if (fid > 0) params.set('folder_id', String(fid))
      const data = await request(`/api/admin/kb/search?${params.toString()}`)
      setHits(data.results)
      setHitTotal(data.total ?? 0)
      setHitPage(target)
      setHitMode(data.mode ?? 'lexical')
      setError('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSearchBusy(false)
    }
  }

  async function deleteFolder(id: number, name: string) {
    if (!window.confirm(`确定删除文件夹「${name}」?有文档或授权时将无法删除。`)) return
    try {
      await request(`/api/admin/kb/folders/${id}`, { method: 'DELETE' })
      // L10: setSelected 是异步的,直接按删除后的语义加载根目录,避免
      // 对已删文件夹发一次无效请求后再由 effect 补一次
      if (selected === id) setSelected(0)
      loadFolders()
      loadDocs(1, selected === id ? 0 : selected)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function createFolder() {
    try {
      await request('/api/admin/kb/folders', { method: 'POST', body: JSON.stringify({ name: folderName }) })
      setFolderDialog(false)
      setFolderName('')
      loadFolders()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function uploadDoc() {
    if (!file) return
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('title', title || file.name)
    fd.append('folder_id', String(uploadFolder))
    try {
      await request('/api/admin/kb/upload', { method: 'POST', body: fd })
      setUploadDialog(false)
      setFile(null)
      setTitle('')
      // H1: single-file upload is async too — refresh the ingestion status so
      // the progress panel reflects the new pending row instead of going stale
      loadImportStatus()
      if (searching) doSearch()
      loadDocs(docPage, selected)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  async function deleteDoc(id: number, docTitle: string) {
    if (!window.confirm(`删除文档「${docTitle}」?`)) return
    try {
      await request(`/api/admin/kb/documents/${id}`, { method: 'DELETE' })
      if (searching) doSearch()
      loadDocs(docPage, selected)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function loadGrants(folderId: number): Promise<boolean> {
    try {
      const data = await request(`/api/admin/kb/folders/${folderId}/grants`)
      setGrantUsers(data.users ?? [])
      setGrantGroups(data.groups ?? [])
      setDeptChecked(data.groups ?? [])
      return true
    } catch (err: any) {
      // M1: 加载失败必须中止打开弹窗——否则 deptChecked=[] 时点"保存部门授权"
      // 会把整组授权清空
      setError(err.message)
      return false
    }
  }

  // 保存部门多选(整组替换,原子)
  async function saveDeptGrants() {
    if (!grantFolder) return
    setSavingGrants(true)
    try {
      await request(`/api/admin/kb/folders/${grantFolder.id}/grants`, {
        method: 'PUT',
        body: JSON.stringify({ groups: deptChecked }),
      })
      await loadGrants(grantFolder.id)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingGrants(false)
    }
  }

  function toggleGroup(name: string) {
    setDeptChecked((prev) => (prev.includes(name) ? prev.filter((g) => g !== name) : [...prev, name]))
  }

  async function revoke(target: string, isGroup: boolean) {
    if (!grantFolder) return
    if (!window.confirm(`撤销「${target}」对「${grantFolder.name}」的授权?`)) return
    try {
      await request(`/api/admin/kb/folders/${grantFolder.id}/grant`, {
        method: 'DELETE',
        body: JSON.stringify(isGroup ? { group: target } : { username: target }),
      })
      loadGrants(grantFolder.id)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function grant() {
    if (!grantFolder || !grantTarget.trim()) return
    const isGroup = grantTarget.trim().startsWith('@')
    try {
      await request(`/api/admin/kb/folders/${grantFolder.id}/grant`, {
        method: 'PUT',
        body: JSON.stringify(isGroup ? { group: grantTarget.trim().slice(1) } : { username: grantTarget.trim() }),
      })
      setGrantTarget('')
      loadGrants(grantFolder.id)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function openEdit(id: number, title: string) {
    try {
      const data = await request(`/api/admin/kb/documents/${id}`)
      setEditId(id)
      setEditTitle(title)
      setEditContent(data.doc.content ?? '')
      setEditDialog(true)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function saveEdit() {
    if (!editTitle.trim()) return
    try {
      await request(`/api/admin/kb/documents/${editId}`, {
        method: 'PUT',
        body: JSON.stringify({ title: editTitle, content: editContent }),
      })
      setEditDialog(false)
      if (searching) doSearch()
      loadDocs(docPage, selected)
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">知识库管理</h1>
      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="grid grid-cols-[240px_1fr] gap-6">
        <Card>
          <CardHeader>
            <CardTitle>文件夹</CardTitle>
            <CardDescription>授权制:所有文件夹(含根目录)须显式授权用户/部门组后才可见;公共文档请建「公共」文件夹并授权全员组</CardDescription>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setFolderDialog(true)}>新建文件夹</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {[{ id: 0, name: '根目录', parent_id: 0 }, ...folders].map((f) => (
                <div key={f.id} className="flex w-full items-center justify-between">
                  <Button
                    variant="ghost"
                    onClick={() => { setSelected(f.id); setSearchFolder(f.id) }}
                    style={f.parent_id !== 0 ? { paddingLeft: '2rem' } : undefined}
                    className={cn('h-auto flex-1 justify-start whitespace-normal px-3 py-2 text-left text-sm', selected === f.id && 'bg-accent')}
                  >
                    {f.parent_id !== 0 && <span className="text-muted-foreground">↳ </span>}
                    {f.name}
                  </Button>
                  {f.id !== 0 && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2"
                        onClick={async () => {
                          // 先加载 grants 再开弹窗:否则 deptChecked 仍是上一个文件夹的
                          // 勾选,保存时会把旧文件夹的整组授权覆盖到新文件夹(审计2026-W2)
                          // M1: 加载失败(网络/404)不打开弹窗,防止空 deptChecked 保存清空授权
                          setGrantFolder(f)
                          setGrantTarget('')
                          setGrantUsers([])
                          setGrantGroups([])
                          setDeptChecked([])
                          const ok = await loadGrants(f.id)
                          if (ok) setGrantDialog(true)
                        }}
                      >
                        授权
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-destructive"
                        title="删除文件夹(需先清空文档与授权)"
                        onClick={() => deleteFolder(f.id, f.name)}
                      >
                        删除
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>文档</CardTitle>
            <div className="flex justify-end gap-2">
              <Input
                className="w-64"
                placeholder="搜索知识库…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { setHitPage(1); doSearch(1) } }}
              />
              <Button variant="outline" disabled={searchBusy} onClick={() => { setHitPage(1); doSearch(1) }}>搜索</Button>
              {query.trim() !== '' && (
                <Badge variant={hitMode === 'hybrid' ? 'default' : 'outline'}>
                  {hitMode === 'hybrid' ? '混合检索' : '纯关键词检索'}
                </Badge>
              )}
              <Button size="sm" variant="outline" onClick={() => { setZipDialog(true); setZipFolder(selected) }}>批量导入</Button>
              <Button size="sm" onClick={() => { setUploadDialog(true); setUploadFolder(selected) }}>上传文档</Button>
            </div>
            {importMsg && <div className="text-xs text-muted-foreground">{importMsg}</div>}
            {importStatus && importStatus.total > 0 && (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="text-muted-foreground">导入进度:</span>
                <Badge variant="secondary">{importStatus.ready} 就绪</Badge>
                <Badge variant="outline">{importStatus.pending} 待处理</Badge>
                {(importStatus.processing ?? 0) > 0 && (
                  <Badge variant="outline">{importStatus.processing} 处理中</Badge>
                )}
                {importStatus.error > 0 && <Badge variant="destructive">{importStatus.error} 失败</Badge>}
                {typeof importStatus.embed_missing === 'number' && importStatus.embed_missing > 0 && (
                  <Badge variant="outline">全库向量化中 {importStatus.embed_missing} 个分块</Badge>
                )}
                <span className="text-muted-foreground">共 {importStatus.total} 篇</span>
                {importErrors.length > 0 && (
                  <div className="w-full space-y-1">
                    {importErrors.map((e) => (
                      <div key={e.id} className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 px-2 py-1">
                        <span className="truncate">「{e.title}」: {e.error}</span>
                        <Button size="sm" variant="outline" className="h-6 shrink-0" onClick={() => retryDoc(e.id)}>重试</Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标题</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>上传者</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docsLoading && !searching && (
                  <>
                    {[0, 1, 2].map((i) => (
                      <TableRow key={`sk${i}`}>
                        <TableCell colSpan={5}><Skeleton className="h-5 w-full" /></TableCell>
                      </TableRow>
                    ))}
                  </>
                )}
                {!docsLoading && searching
                  ? hits.map((h) => (
                    <TableRow key={h.chunk_id}>
                      <TableCell>
                        <div className="font-medium">
                          {h.title ?? '—'}
                          {h.title_path && <span className="text-muted-foreground"> › {h.title_path}</span>}
                        </div>
                        <div className="text-xs text-muted-foreground">{(h.content ?? '').slice(0, 120)}…</div>
                      </TableCell>
                      <TableCell><Badge variant="secondary">分块</Badge></TableCell>
                      <TableCell className="text-muted-foreground">score {typeof h.score === 'number' ? h.score.toFixed(2) : '—'}</TableCell>
                      <TableCell />
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="outline" onClick={() => openEdit(h.doc_id, h.title)}>编辑</Button>
                          <Button size="sm" variant="destructive" onClick={() => deleteDoc(h.doc_id, h.title)}>删除</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                  : docs.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {d.title}
                          {d.status && d.status !== 'ready' && (
                            <Badge variant={d.status === 'error' ? 'destructive' : 'outline'}>{STATUS_LABEL[d.status] ?? d.status}</Badge>
                          )}
                        </div>
                        {d.status === 'error' && d.error && <div className="text-xs text-destructive">{d.error}</div>}
                      </TableCell>
                      <TableCell><Badge variant="secondary">{CT_LABEL[d.content_type] ?? d.content_type}</Badge></TableCell>
                      <TableCell>{fmtSize(d.size)}</TableCell>
                      <TableCell>{d.created_by}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {d.status === 'error' && <Button size="sm" variant="outline" onClick={() => retryDoc(d.id)}>重试</Button>}
                          <Button size="sm" variant="outline" disabled={d.status === 'pending' || d.status === 'processing'} title={d.status === 'pending' || d.status === 'processing' ? '处理中,暂不可编辑' : undefined} onClick={() => openEdit(d.id, d.title)}>编辑</Button>
                          <Button size="sm" variant="destructive" onClick={() => deleteDoc(d.id, d.title)}>删除</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                {!searching && !docsLoading && docs.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无文档</TableCell></TableRow>
                )}
                {searching && hits.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">无搜索结果</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
            {!searching && (
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={docPage <= 1} onClick={() => loadDocs(docPage - 1, selected)}>上一页</Button>
                <span className="text-sm text-muted-foreground">第 {docPage}/{Math.max(1, Math.ceil(docTotal / 20))} 页 · 共 {docTotal} 篇</span>
                <Button size="sm" variant="outline" disabled={docPage >= Math.max(1, Math.ceil(docTotal / 20))} onClick={() => loadDocs(docPage + 1, selected)}>下一页</Button>
              </div>
            )}
            {searching && (
              // M2: 搜索结果也分页(服务端 size=20,默认只回第一页)
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={hitPage <= 1} onClick={() => doSearch(hitPage - 1)}>上一页</Button>
                <span className="text-sm text-muted-foreground">第 {hitPage}/{Math.max(1, Math.ceil(hitTotal / 20))} 页 · 共 {hitTotal} 条</span>
                <Button size="sm" variant="outline" disabled={hitPage >= Math.max(1, Math.ceil(hitTotal / 20))} onClick={() => doSearch(hitPage + 1)}>下一页</Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="grid gap-3 p-4 sm:col-span-2">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>向量检索模型(留空 = 纯关键词检索)</Label>
            <Input
              className="w-72"
              placeholder="如 bge-m3 / text-embedding-3-small"
              value={embedModel}
              onChange={(e) => setEmbedModel(e.target.value)}
            />
          </div>
          <Button size="sm" variant="outline" onClick={saveEmbedModel}>保存</Button>
          <Button size="sm" variant="ghost" disabled={!embedModel.trim()} title={embedModel.trim() ? undefined : '请先配置向量模型'} onClick={reindexEmbeddings}>重建向量索引</Button>
          <span className="text-xs text-muted-foreground">
            模型名须已存在于网关模型列表中;保存后后台自动为文档分块生成向量,搜索自动切换为混合检索
          </span>
        </div>
      </Card>

      <Dialog open={folderDialog} onOpenChange={setFolderDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>新建文件夹</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>名称</Label>
              <Input value={folderName} onChange={(e) => setFolderName(e.target.value)} />
            </div>
            <Button className="w-full" onClick={createFolder}>创建</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={uploadDialog} onOpenChange={setUploadDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>上传文档</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>文件(txt / md / docx / pdf)</Label>
              <Input type="file" accept=".txt,.md,.docx,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="space-y-1">
              <Label>标题(留空使用文件名)</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>文件夹</Label>
              <Select value={String(uploadFolder)} onValueChange={(v) => setUploadFolder(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">全部 / 根目录</SelectItem>
                  {folders.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full" disabled={!file || uploading} onClick={uploadDoc}>{uploading ? '上传中…' : '上传'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={zipDialog} onOpenChange={setZipDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>批量导入</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>zip 压缩包(txt / md / docx / pdf,≤200 个文件)</Label>
              <Input type="file" accept=".zip" onChange={(e) => setZipFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="space-y-1">
              <Label>目标文件夹</Label>
              <Select value={String(zipFolder)} onValueChange={(v) => setZipFolder(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">全部 / 根目录</SelectItem>
                  {folders.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="text-xs text-muted-foreground">
              上传后自动异步解析并分块建索引;可在上方进度条查看状态,失败的文件可单独重试。
            </div>
            <Button className="w-full" disabled={!zipFile || importing} onClick={importZip}>{importing ? '导入中…' : '导入'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={grantDialog} onOpenChange={setGrantDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>授权文件夹「{grantFolder?.name}」</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {grantUsers.length + grantGroups.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                {grantUsers.map((u) => (
                  <div key={`u${u}`} className="flex items-center justify-between text-sm">
                    <Badge variant="secondary">{u}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => revoke(u, false)}>撤销</Button>
                  </div>
                ))}
                {grantGroups.map((g) => (
                  <div key={`g${g}`} className="flex items-center justify-between text-sm">
                    <Badge variant="secondary">@{g}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => revoke(g, true)}>撤销</Button>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1">
              <Label>部门(多选:一个文件夹可授权多个部门,成员共享)</Label>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {departments.map((d) => (
                  <label key={d.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={deptChecked.includes(d.name)}
                      onChange={() => toggleGroup(d.name)}
                    />
                    {d.parent_id !== 0 && <span className="text-muted-foreground">↳</span>}
                    {d.name}
                  </label>
                ))}
              </div>
              <Button size="sm" variant="outline" className="mt-1 w-full" disabled={savingGrants} onClick={saveDeptGrants}>{savingGrants ? '保存中…' : '保存部门授权'}</Button>
            </div>
            <div className="space-y-1">
              <Label>用户名(单个,可选)</Label>
              <Input placeholder="如 alice" value={grantTarget} onChange={(e) => setGrantTarget(e.target.value)} />
            </div>
            <Button className="w-full" disabled={!grantTarget.trim() || savingGrants} onClick={grant}>添加用户授权</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialog} onOpenChange={setEditDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>编辑文档</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>标题</Label>
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>内容</Label>
              <Textarea className="min-h-56" value={editContent} onChange={(e) => setEditContent(e.target.value)} />
            </div>
            <Button className="w-full" disabled={!editTitle.trim()} onClick={saveEdit}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
