import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Switch } from '../components/ui/switch'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { EmptyState } from '../components/empty-state'
import { PageHeader } from '../components/page-header'
import { hasPermission, PERM_CAP_READ, PERM_CAP_WRITE } from '../lib/rbac'
import { Boxes, Eye, RefreshCw, UserCog } from 'lucide-react'

/**
 * 应用中心(平台管理员视角,2026-09-18):管理员工自建的 WASM 应用。
 *
 * 服务端管理面已就绪(server/internal/wasmapp/api/admin.go),本页只做组合与状态
 * 编排,不复制任何后端语义:
 *   GET  /wasm-apps                     列表 + 组织级「更新审批」开关
 *   POST /wasm-apps/:app_id/publish     上架(幂等:已上架 changed:false)
 *   POST /wasm-apps/:app_id/unpublish   下架(同上,对称)
 *   POST /wasm-apps/:app_id/freeze      body {"frozen":true|false} 冻结/解冻
 *   PUT  /wasm-apps/:app_id/owner       body {"owner":"<用户名>"} 转移归属
 *   PUT  /wasm-apps/review              body {"required":true|false} 更新审批开关
 *
 * 两条边界:
 *   - 读面按 capability:read、写面按 capability:write 判定。前端只是**体验层**
 *     (没有权限就不渲染写控件、不发注定 403 的请求);服务端 RequirePermission
 *     才是护栏。写控件整体缺席而不是"留着让用户点出 403"。
 *   - 状态徽章里**冻结优先于上下架**:冻结会连带把 enabled 置 false,只看 enabled
 *     会把"被平台冻结"误读成"员工自己下架了"。deleted_at 非空显示「已删除」。
 */

