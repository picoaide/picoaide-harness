import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Switch } from '../components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { PageHeader } from '../components/page-header'
import { useFlash } from '../lib/use-flash'
import { inspectErrorReportingDsn } from '../lib/dsn'

/** 客户端上报状态聚合(P1-3 / 决策 D7,GET /gateway/error-reporting/clients)。 */
interface ErrorReportingClientStatus {
  username: string
  state: string
  reason: string
  dsn_host: string
  level: string
  release: string
  updated_at: string
}

interface ErrorReportingClientsPayload {
  ready?: number
  disabled?: number
  failed?: number
  config_unavailable?: number
  idle?: number
  total?: number
  last_report_at?: string | null
  items?: ErrorReportingClientStatus[]
}

const EMPTY_CLIENTS: ErrorReportingClientsPayload = { total: 0, items: [] }

/** 状态 → 中文标签(未知状态原样展示,便于发现协议漂移)。 */
const STATE_LABELS: Record<string, string> = {
  ready: '已启用',
  disabled: '未启用',
  failed: '初始化失败',
  config_unavailable: '配置不可用',
  idle: '未上报',
}

function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state
}

/** 时间戳本地化;空值显示 "—" 而不是渲染成空白(空白会被误读成"正常")。 */
function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

/**
 * 客户端错误监控配置(决策 2026-08):从「网关」页拆分为独立页面。
 * 仅保存错误监控域字段(开关/DSN/等级/心跳/GlitchTip 预填),其余网关配置不受影响:
 * 服务端 setGatewayConfig 用指针字段,缺省(null)不覆盖。
 *
 * 2026-09-16(GlitchTip 收集为空缺陷):
 *  - 保存前用 `src/lib/dsn.ts`(与 Go 权威实现共享对拍语料)拦截必然不可用的
 *    DSN —— 现场 `http://…@localhost:8000/1` 曾被照收不误并提示"已保存";
 *  - 私网/明文 http 只给黄色告警条,不阻断保存(内网自建 GlitchTip 合法);
 *  - 「发送测试事件」由**服务端**代发(D3:浏览器直发拿不到可读失败原因,
 *    还要为第三方放开窗口 CSP connect-src);
 *  - 展示客户端上报状态:不再把"没有数据"渲染成"一切正常"(这正是本 bug 的教训)。
 */
