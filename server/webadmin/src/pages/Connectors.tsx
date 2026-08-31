import { useCallback, useEffect, useMemo, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Switch } from '../components/ui/switch'
import { Checkbox } from '../components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Plus, RefreshCw, Trash2, Pencil, Plug, Copy, ClipboardPaste, Wand2 } from 'lucide-react'

/**
 * 连接器目录管理页(图形化)。
 *
 * 连接器定义 JSON 不是自由格式,而是与客户端 ConnectorDef 协议严格对齐
 * (packages/host/connectors/src/types.ts):
 *   {
 *     "authMode":  "oauth|device|token|server-side",   // 可选,行字段 auth_mode 优先
 *     "auth":      { ... },                             // oauth/device 的认证配置
 *     "tokenFields":[{key,label,type,required,defaultValue}], // token 模式的表单字段
 *     "examples":  ["...", "..."],                      // 示例提示词(连接成功后展示)
 *     "mcp":       [{serverName,transport,...}]         // 必填:连接的 MCP 服务器
 *   }
 * 服务端只强制 mcp 非空数组且每项含 serverName;其余字段为本页面按模式引导。
 * 定义不含任何密钥(凭证只存客户端本地),stdio 命令在客户端本机执行。
 *
 * 本页以图形化表单为主字段 + 实时 JSON 预览;高级区支持整体导入/示例模板,
 * 兼容「已有一份标准 JSON 直接粘贴」的场景。
 */

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

type AuthMode = ConnectorRow['auth_mode']

const AUTH_META: Record<AuthMode, { label: string; variant: 'secondary' | 'outline' | 'success' | 'destructive' }> = {
  oauth: { label: 'OAuth', variant: 'outline' },
  device: { label: 'Device', variant: 'secondary' },
  token: { label: 'Token', variant: 'success' },
  'server-side': { label: '服务端', variant: 'secondary' },
}

/** 行稳定 id(替换 index key,防删除中间行时 DOM/焦点错位)。 */
function uid(): string {
  return crypto.randomUUID()
}

/** 键值对行(请求头/环境变量)。 */
interface KVRow {
  keyId: string
  key: string
  value: string
}

/** token 模式表单字段行。 */
interface TokenFieldRow {
  keyId: string
  key: string
  label: string
  type: 'text' | 'password'
  required: boolean
  defaultValue: string
}

/** MCP 服务器行(stdio 或 streamable-http)。 */
interface McpRow {
  keyId: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  url: string
  command: string
  args: string
  env: KVRow[]
  headers: KVRow[]
}

interface ConnectorForm {
  id: string
  name: string
  description: string
  authMode: AuthMode
  // oauth
  discoveryUrl: string
  authorizeUrl: string
  tokenUrl: string
  registrationEndpoint: string
  clientId: string
  scopes: string
  redirectUri: string
  pkce: boolean
  publicClient: boolean
  // device
  verificationUrl: string
  pollIntervalMs: string
  pollTimeoutMs: string
  // token
  tokenFields: TokenFieldRow[]
  examples: string
  mcp: McpRow[]
}

function emptyForm(): ConnectorForm {
  return {
    id: '',
    name: '',
    description: '',
    authMode: 'token',
    discoveryUrl: '',
    authorizeUrl: '',
    tokenUrl: '',
    registrationEndpoint: '',
    clientId: '',
    scopes: '',
    redirectUri: '',
    pkce: true,
    publicClient: true,
    verificationUrl: '',
    pollIntervalMs: '5000',
    pollTimeoutMs: '120000',
    tokenFields: [{ keyId: uid(), key: '', label: '', type: 'password', required: true, defaultValue: '' }],
    examples: '',
    mcp: [{ keyId: uid(), serverName: '', transport: 'streamable-http', url: '', command: '', args: '', env: [], headers: [] }],
  }
}

