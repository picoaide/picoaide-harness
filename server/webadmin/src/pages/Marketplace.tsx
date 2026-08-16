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

interface Skill {
  name: string
  version: string
  description: string
  author: string
  git_url: string
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

export default function Marketplace() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [mcps, setMcps] = useState<Mcp[]>([])
  const [downloads, setDownloads] = useState<Download[]>([])
  const [error, setError] = useState('')

  const [skillDialog, setSkillDialog] = useState(false)
  const [skillForm, setSkillForm] = useState({ name: '', git_url: '', version: '', description: '', author: '' })
  const [mcpDialog, setMcpDialog] = useState(false)
  const [mcpForm, setMcpForm] = useState({
    name: '', description: '', transport: 'stdio', command: '', args: '', url: '', env: '', headers: '',
  })
  const [grantDialog, setGrantDialog] = useState<{ kind: 'skill' | 'mcp'; name: string; id: number } | null>(null)
  const [grants, setGrants] = useState<Grant[]>([])
  const [grantTarget, setGrantTarget] = useState('')

  const load = useCallback(async () => {
    try {
      const [s, m, d] = await Promise.all([
        request('/api/admin/skills'),
        request('/api/admin/mcp'),
        request('/api/admin/mcp-downloads?size=20'),
      ])
      setSkills(s.skills)
      setMcps(m.mcp)
      setDownloads(d.downloads)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function createSkill() {
    try {
      await request('/api/admin/skills', { method: 'POST', body: JSON.stringify(skillForm) })
      setSkillDialog(false)
      setSkillForm({ name: '', git_url: '', version: '', description: '', author: '' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function disableSkill(name: string) {
    if (!window.confirm(`下架技能 ${name}?员工建议清单将不再展示。`)) return
    try {
      await request(`/api/admin/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function createMcp() {
    try {
      let args: string[] = []
      let env: Record<string, string> = {}
      let headers: Record<string, string> = {}
      try { args = JSON.parse(mcpForm.args || '[]') } catch { args = mcpForm.args.split(',').map((s) => s.trim()).filter(Boolean) }
      let parseErr = ''
      try { env = JSON.parse(mcpForm.env || '{}') } catch { parseErr = 'env 必须是合法 JSON' }
      try { headers = JSON.parse(mcpForm.headers || '{}') } catch { parseErr = parseErr || 'headers 必须是合法 JSON' }
      if (parseErr) {
        setError(parseErr)
        return
      }
      await request('/api/admin/mcp', {
        method: 'POST',
        body: JSON.stringify({
          name: mcpForm.name,
          description: mcpForm.description,
          transport: mcpForm.transport,
          command: mcpForm.command,
          args,
          url: mcpForm.url,
          env,
          headers,
        }),
      })
      setMcpDialog(false)
      setMcpForm({ name: '', description: '', transport: 'stdio', command: '', args: '', url: '', env: '', headers: '' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function disableMcp(id: number) {
    if (!window.confirm(`下架 MCP 插件 #${id}?已安装客户端不再获得新凭证。`)) return
    try {
      await request(`/api/admin/mcp/${id}`, { method: 'DELETE' })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  function grantPath(d: { kind: 'skill' | 'mcp'; name: string; id: number }): string {
    return d.kind === 'skill' ? `/api/admin/skills/${encodeURIComponent(d.name)}/grant` : `/api/admin/mcp/${d.id}/grant`
  }

  function grantsPath(d: { kind: 'skill' | 'mcp'; name: string; id: number }): string {
    return d.kind === 'skill' ? `/api/admin/skills/${encodeURIComponent(d.name)}/grants` : `/api/admin/mcp/${d.id}/grants`
  }

  async function openGrants(d: { kind: 'skill' | 'mcp'; name: string; id: number }) {
    try {
      const data = await request(grantsPath(d))
      setGrants(data.grants ?? [])
      setGrantTarget('')
      setGrantDialog(d)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function doGrant() {
    if (!grantDialog || !grantTarget.trim()) return
    const isGroup = grantTarget.trim().startsWith('@')
    try {
      await request(grantPath(grantDialog), {
        method: 'PUT',
        body: JSON.stringify(isGroup ? { group: grantTarget.trim().slice(1) } : { username: grantTarget.trim() }),
      })
      setGrantTarget('')
      openGrants(grantDialog)
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function revokeGrant(g: Grant) {
    if (!grantDialog) return
    if (!window.confirm(`撤销「${g.grantee}」的授权?`)) return
    try {
      await request(grantPath(grantDialog), {
        method: 'DELETE',
        body: JSON.stringify(g.grantee_type === 'group' ? { group: g.grantee } : { username: g.grantee }),
      })
      openGrants(grantDialog)
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">商城管理</h1>
      {error && <div className="text-sm text-destructive">{error}</div>}

      <Card>
        <CardHeader>
          <CardTitle>技能(Skill)</CardTitle>
          <CardDescription>Git 源上架 + 授权制:未授权用户不可见不可安装(授权用户或部门组)</CardDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setSkillDialog(true)}>上架技能</Button>
          </div>
        </CardHeader>
        <CardContent>
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
                      <Button size="sm" variant="outline" onClick={() => openGrants({ kind: 'skill', name: s.name, id: 0 })}>授权</Button>
                      {s.enabled && <Button size="sm" variant="destructive" onClick={() => disableSkill(s.name)}>下架</Button>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>MCP 插件</CardTitle>
          <CardDescription>管理员上架/授权,员工按授权使用;凭证加密存储,拉取限流+审计</CardDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setMcpDialog(true)}>上架插件</Button>
          </div>
        </CardHeader>
        <CardContent>
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
                  <TableCell className="max-w-56 truncate font-mono text-xs">{m.transport === 'stdio' ? `${m.command} ${m.args}` : m.url}</TableCell>
                  <TableCell>{m.enabled ? <Badge variant="success">上架</Badge> : <Badge variant="secondary">已下架</Badge>}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => openGrants({ kind: 'mcp', name: m.name, id: m.id })}>授权</Button>
                      {m.enabled && <Button size="sm" variant="destructive" onClick={() => disableMcp(m.id)}>下架</Button>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>凭证下载审计</CardTitle>
          <CardDescription>插件凭证拉取记录(per-user 限流 + 审计,防批量导出)</CardDescription>
        </CardHeader>
        <CardContent>
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
                  <TableCell>{d.created_at}</TableCell>
                </TableRow>
              ))}
              {downloads.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">暂无记录</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={skillDialog} onOpenChange={setSkillDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>上架技能</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>名称</Label>
              <Input value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Git 地址</Label>
              <Input value={skillForm.git_url} onChange={(e) => setSkillForm({ ...skillForm, git_url: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>版本</Label>
                <Input value={skillForm.version} onChange={(e) => setSkillForm({ ...skillForm, version: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>作者</Label>
                <Input value={skillForm.author} onChange={(e) => setSkillForm({ ...skillForm, author: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>描述</Label>
              <Input value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} />
            </div>
            <Button className="w-full" onClick={createSkill}>上架</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={mcpDialog} onOpenChange={setMcpDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>上架 MCP 插件</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>名称</Label>
                <Input value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>传输方式</Label>
                <Select value={mcpForm.transport} onValueChange={(v) => setMcpForm({ ...mcpForm, transport: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">stdio</SelectItem>
                    <SelectItem value="http">http</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>描述</Label>
              <Input value={mcpForm.description} onChange={(e) => setMcpForm({ ...mcpForm, description: e.target.value })} />
            </div>
            {mcpForm.transport === 'stdio' ? (
              <>
                <div className="space-y-1">
                  <Label>命令</Label>
                  <Input placeholder="npx" value={mcpForm.command} onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label>参数(JSON 数组或逗号分隔)</Label>
                  <Input placeholder='["-y","mcp-server-x"]' value={mcpForm.args} onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })} />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <Label>URL</Label>
                <Input placeholder="http://127.0.0.1:3000/mcp" value={mcpForm.url} onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })} />
              </div>
            )}
            <div className="space-y-1">
              <Label>环境变量(JSON,敏感值自动加密)</Label>
              <Input placeholder='{"APP_ID":"x","APP_SECRET":"y"}' value={mcpForm.env} onChange={(e) => setMcpForm({ ...mcpForm, env: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>请求头(JSON)</Label>
              <Input placeholder='{"Authorization":"Bearer x"}' value={mcpForm.headers} onChange={(e) => setMcpForm({ ...mcpForm, headers: e.target.value })} />
            </div>
            <Button className="w-full" onClick={createMcp}>上架</Button>
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
                    <Button size="sm" variant="ghost" onClick={() => revokeGrant(g)}>撤销</Button>
                  </div>
                ))}
              </div>
            )}
            {grants.length === 0 && (
              <div className="text-xs text-muted-foreground">未授权:所有用户均不可见(严格默认),请授权用户或部门组</div>
            )}
            <div className="space-y-1">
              <Label>用户名或部门组(组名以 @ 开头,如 @研发部)</Label>
              <Input value={grantTarget} onChange={(e) => setGrantTarget(e.target.value)} />
            </div>
            <Button className="w-full" disabled={!grantTarget.trim()} onClick={doGrant}>授权</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
