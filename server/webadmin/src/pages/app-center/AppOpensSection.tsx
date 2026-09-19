import { useCallback, useEffect, useRef, useState } from 'react'
import type { ISpec } from '@visactor/vchart'
import { request, ADMIN_API } from '../../api'
import { ChartLazy } from '../../components/chart-lazy'
import { Button } from '../../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { rangePreset } from '../../lib/format'
import { hasPermission, PERM_DEPT_READ } from '../../lib/rbac'
import { BarChart3, RefreshCw } from 'lucide-react'
import {
  OPENS_COUNT_NOTE,
  OPENS_DETAIL_RETENTION_DAYS,
  OPENS_DETAIL_UV_SINGLE_NOTE,
  OPENS_DETAIL_UV_SUM_NOTE,
  OPENS_PRIVACY_NOTE,
  OPENS_RETENTION_NOTE,
  classifyEndpointFailure,
  countText,
  daySeries,
  detailTotals,
  effectiveWindowText,
  numOrNull,
  opensDetailPath,
  requireOpensDetail,
  shapeDrift,
  trendValues,
  type EndpointFailure,
  type OpensDetail,
} from './opens-contract'

/**
 * 应用详情抽屉 · 「打开次数」面板（F16 ②，契约 §8.9 / §19 Q11/Q12）。
 *
 * 数据源 = 设计已冻结、且**已落地**的那一条：
 *   `GET /wasm-apps/:app_id/opens?from=&to=&granularity=day|dept`（capability:read）
 * 与打开看板（跨应用聚合）分开取数，理由是两者的失败/口径互不牵连：
 * 看板端点没上线时，单个应用的"打开次数"仍可能可用（反之亦然）。
 *
 * 三块内容：
 *   ① 概览：今日 / 列表窗口（来自跨应用聚合，端点未上线时显示 —）
 *      + 当前查询窗口的区间合计（服务端 `total_pv`/`total_uv`）；
 *   ② 趋势（granularity=day）或按部门聚合（granularity=dept）；
 *   ③ 保留期、UV 口径与隐私说明（明细 90 天、日汇总长期；明细含 user_id/部门/时间）。
 *
 * 语义纪律（与 opens-contract.ts 同一份实现）：
 *   - **PV 不去重**：区间 PV 可以相加；服务端的 `total_pv` 就是它。
 *   - **UV 分两种口径，必须分开说**：
 *       · 服务端 `total_uv` / 按日 UV = **按（日 × 部门）去重后加总**（同一人跨天或
 *         跨部门会重复计数）——不是"区间去重人数"；
 *       · 单部门日（每天只有一行）时，按日 UV 就是当日去重人数。
 *     界面按 `daySeries().multiDeptDays` 自动切换文案，**不假装**它是区间去重人数。
 *   - **缺后端不得显示 0**：端点 404 / 形状漂移 ⇒ 明说"服务端尚未提供"，数字显示 `—`。
 */

export interface OpensOverview {
  /** 列表那份聚合的窗口天数（当前固定 7，随列表请求的 days 参数）。 */
  days: number
  todayPv?: number
  todayUv?: number
  windowPv?: number
  windowUv?: number
}

/** 部门名映射（`dept_id → name`）：服务端 opens 响应**不含部门名**，best-effort 补。 */
type DeptNames = Record<string, string>


/**
 * 查询窗口选项。
 *
 * ⚠️ **「全部（长期日汇总）」必须显式请求 90 天窗口**（§5.1c C，R2-L6-3）：
 * 这一档曾经写成 `days: 0` ⇒ 不传 `from`/`to` ⇒ 服务端按缺省回落"近 7 天"，
 * 而响应里的 `from`/`to` 前端又不渲染 ⇒ 管理员以为看的是全部历史，实际是 7 天
 * （静默少数据，且无从察觉）。现在这一档与「近 90 天」是同一个窗口，
 * 所以合并成一档：标签直说"实取近 90 天"，页面另外**渲染服务端回显的生效窗口**。
 *
 * 明细只保留 90 天（`OPENS_DETAIL_RETENTION_DAYS`），更早的只有日汇总 ——
 * 想要更长区间需要服务端新增"读汇总"的窗口参数，不在本期（如实标注，不假装能看全部）。
 */
