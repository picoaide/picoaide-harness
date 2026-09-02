import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ISpec } from '@visactor/vchart'
import { ChartLazy } from '../../components/chart-lazy'
import { request, ADMIN_API } from '../../api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { Button } from '../../components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { PageHeader } from '../../components/page-header'
import { RangeFilter, defaultRange, fetchUsageList, chatTokens, downloadCsv, fmtY, type UsageRow, type DeptInfo } from './common'
import { fmtTokens, moneyRate, moneyOver } from '../../lib/format'
import { cn } from '../../lib/utils'

// 部门用量:部门树总表(费用/预算/使用率/成员) + 选中部门详情(趋势/成员排行/模型拆分)
export default function UsageDepartments() {
  const init = defaultRange()
  const [from, setFrom] = useState(init.from)
  const [to, setTo] = useState(init.to)
  const [depts, setDepts] = useState<DeptInfo[]>([])
  const [deptRows, setDeptRows] = useState<UsageRow[]>([])
  const [selected, setSelected] = useState<string>('')
  const [detail, setDetail] = useState<{ trend: UsageRow[]; members: UsageRow[]; models: UsageRow[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true)
    setError('')
    try {
      const [d, rows] = await Promise.all([
        request<{ departments: DeptInfo[] }>(`${ADMIN_API}/departments`),
        fetchUsageList({ group: 'dept', from: f, to: t }),
      ])
      setDepts(d.departments ?? [])
      setDeptRows(rows)
      setLoading(false)
    } catch (e: any) {
      setError(e.message || '查询失败')
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(from, to) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 部门树深度(缩进)
  const depth = useMemo(() => {
    const m = new Map<number, number>()
    const byId = new Map(depts.map((d) => [d.id, d]))
    for (const d of depts) {
      let p = d.parent_id
      let n = 0
      while (p !== 0 && byId.has(p)) {
        n += 1
        p = byId.get(p)!.parent_id
      }
      m.set(d.id, n)
    }
    return m
  }, [depts])

  const rowOf = useMemo(() => {
    const m = new Map<string, UsageRow>()
    for (const r of deptRows) m.set(r.label, r)
    return m
  }, [deptRows])

  const openDetail = useCallback(async (name: string) => {
    setSelected(name)
    setDetailLoading(true)
    setDetail(null)
    try {
      const [trend, members, models] = await Promise.all([
        fetchUsageList({ group: 'day', dept: name, from, to }),
        fetchUsageList({ group: 'user', dept: name, from, to }),
        fetchUsageList({ group: 'model', dept: name, from, to }),
      ])
      setDetail({ trend, members: members.slice(0, 10), models })
    } catch {
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }, [from, to])

  const trendSpec: ISpec | null = detail && detail.trend.length > 0 ? {
    type: 'line',
    data: { values: detail.trend.map((r) => ({ label: r.label.slice(5), cost: Number((r.cost ?? 0).toFixed(4)) })) },
    xField: 'label',
    yField: 'cost',
    point: { visible: true },
    axes: [
      { orient: 'left', title: { visible: true, text: '费用(¥)' }, label: { visible: true, style: { fontSize: 11 } } },
      { orient: 'bottom', label: { visible: true, style: { fontSize: 10 } } },
    ],
    tooltip: { visible: true },
  } : null

  const exportDept = () => {
    if (!selected) return
    const rows = detail?.members ?? []
    downloadCsv(`dept_${selected}_${from}_${to}.csv`,
      ['成员', '请求数', '输入tokens', '输出tokens', 'chat合计tokens', '费用(¥)'],
      rows.map((r) => [r.label, r.requests, r.prompt_tokens, r.completion_tokens, chatTokens(r), (r.cost ?? 0).toFixed(4)]))
  }

  return (
    <div className="space-y-6">
      <PageHeader title="部门用量" desc="按部门维度查看消耗：预算使用率、成员排行、模型拆分（与部门预算 enforcement 同口径）" />
      <RangeFilter from={from} to={to} setFrom={setFrom} setTo={setTo} onQuery={() => void load(from, to)} />
      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">部门列表</CardTitle>
            <CardDescription>本月费用为自然月口径 · 区间费用为所选范围</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-80 w-full" /> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>部门</TableHead>
                    <TableHead className="text-right">本月费用</TableHead>
                    <TableHead className="text-right">预算</TableHead>
                    <TableHead className="text-right">使用率</TableHead>
                    <TableHead className="text-right">成员</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {depts.map((d) => {
                    const used = d.monthly_cost
                    const over = moneyOver(used, d.budget_money)
                    const rate = moneyRate(used, d.budget_money)
                    const rangeCost = rowOf.get(d.name)?.cost ?? 0
                    return (
                      <TableRow
                        key={d.id}
                        className={cn('cursor-pointer', selected === d.name && 'bg-accent')}
                        onClick={() => void openDetail(d.name)}
                      >
                        <TableCell>
                          <span style={{ paddingLeft: `${(depth.get(d.id) ?? 0) * 14}px` }} className="font-medium">{d.name}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <div>{fmtY(used)}</div>
                          <div className="text-[10px] text-muted-foreground">{fmtY(rangeCost)}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{d.budget_money ? fmtY(d.budget_money) : '不限'}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {d.budget_money ? (
                            <span className={cn(over && 'text-destructive font-semibold', !over && rate >= 90 && 'text-amber-600')}>{rate}%</span>
                          ) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{d.member_count}</TableCell>
                      </TableRow>
                    )
                  })}
                  {depts.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无部门</TableCell></TableRow>}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">{selected ? `${selected} · 部门详情` : '部门详情'}</CardTitle>
              <CardDescription>{selected ? `${from} ~ ${to}` : '点击左侧部门查看'}</CardDescription>
            </div>
            {selected && <Button size="sm" variant="outline" onClick={exportDept}>导出 CSV</Button>}
          </CardHeader>
          <CardContent>
            {detailLoading ? (
              <Skeleton className="h-72 w-full" />
            ) : !selected ? (
              <div className="flex h-72 items-center justify-center text-muted-foreground">选择部门查看消耗明细</div>
            ) : detail ? (
              <div className="space-y-5">
                <div className="h-56">
                  {trendSpec ? <ChartLazy spec={trendSpec} /> : <div className="flex h-56 items-center justify-center text-muted-foreground">区间内无数据</div>}
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium">成员消费排行</div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>成员</TableHead>
                        <TableHead className="text-right">请求数</TableHead>
                        <TableHead className="text-right">tokens</TableHead>
                        <TableHead className="text-right">费用(¥)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.members.map((r) => (
                        <TableRow key={r.label}>
                          <TableCell>{r.label}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtTokens(chatTokens(r))}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtY(r.cost ?? 0)}</TableCell>
                        </TableRow>
                      ))}
                      {detail.members.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">无数据</TableCell></TableRow>}
                    </TableBody>
                  </Table>
                </div>
                <div>
                  <div className="mb-2 text-sm font-medium">模型花费</div>
                  <div className="flex flex-wrap gap-2">
                    {detail.models.slice(0, 5).map((r) => (
                      <Badge key={r.label} variant="secondary">{r.label} {fmtY(r.cost ?? 0)}</Badge>
                    ))}
                    {detail.models.length === 0 && <span className="text-sm text-muted-foreground">无数据</span>}
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
