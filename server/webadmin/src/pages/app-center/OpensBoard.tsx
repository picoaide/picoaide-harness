import { useCallback, useEffect, useRef, useState } from 'react'
import type { ISpec } from '@visactor/vchart'
import { request } from '../../api'
import { ChartLazy } from '../../components/chart-lazy'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Badge } from '../../components/ui/badge'
import { EmptyState } from '../../components/empty-state'
import { PageHeader } from '../../components/page-header'
import { hasPermission, PERM_CAP_READ } from '../../lib/rbac'
import { BarChart3, Flame, RefreshCw } from 'lucide-react'
import {
  OPENS_COUNT_NOTE,
  OPENS_DETAIL_RETENTION_DAYS,
  OPENS_PRIVACY_NOTE,
  OPENS_RETENTION_NOTE,
  OPENS_SCOPE_NOTE,
  OPENS_SUMMARY_PATH,
  classifyEndpointFailure,
  countText,
  numOrNull,
  rankTopApps,
  requireOpensSummary,
  shapeDrift,
  summarizeWindow,
  trendValues,
  type EndpointFailure,
  type OpensSummary,
  type OpensTrendPoint,
} from './opens-contract'

/**
 * 应用中心 · 运营看板（F16，2026-09-19 契约 §3 F16 / §8.9 / §19 Q13）。
 *
 * 管理员据此做运营（哪些应用真正被用、趋势如何），而不是靠"发布数量"猜。
 * 页面读**一个**跨应用聚合端点（`GET /wasm-apps/opens/summary`，见 opens-contract.ts
 * 的契约说明）：今日/窗口 PV+UV、平台日趋势、热门应用 TOP N（默认 10）。
 * 单应用的日趋势 + 按部门聚合在「应用」页的详情抽屉里（`granularity=dept`）。
 *
 * 三条本页必须守住的语义（都有用例钉住）：
 *   ① **PV 不去重 / UV 去重**：PV 可逐日相加（每次打开 +1）；UV 只能取服务端
 *      按窗口去重的值 —— 逐日 UV 相加会把同一个人重复计数，所以服务端没给就显示 `—`。
 *   ② **缺后端不得显示 0**：端点 404/形状漂移时显示「—」+ 明说"服务端尚未提供该端点"
 *      （`opens-contract.classifyEndpointFailure`）。把"读不到"显示成 0，管理员会
 *      据此认为"这个平台没人用应用"。
 *   ③ **TOP N 的排序与截断在前端兜底**：服务端换了顺序/多返回几行都不能改变页面名次。
 *
 * 权限：只读视图走 `capability:read`（与服务端 AdminRoute 申报一致）；没有该权限时
 * **不发**这个注定 403 的请求，直接给说明（与用量中心、应用列表同口径）。
 */

const WINDOWS: { value: string; label: string; days: number }[] = [
  { value: '7', label: '近 7 天', days: 7 },
  { value: '30', label: '近 30 天', days: 30 },
  { value: '90', label: '近 90 天', days: 90 },
]

const TOP_CHOICES = ['10', '20']

