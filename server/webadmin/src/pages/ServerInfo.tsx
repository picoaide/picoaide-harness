import { useEffect, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { PageHeader } from '../components/page-header'
import { Server, Cpu, MemoryStick, HardDrive, Database, Activity, RefreshCw, ShieldCheck, Sparkles, ExternalLink, Gauge } from 'lucide-react'

interface SysInfo {
  uptime_sec: number
  uptime_human: string
  go_version: string
  num_cpu: number
  gomaxprocs: number
  goroutines: number
  mem: { allocated_mb: number; total_system_mb: number; system_memory_mb: number }
  load_avg: [number, number, number]
  disk: { data_path: string; total_gb: number; used_gb: number; free_gb: number; used_pct: number }
  db: {
    driver: string
    tables: Record<string, number>
    total_rows: number
    disk_bytes: number
    disk_human: string
    schema_migrations: number
  }
  version: string
  /**
   * F-03（审计 2026-09-26，P2）：**余额准入闸门的拒绝证据**。
   *
   * 服务端把 R16C-02 的准入闸门（余额不足时**不转发上游**）的计数与"最近一条被拒
   * 的形状"挂在这里，注释写明是为了让"谁在被拒、依据是什么、差多少钱"可检索 ——
   * 但修前 webadmin 既不声明也不渲染这两个字段（全仓 TS 侧
   * `admission_rejections` 零命中），于是这条"可视化出口"实际上**零消费方**：
   * 管理员在界面上永远看不到有人被余额闸门挡住，只能去翻日志/直连 API。
   *
   * 字段名与 `internal/serverstore.BalanceAdmissionRejection` 的 json tag 一一对应，
   * 由 `server-info-health-contract.test.ts` 读 Go 源对拍（单边改名即红）。
   */
  balance?: {
    /** 准入处被余额闸门拒绝的累计次数（进程内计数，重启归零；每次都不产生上游调用）。 */
    admission_rejections: number
    /** 最近一条拒绝的形状（用户 / 端点 / 模型 / 依据 / 要求金额 / 当时余额）。 */
    last_rejection?: {
      user_id: number
      username: string
      endpoint: string
      model: string
      reason: string
      required_money: number
      balance_money: number
      at: string
    } | null
  }
  /**
   * F-03：**审计链与审计写入的健康状态**（FIX-12 / R16C-03 / R16C-05 的可视化出口）。
   *
   * `chain_stale` / `chain_source` / `chain_age_seconds` 是"长跑实例把过期的 true
   * 当当前状态对外"这条 P1 的修复产物（R16C-03）：**必须显示出来**，否则一个启停
   * 于三天前的实例与刚刚校验过的实例在界面上完全同形 —— 正是那条 P1 的形态。
   */
  audit?: {
    chain_checked: boolean
    chain_intact: boolean
    chain_broken_id: number
    chain_checked_at?: string
    /** 最近一次校验距今秒数（-1 = 本进程还没校验过）。 */
    chain_age_seconds: number
    /** 结论是否已过期（超过服务端的新鲜度阈值）——过期结论不得看着像实时结论。 */
    chain_stale: boolean
    /** 执行者：startup | periodic。 */
    chain_source?: string
    /** 本进程累计校验次数（周期执行者真的在跑吗）。 */
    chain_checks: number
    chain_rows: number
    chain_duration_ms: number
    chain_error?: string
    write_failures: number
    /** 彻底丢失、从未落库的审计条目数 —— 非零即审计有缺口。 */
    dropped_entries: number
    retries: number
    last_failure?: {
      reason: string
      action: string
      username: string
      cause: string
      cause_class: string
      at: string
    } | null
  }
  // 2026-09-10: 实时版本检查(服务端代理我方更新服务器 release.picoaide.com;
  // 失败为 null 静默降级)。更新源已从 GitHub Releases 迁到 R2 静态 manifest。
  update_check?: {
    current: string
    latest: string
    update_available: boolean
    /** 升级目标镜像 tag(如 v2.7.0);老版本服务端可能缺该字段 */
    image_tag?: string
    /** 应答的更新清单地址(渠道归因/排查用) */
    manifest_url?: string
    checked_at: string
  } | null
}

// 2026-08-31: 按模型并发状态(网关内存快照 + 90 天峰值 DB + 配置目标)
interface ConcurrencyStatus {
  checked_at: string
  models: Array<{
    model: string
    current: number
    peak_90d: number
    target: number
    provider?: string
  }>
}

// 统计卡(与用量页 stat-card 风格一致):图标品牌色渐变方块 + 标题 + 主值
function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="app-card p-4">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-600/10 text-[#1E40AF]">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

export default function ServerInfo() {
  const [info, setInfo] = useState<SysInfo | null>(null)
  const [conc, setConc] = useState<ConcurrencyStatus | null>(null)
  const [error, setError] = useState('')

  const load = async () => {
    setError('')
    try {
      // server-info + concurrency 并行拉取(并发指标独立于系统状态,失败降级)
      const [d, c] = await Promise.all([
        request(`${ADMIN_API}/server-info`),
        request(`${ADMIN_API}/concurrency`).catch(() => null),
      ])
      setInfo(d)
      setConc(c)
    } catch (e: any) {
      setError(e.message || '加载失败')
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-4">
      <PageHeader
        title="服务器信息"
        desc="系统运行状态与数据库统计(独立于业务数据,仅管理员可见)"
        actions={
          <Button size="sm" variant="outline" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </Button>
        }
      />
      {error && <div className="text-sm text-destructive">{error}</div>}

      {/* 版本升级提示(2026-08-31;2026-09-10 改指更新服务器):
          有更新且更新服务器可达时显示;静默降级。
          链接指向更新清单(渠道归因),升级仍由管理员在服务器上手动执行。 */}
      {info?.update_check?.update_available && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-600/10 text-[#1E40AF]">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-blue-900">
              发现新版本 {info.update_check.latest}(当前 v{info.version})
            </div>
            <div className="mt-0.5 text-xs text-blue-700">
              按部署说明执行升级{info.update_check.image_tag
                ? <> 到 <code className="rounded bg-blue-100 px-1 font-mono text-[11px]">{info.update_check.image_tag}</code></>
                : null}(数据不丢;升级前会先做备份)。
            </div>
          </div>
          {info.update_check.manifest_url && (
            <a href={info.update_check.manifest_url} target="_blank" rel="noreferrer">
              <Button size="sm" variant="outline" className="shrink-0 border-blue-300 bg-white text-blue-700 hover:bg-blue-100 hover:text-blue-900">
                <ExternalLink className="h-3.5 w-3.5" /> 查看更新信息
              </Button>
            </a>
          )}
        </div>
      )}

      {info ? (
        <>
          {/* 系统统计卡 */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard icon={<Activity className="h-4 w-4" />} label="运行时长" value={info.uptime_human} sub={`版本 ${info.version}`} />
            <StatCard icon={<Cpu className="h-4 w-4" />} label="CPU / 负载" value={`${info.num_cpu} 核`} sub={`负载 ${info.load_avg[0].toFixed(2)} / ${info.load_avg[1].toFixed(2)} / ${info.load_avg[2].toFixed(2)} · GOMAXPROCS ${info.gomaxprocs}`} />
            <StatCard icon={<MemoryStick className="h-4 w-4" />} label="内存 (Go 堆)" value={`${info.mem.allocated_mb} MB`} sub={`系统 ${info.mem.system_memory_mb} MB · 进程占用 ${info.mem.total_system_mb} MB`} />
            <StatCard icon={<HardDrive className="h-4 w-4" />} label="磁盘占用" value={`${info.disk.used_gb} / ${info.disk.total_gb} GB`} sub={`使用率 ${info.disk.used_pct}% · 剩余 ${info.disk.free_gb} GB`} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 系统详情 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Server className="h-4 w-4 text-muted-foreground" /> 系统详情</CardTitle>
                <CardDescription>运行时与数据库引擎信息</CardDescription>
              </CardHeader>
              <CardContent>
                <InfoRow label="Go 运行时" value={info.go_version} />
                <InfoRow label="Goroutines" value={info.goroutines} />
                <InfoRow label="GOMAXPROCS" value={info.gomaxprocs} />
                {/* P3: SQLite 已下线(2026-08-27 PG-only),原 `driver==='pg'?'PostgreSQL':'SQLite'`
                    分支的 else 永不成立且误导——直接展示 PostgreSQL,驱动字段非 pg 时原样回显。 */}
                <InfoRow label="数据库引擎" value={info.db.driver === 'pg' ? 'PostgreSQL' : info.db.driver} />
                <InfoRow label="数据库大小" value={`${info.db.disk_human} (${info.db.disk_bytes.toLocaleString()} B)`} />
                <InfoRow label="Schema 迁移版本" value={info.db.schema_migrations} />
                <InfoRow label="数据目录" value={<span className="font-mono text-xs">{info.disk.data_path}</span>} />
              </CardContent>
            </Card>

            {/* 数据表统计 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4 text-muted-foreground" /> 数据表统计</CardTitle>
                <CardDescription>各表行数(共 {info.db.total_rows.toLocaleString()} 行)</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>表</TableHead>
                      <TableHead className="text-right">行数</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(info.db.tables).map(([name, rows]) => (
                      <TableRow key={name}>
                        <TableCell className="font-mono text-xs">{name}</TableCell>
                        <TableCell className="text-right tabular-nums">{rows.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          {/* F-03(审计 2026-09-26,P2):余额闸门准入 + 审计健康。
              这两块是服务端 R16C-02/R16C-03/C-05 三条修复**自己声明的可视化出口**
              （sysinfo.go 的注释写着"让谁在被拒、依据是什么、差多少钱可检索"），
              而修前 webadmin 既不声明也不渲染 ⇒ 承诺零消费方。 */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Gauge className="h-4 w-4 text-muted-foreground" /> 余额闸门准入
                </CardTitle>
                <CardDescription>
                  余额不足的请求在**转发上游之前**被拒（不产生上游调用）；此处是本进程的拒绝证据
                </CardDescription>
              </CardHeader>
              <CardContent>
                <InfoRow
                  label="累计拒绝次数"
                  value={info.balance ? info.balance.admission_rejections.toLocaleString() : '—'}
                />
                {info.balance?.last_rejection ? (
                  <>
                    <InfoRow label="最近被拒账号" value={info.balance.last_rejection.username || '—'} />
                    <InfoRow label="端点 / 模型" value={
                      <span className="font-mono text-xs">
                        {info.balance.last_rejection.endpoint || '—'} · {info.balance.last_rejection.model || '—'}
                      </span>
                    } />
                    <InfoRow label="拒绝依据" value={
                      <span className="font-mono text-xs">{info.balance.last_rejection.reason || '—'}</span>
                    } />
                    <InfoRow label="要求金额 / 当时余额" value={
                      <span className="tabular-nums">
                        {info.balance.last_rejection.required_money} / {info.balance.last_rejection.balance_money} 元
                      </span>
                    } />
                    <InfoRow label="发生时刻" value={info.balance.last_rejection.at || '—'} />
                  </>
                ) : (
                  <InfoRow label="最近被拒记录" value="—" />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" /> 审计健康
                </CardTitle>
                <CardDescription>
                  哈希链校验结论的**新鲜度**与审计写入缺口；写入失败以前完全不可见
                </CardDescription>
              </CardHeader>
              <CardContent>
                <InfoRow label="链校验结论" value={
                  !info.audit ? '—' : !info.audit.chain_checked ? '尚未校验' :
                    info.audit.chain_intact ? '完整' :
                      `断链于 id=${info.audit.chain_broken_id}`
                } />
                <InfoRow label="结论新鲜度" value={
                  !info.audit ? '—' : info.audit.chain_stale
                    ? `已过期（${info.audit.chain_age_seconds} 秒前）`
                    : `有效（${info.audit.chain_age_seconds} 秒前）`
                } />
                <InfoRow label="校验执行者 / 次数" value={
                  !info.audit ? '—' :
                    `${info.audit.chain_source || '—'} · ${info.audit.chain_checks} 次 · 扫描 ${info.audit.chain_rows} 行`
                } />
                <InfoRow label="写入失败 / 丢弃条目" value={
                  !info.audit ? '—' : (
                    <span className={info.audit.dropped_entries > 0 || info.audit.write_failures > 0 ? 'font-semibold text-destructive' : ''}>
                      {info.audit.write_failures} / {info.audit.dropped_entries}（重试 {info.audit.retries}）
                    </span>
                  )
                } />
                {info.audit?.last_failure && (
                  <InfoRow label="最近写入失败" value={
                    <span className="font-mono text-xs" title={info.audit.last_failure.cause}>
                      {info.audit.last_failure.action || '—'}
                      {info.audit.last_failure.cause_class ? ` · ${info.audit.last_failure.cause_class}` : ''}
                    </span>
                  } />
                )}
                {info.audit?.chain_error && (
                  <InfoRow label="校验自身错误" value={<span className="text-xs text-destructive">{info.audit.chain_error}</span>} />
                )}
              </CardContent>
            </Card>
          </div>

          {/* 按模型并发(2026-08-31):扩容申请依据。当前=实时 in-flight;
              90 天峰值=采样历史最大;目标=default_params.concurrency_target
              (如 flash 2500 / pro 500);利用率=峰值/目标。 */}
          {conc && conc.models && conc.models.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Gauge className="h-4 w-4 text-muted-foreground" /> 模型并发
                  <span className="ml-1 text-xs font-normal text-muted-foreground">当前 / 90 天峰值 / 目标(扩容申请参考)</span>
                </CardTitle>
                <CardDescription>
                  采样于 {conc.checked_at?.replace('T', ' ').replace(/Z$/, ' UTC') ?? '—'} · 峰值每 15s 采样落库(GREATEST 累计,永不回退)
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>模型</TableHead>
                      <TableHead className="text-right">当前并发</TableHead>
                      <TableHead className="text-right">90 天峰值</TableHead>
                      <TableHead className="text-right">目标</TableHead>
                      <TableHead className="text-right">峰值利用率</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {conc.models.map((m) => {
                      const util = m.target > 0 ? ((m.peak_90d / m.target) * 100).toFixed(0) + '%' : '—'
                      const exceeding = m.target > 0 && m.peak_90d >= m.target
                      return (
                        <TableRow key={m.model}>
                          <TableCell className="font-mono text-xs">{m.model}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.current}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.peak_90d}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.target > 0 ? m.target : '未配置'}</TableCell>
                          <TableCell className={`text-right tabular-nums ${exceeding ? 'font-semibold text-destructive' : ''}`}>
                            {util}
                            {exceeding && ' ⚠'}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3" /> 仅管理员可访问 · 数据实时从服务器获取
          </div>
        </>
      ) : (
        <div className="flex h-64 items-center justify-center text-muted-foreground">加载中…</div>
      )}
    </div>
  )
}