/** 示例模板(与 0042 种子数据对齐,便于「抄一个改一改」)。 */
const TEMPLATES: { label: string; name: string; description: string; authMode: AuthMode; json: string }[] = [
  {
    label: 'Moka(远程 MCP + OAuth 发现)',
    name: 'Moka HR 智能体',
    description: '招聘和人事一体的 AI 同事,把查询与执行收进一个对话。',
    authMode: 'oauth',
    json: '{"auth":{"discoveryUrl":"https://mcp.mokahr.com/mcp","clientId":"","authorizeUrl":"","tokenUrl":"","redirectUri":"http://127.0.0.1/callback","pkce":true,"publicClient":true,"scopes":"offline_access"},"mcp":[{"serverName":"moka","transport":"streamable-http","url":"https://mcp.mokahr.com/mcp"}]}',
  },
  {
    label: 'GlitchTip(本地 stdio + Token 表单)',
    name: 'GlitchTip',
    description: 'GlitchTip(Sentry 兼容错误追踪):查询 issue 与最新事件堆栈。',
    authMode: 'token',
    json: '{"tokenFields":[{"key":"GLITCHTIP_BASE_URL","label":"服务地址(必填,如自部署地址或 app.glitchtip.com)","type":"text","required":true},{"key":"GLITCHTIP_TOKEN","label":"API Token(Auth Tokens 页创建,需 org:read / project:read / event:read)","type":"password","required":true},{"key":"GLITCHTIP_ORGANIZATION","label":"组织 slug(如 picoaide)","type":"text","required":true}],"examples":["查询当前未解决的错误 issue","查看最近一次异常的堆栈详情"],"mcp":[{"serverName":"glitchtip","transport":"stdio","command":"npx","args":["-y","glitchtip-mcp"],"env":{}}]}',
  },
  {
    label: '销售易(远程 MCP + OAuth 注册)',
    name: '销售易',
    description: '销售易 NeoCRM 官方 MCP:查询客户、线索、商机、联系人。',
    authMode: 'oauth',
    json: '{"auth":{"authorizeUrl":"https://mcp.xiaoshouyi.com/oauth/authorize","tokenUrl":"https://mcp.xiaoshouyi.com/oauth/token","registrationEndpoint":"https://mcp.xiaoshouyi.com/oauth/register","clientId":"","redirectUri":"","scopes":"offline_access","pkce":true,"publicClient":true},"examples":["查询最近赢单的 10 个商机","统计各行业客户数量"],"mcp":[{"serverName":"neo-crm","transport":"streamable-http","url":"https://mcp.xiaoshouyi.com/mcp"}]}',
  },
]

/** 表单 → 定义 JSON(过滤空值,保持精简;authMode 一并写入,便于 JSON 独立使用)。 */
function buildDefinition(form: ConnectorForm): string {
  const def: Record<string, unknown> = { authMode: form.authMode }
  if (form.authMode === 'oauth') {
    const a: Record<string, unknown> = { pkce: form.pkce, publicClient: form.publicClient }
    if (form.discoveryUrl.trim()) a.discoveryUrl = form.discoveryUrl.trim()
    if (form.authorizeUrl.trim()) a.authorizeUrl = form.authorizeUrl.trim()
    if (form.tokenUrl.trim()) a.tokenUrl = form.tokenUrl.trim()
    if (form.registrationEndpoint.trim()) a.registrationEndpoint = form.registrationEndpoint.trim()
    if (form.clientId.trim()) a.clientId = form.clientId.trim()
    if (form.scopes.trim()) a.scopes = form.scopes.trim()
    if (form.redirectUri.trim()) a.redirectUri = form.redirectUri.trim()
    def.auth = a
  } else if (form.authMode === 'device') {
    const a: Record<string, unknown> = {}
    if (form.verificationUrl.trim()) a.verificationUrl = form.verificationUrl.trim()
    if (form.pollIntervalMs.trim()) a.pollIntervalMs = Number(form.pollIntervalMs.trim())
    if (form.pollTimeoutMs.trim()) a.pollTimeoutMs = Number(form.pollTimeoutMs.trim())
    def.auth = a
  } else if (form.authMode === 'token') {
    const fields = form.tokenFields
      .filter((f) => f.key.trim() !== '')
      .map((f) => {
        const o: Record<string, unknown> = { key: f.key.trim(), label: f.label.trim(), type: f.type }
        if (f.required) o.required = true
        if (f.defaultValue.trim() !== '') o.defaultValue = f.defaultValue.trim()
        return o
      })
    if (fields.length > 0) def.tokenFields = fields
  }
  const examples = form.examples.split('\n').map((s) => s.trim()).filter(Boolean)
  if (examples.length > 0) def.examples = examples
  def.mcp = form.mcp.map((m) => {
    const o: Record<string, unknown> = { serverName: m.serverName.trim(), transport: m.transport }
    if (m.transport === 'streamable-http') {
      if (m.url.trim()) o.url = m.url.trim()
      const headers = kvToObj(m.headers)
      if (Object.keys(headers).length > 0) o.headers = headers
    } else {
      if (m.command.trim()) o.command = m.command.trim()
      const args = m.args.trim().split(/\s+/).filter(Boolean)
      if (args.length > 0) o.args = args
      const env = kvToObj(m.env)
      if (Object.keys(env).length > 0) o.env = env
    }
    return o
  })
  return JSON.stringify(def, null, 2)
}

