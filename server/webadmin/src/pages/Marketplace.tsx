import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Skeleton } from '../components/ui/skeleton'
import { deptTreeOptions } from '../lib/utils'

interface Skill {
  id: number
  name: string
  version: string
  description: string
  author: string
  git_url: string
  git_ref: string
  enabled: boolean
}

interface Mcp {
  id: number
  name: string
  description: string
  transport: string
  command: string
  args?: string[]
  url: string
  env: Record<string, string>
  headers: Record<string, string>
  enabled: boolean
}

interface Download {
  id: number
  username: string
  mcp_name: string
  created_at: string
}

interface Grant {
  grantee_type: string
  grantee: string
}

interface Dept {
  id: number
  parent_id: number
  name: string
}

// ---- 表单状态 ----
const EMPTY_SKILL_FORM = { name: '', git_url: '', version: '', description: '', author: '' }
const EMPTY_MCP_FORM = { name: '', description: '', transport: 'stdio', command: '', args: '', url: '', env: '', headers: '' }

const DOWNLOAD_PAGE_SIZE = 20

export default function Marketplace() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [mcps, setMcps] = useState<Mcp[]>([])
  const [downloads, setDownloads] = useState<Download[]>([])
  const [downloadTotal, setDownloadTotal] = useState(0)
  const [downloadPage, setDownloadPage] = useState(1)
  const [departments, setDepartments] = useState<Dept[]>([])

  // 独立加载态与错误(审计 A5-M4):四块数据互不拖累,loading/error/empty 各自呈现
  const [skillsLoading, setSkillsLoading] = useState(true)
  const [mcpsLoading, setMcpsLoading] = useState(true)
  const [downloadsLoading, setDownloadsLoading] = useState(true)
  const [skillsError, setSkillsError] = useState('')
  const [mcpsError, setMcpsError] = useState('')
  const [downloadsError, setDownloadsError] = useState('')

  // 技能:新增/编辑共用一个表单(审计 A5-M2)
  const [skillDialog, setSkillDialog] = useState(false)
  const [skillEdit, setSkillEdit] = useState<Skill | null>(null)
  const [skillForm, setSkillForm] = useState(EMPTY_SKILL_FORM)

  // MCP:新增/编辑共用一个表单
  const [mcpDialog, setMcpDialog] = useState(false)
  const [mcpEdit, setMcpEdit] = useState<Mcp | null>(null)
  const [mcpForm, setMcpForm] = useState(EMPTY_MCP_FORM)

  // 授权
  const [grantDialog, setGrantDialog] = useState<{ kind: 'skill' | 'mcp'; name: string; id: number } | null>(null)
  const [grants, setGrants] = useState<Grant[]>([])
  const [grantTarget, setGrantTarget] = useState('')
  const [grantGroups, setGrantGroups] = useState<string[]>([])
  const [grantSaving, setGrantSaving] = useState(false)

  // 弹窗内操作错误(审计 A5-L4):靠近操作点展示,页面级错误只留给加载失败
  const [dialogError, setDialogError] = useState('')
  // P1-6: 提交中操作标识(双击守卫 + 按钮禁用/loading)。null = 空闲,值为操作 key。
  const [busy, setBusy] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    setSkillsError('')
    try {
      const s = await request('/api/admin/skills')
      setSkills(s.skills ?? [])
    } catch (err: any) {
      setSkillsError(err.message)
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  const loadMcps = useCallback(async () => {
    setMcpsLoading(true)
    setMcpsError('')
    try {
      const m = await request('/api/admin/mcp')
      setMcps(m.mcp ?? [])
    } catch (err: any) {
      setMcpsError(err.message)
    } finally {
      setMcpsLoading(false)
    }
  }, [])

  const loadDownloads = useCallback(async (page: number) => {
    setDownloadsLoading(true)
    setDownloadsError('')
    try {
      const d = await request(`/api/admin/mcp-downloads?page=${page}&size=${DOWNLOAD_PAGE_SIZE}`)
      setDownloads(d.downloads ?? [])
      setDownloadTotal(d.total ?? 0)
      setDownloadPage(page)
    } catch (err: any) {
      setDownloadsError(err.message)
    } finally {
      setDownloadsLoading(false)
    }
  }, [])

  const loadDepartments = useCallback(async () => {
    try {
      const dep = await request('/api/admin/departments')
      setDepartments(dep.departments ?? [])
    } catch {
      // 部门列表仅授权对话框使用,加载失败不阻塞主页面
    }
  }, [])

  useEffect(() => { loadSkills(); loadMcps(); loadDownloads(1); loadDepartments() }, [loadSkills, loadMcps, loadDownloads, loadDepartments])

  // ---- 技能 ----
  async function saveSkill() {
    if (busy) return // P1-6: 双击守卫
    setDialogError('')
    if (!skillForm.name.trim()) { setDialogError('名称必填'); return }
    if (!skillForm.git_url.trim()) { setDialogError('Git 地址必填'); return }
    setBusy('save-skill')
    try {
      if (skillEdit) {
        await request(`/api/admin/skills/${encodeURIComponent(skillEdit.name)}`, {
          method: 'PUT',
          body: JSON.stringify(skillForm),
        })
      } else {
        await request('/api/admin/skills', { method: 'POST', body: JSON.stringify(skillForm) })
      }
      setSkillDialog(false)
      setSkillEdit(null)
      setSkillForm(EMPTY_SKILL_FORM)
      loadSkills()
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setBusy(null)
    }
  }

  function openCreateSkill() {
    setDialogError('')
    setSkillEdit(null)
    setSkillForm(EMPTY_SKILL_FORM)
    setSkillDialog(true)
  }

  function openEditSkill(s: Skill) {
    setDialogError('')
    setSkillEdit(s)
    setSkillForm({ name: s.name, git_url: s.git_url, version: s.version, description: s.description, author: s.author })
    setSkillDialog(true)
  }

  async function disableSkill(name: string) {
    if (busy) return // P1-6: 双击守卫
    if (!window.confirm(`下架技能 ${name}?员工建议清单将不再展示(可重新上架)。`)) return
    setBusy(`disable-skill-${name}`)
    try {
      await request(`/api/admin/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
      loadSkills()
    } catch (err: any) {
      setSkillsError(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function enableSkill(name: string) {
    if (busy) return // P1-6: 双击守卫
    setBusy(`enable-skill-${name}`)
    try {
      await request(`/api/admin/skills/${encodeURIComponent(name)}/enable`, { method: 'POST' })
      loadSkills()
    } catch (err: any) {
      setSkillsError(err.message)
    } finally {
      setBusy(null)
    }
  }

  // ---- MCP ----
  // args/env/headers 输入都是文本,解析成 JSON 传输
  function parseMcpForm(): { args: string[]; env: Record<string, string>; headers: Record<string, string> } | string {
    let args: string[] = []
    let env: Record<string, string> = {}
    let headers: Record<string, string> = {}
    try {
      args = JSON.parse(mcpForm.args || '[]')
      if (!Array.isArray(args)) throw new Error()
    } catch {
      args = mcpForm.args.split(',').map((s) => s.trim()).filter(Boolean)
    }
    try {
      env = JSON.parse(mcpForm.env || '{}')
      if (typeof env !== 'object' || env === null || Array.isArray(env)) throw new Error()
    } catch {
      return 'env 必须是合法 JSON 对象'
    }
    try {
      headers = JSON.parse(mcpForm.headers || '{}')
      if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) throw new Error()
    } catch {
      return 'headers 必须是合法 JSON 对象'
    }
    return { args, env, headers }
  }

  // 编辑回填:args 数组转文本;env/headers 敏感值已是 "***"(服务端掩码),
  // 原样回传即表示保持(审计 A5-H2 契约),非敏感值明文便于直接修改
  function mcpFormFrom(m: Mcp) {
    return {
      name: m.name,
      description: m.description,
      transport: m.transport,
      command: m.command,
      args: Array.isArray(m.args) ? JSON.stringify(m.args) : '',
      url: m.url,
      env: JSON.stringify(m.env ?? {}, null, 2),
      headers: JSON.stringify(m.headers ?? {}, null, 2),
    }
  }

  async function saveMcp() {
    if (busy) return // P1-6: 双击守卫
    setDialogError('')
    if (!mcpForm.name.trim()) { setDialogError('名称必填'); return }
    if (mcpForm.transport === 'http' && !mcpForm.url.trim()) { setDialogError('HTTP 传输方式必须填写 URL'); return }
    const parsed = parseMcpForm()
    if (typeof parsed === 'string') { setDialogError(parsed); return }
    setBusy('save-mcp')
    try {
      const body = JSON.stringify({
        name: mcpForm.name,
        description: mcpForm.description,
        transport: mcpForm.transport,
        command: mcpForm.command,
        args: parsed.args,
        url: mcpForm.url,
        env: parsed.env,
        headers: parsed.headers,
      })
      if (mcpEdit) {
        await request(`/api/admin/mcp/${mcpEdit.id}`, { method: 'PUT', body })
      } else {
        await request('/api/admin/mcp', { method: 'POST', body })
      }
      setMcpDialog(false)
      setMcpEdit(null)
      setMcpForm(EMPTY_MCP_FORM)
      loadMcps()
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setBusy(null)
    }
  }

  function openCreateMcp() {
    setDialogError('')
    setMcpEdit(null)
    setMcpForm(EMPTY_MCP_FORM)
    setMcpDialog(true)
  }

  function openEditMcp(m: Mcp) {
    setDialogError('')
    setMcpEdit(m)
    setMcpForm(mcpFormFrom(m))
    setMcpDialog(true)
  }

  async function disableMcp(id: number) {
    if (busy) return // P1-6: 双击守卫
    if (!window.confirm(`下架 MCP 插件 #${id}?已安装客户端不再获得新凭证(可重新上架)。`)) return
    setBusy(`disable-mcp-${id}`)
    try {
      await request(`/api/admin/mcp/${id}`, { method: 'DELETE' })
      loadMcps()
    } catch (err: any) {
      setMcpsError(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function enableMcp(id: number) {
    if (busy) return // P1-6: 双击守卫
    setBusy(`enable-mcp-${id}`)
    try {
      await request(`/api/admin/mcp/${id}/enable`, { method: 'POST' })
      loadMcps()
    } catch (err: any) {
      setMcpsError(err.message)
    } finally {
      setBusy(null)
    }
  }

  // ---- 授权 ----
  function grantPath(d: { kind: 'skill' | 'mcp'; name: string; id: number }): string {
    return d.kind === 'skill' ? `/api/admin/skills/${encodeURIComponent(d.name)}/grant` : `/api/admin/mcp/${d.id}/grant`
  }

  function grantsPath(d: { kind: 'skill' | 'mcp'; name: string; id: number }): string {
    return d.kind === 'skill' ? `/api/admin/skills/${encodeURIComponent(d.name)}/grants` : `/api/admin/mcp/${d.id}/grants`
  }

  async function openGrants(d: { kind: 'skill' | 'mcp'; name: string; id: number }) {
    setDialogError('')
    try {
      const data = await request(grantsPath(d))
      setGrants(data.grants ?? [])
      setGrantGroups((data.grants ?? []).filter((g: Grant) => g.grantee_type === 'group').map((g: Grant) => g.grantee))
      setGrantTarget('')
      setGrantDialog(d)
    } catch (err: any) {
      setDialogError(err.message)
    }
  }

  // 保存部门多选 = 整组替换(原子;用户授权保留)。审计 A5-M6:
  // 覆盖语义必须确认 + 明示,避免取消勾选一个部门就把其它部门授权静默清掉。
  async function saveDeptGrants() {
    if (grantSaving || !grantDialog) return // P1-6: 双击守卫
    if (!window.confirm('保存部门授权将覆盖该资源的全部部门授权(用户授权不受影响)。确定保存?')) return
    setGrantSaving(true)
    setDialogError('')
    try {
      await request(grantsPath(grantDialog), {
        method: 'PUT',
        body: JSON.stringify({ groups: grantGroups }),
      })
      setGrantDialog(null)
      loadSkills()
      loadMcps()
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
    if (busy || !grantDialog || !grantTarget.trim()) return // P1-6: 双击守卫
    const isGroup = grantTarget.trim().startsWith('@')
    setDialogError('')
    setBusy('grant')
    try {
      await request(grantPath(grantDialog), {
        method: 'PUT',
        body: JSON.stringify(isGroup ? { group: grantTarget.trim().slice(1) } : { username: grantTarget.trim() }),
      })
      setGrantTarget('')
      openGrants(grantDialog)
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function revokeGrant(g: Grant) {
    if (busy || !grantDialog) return // P1-6: 双击守卫
    if (!window.confirm(`撤销「${g.grantee}」的授权?`)) return
    setDialogError('')
    setBusy(`revoke-${g.grantee_type}-${g.grantee}`)
    try {
      await request(grantPath(grantDialog), {
        method: 'DELETE',
        body: JSON.stringify(g.grantee_type === 'group' ? { group: g.grantee } : { username: g.grantee }),
      })
      openGrants(grantDialog)
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setBusy(null)
    }
  }

  // ---- 展示辅助 ----
  // 审计 A5-L8:时间本地化展示,不再原样输出 UTC RFC3339
  function fmtTime(iso: string): string {
    const d = new Date(iso)
    return isNaN(d.getTime()) ? iso : d.toLocaleString()
  }

  const deptOptions = useMemo(() => {
    const nameById = new Map(departments.map((d) => [d.id, d.name]))
    return deptTreeOptions(departments).map((o) => ({ ...o, name: nameById.get(o.id) ?? '' }))
  }, [departments])

  const downloadPages = Math.max(1, Math.ceil(downloadTotal / DOWNLOAD_PAGE_SIZE))

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">商城管理</h1>

      <Card>
        <CardHeader>
          <CardTitle>技能(Skill)</CardTitle>
          <CardDescription>Git 源上架 + 授权制:未授权用户不可见不可安装(授权用户或部门组)</CardDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={openCreateSkill}>上架技能</Button>
          </div>
        </CardHeader>
        <CardContent>
          {skillsError ? (
            <div className="flex items-center justify-between rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              <span>技能加载失败:{skillsError}</span>
              <Button size="sm" variant="outline" onClick={loadSkills}>重试</Button>
            </div>
          ) : skillsLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead>描述</TableHead>
                  <TableHead>Git 源</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skills.map((s) => (
                  <TableRow key={s.name}>
                    <TableCell>{s.name}</TableCell>
                    <TableCell>{s.version}</TableCell>
                    <TableCell>{s.description}</TableCell>
                    <TableCell className="max-w-56 truncate font-mono text-xs">{s.git_url}</TableCell>
                    <TableCell>{s.enabled ? <Badge variant="success">上架</Badge> : <Badge variant="secondary">已下架</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => openEditSkill(s)}>编辑</Button>
                        <Button size="sm" variant="outline" onClick={() => openGrants({ kind: 'skill', name: s.name, id: 0 })}>授权</Button>
                        {s.enabled
                          ? <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => disableSkill(s.name)}>{busy === `disable-skill-${s.name}` ? '下架中…' : '下架'}</Button>
                          : <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => enableSkill(s.name)}>{busy === `enable-skill-${s.name}` ? '上架中…' : '重新上架'}</Button>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {skills.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无技能,点击「上架技能」添加</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>MCP 插件</CardTitle>
          <CardDescription>管理员上架/授权,员工按授权使用;凭证加密存储,拉取限流+审计</CardDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={openCreateMcp}>上架插件</Button>
          </div>
        </CardHeader>
        <CardContent>
          {mcpsError ? (
            <div className="flex items-center justify-between rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              <span>插件加载失败:{mcpsError}</span>
              <Button size="sm" variant="outline" onClick={loadMcps}>重试</Button>
            </div>
          ) : mcpsLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>描述</TableHead>
                  <TableHead>传输</TableHead>
                  <TableHead>命令/URL</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mcps.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.id}</TableCell>
                    <TableCell>{m.name}</TableCell>
                    <TableCell>{m.description}</TableCell>
                    <TableCell>{m.transport}</TableCell>
                    <TableCell className="max-w-56 truncate font-mono text-xs">{m.transport === 'stdio' ? `${m.command} ${m.args?.join(' ')}` : m.url}</TableCell>
                    <TableCell>{m.enabled ? <Badge variant="success">上架</Badge> : <Badge variant="secondary">已下架</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => openEditMcp(m)}>编辑</Button>
                        <Button size="sm" variant="outline" onClick={() => openGrants({ kind: 'mcp', name: m.name, id: m.id })}>授权</Button>
                        {m.enabled
                          ? <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => disableMcp(m.id)}>{busy === `disable-mcp-${m.id}` ? '下架中…' : '下架'}</Button>
                          : <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => enableMcp(m.id)}>{busy === `enable-mcp-${m.id}` ? '上架中…' : '重新上架'}</Button>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {mcps.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">暂无插件,点击「上架插件」添加</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>凭证下载审计</CardTitle>
          <CardDescription>插件凭证拉取记录(per-user 限流 + 审计,防批量导出)</CardDescription>
        </CardHeader>
        <CardContent>
          {downloadsError ? (
            <div className="flex items-center justify-between rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              <span>下载记录加载失败:{downloadsError}</span>
              <Button size="sm" variant="outline" onClick={() => loadDownloads(downloadPage)}>重试</Button>
            </div>
          ) : downloadsLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>用户</TableHead>
                    <TableHead>插件</TableHead>
                    <TableHead>时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {downloads.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>{d.id}</TableCell>
                      <TableCell>{d.username}</TableCell>
                      <TableCell>{d.mcp_name}</TableCell>
                      <TableCell>{fmtTime(d.created_at)}</TableCell>
                    </TableRow>
                  ))}
                  {downloads.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">暂无记录</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
              {/* 审计 A5-M5:分页(总数 + 上一页/下一页),不再固定只看最近 20 条 */}
              {downloadTotal > DOWNLOAD_PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                  <span>共 {downloadTotal} 条</span>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={downloadPage <= 1} onClick={() => loadDownloads(downloadPage - 1)}>上一页</Button>
                    <span>{downloadPage} / {downloadPages}</span>
                    <Button size="sm" variant="outline" disabled={downloadPage >= downloadPages} onClick={() => loadDownloads(downloadPage + 1)}>下一页</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={skillDialog} onOpenChange={(v) => { setSkillDialog(v); if (!v) { setSkillEdit(null); setSkillForm(EMPTY_SKILL_FORM) } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{skillEdit ? `编辑技能 ${skillEdit.name}` : '上架技能'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="skill-name">名称</Label>
              <Input id="skill-name" value={skillForm.name} disabled={!!skillEdit} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} />
              {skillEdit && <p className="text-xs text-muted-foreground">名称不可修改(唯一键);如需改名请下架后重新上架</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="skill-git">Git 地址</Label>
              <Input id="skill-git" value={skillForm.git_url} onChange={(e) => setSkillForm({ ...skillForm, git_url: e.target.value })} />
              <p className="text-xs text-muted-foreground">仅支持 http/https 远程仓库</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="skill-version">版本</Label>
                <Input id="skill-version" value={skillForm.version} onChange={(e) => setSkillForm({ ...skillForm, version: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="skill-author">作者</Label>
                <Input id="skill-author" value={skillForm.author} onChange={(e) => setSkillForm({ ...skillForm, author: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="skill-desc">描述</Label>
              <Input id="skill-desc" value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} />
            </div>
            {dialogError && <div className="text-sm text-destructive">{dialogError}</div>}
            <Button className="w-full" disabled={busy !== null} onClick={saveSkill}>{busy === 'save-skill' ? '处理中…' : (skillEdit ? '保存修改' : '上架')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={mcpDialog} onOpenChange={(v) => { setMcpDialog(v); if (!v) { setMcpEdit(null); setMcpForm(EMPTY_MCP_FORM) } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{mcpEdit ? `编辑插件 ${mcpEdit.name}` : '上架 MCP 插件'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="mcp-name">名称</Label>
                <Input id="mcp-name" value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mcp-transport">传输方式</Label>
                <Select value={mcpForm.transport} onValueChange={(v) => setMcpForm({ ...mcpForm, transport: v })}>
                  <SelectTrigger id="mcp-transport"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">stdio</SelectItem>
                    <SelectItem value="http">http</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="mcp-desc">描述</Label>
              <Input id="mcp-desc" value={mcpForm.description} onChange={(e) => setMcpForm({ ...mcpForm, description: e.target.value })} />
            </div>
            {mcpForm.transport === 'stdio' ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor="mcp-command">命令</Label>
                  <Input id="mcp-command" placeholder="npx" value={mcpForm.command} onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="mcp-args">参数(JSON 数组或逗号分隔)</Label>
                  <Input id="mcp-args" placeholder='["-y","mcp-server-x"]' value={mcpForm.args} onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })} />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="mcp-url">URL</Label>
                <Input id="mcp-url" placeholder="http://127.0.0.1:3000/mcp" value={mcpForm.url} onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })} />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="mcp-env">环境变量(JSON,敏感值自动加密;编辑时 *** 表示保持原值)</Label>
              <Input id="mcp-env" placeholder='{"APP_ID":"x","APP_SECRET":"y"}' value={mcpForm.env} onChange={(e) => setMcpForm({ ...mcpForm, env: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mcp-headers">请求头(JSON,编辑时 *** 表示保持原值)</Label>
              <Input id="mcp-headers" placeholder='{"Authorization":"Bearer x"}' value={mcpForm.headers} onChange={(e) => setMcpForm({ ...mcpForm, headers: e.target.value })} />
            </div>
            {dialogError && <div className="text-sm text-destructive">{dialogError}</div>}
            <Button className="w-full" disabled={busy !== null} onClick={saveMcp}>{busy === 'save-mcp' ? '处理中…' : (mcpEdit ? '保存修改' : '上架')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={grantDialog !== null} onOpenChange={(v) => !v && setGrantDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>授权「{grantDialog?.name}」</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {grants.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                {grants.map((g) => (
                  <div key={`${g.grantee_type}:${g.grantee}`} className="flex items-center justify-between text-sm">
                    <Badge variant={g.grantee_type === 'group' ? 'outline' : 'secondary'}>
                      {g.grantee_type === 'group' ? `@${g.grantee}` : g.grantee}
                    </Badge>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => revokeGrant(g)}>{busy === `revoke-${g.grantee_type}-${g.grantee}` ? '撤销中…' : '撤销'}</Button>
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
                    <Checkbox
                      checked={grantGroups.includes(o.name)}
                      onChange={() => toggleGroup(o.name)}
                    />
                    {o.label}
                  </label>
                ))}
                {deptOptions.length === 0 && <div className="text-xs text-muted-foreground">暂无部门</div>}
              </div>
              <p className="text-xs text-muted-foreground">「保存部门授权」将覆盖该资源的全部部门授权(用户授权不受影响)</p>
              <Button size="sm" variant="outline" className="mt-1 w-full" disabled={grantSaving || busy !== null} onClick={saveDeptGrants}>{grantSaving ? '保存中…' : '保存部门授权'}</Button>
            </div>
            <div className="space-y-1">
              <Label htmlFor="grant-user">用户名(单个,可选)</Label>
              <Input id="grant-user" placeholder="如 alice" value={grantTarget} onChange={(e) => setGrantTarget(e.target.value)} />
            </div>
            {dialogError && <div className="text-sm text-destructive">{dialogError}</div>}
            <Button className="w-full" disabled={!grantTarget.trim() || grantSaving || busy !== null} onClick={doGrant}>{busy === 'grant' ? '处理中…' : '添加用户授权'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