interface WasmApp {
  app_id: string
  title: string
  description: string
  owner: string
  enabled: boolean
  /** 访问级别:public 公开 / login 登录后全员 / whitelist 白名单。 */
  access: 'public' | 'login' | 'whitelist' | string
  purpose: string
  data_sensitivity: string
  current_release_id: number
  /** 可能是空串(版本行已被保留策略回收);展示时回落 '—'。 */
  current_version: string
  frozen_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

/**
 * 应用泛域名配置视图（GET/PUT `/wasm-apps/domain` 的同一形状）。
 *
 * `source` 让管理员一眼看出"这个值是控制台配的还是部署时写死的"；
 * `url_pattern` 是服务端拼好的示例（把 `<app_id>` 换成真实应用名就是访问地址）。
 */
interface DomainView {
  base_domain: string
  source: 'setting' | 'env' | 'none'
  enabled: boolean
  url_pattern: string
  setting_key: string
}

interface ListResponse {
  apps: WasmApp[]
  review_required: boolean
  setting_key: string
}

const ACCESS_META: Record<string, { label: string; variant: 'success' | 'secondary' | 'outline' }> = {
  public: { label: '公开', variant: 'success' },
  login: { label: '登录后全员', variant: 'secondary' },
  whitelist: { label: '白名单', variant: 'outline' },
}

/** 未知访问级别不静默吞掉:原样回显(服务端加了新枚举时页面仍可读)。 */
function accessMeta(access: string): { label: string; variant: 'success' | 'secondary' | 'outline' } {
  return ACCESS_META[access] ?? { label: access || '未知', variant: 'outline' }
}

type StatusVariant = 'success' | 'secondary' | 'destructive'

/** 冻结 > 上下架;已删除优先于一切(列表缺省不含已删,防漏判仍保留判定)。 */
function statusMeta(app: WasmApp): { label: string; variant: StatusVariant } {
  if (app.deleted_at) return { label: '已删除', variant: 'destructive' }
  if (app.frozen_at) return { label: '已冻结', variant: 'destructive' }
  if (app.enabled) return { label: '上架', variant: 'success' }
  return { label: '已下架', variant: 'secondary' }
}

function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function AppCenter() {
  const [apps, setApps] = useState<WasmApp[]>([])
  const [reviewRequired, setReviewRequired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 在途操作键(`<app_id>:<动作>` 或 'review');非空时禁用写控件防连点。 */
  const [busy, setBusy] = useState('')
  const [ownerTarget, setOwnerTarget] = useState<WasmApp | null>(null)
  const [ownerInput, setOwnerInput] = useState('')
  const [detail, setDetail] = useState<WasmApp | null>(null)
  // 应用泛域名配置（2026-09-18 用户要求：应用名 + 泛域名 = 应用访问地址）。
  const [domain, setDomain] = useState<DomainView | null>(null)
  const [domainInput, setDomainInput] = useState('')
  const [domainBusy, setDomainBusy] = useState(false)
  const [domainError, setDomainError] = useState('')
  const loadSeq = useRef(0)

  // 体验层能力判定:服务端 RequirePermission 才是护栏(见页面头注释)。
  const canRead = hasPermission(PERM_CAP_READ)
  const canWrite = hasPermission(PERM_CAP_WRITE)

  const load = useCallback(async () => {
    // 没有 capability:read 时不发这个注定 403 的请求(与用量中心同口径)。
    if (!canRead) {
      setLoading(false)
      return
    }
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const data = await request<ListResponse>(`${ADMIN_API}/wasm-apps`)
      if (current !== loadSeq.current) return // 刷新连点时只认最后一次响应
      setApps(data.apps ?? [])
      setReviewRequired(data.review_required === true)
      // 基域配置单独取：它失败不该让整页列表报错（两个面互相独立）。
      try {
        const dv = await request<DomainView>(`${ADMIN_API}/wasm-apps/domain`)
        if (current !== loadSeq.current) return
        setDomain(dv)
        setDomainInput(dv.base_domain ?? '')
      } catch (derr: any) {
        if (current !== loadSeq.current) return
        setDomainError(derr.message || '读取应用域名配置失败')
      }
    } catch (err: any) {
      if (current !== loadSeq.current) return
      setError(err.message || '加载失败')
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [canRead])

  useEffect(() => { void load() }, [load])

  /** 写操作成功后按响应回填单行(服务端返回的就是该字段的新真值)。 */
  const patchRow = (appId: string, patch: Partial<WasmApp>) => {
    setApps((prev) => prev.map((a) => (a.app_id === appId ? { ...a, ...patch } : a)))
  }

  const togglePublished = async (row: WasmApp) => {
    if (busy || !canWrite) return
    const next = !row.enabled
    setBusy(`${row.app_id}:publish`)
    setError('')
    try {
      const out = await request<{ app?: { enabled?: boolean } }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/${next ? 'publish' : 'unpublish'}`,
        { method: 'POST' },
      )
      patchRow(row.app_id, { enabled: typeof out?.app?.enabled === 'boolean' ? out.app.enabled : next })
    } catch (err: any) {
      setError(err.message || (next ? '上架失败' : '下架失败'))
    } finally {
      setBusy('')
    }
  }

  const toggleFrozen = async (row: WasmApp) => {
    if (busy || !canWrite) return
    const frozen = !row.frozen_at
    setBusy(`${row.app_id}:freeze`)
    setError('')
    try {
      const out = await request<{ app?: { enabled?: boolean; frozen_at?: string | null } }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/freeze`,
        { method: 'POST', body: JSON.stringify({ frozen }) },
      )
      patchRow(row.app_id, {
        frozen_at: frozen ? (out?.app?.frozen_at ?? new Date().toISOString()) : null,
        // 冻结会连带下架(服务端行为);解冻不改 enabled。响应缺字段时不臆测。
        ...(typeof out?.app?.enabled === 'boolean' ? { enabled: out.app.enabled } : {}),
      })
    } catch (err: any) {
      setError(err.message || (frozen ? '冻结失败' : '解冻失败'))
    } finally {
      setBusy('')
    }
  }

  const toggleReview = async (next: boolean) => {
    if (busy || !canWrite) return
    const prev = reviewRequired
    setBusy('review')
    setError('')
    setReviewRequired(next) // 乐观切换(开关手感);失败回滚
    try {
      const out = await request<{ review_required?: boolean }>(`${ADMIN_API}/wasm-apps/review`, {
        method: 'PUT',
        body: JSON.stringify({ required: next }),
      })
      if (typeof out?.review_required === 'boolean') setReviewRequired(out.review_required)
    } catch (err: any) {
      setReviewRequired(prev)
      setError(err.message || '更新审批开关保存失败')
    } finally {
      setBusy('')
    }
  }

  const openOwner = (row: WasmApp) => {
    setOwnerInput('')
    setOwnerTarget(row)
  }

  const submitOwner = async () => {
    const row = ownerTarget
    if (!row || busy || !canWrite) return
    const owner = ownerInput.trim()
    if (owner === '') {
      setError('请填写新负责人用户名')
      return
    }
    setBusy(`${row.app_id}:owner`)
    setError('')
    try {
      const out = await request<{ app?: { owner?: string } }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/owner`,
        { method: 'PUT', body: JSON.stringify({ owner }) },
      )
      patchRow(row.app_id, { owner: out?.app?.owner ?? owner })
      setOwnerTarget(null)
      setOwnerInput('')
    } catch (err: any) {
      setError(err.message || '转移归属失败')
    } finally {
      setBusy('')
    }
  }

  /**
   * 保存应用基域（空串 = 关闭应用子域）。
   *
   * 校验/自检全在服务端：启用子域要过"显式可信反代"与"内存四笔账"两条 fail-closed，
   * 不过就是保存失败 —— 因此这里把**服务端的 message + hints 原样显示**，
   * 让管理员知道还差什么条件，而不是给一句"保存失败"。
   */
  const saveDomain = async (next: string) => {
    if (!canWrite || domainBusy) return
    setDomainBusy(true)
    setDomainError('')
    try {
      const dv = await request<DomainView>(`${ADMIN_API}/wasm-apps/domain`, {
        method: 'PUT',
        body: JSON.stringify({ base_domain: next }),
      })
      setDomain(dv)
      setDomainInput(dv.base_domain ?? '')
    } catch (err: any) {
      const hints: string[] = Array.isArray(err?.hints) ? err.hints : []
      setDomainError([err?.message || '保存失败', ...hints].join(' '))
    } finally {
      setDomainBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="应用中心"
        desc="员工自建的 WASM 应用:查看访问级别与运行状态,并做上下架、冻结、归属转移等平台级处置"
        actions={
          <>
            {/* 组织级「更新审批」开关:开启后新版本进待审队列,线上仍旧版本。 */}
            <div className="flex items-center gap-2 rounded-md border px-3 py-1.5">
              <Switch
                id="wasm-review-required"
                aria-label="更新审批"
                checked={reviewRequired}
                disabled={!canWrite || busy === 'review'}
                title={canWrite ? undefined : '没有 capability:write 权限,仅可查看'}
                onCheckedChange={(v) => { void toggleReview(v) }}
              />
              <Label htmlFor="wasm-review-required" className="text-xs">更新审批</Label>
              <span className="text-[11px] text-muted-foreground">
                {reviewRequired ? '开启:新版本需审核' : '关闭:更新即生效'}
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={() => { void load() }} title="刷新" aria-label="刷新">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </>
        }
      />

      {/* 应用泛域名：应用访问地址 = 应用名 + 该域名（2026-09-18 用户要求）。
          启用需要三件外部条件（通配证书 / 通配 DNS / 显式可信反代），平台不做证书自动化，
          因此这里把条件写在卡片上，保存失败时显示服务端原话 + hints。 */}
      <div className="rounded-md border p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="wasm-base-domain" className="text-sm">应用域名（泛域名）</Label>
          {domain && (
            <Badge variant={domain.enabled ? 'success' : 'secondary'}>
              {domain.enabled ? '已启用' : '未启用'}
            </Badge>
          )}
          {domain && (
            <span className="text-[11px] text-muted-foreground">
              来源：
              {domain.source === 'setting' ? '控制台配置' : domain.source === 'env' ? '部署环境变量' : '未配置'}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          填主域名本身（例如 example.com）：应用访问地址 = <span className="font-mono">应用名.该域名</span>。
          不要填 <span className="font-mono">*.example.com</span>。启用前需要：①该域名的
          <span className="font-mono">*.该域名</span> 通配证书 ②通配 DNS 解析到本服务端
          ③在部署 .env 里显式配置可信反向代理（PICOAI_TRUSTED_PROXIES）。留空 = 关闭应用子域。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="wasm-base-domain"
            aria-label="应用域名"
            className="max-w-xs"
            placeholder="example.com"
            value={domainInput}
            disabled={!canWrite || domainBusy}
            onChange={(e) => { setDomainInput(e.target.value) }}
          />
          <Button
            size="sm"
            disabled={!canWrite || domainBusy || domainInput === (domain?.base_domain ?? '')}
            onClick={() => { void saveDomain(domainInput.trim()) }}
          >
            保存
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canWrite || domainBusy || !domain?.enabled}
            onClick={() => { void saveDomain('') }}
          >
            关闭应用子域
          </Button>
          {domain?.url_pattern && (
            <span className="text-[11px] text-muted-foreground">
              当前访问地址格式：<span className="font-mono">{domain.url_pattern}</span>
            </span>
          )}
        </div>
        {domainError && <p className="text-sm text-destructive">{domainError}</p>}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!canWrite && (
        <p className="text-xs text-muted-foreground">
          当前账号没有 capability:write 权限 —— 仅可查看,处置按钮已隐藏(服务端同样会拒绝写请求)。
        </p>
      )}

      {loading ? (
        <EmptyState icon={<Boxes className="h-6 w-6" />} title="加载中…" desc="请稍候" />
      ) : !canRead ? (
        <EmptyState
          icon={<Boxes className="h-6 w-6" />}
          title="没有查看应用中心的权限"
          desc="需要 capability:read 权限,请联系平台管理员"
        />
      ) : apps.length === 0 ? (
        // 加载失败时 apps 必为空 —— 此刻错误已在上方显示,再渲染「暂无应用」等于谎报
        // (写操作失败时 apps 非空,走下面的表格分支,错误与列表可以并存)。
        error === '' ? (
          <EmptyState
            icon={<Boxes className="h-6 w-6" />}
            title="暂无应用"
            desc="员工发布的 WASM 应用将出现在这里"
          />
        ) : null
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>应用</TableHead>
                <TableHead>访问级别</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>负责人</TableHead>
                <TableHead>当前版本</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((row) => {
                const am = accessMeta(row.access)
                const sm = statusMeta(row)
                const isBusy = busy.startsWith(`${row.app_id}:`)
                const frozen = row.frozen_at !== null && row.frozen_at !== ''
                return (
                  <TableRow key={row.app_id}>
                    <TableCell>
                      <div className="whitespace-nowrap font-medium">{row.title || row.app_id}</div>
                      <div className="font-mono text-xs text-muted-foreground">{row.app_id}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={am.variant}>{am.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={sm.variant}>{sm.label}</Badge>
                    </TableCell>
                    <TableCell>{row.owner || '—'}</TableCell>
                    <TableCell className="font-mono text-sm">{row.current_version || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtTime(row.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setDetail(row) }}
                          title="详情"
                          aria-label="详情"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {/* 写操作整体按 capability:write 缺席(只读账号看不到注定 403 的按钮)。 */}
                        {canWrite && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => { openOwner(row) }}
                              title="转移归属(负责人)"
                              aria-label="转移归属"
                            >
                              <UserCog className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isBusy}
                              onClick={() => { void togglePublished(row) }}
                              title={row.enabled ? '下架(员工不可用,数据保留)' : '上架(员工可见可用)'}
                              aria-label={row.enabled ? '下架' : '上架'}
                            >
                              {row.enabled ? '下架' : '上架'}
                            </Button>
                            <Button
                              size="sm"
                              variant={frozen ? 'outline' : 'destructive'}
                              disabled={isBusy}
                              onClick={() => { void toggleFrozen(row) }}
                              title={frozen ? '解冻(恢复服务)' : '冻结(停止服务 + 只读快照保留期)'}
                              aria-label={frozen ? '解冻' : '冻结'}
                            >
                              {frozen ? '解冻' : '冻结'}
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 转移归属:输入用户名 → PUT /wasm-apps/:app_id/owner(服务端校验用户存在)。 */}
      <Dialog
        open={ownerTarget !== null}
        onOpenChange={(open) => { if (!open) { setOwnerTarget(null); setOwnerInput('') } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              转移归属{ownerTarget ? `:${ownerTarget.title || ownerTarget.app_id}` : ''}
            </DialogTitle>
            <DialogDescription>
              转移后新负责人获得该应用的续传发布权,原负责人的发布请求将失效。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="wasm-app-owner" className="text-xs text-muted-foreground">新负责人用户名</Label>
            <Input
              id="wasm-app-owner"
              aria-label="新负责人用户名"
              value={ownerInput}
              placeholder="如 alice"
              disabled={busy !== ''}
              onChange={(e) => { setOwnerInput(e.target.value) }}
            />
            {ownerTarget && (
              <p className="text-xs text-muted-foreground">当前负责人:{ownerTarget.owner || '—'}</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setOwnerTarget(null); setOwnerInput('') }}>取消</Button>
            <Button
              disabled={busy !== '' || ownerInput.trim() === ''}
              onClick={() => { void submitOwner() }}
            >
              确认转移
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 详情:用途/数据敏感度/当前版本 id/创建与更新时间/描述。 */}
      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detail ? `${detail.title || detail.app_id} 详情` : '应用详情'}</DialogTitle>
            <DialogDescription>{detail?.app_id}</DialogDescription>
          </DialogHeader>
          {detail && (
            <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">用途</dt>
              <dd className="break-words">{detail.purpose || '—'}</dd>
              <dt className="text-muted-foreground">数据敏感度</dt>
              <dd>{detail.data_sensitivity || '—'}</dd>
              <dt className="text-muted-foreground">当前版本 ID</dt>
              <dd className="font-mono">{detail.current_release_id > 0 ? detail.current_release_id : '—'}</dd>
              <dt className="text-muted-foreground">创建时间</dt>
              <dd>{fmtTime(detail.created_at)}</dd>
              <dt className="text-muted-foreground">更新时间</dt>
              <dd>{fmtTime(detail.updated_at)}</dd>
              <dt className="text-muted-foreground">描述</dt>
              <dd className="whitespace-pre-wrap break-words">{detail.description || '—'}</dd>
            </dl>
          )}
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => { setDetail(null) }}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