function kvToObj(rows: KVRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (r.key.trim() !== '') out[r.key.trim()] = r.value
  }
  return out
}

function kvRows(v: unknown): KVRow[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  return Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ keyId: uid(), key, value: String(value) }))
}

/**
 * 定义 JSON → 表单。authMode 与客户端 parseServerConnectors 同规则:
 * 行字段优先 → definition.authMode → 结构推断(tokenFields→token / auth→oauth)。
 * 解析失败时抛错(调用方兜底,不静默丢数据)。
 */
function parseDefinition(def: string, fallbackMode: AuthMode): ConnectorForm {
  const raw = JSON.parse(def) as Record<string, any>
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('定义必须是 JSON 对象')
  let authMode = (raw.authMode as AuthMode) || fallbackMode || ''
  if (!authMode) {
    if (Array.isArray(raw.tokenFields) && raw.tokenFields.length > 0) authMode = 'token'
    else if (raw.auth) authMode = 'oauth'
    else authMode = 'device'
  }
  const oauth = raw.auth && typeof raw.auth === 'object' ? raw.auth : {}
  const mcp: McpRow[] = Array.isArray(raw.mcp)
    ? raw.mcp.map((m: any) => ({
        keyId: uid(),
        serverName: typeof m?.serverName === 'string' ? m.serverName : '',
        transport: m?.transport === 'stdio' ? 'stdio' : 'streamable-http',
        url: typeof m?.url === 'string' ? m.url : '',
        command: typeof m?.command === 'string' ? m.command : '',
        args: Array.isArray(m?.args) ? m.args.map(String).join(' ') : '',
        env: kvRows(m?.env),
        headers: kvRows(m?.headers),
      }))
    : []
  const tokenFields: TokenFieldRow[] = Array.isArray(raw.tokenFields)
    ? raw.tokenFields.map((f: any) => ({
        keyId: uid(),
        key: typeof f?.key === 'string' ? f.key : '',
        label: typeof f?.label === 'string' ? f.label : '',
        type: f?.type === 'text' ? 'text' : 'password',
        required: f?.required === true,
        defaultValue: typeof f?.defaultValue === 'string' ? f.defaultValue : '',
      }))
    : []
  const form = emptyForm()
  return {
    ...form,
    authMode: authMode as AuthMode,
    discoveryUrl: typeof oauth.discoveryUrl === 'string' ? oauth.discoveryUrl : '',
    authorizeUrl: typeof oauth.authorizeUrl === 'string' ? oauth.authorizeUrl : '',
    tokenUrl: typeof oauth.tokenUrl === 'string' ? oauth.tokenUrl : '',
    registrationEndpoint: typeof oauth.registrationEndpoint === 'string' ? oauth.registrationEndpoint : '',
    clientId: typeof oauth.clientId === 'string' ? oauth.clientId : '',
    scopes: typeof oauth.scopes === 'string' ? oauth.scopes : '',
    redirectUri: typeof oauth.redirectUri === 'string' ? oauth.redirectUri : '',
    pkce: typeof oauth.pkce === 'boolean' ? oauth.pkce : true,
    publicClient: typeof oauth.publicClient === 'boolean' ? oauth.publicClient : true,
    verificationUrl: typeof oauth.verificationUrl === 'string' ? oauth.verificationUrl : '',
    pollIntervalMs: typeof oauth.pollIntervalMs === 'number' ? String(oauth.pollIntervalMs) : '5000',
    pollTimeoutMs: typeof oauth.pollTimeoutMs === 'number' ? String(oauth.pollTimeoutMs) : '120000',
    tokenFields: tokenFields.length > 0 ? tokenFields : form.tokenFields,
    examples: Array.isArray(raw.examples) ? (raw.examples as unknown[]).map(String).join('\n') : '',
    mcp: mcp.length > 0 ? mcp : form.mcp,
  }
}