export default function OpensBoard() {
  const [days, setDays] = useState('7')
  const [topN, setTopN] = useState('10')
  const [data, setData] = useState<OpensSummary | null>(null)
  const [failure, setFailure] = useState<EndpointFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const seq = useRef(0)

  const canRead = hasPermission(PERM_CAP_READ)

  const load = useCallback(async () => {
    if (!canRead) {
      setLoading(false)
      return
    }
    const current = ++seq.current
    setLoading(true)
    setFailure(null)
    try {
      const raw = await request(`${OPENS_SUMMARY_PATH}?days=${days}&top=${topN}`)
      if (current !== seq.current) return // 快速切窗口时只认最后一次响应
      const parsed = requireOpensSummary(raw)
      if (!parsed.ok) {
        setData(null)
        setFailure(shapeDrift('打开次数', parsed.detail))
        return
      }
      setData(parsed.value)
      setLoaded(true)
    } catch (err: unknown) {
      if (current !== seq.current) return
      setData(null)
      setFailure(classifyEndpointFailure(err, '打开次数', OPENS_SUMMARY_PATH))
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [canRead, days, topN])

  useEffect(() => { void load() }, [load])

  const trend: OpensTrendPoint[] = data?.trend ?? []
  /**
   * 窗口汇总：**只有拿到数据才算**。
   *
   * 这里刻意不用 `summarizeWindow({ trend: data?.trend ?? [] })`：空数组会被
   * 合法地累加成 `pv = 0`，于是"端点不可用"会被渲染成"窗口内 PV 0"—— 正是
   * "缺后端不得显示 0"要拦的那条。数据缺席一律 `null` ⇒ 页面显示 `—`。
   */
  const win = data === null
    ? { pv: null, uv: null, uvNote: '' }
    : summarizeWindow({ totals: data.totals, trend: data.trend ?? [] })
  const top = rankTopApps(data?.top_apps, Number(topN))
  const todayPv = data?.today?.pv
  const todayUv = data?.today?.uv
  /**
   * 保留期与生效窗口一律**读服务端回显**（§5.1c A/C）：
   * 前端常量只是回落 —— 服务端要说"只保留了 90 天"，管理员看到的就必须是服务端的那个数。
   */
  const retentionDays = data?.detail_retention_days ?? OPENS_DETAIL_RETENTION_DAYS

  // 趋势点：缺 pv/uv 的**不画**（补 0 会画出一条"那天没人用"的假线），
  // 跳过数量在图上显式提示（见下面的 opens-trend-skipped）。
  const trendSeries = trendValues(
    trend.map((p) => ({ label: (p.day ?? '').slice(5), pv: numOrNull(p.pv), uv: numOrNull(p.uv) })),
    'UV（去重人数）',
  )
  const trendSpec: ISpec | null = trendSeries.values.length > 0 ? {
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

  const kpis = [
    { key: 'today-pv', title: '今日 PV', value: countText(todayPv), desc: '每次打开 +1（不去重）' },
    { key: 'today-uv', title: '今日 UV', value: countText(todayUv), desc: '当日按用户去重' },
    { key: 'window-pv', title: '窗口 PV', value: countText(win.pv), desc: `近 ${days} 天累计打开次数` },
    { key: 'window-uv', title: '窗口 UV', value: countText(win.uv), desc: '窗口内按用户去重（服务端口径）' },
  ]

  return (
    <div className="space-y-4" data-testid="opens-board">
      <PageHeader
        title="运营看板"
        desc="应用打开次数（F16）：PV / UV / 趋势 / 热门应用 TOP N —— 判断哪些应用真正被使用"
        actions={
          <Button variant="outline" size="sm" onClick={() => { void load() }} title="刷新" aria-label="刷新" data-testid="opens-refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      />

      {!canRead ? (
        <EmptyState
          icon={<BarChart3 className="h-6 w-6" />}
          title="没有查看运营看板的权限"
          desc="需要 capability:read 权限，请联系平台管理员"
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-32" aria-label="统计窗口" data-testid="opens-days">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={topN} onValueChange={setTopN}>
              <SelectTrigger className="w-32" aria-label="TOP N" data-testid="opens-topn">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOP_CHOICES.map((n) => <SelectItem key={n} value={n}>{`TOP ${n}`}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">{OPENS_COUNT_NOTE}</span>
          </div>

          {/* 生效区间由**服务端**回显（§5.1c A/C）：不渲染它，管理员就无从察觉
              服务端是否把窗口收敛过（capped）。 */}
          {data !== null && (
            <p className="text-xs text-muted-foreground" data-testid="opens-effective-window">
              统计区间：{typeof data.from === 'string' && data.from !== '' ? data.from : '—'}
              {' ~ '}
              {typeof data.to === 'string' && data.to !== '' ? data.to : '—'}
              （窗口 {data.days ?? days} 天 · 明细保留 {retentionDays} 天）
            </p>
          )}
          {data?.capped === true && (
            <p className="text-xs text-destructive" data-testid="opens-capped">
              请求窗口长于明细保留期（{retentionDays} 天）：服务端已收敛到保留期并如实回报
              （capped=true）—— 这里显示的是保留期内可算的窗口，不是全部历史。
            </p>
          )}

          {/* 缺后端 / 形状漂移 / 读失败：明说"不可用"，下面的数字一律显示 —（不是 0）。 */}
          {failure && (
            <div className="space-y-2" data-testid="opens-failure-block">
              <p
                data-testid="opens-failure"
                role="alert"
                aria-live="assertive"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {failure.text}
              </p>
              <Button variant="outline" size="sm" data-testid="opens-retry" onClick={() => { void load() }}>
                <RefreshCw className="mr-1 h-4 w-4" />重试
              </Button>
            </div>
          )}

          {loading && !loaded ? (
            <p className="text-sm text-muted-foreground" data-testid="opens-loading">加载中…</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {kpis.map((k) => (
                  <Card key={k.key}>
                    <CardHeader className="pb-2">
                      <CardDescription>{k.title}</CardDescription>
                      <CardTitle className="text-2xl" data-testid={`opens-${k.key}`}>{k.value}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-xs text-muted-foreground">{k.desc}</CardContent>
                  </Card>
                ))}
              </div>

              {win.uv === null && win.uvNote !== '' && (
                <p className="text-xs text-muted-foreground" data-testid="opens-uv-note">{win.uvNote}</p>
              )}

              <div className="grid gap-3 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">打开趋势（近 {days} 天）</CardTitle>
                    <CardDescription>{OPENS_RETENTION_NOTE}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {/* 缺字段的点**不画**（补 0 = 画一条"那天没人用"的假线），跳过数量显式提示。 */}
                    {trendSeries.skipped > 0 && (
                      <p className="mb-2 text-xs text-destructive" data-testid="opens-trend-skipped">
                        有 {trendSeries.skipped} 个趋势值缺少 pv/uv 字段（响应结构与契约不符）：已跳过这些点，不是按 0 画点。
                      </p>
                    )}
                    {trendSpec ? (
                      <div className="h-72" data-testid="opens-trend"><ChartLazy spec={trendSpec} /></div>
                    ) : (
                      <EmptyState
                        icon={<BarChart3 className="h-6 w-6" />}
                        title="窗口内还没有打开记录"
                        desc="员工在客户端打开应用后，这里会出现按日的 PV / UV 趋势"
                      />
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-1 text-base">
                      <Flame className="h-4 w-4" />热门应用 TOP {topN}
                    </CardTitle>
                    <CardDescription>按窗口内 PV 降序（PV 相同时按 UV 降序）</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {top.length === 0 ? (
                      <EmptyState
                        icon={<Flame className="h-6 w-6" />}
                        title="窗口内还没有应用上榜"
                        desc="TOP 榜来自 wasm_app_opens_daily 日汇总，员工打开后自动出现"
                      />
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">名次</TableHead>
                            <TableHead>应用</TableHead>
                            <TableHead className="text-right">PV</TableHead>
                            <TableHead className="text-right">UV</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody data-testid="opens-top-list">
                          {top.map((r) => (
                            <TableRow key={r.app_id} data-testid={`opens-top-${r.app_id}`}>
                              <TableCell>
                                <Badge variant={r.rank <= 3 ? 'success' : 'secondary'} data-testid={`opens-rank-${r.app_id}`}>
                                  {r.rank}
                                </Badge>
                              </TableCell>
                              <TableCell className="max-w-[14rem]">
                                <div className="truncate font-medium" title={r.title}>{r.title}</div>
                                <div className="truncate font-mono text-xs text-muted-foreground">{r.app_id}</div>
                              </TableCell>
                              <TableCell className="text-right font-mono" data-testid={`opens-pv-${r.app_id}`}>{countText(r.pv)}</TableCell>
                              {/* UV 缺失（形状漂移）⇒ —，不是 0（与 headline 同一套语义）。 */}
                              <TableCell className="text-right font-mono" data-testid={`opens-uv-${r.app_id}`}>{countText(r.uv)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* 口径与合规说明（§8.9 隐私/合规行；§19 Q11 的"计数告知"在员工侧，
                  管理员侧这里说清数据范围与保留期）。 */}
              <Card data-testid="opens-notes">
                <CardHeader>
                  <CardTitle className="text-base">口径与数据边界</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-xs text-muted-foreground">
                  <p>{OPENS_COUNT_NOTE}</p>
                  <p>{OPENS_SCOPE_NOTE}</p>
                  <p>{OPENS_RETENTION_NOTE}</p>
                  <p data-testid="opens-retention-echo">服务端本次回报：明细保留 {retentionDays} 天（`detail_retention_days`）。</p>
                  <p>{OPENS_PRIVACY_NOTE}</p>
                  <p>按部门聚合在「应用」页的详情抽屉里（granularity=dept）；部门取打开时刻的用户主部门，无部门记 NULL。</p>
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  )
}