const RANGES: { value: string; label: string; days: number }[] = [
  { value: '30', label: '近 30 天', days: 30 },
  {
    value: 'all',
    label: `全部（长期日汇总 · 实取近 ${OPENS_DETAIL_RETENTION_DAYS} 天）`,
    days: OPENS_DETAIL_RETENTION_DAYS,
  },
]

const GRANULARITIES: { value: 'day' | 'dept'; label: string }[] = [
  { value: 'day', label: '按日趋势' },
  { value: 'dept', label: '按部门' },
]

export function AppOpensSection({ appId, canRead, overview }: {
  appId: string
  canRead: boolean
  /** 列表聚合里这一行的概览；聚合端点不可用时为 null（详情面板照常独立取数）。 */
  overview?: OpensOverview | null
}) {
  const [range, setRange] = useState('30')
  const [granularity, setGranularity] = useState<'day' | 'dept'>('day')
  const [data, setData] = useState<OpensDetail | null>(null)
  const [failure, setFailure] = useState<EndpointFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!canRead) {
      setLoading(false)
      return
    }
    const current = ++seq.current
    setLoading(true)
    setFailure(null)
    const qs = new URLSearchParams()
    const r = RANGES.find((x) => x.value === range)
    // **每一档都带显式 from/to**（含「全部」）：把窗口表达成"不传参"会让服务端
    // 按缺省回落（近 7 天）而前端无从察觉（§5.1c C / R2-L6-3）。
    const days = r?.days ?? RANGES[0].days
    const preset = rangePreset(days)
    qs.set('from', preset.from)
    qs.set('to', preset.to)
    qs.set('granularity', granularity)
    const query = qs.toString()
    try {
      const raw = await request(opensDetailPath(appId, query))
      if (current !== seq.current) return
      const parsed = requireOpensDetail(raw)
      if (!parsed.ok) {
        setData(null)
        setFailure(shapeDrift('打开次数', parsed.detail))
        return
      }
      setData(parsed.value)
    } catch (err: unknown) {
      if (current !== seq.current) return
      setData(null)
      setFailure(classifyEndpointFailure(err, '打开次数', opensDetailPath(appId, query)))
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [appId, canRead, granularity, range])

  useEffect(() => { void load() }, [load])

  /**
   * 部门名 best-effort 映射。
   *
   * 服务端 opens 响应只给 `dept_id`（`WasmOpenPoint` 没有部门名），而"按部门"视图
   * 只有 id 是读不懂的。部门列表走既有 `GET /departments`（**`dept:read`**，
   * 与本面板的 `capability:read` 不是同一个权限点）⇒ **只在确实要用、且确实有权限
   * 时**才请求；拿不到就显示 `#<id>`，绝不编一个名字出来。
   */
  const canReadDepts = hasPermission(PERM_DEPT_READ)
  const [deptNames, setDeptNames] = useState<DeptNames | null>(null)
  useEffect(() => {
    if (!canRead || !canReadDepts || granularity !== 'dept' || deptNames !== null) return
    let alive = true
    void (async () => {
      try {
        const out = await request<{ departments?: { id: number; name: string }[] }>(`${ADMIN_API}/departments`)
        if (!alive) return
        const map: DeptNames = {}
        for (const d of out?.departments ?? []) {
          if (typeof d?.id === 'number') map[String(d.id)] = d.name ?? ''
        }
        setDeptNames(map)
      } catch {
        if (alive) setDeptNames({}) // 失败 = 没有名字可用（显示 #id），不是"没有部门"
      }
    })()
    return () => { alive = false }
  }, [canRead, canReadDepts, deptNames, granularity])

  /** 区间合计：只取服务端下发值（`total_pv`/`total_uv`，见 detailTotals 注释）。 */
  const totals = detailTotals(data)
  const deptRows = (data?.points ?? [])
    .filter((p) => data?.granularity === 'dept' || p.day === '' || p.day === undefined)
    .map((p) => {
      const id = p.dept_id === null || p.dept_id === undefined ? null : Number(p.dept_id)
      const named = id === null ? '' : (deptNames?.[String(id)] ?? '')
      return {
        key: id === null || id === 0 ? 'none' : String(id),
        // 部门 id 为 0/NULL = 无部门（服务端记 NULL）；有名字就用名字，否则 `#<id>`。
        name: named !== '' ? named : (id === null || id === 0 ? '（未归属部门）' : `部门 #${id}`),
        // 缺失 ⇒ null ⇒ 单元格显示 `—`（**不是 0**；主控预审计 CTL-11）。
        pv: numOrNull(p.pv),
        uv: numOrNull(p.uv),
      }
    })
    // 缺 PV 的部门行排到最后（不参与"降序"，也不被当成 0 排到队尾之外）。
    .sort((a, b) => {
      if (a.pv === null || b.pv === null) return (a.pv === null ? 1 : 0) - (b.pv === null ? 1 : 0) || a.name.localeCompare(b.name)
      return b.pv !== a.pv ? b.pv - a.pv : a.name.localeCompare(b.name)
    })

  const series = daySeries(data?.points)
  /**
   * 按日 UV 的展示名随口径切换（**不冒充**区间去重人数）：
   * 一天多行（多部门）时它是"加总"，单部门时才是当日去重人数。
   */
  const uvSeriesName = series.multiDeptDays ? 'UV（按日×部门去重后加总）' : 'UV（当日去重人数）'

  // 缺 pv/uv 的天**不画点**（补 0 会画出一条"那天没人用"的假线），跳过数量显式提示。
  const trendSeries = trendValues(
    series.points.map((p) => ({ label: p.day.slice(5), pv: p.pv, uv: p.uv })),
    uvSeriesName,
  )

  const trendSpec: ISpec | null = granularity === 'day' && trendSeries.values.length > 0 ? {
    type: 'line',
    data: { values: trendSeries.values },
    xField: 'label',
    yField: 'value',
    seriesField: 'kind',
    legends: { visible: true, orient: 'top' },
    axes: [
      { orient: 'left', label: { visible: true, style: { fontSize: 11 } } },
      { orient: 'bottom', label: { visible: true, style: { fontSize: 10 } }, title: { visible: true, text: '日期' } },
    ],
    tooltip: { visible: true },
  } : null

  if (!canRead) {
    return (
      <section className="space-y-2 rounded-md border p-3" data-testid="app-opens-block">
        <h3 className="flex items-center gap-1 text-sm font-semibold">
          <BarChart3 className="h-4 w-4" />打开次数
        </h3>
        <p className="text-sm text-muted-foreground" data-testid="app-opens-noperm">
          需要 capability:read 权限才能查看打开次数（服务端同样会拒绝只读以外的账号）。
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-2 rounded-md border p-3" data-testid="app-opens-block">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1 text-sm font-semibold">
          <BarChart3 className="h-4 w-4" />打开次数
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="w-44" aria-label="打开次数窗口" data-testid="app-opens-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={granularity} onValueChange={(v) => setGranularity(v === 'dept' ? 'dept' : 'day')}>
            <SelectTrigger className="w-32" aria-label="打开次数粒度" data-testid="app-opens-granularity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GRANULARITIES.map((g) => <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={() => { void load() }} title="刷新" aria-label="刷新打开次数" data-testid="app-opens-refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 概览：今日 / 列表窗口（来自跨应用聚合；聚合不可用时显示 — 而不是 0）。 */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          今日 PV <span className="font-mono text-foreground" data-testid="app-opens-today-pv">{countText(overview?.todayPv)}</span>
          {' · '}UV <span className="font-mono text-foreground" data-testid="app-opens-today-uv">{countText(overview?.todayUv)}</span>
        </span>
        <span>
          近 {overview?.days ?? 7} 日 PV <span className="font-mono text-foreground" data-testid="app-opens-window-pv">{countText(overview?.windowPv)}</span>
          {' · '}UV <span className="font-mono text-foreground" data-testid="app-opens-window-uv">{countText(overview?.windowUv)}</span>
        </span>
        <span>
          当前窗口 PV <span className="font-mono text-foreground" data-testid="app-opens-range-pv">{countText(totals.pv)}</span>
          {' · '}UV <span className="font-mono text-foreground" data-testid="app-opens-range-uv">{countText(totals.uv)}</span>
        </span>
      </div>

      {/* 生效窗口**必须渲染**（§5.1c C / R2-L6-3）：服务端的 from/to 缺省回落
          （近 7 天）只体现在响应里；不显示它，管理员就无从察觉档位被静默改写。 */}
      {!failure && data !== null && (
        <p className="text-[11px] text-muted-foreground" data-testid="app-opens-effective-window">
          {effectiveWindowText(data)}
          {' · '}
          明细保留 {data.detail_retention_days ?? OPENS_DETAIL_RETENTION_DAYS} 天
        </p>
      )}

      {/* UV 口径（服务端 `total_uv` = 按日×部门去重后加总）：多部门日在图里说清，
          单部门日才敢说"当日去重人数"。**不把加总值写成区间去重人数。** */}
      {!failure && !loading && granularity === 'day' && trendSeries.skipped > 0 && (
        <p className="text-[11px] text-destructive" data-testid="app-opens-trend-skipped">
          有 {trendSeries.skipped} 个趋势值缺少 pv/uv 字段（响应结构与契约不符）：已**跳过这些点**而不是按 0 画点。
        </p>
      )}

      {!failure && !loading && granularity === 'day' && series.points.length > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="app-opens-uv-note">
          {series.multiDeptDays ? OPENS_DETAIL_UV_SUM_NOTE : OPENS_DETAIL_UV_SINGLE_NOTE}
        </p>
      )}

      {failure && (
        <div className="space-y-2" data-testid="app-opens-failure-block">
          <p data-testid="app-opens-failure" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
            {failure.text}
          </p>
          <Button variant="outline" size="sm" data-testid="app-opens-retry" onClick={() => { void load() }}>
            <RefreshCw className="mr-1 h-4 w-4" />重试
          </Button>
        </div>
      )}

      {!failure && loading && (
        <p className="text-sm text-muted-foreground" data-testid="app-opens-loading">读取中…</p>
      )}

      {!failure && !loading && granularity === 'day' && (
        trendSpec ? (
          <div className="h-64" data-testid="app-opens-trend"><ChartLazy spec={trendSpec} /></div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="app-opens-empty">
            该窗口内没有打开记录。
          </p>
        )
      )}

      {!failure && !loading && granularity === 'dept' && (
        deptRows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="app-opens-dept-empty">
            该窗口内没有按部门的打开记录。
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>部门（打开时刻的主部门）</TableHead>
                  <TableHead className="text-right">PV</TableHead>
                  <TableHead className="text-right">UV</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody data-testid="app-opens-dept-list">
                {deptRows.map((d) => (
                  <TableRow key={d.key} data-testid={`app-opens-dept-${d.key}`}>
                    <TableCell>{d.name}</TableCell>
                    <TableCell className="text-right font-mono" data-testid={`app-opens-dept-pv-${d.key}`}>{countText(d.pv)}</TableCell>
                    <TableCell className="text-right font-mono" data-testid={`app-opens-dept-uv-${d.key}`}>{countText(d.uv)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {/* 部门名的来源与 UV 口径都要说清（服务端只给 dept_id）。 */}
            <p className="text-[11px] text-muted-foreground" data-testid="app-opens-dept-note">
              部门名取自「部门」页（需要 dept:read 权限）；取不到时显示「部门 #&lt;id&gt;」。
              每行 UV 是该部门区间内按（日 × 部门）去重后加总。
            </p>
          </>
        )
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {OPENS_COUNT_NOTE}<br />
        {OPENS_RETENTION_NOTE}<br />
        {OPENS_PRIVACY_NOTE}
      </p>
    </section>
  )
}