/** 表单校验:与现有服务端校验对齐(服务端仍兜底),另加模式内必填引导。 */
function validateForm(form: ConnectorForm): string {
  if (form.id.trim() === '' || form.name.trim() === '') return '编号/名称必填'
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(form.id.trim())) return '编号须为小写字母/数字/连字符,且以字母数字开头'
  if (form.mcp.length === 0 || form.mcp.some((m) => m.serverName.trim() === '')) return '至少配置一个 MCP 服务器,且 serverName 必填'
  if (form.mcp.some((m) => m.transport === 'streamable-http' && m.url.trim() === '')) return 'streamable-http 传输的 MCP 必须填写端点 URL'
  if (form.mcp.some((m) => m.transport === 'stdio' && m.command.trim() === '')) return 'stdio 传输的 MCP 必须填写执行命令 command'
  if (form.authMode === 'oauth' && !form.discoveryUrl.trim() && (!form.authorizeUrl.trim() || !form.tokenUrl.trim())) return 'OAuth 未填写 MCP OAuth 发现地址时,授权端点与 Token 端点必填'
  if (form.authMode === 'device' && form.verificationUrl.trim() === '') return 'Device 模式必须填写用户授权页 URL(verificationUrl)'
  if (form.authMode === 'token' && form.tokenFields.filter((f) => f.key.trim() !== '').length === 0) return 'Token 模式至少配置一个表单字段'
  return ''
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
  const [form, setForm] = useState<ConnectorForm>(emptyForm)
  const [formError, setFormError] = useState('')
  const [confirmDel, setConfirmDel] = useState<ConnectorRow | null>(null)
  // 高级区:JSON 预览(只读,实时生成)与 JSON 整体导入
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [copied, setCopied] = useState(false)

  const definition = useMemo(() => buildDefinition(form), [form])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await request<{ connectors: ConnectorRow[] }>(`${ADMIN_API}/connectors`)
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
    setForm(emptyForm())
    setFormError('')
    setShowImport(false)
    setImportText('')
  }

  const openEdit = (row: ConnectorRow) => {
    setEditing(row)
    setShowImport(false)
    setImportText('')
    setFormError('')
    try {
      const parsed = parseDefinition(row.definition, row.auth_mode)
      setForm({ ...parsed, id: row.id, name: row.name, description: row.description })
    } catch {
      // 库里定义 JSON 非法(历史数据):不静默丢数据——放入导入框供修正后导入。
      setForm({ ...emptyForm(), id: row.id, name: row.name, description: row.description })
      setImportText(row.definition)
      setShowImport(true)
      setFormError('原定义 JSON 无法解析,已在下方导入框给出原文,请修正后点击「解析导入」')
    }
  }

  const set = (patch: Partial<ConnectorForm>) => setForm((prev) => ({ ...prev, ...patch }))

  const applyImport = () => {
    try {
      const f = parseDefinition(importText, form.authMode)
      setForm({ ...f, id: form.id, name: form.name, description: form.description })
      setImportText('')
      setShowImport(false)
      setFormError('')
    } catch (err: any) {
      setFormError(`JSON 导入失败:${err.message}`)
    }
  }

  const applyTemplate = (t: (typeof TEMPLATES)[number]) => {
    try {
      const f = parseDefinition(t.json, t.authMode)
      setForm({ ...f, id: form.id, name: t.name, description: t.description, authMode: t.authMode })
      setFormError('')
    } catch {
      setFormError('示例模板加载失败')
    }
  }

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(definition)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setFormError('复制失败,请手动选择复制')
    }
  }

  const toggleEnabled = async (row: ConnectorRow, enabled: boolean) => {
    if (busy !== '') return
    setBusy(row.id + '-enabled')
    setError('')
    try {
      await request(`${ADMIN_API}/connectors/${encodeURIComponent(row.id)}/enabled`, {
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
    const msg = validateForm(form)
    if (msg !== '') {
      setFormError(msg)
      return
    }
    setBusy('save')
    setError('')
    try {
      const isNew = editing === 'new'
      const path = isNew ? `${ADMIN_API}/connectors` : `${ADMIN_API}/connectors/${encodeURIComponent(editing.id)}`
      await request(path, {
        method: isNew ? 'POST' : 'PUT',
        body: JSON.stringify({
          id: form.id.trim(),
          name: form.name.trim(),
          description: form.description.trim(),
          auth_mode: form.authMode,
          definition,
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
      await request(`${ADMIN_API}/connectors/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      setConfirmDel(null)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const updateTokenField = (keyId: string, patch: Partial<TokenFieldRow>) => {
    set({ tokenFields: form.tokenFields.map((f) => (f.keyId === keyId ? { ...f, ...patch } : f)) })
  }

  const updateMcp = (keyId: string, patch: Partial<McpRow>) => {
    set({ mcp: form.mcp.map((m) => (m.keyId === keyId ? { ...m, ...patch } : m)) })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="连接器"
        desc="客户端连接器目录(服务端下发):图形化配置定义 JSON,保存后客户端登录自动同步;凭证仍只存客户端本地"
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
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? '新建连接器' : `编辑连接器: ${editing?.id}`}</DialogTitle>
            <DialogDescription>按表单填写即可,右侧实时生成定义 JSON;凭证仍只存客户端本地,定义不含任何密钥</DialogDescription>
          </DialogHeader>

          {/* 基本信息 */}
          {editing === 'new' && (
            <div className="space-y-1">
              <Label htmlFor="conn-id">编号(不可改,客户端按 id 匹配凭证)</Label>
              <Input id="conn-id" placeholder="如 feishu"
                value={form.id}
                onChange={(e) => set({ id: e.target.value.toLowerCase() })} />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="conn-name">名称</Label>
            <Input id="conn-name" placeholder="如 飞书"
              value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="conn-desc">描述</Label>
            <Input id="conn-desc" placeholder="连接器功能说明(客户端卡片展示)"
              value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="conn-auth">认证方式</Label>
            <Select value={form.authMode} onValueChange={(v) => set({ authMode: v as AuthMode })}>
              <SelectTrigger id="conn-auth"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="oauth">OAuth(授权码+PKCE)</SelectItem>
                <SelectItem value="device">Device(设备码)</SelectItem>
                <SelectItem value="token">Token(表单)</SelectItem>
                <SelectItem value="server-side">服务端</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              服务端模式由企业网关注入 token,无需在表单填写任何认证字段。
            </p>
          </div>

          {/* 认证配置 */}
          {form.authMode === 'oauth' && (
            <div className="space-y-3 rounded-md border p-3">
              <h3 className="text-sm font-semibold">OAuth 认证配置</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="conn-oauth-discovery">MCP OAuth 发现地址(可选,推荐)</Label>
                  <Input id="conn-oauth-discovery" placeholder="如 https://mcp.example.com/mcp"
                    value={form.discoveryUrl} onChange={(e) => set({ discoveryUrl: e.target.value })} />
                  <p className="text-xs text-muted-foreground">
                    填 MCP 端点 URL 即可:连接时自动探测该服务是否公开;需要授权时按 RFC 8414 发现
                    authorize/token/registration 端点,无需手工填写下面两个地址。
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="conn-oauth-authorize">授权端点 authorizeUrl</Label>
                  <Input id="conn-oauth-authorize" placeholder="如 https://auth.example.com/authorize"
                    value={form.authorizeUrl} onChange={(e) => set({ authorizeUrl: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="conn-oauth-token">Token 端点 tokenUrl</Label>
                  <Input id="conn-oauth-token" placeholder="如 https://auth.example.com/token"
                    value={form.tokenUrl} onChange={(e) => set({ tokenUrl: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="conn-oauth-reg">动态客户端注册端点(可选)</Label>
                  <Input id="conn-oauth-reg" placeholder="如 https://auth.example.com/register(RFC 7591)"
                    value={form.registrationEndpoint} onChange={(e) => set({ registrationEndpoint: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="conn-oauth-client">固定 clientId(无注册端点时必填)</Label>
                  <Input id="conn-oauth-client" placeholder="如 mcp-client"
                    value={form.clientId} onChange={(e) => set({ clientId: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="conn-oauth-scopes">授权范围 scopes(空格分隔)</Label>
                  <Input id="conn-oauth-scopes" placeholder="如 offline_access"
                    value={form.scopes} onChange={(e) => set({ scopes: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="conn-oauth-redirect">回调地址 redirectUri(一般留空)</Label>
                  <Input id="conn-oauth-redirect" placeholder="客户端自动起本地回环回调"
                    value={form.redirectUri} onChange={(e) => set({ redirectUri: e.target.value })} />
                </div>
                <label htmlFor="conn-oauth-pkce" className="flex items-center gap-2 text-sm">
                  <Checkbox id="conn-oauth-pkce" checked={form.pkce} onChange={(e) => set({ pkce: e.target.checked })} />
                  使用 PKCE(推荐,授权码+校验码)
                </label>
                <label htmlFor="conn-oauth-public" className="flex items-center gap-2 text-sm">
                  <Checkbox id="conn-oauth-public" checked={form.publicClient} onChange={(e) => set({ publicClient: e.target.checked })} />
                  公网客户端(publicClient,token 端点不带密钥)
                </label>
              </div>
            </div>
          )}

          {form.authMode === 'device' && (
            <div className="space-y-3 rounded-md border p-3">
              <h3 className="text-sm font-semibold">Device 认证配置</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="conn-device-url">用户授权页 URL(verificationUrl)</Label>
                  <Input id="conn-device-url" placeholder="如 https://auth.example.com/device"
                    value={form.verificationUrl} onChange={(e) => set({ verificationUrl: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="conn-device-interval">轮询间隔(ms,可选)</Label>
                  <Input id="conn-device-interval" type="number" min={500}
                    value={form.pollIntervalMs} onChange={(e) => set({ pollIntervalMs: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="conn-device-timeout">轮询超时(ms,可选)</Label>
                  <Input id="conn-device-timeout" type="number" min={1000}
                    value={form.pollTimeoutMs} onChange={(e) => set({ pollTimeoutMs: e.target.value })} />
                </div>
              </div>
            </div>
          )}

          {form.authMode === 'token' && (
            <div className="space-y-3 rounded-md border p-3">
              <h3 className="text-sm font-semibold">Token 表单字段(连接时提示用户填写)</h3>
              <div className="space-y-2">
                <div className="grid grid-cols-12 items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span className="col-span-2">字段 key</span>
                  <span className="col-span-3">显示名</span>
                  <span className="col-span-2">类型</span>
                  <span className="col-span-1">必填</span>
                  <span className="col-span-3">默认值(可选)</span>
                  <span className="col-span-1" />
                </div>
                {form.tokenFields.map((f, i) => (
                  <div key={f.keyId} className="grid grid-cols-12 items-center gap-2">
                    <Input className="col-span-2 font-mono text-xs" aria-label={`字段 key ${i + 1}`} placeholder="如 API_TOKEN"
                      value={f.key} onChange={(e) => updateTokenField(f.keyId, { key: e.target.value })} />
                    <Input className="col-span-3 text-xs" aria-label={`字段显示名 ${i + 1}`} placeholder="如 API Token"
                      value={f.label} onChange={(e) => updateTokenField(f.keyId, { label: e.target.value })} />
                    <Select value={f.type} onValueChange={(v) => updateTokenField(f.keyId, { type: v as 'text' | 'password' })}>
                      <SelectTrigger className="col-span-2 h-9 text-xs" aria-label={`字段类型 ${i + 1}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="text">明文</SelectItem>
                        <SelectItem value="password">密码</SelectItem>
                      </SelectContent>
                    </Select>
                    <label className="col-span-1 flex items-center justify-center">
                      <Checkbox aria-label={`字段必填 ${i + 1}`} checked={f.required}
                        onChange={(e) => updateTokenField(f.keyId, { required: e.target.checked })} />
                    </label>
                    <Input className="col-span-3 text-xs" aria-label={`字段默认值 ${i + 1}`} placeholder="如 https://app.example.com"
                      value={f.defaultValue} onChange={(e) => updateTokenField(f.keyId, { defaultValue: e.target.value })} />
                    <Button className="col-span-1" variant="ghost" size="sm"
                      aria-label={`删除字段 ${i + 1}`}
                      onClick={() => set({ tokenFields: form.tokenFields.filter((x) => x.keyId !== f.keyId) })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => set({ tokenFields: [...form.tokenFields, { keyId: uid(), key: '', label: '', type: 'password', required: false, defaultValue: '' }] })}>
                  <Plus className="h-4 w-4" /> 添加字段
                </Button>
              </div>
            </div>
          )}

          {/* MCP 服务器 */}
          <div className="space-y-3 rounded-md border p-3">
            <h3 className="text-sm font-semibold">MCP 服务器(至少一个,连接后注入的工具 mcp__{'{serverName}'}__* )</h3>
            {form.mcp.map((m, i) => (
              <div key={m.keyId} className="space-y-2 rounded-md border border-dashed p-3">
                <div className="grid grid-cols-12 items-center gap-2">
                  <div className="col-span-4 space-y-1">
                    <Label htmlFor={`conn-mcp-${i}-name`}>服务器名 serverName(名称空间,小写)</Label>
                    <Input id={`conn-mcp-${i}-name`} className="font-mono text-xs" placeholder="如 feishu"
                      value={m.serverName} onChange={(e) => updateMcp(m.keyId, { serverName: e.target.value })} />
                  </div>
                  <div className="col-span-3 space-y-1">
                    <Label htmlFor={`conn-mcp-${i}-transport`}>传输方式</Label>
                    <Select value={m.transport} onValueChange={(v) => updateMcp(m.keyId, { transport: v as 'stdio' | 'streamable-http' })}>
                      <SelectTrigger id={`conn-mcp-${i}-transport`} className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="streamable-http">streamable-http(远程)</SelectItem>
                        <SelectItem value="stdio">stdio(本地进程)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-4 flex justify-end">
                    <Button variant="ghost" size="sm" aria-label={`删除 MCP 服务器 ${i + 1}`}
                      onClick={() => set({ mcp: form.mcp.filter((x) => x.keyId !== m.keyId) })}>
                      <Trash2 className="h-4 w-4" /> 删除
                    </Button>
                  </div>
                </div>

                {m.transport === 'streamable-http' ? (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor={`conn-mcp-${i}-url`}>端点 URL(必填)</Label>
                      <Input id={`conn-mcp-${i}-url`} className="font-mono text-xs" placeholder="如 https://mcp.example.com/mcp"
                        value={m.url} onChange={(e) => updateMcp(m.keyId, { url: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label>静态请求头(可选)</Label>
                        <Button variant="outline" size="sm"
                          onClick={() => updateMcp(m.keyId, { headers: [...m.headers, { keyId: uid(), key: '', value: '' }] })}>
                          <Plus className="h-4 w-4" /> 添加请求头
                        </Button>
                      </div>
                      {m.headers.map((h, j) => (
                        <div key={h.keyId} className="flex items-center gap-2">
                          <Input className="flex-1 font-mono text-xs" aria-label={`请求头 key ${i + 1}-${j + 1}`} placeholder="Authorization"
                            value={h.key} onChange={(e) => updateMcp(m.keyId, { headers: m.headers.map((x) => x.keyId === h.keyId ? { ...x, key: e.target.value } : x) })} />
                          <Input className="flex-1 font-mono text-xs" aria-label={`请求头 value ${i + 1}-${j + 1}`} placeholder='值含 ${FIELD} 时用已存凭证渲染;留空自动填 Bearer <token>'
                            value={h.value} onChange={(e) => updateMcp(m.keyId, { headers: m.headers.map((x) => x.keyId === h.keyId ? { ...x, value: e.target.value } : x) })} />
                          <Button variant="ghost" size="sm" aria-label={`删除请求头 ${i + 1}-${j + 1}`}
                            onClick={() => updateMcp(m.keyId, { headers: m.headers.filter((x) => x.keyId !== h.keyId) })}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`conn-mcp-${i}-cmd`}>执行命令 command(必填)</Label>
                        <Input id={`conn-mcp-${i}-cmd`} className="font-mono text-xs" placeholder="如 npx / node / python"
                          value={m.command} onChange={(e) => updateMcp(m.keyId, { command: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`conn-mcp-${i}-args`}>参数 args(空格分隔)</Label>
                        <Input id={`conn-mcp-${i}-args`} className="font-mono text-xs" placeholder="如 -y glitchtip-mcp"
                          value={m.args} onChange={(e) => updateMcp(m.keyId, { args: e.target.value })} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={`conn-mcp-${i}-env-0-key`}>环境变量(可选)</Label>
                        <Button variant="outline" size="sm"
                          onClick={() => updateMcp(m.keyId, { env: [...m.env, { keyId: uid(), key: '', value: '' }] })}>
                          <Plus className="h-4 w-4" /> 添加环境变量
                        </Button>
                      </div>
                      {m.env.map((e, j) => (
                        <div key={e.keyId} className="flex items-center gap-2">
                          <Input className="flex-1 font-mono text-xs" aria-label={`环境变量 key ${i + 1}-${j + 1}`} placeholder="如 BASE_URL"
                            value={e.key} onChange={(ev) => updateMcp(m.keyId, { env: m.env.map((x) => x.keyId === e.keyId ? { ...x, key: ev.target.value } : x) })} />
                          <Input className="flex-1 font-mono text-xs" aria-label={`环境变量 value ${i + 1}-${j + 1}`} placeholder="值"
                            value={e.value} onChange={(ev) => updateMcp(m.keyId, { env: m.env.map((x) => x.keyId === e.keyId ? { ...x, value: ev.target.value } : x) })} />
                          <Button variant="ghost" size="sm" aria-label={`删除环境变量 ${i + 1}-${j + 1}`}
                            onClick={() => updateMcp(m.keyId, { env: m.env.filter((x) => x.keyId !== e.keyId) })}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">stdio 命令将在每个客户端本机执行,请仅使用可信命令。</p>
                  </>
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => set({ mcp: [...form.mcp, { keyId: uid(), serverName: '', transport: 'streamable-http', url: '', command: '', args: '', env: [], headers: [] }] })}>
              <Plus className="h-4 w-4" /> 添加 MCP 服务器
            </Button>
          </div>

          {/* 示例提示词 */}
          <div className="space-y-1">
            <Label htmlFor="conn-examples">示例提示词(每行一条,连接成功后展示)</Label>
            <Textarea id="conn-examples" rows={3}
              placeholder={'如 查询当前未解决的错误 issue\n查看最近一次异常的堆栈详情'}
              value={form.examples} onChange={(e) => set({ examples: e.target.value })} />
          </div>

          {/* 定义 JSON:实时预览 + 导入/示例 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="conn-def">定义 JSON(实时生成,保存即为下发内容)</Label>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={copyJson}>
                  <Copy className="h-4 w-4" /> {copied ? '已复制' : '复制'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowImport((v) => !v)}>
                  <ClipboardPaste className="h-4 w-4" /> 从 JSON 导入
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowImport((v) => !v)} title="从示例开始">
                  <Wand2 className="h-4 w-4" /> 示例模板
                </Button>
              </div>
            </div>
            <Textarea id="conn-def" rows={10} readOnly spellCheck={false} aria-label="定义 JSON(与客户端 ConnectorDef 对齐,实时生成)"
              className="font-mono text-xs"
              value={definition} />
            {showImport && (
              <div className="space-y-2 rounded-md border border-dashed p-3">
                {editing === 'new' ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">从示例模板开始(可在此基础上修改):</span>
                    {TEMPLATES.map((t) => (
                      <Button key={t.label} variant="outline" size="sm" onClick={() => applyTemplate(t)}>{t.label}</Button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">粘贴已有连接器的标准定义 JSON(与客户端 ConnectorDef 对齐),解析后自动填充表单。</p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="conn-import">JSON</Label>
                  <Textarea id="conn-import" rows={6} spellCheck={false} className="font-mono text-xs"
                    placeholder='{"auth":{...},"tokenFields":[...],"examples":["..."],"mcp":[{"serverName":"x","transport":"streamable-http","url":"https://..."}]}'
                    value={importText} onChange={(e) => setImportText(e.target.value)} />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setImportText(''); setShowImport(false) }}>关闭</Button>
                  <Button size="sm" disabled={importText.trim() === ''} onClick={applyImport}>解析导入</Button>
                </div>
              </div>
            )}
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