export default function ErrorMonitoring() {
  const [cfg, setCfg] = useState({
    error_reporting_enabled: false,
    error_reporting_dsn: '',
    error_reporting_level: 'error',
    error_reporting_heartbeat: false,
    glitchtip_base_url: '',
    glitchtip_organization: '',
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // P3: flash 定时器由 useFlash 统一清理。
  const [okMsg, setOkMsg] = useFlash(3000)
  const [busy, setBusy] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [testBusy, setTestBusy] = useState(false)
  const [testOk, setTestOk] = useState('')
  const [testErr, setTestErr] = useState('')
  const [clients, setClients] = useState<ErrorReportingClientsPayload>(EMPTY_CLIENTS)
  const [clientsError, setClientsError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const g = await request(`${ADMIN_API}/gateway`)
      setCfg({
        error_reporting_enabled: g.error_reporting_enabled === true,
        error_reporting_dsn: g.error_reporting_dsn ?? '',
        error_reporting_level: g.error_reporting_level ?? 'error',
        error_reporting_heartbeat: g.error_reporting_heartbeat === true,
        glitchtip_base_url: g.glitchtip_base_url ?? '',
        glitchtip_organization: g.glitchtip_organization ?? '',
      })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 客户端上报状态单独加载:它失败**不能**影响配置表单(否则管理员连配置都改不了)。
  const loadClients = useCallback(async () => {
    setClientsError('')
    try {
      const data = await request(`${ADMIN_API}/gateway/error-reporting/clients`)
      setClients(data ?? EMPTY_CLIENTS)
    } catch (err: any) {
      setClients(EMPTY_CLIENTS)
      setClientsError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadClients() }, [loadClients])

  // DSN 解析结果(实时):只回显主机与项目 ID,**不回显 public key**。
  const inspection = inspectErrorReportingDsn(cfg.error_reporting_dsn)

  async function save() {
    if (busy) return
    setError('')
    setWarnings([])
    // P0-2:坏 DSN 在**发请求之前**就被拒(与 Go 权威规则逐字一致)。
    const verdict = inspectErrorReportingDsn(cfg.error_reporting_dsn)
    if (verdict.verdict === 'reject') {
      setError(verdict.message)
      return
    }
    // F-13(修复轮 1):跨字段 —— 开关打开而 DSN 为空是"必然不工作"的组合
    // (客户端 initSentry('') 直接返回,后台永远收不到,且看不出是配置问题)。
    // 服务端也会拦(权威),这里先给即时反馈。
    if (cfg.error_reporting_enabled && cfg.error_reporting_dsn.trim() === '') {
      setError('启用客户端错误上报时必须填写 DSN:开关打开而 DSN 为空时客户端不会上报任何错误')
      return
    }
    if (cfg.glitchtip_base_url && !/^https?:\/\//i.test(cfg.glitchtip_base_url.trim())) {
      setError('GlitchTip 服务地址必须是 http(s) URL(或留空)')
      return
    }
    setBusy(true)
    try {
      // 仅提交错误监控域字段;其余网关配置(默认模型/思考强度/限流等)不动。
      const res = await request(`${ADMIN_API}/gateway`, {
        method: 'PUT',
        body: JSON.stringify({
          error_reporting_enabled: cfg.error_reporting_enabled,
          error_reporting_dsn: cfg.error_reporting_dsn.trim(),
          error_reporting_level: cfg.error_reporting_level,
          error_reporting_heartbeat: cfg.error_reporting_heartbeat,
          glitchtip_base_url: cfg.glitchtip_base_url.trim(),
          glitchtip_organization: cfg.glitchtip_organization.trim(),
        }),
      })
      setError('')
      // P2-3:服务端对私网/明文 http 返回告警(不阻断),这里显示黄条。
      const returned = Array.isArray(res?.warnings) ? res.warnings.filter((w: unknown) => typeof w === 'string') : []
      setWarnings(returned)
      setOkMsg('已保存')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function sendTestEvent() {
    if (testBusy) return
    setTestOk('')
    setTestErr('')
    // 与保存同一套规则:必然不可用的 DSN 连测试都不发(服务端也会再拦一次)。
    const verdict = inspectErrorReportingDsn(cfg.error_reporting_dsn)
    if (verdict.verdict === 'reject') {
      setTestErr(verdict.message)
      return
    }
    setTestBusy(true)
    try {
      const res = await request(`${ADMIN_API}/gateway/error-reporting/test`, {
        method: 'POST',
        body: JSON.stringify({ dsn: cfg.error_reporting_dsn.trim() }),
      })
      const eventId = String(res?.event_id ?? '')
      setTestOk(
        `测试事件已发送(event_id ${eventId.slice(0, 8)}…,HTTP ${res?.http_status ?? '?'},${res?.elapsed_ms ?? '?'}ms)。` +
        `${res?.note ? ' ' + res.note : ''}`,
      )
    } catch (err: any) {
      // 失败原因由服务端分类(DNS/CONNECT/TLS/TIMEOUT/HTTP_4XX/HTTP_5XX),见 detail.kind。
      setTestErr(err?.detail?.kind ? `${err.message}(${err.detail.kind})` : err.message)
    } finally {
      setTestBusy(false)
    }
  }

  const failedItems = (clients.items ?? []).filter((item) => item.state === 'failed' || item.state === 'config_unavailable')
  const hasClientData = (clients.total ?? 0) > 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="错误监控"
        desc="客户端错误上报与 GlitchTip 连接器预填:登录自动应用,无需用户手动连接"
      />
      {error && <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</div>}
      {okMsg && <div className="rounded-md border border-green-500/40 p-3 text-sm text-green-600">{okMsg}</div>}
      {warnings.map((w) => (
        <div key={w} className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700">
          {w}
        </div>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>客户端错误上报</CardTitle>
          <CardDescription>开关 + DSN + 等级,随客户端配置下发(登录自动启用)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Switch checked={cfg.error_reporting_enabled} onCheckedChange={(v) => setCfg({ ...cfg, error_reporting_enabled: v })} />
                <Label>启用客户端错误上报(未捕获异常/未处理 rejection)</Label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="error-reporting-dsn">错误上报 DSN(客户端 Sentry 上报地址,如 GlitchTip)</Label>
                  <Input id="error-reporting-dsn" type="text" placeholder="https://glitchtip.example.com/...或空=不启用"
                    value={cfg.error_reporting_dsn}
                    onChange={(e) => setCfg({ ...cfg, error_reporting_dsn: e.target.value })} />
                  {/* P2-3:解析结果回显(不含 public key),管理员能一眼看出填错没有。 */}
                  {cfg.error_reporting_dsn.trim() !== '' && inspection.host !== '' && (
                    <p className="text-xs text-muted-foreground">
                      主机: {inspection.host} / 项目 ID: {inspection.projectId}
                    </p>
                  )}
                  {/* P2-3:私网/明文 http 只告警不阻断 —— 告警文案直接内联在字段下方,
                      而不是让用户去别处找(保存前本地算出来,保存后服务端会再返回一次)。 */}
                  {inspection.verdict === 'warn' && (
                    <p className="text-xs text-amber-700">{inspection.message}</p>
                  )}
                  {inspection.verdict === 'reject' && (
                    <p className="text-xs text-destructive">{inspection.message}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="error-reporting-level">上报等级({'>= '}该等级才上报)</Label>
                  <Select value={cfg.error_reporting_level} onValueChange={(v) => setCfg({ ...cfg, error_reporting_level: v })}>
                    <SelectTrigger id="error-reporting-level" aria-label="上报等级"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="debug">debug(全部)</SelectItem>
                      <SelectItem value="info">info(debug+info)</SelectItem>
                      <SelectItem value="warning">warning(含 error)</SelectItem>
                      <SelectItem value="error">error(仅错误)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Switch
                    id="error-reporting-heartbeat"
                    checked={cfg.error_reporting_heartbeat}
                    onCheckedChange={(v) => setCfg({ ...cfg, error_reporting_heartbeat: v })}
                  />
                  <Label htmlFor="error-reporting-heartbeat">启动时发送链路心跳(证明上报链路存活)</Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  开启后,每个客户端每次启动上报一条 info 级「链路心跳」——该条**不受上面的上报等级阈值限制**,
                  仅用于证明链路存活;介意噪音时保持关闭。
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                开关开启 + DSN 非空时,客户端登录后自动启用错误上报(无需用户手动连接);
                等级阈值:如 warning = 上报 warning 与 error。仅支持 Sentry 兼容服务(如自托管 GlitchTip)。
                指向本机/云元数据地址(如 localhost)的 DSN 会被拒绝 —— 客户端会把事件发往它自己的电脑,永远收不到。
              </p>
              <div className="flex items-center gap-3">
                <Button type="button" variant="outline" onClick={sendTestEvent} disabled={testBusy}>
                  {testBusy ? '发送中…' : '发送测试事件'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  由**服务端**代发一条测试事件,证明服务端到上报地址可达;员工客户端的网络环境可能不同。
                </span>
              </div>
              {testOk && <div className="rounded-md border border-green-500/40 p-3 text-sm text-green-600">{testOk}</div>}
              {testErr && <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{testErr}</div>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>客户端上报状态</CardTitle>
          <CardDescription>客户端登录后回报自身的错误上报初始化结果(最近 100 台)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {clientsError && <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{clientsError}</div>}
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <div>已启用上报: <span className="font-medium">{clients.ready ?? 0}</span> 台</div>
            <div>初始化失败: <span className="font-medium text-destructive">{clients.failed ?? 0}</span> 台</div>
            <div>未启用: <span className="font-medium">{clients.disabled ?? 0}</span> 台</div>
            <div>配置不可用: <span className="font-medium">{clients.config_unavailable ?? 0}</span> 台</div>
          </div>
          <p className="text-xs text-muted-foreground">最近一次上报: {formatTime(clients.last_report_at)}</p>
          {/* 本 bug 的教训:绝不要把"没有数据"渲染成"一切正常"。 */}
          {!hasClientData && !clientsError && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700">
              尚无客户端上报状态。这不代表链路正常:客户端只有登录并完成一次错误上报初始化后才会回报;
              请确认上报开关已开启且客户端版本包含状态上报能力。
            </div>
          )}
          {failedItems.length > 0 && (
            <div className="space-y-1">
              <p className="text-sm font-medium">失败明细</p>
              <ul className="space-y-1 text-xs">
                {failedItems.map((item) => (
                  <li key={`${item.username}-${item.updated_at}`} className="text-destructive">
                    {item.username}({stateLabel(item.state)}): {item.reason || '未提供原因'} · {formatTime(item.updated_at)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={loadClients}>刷新状态</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>GlitchTip 连接器预填</CardTitle>
          <CardDescription>客户端连接器自动预填服务地址与组织,用户只需填 API Token</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="glitchtip-base-url">GlitchTip 服务地址(连接器预填)</Label>
              <Input id="glitchtip-base-url" type="text" placeholder="https://glitchtip.example.com 或空=不预填"
                value={cfg.glitchtip_base_url}
                onChange={(e) => setCfg({ ...cfg, glitchtip_base_url: e.target.value })} />
              <p className="text-xs text-muted-foreground">客户端连接器自动预填,用户只需填 API Token</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="glitchtip-organization">GlitchTip 组织 slug(连接器预填)</Label>
              <Input id="glitchtip-organization" type="text" placeholder="如 picoaide 或空=不预填"
                value={cfg.glitchtip_organization}
                onChange={(e) => setCfg({ ...cfg, glitchtip_organization: e.target.value })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</Button>
      </div>
    </div>
  )
}
