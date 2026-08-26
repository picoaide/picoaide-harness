import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ISpec } from '@visactor/vchart'
import { ChartLazy } from '../components/chart-lazy'
import {
  Activity, Coins, ArrowDownToLine, ArrowUpFromLine, WalletCards, Download, CircleDollarSign, TriangleAlert,
} from 'lucide-react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog'
import { PageHeader } from '../components/page-header'
import {
  fmtTokens, fmtFull, fmtMoney, fmtMoneyFull, usageRate, quotaPercent, quotaOver,
  moneyRate, moneyPercent, moneyOver, rangePreset, monthRange, ymd, isModelPriced,
} from '../lib/format'

interface UsageRow {
  label: string
  prompt_tokens: number
  completion_tokens: number
  requests: number
  embed_requests?: number
  embed_tokens?: number
  cache_tokens?: number // 0030:缓存命中的输入 token
  cost?: number // 0022:该桶费用合计(元),未定价模型贡献 0
}

// chatTokens 返回行的 chat tokens(不含 embedding):embedding 行 tokens 落在
// prompt_tokens 列(0020),聚合口径分离见审计高2。
function chatTokens(r: UsageRow): number {
  return r.prompt_tokens + r.completion_tokens - (r.embed_tokens ?? 0)
}

interface QuotaUser {
  id: number
  username: string
  is_admin: boolean
  quota_tokens: number | null
  monthly_usage: number
  quota_money: number | null // 0022
  monthly_cost: number // 0022
}

type Group = 'day' | 'week' | 'month' | 'model' | 'user'
type ChartTab = 'trend' | 'proportion' | 'rank'
// 统计口径:tokens(原指标)或 money(金额,0022 企业费用维度)
type Metric = 'tokens' | 'money'

const RANK_TOP = 10

const GROUP_LABEL: Record<Group, string> = {
  day: '日期', week: '周', month: '月', model: '模型', user: '用户',
}

export default function Usage() {
  const [group, setGroup] = useState<Group>('day')
  const [metric, setMetric] = useState<Metric>('money') // 企业端第一指标 = 金额
  // 默认近 30 天:避免无界全表聚合(修复 F5)
  const [from, setFrom] = useState(() => rangePreset(30).from)
  const [to, setTo] = useState(() => rangePreset(30).to)
  const [rows, setRows] = useState<UsageRow[]>([])
  const [quotaUsers, setQuotaUsers] = useState<QuotaUser[]>([])
  const [defaultQuota, setDefaultQuota] = useState<number | null>(null)
  const [defaultMoneyQuota, setDefaultMoneyQuota] = useState<number | null>(null)
  const [hasUnpricedModels, setHasUnpricedModels] = useState(false) // 存在未定价模型(金额口径提示)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [chartTab, setChartTab] = useState<ChartTab>('trend')
  const [filterName, setFilterName] = useState('') // 饼图/排行点击过滤明细
  const [compareTokens, setCompareTokens] = useState<number | null>(null) // 上一等长区间 tokens(chat 口径)
  const [compareCost, setCompareCost] = useState<number | null>(null) // 上一等长区间费用(元)
  const [drillUser, setDrillUser] = useState('') // 用户钻取:当前用户名
  const [drillRows, setDrillRows] = useState<UsageRow[]>([])
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError] = useState('') // 钻取弹窗独立错误态(审计低5)
  const [userTotal, setUserTotal] = useState(0) // 非管理员员工总数(配额面板"仅展示前 200"提示,审计中3)
  const [quotaSearch, setQuotaSearch] = useState('') // 配额面板用户搜索(审计低6)
  const [deptBudgets, setDeptBudgets] = useState<{ name: string; budget: number; cost: number }[]>([]) // 部门预算(审计低7)

  // 日期经 ref 读取:load 不被 from/to 变化重创(保持"点击查询才发请求"),
  // 同时点击时读到的永远是最新输入(审计2026-W1 旧闭包修复)
  const fromRef = useRef(from)
  const toRef = useRef(to)
  useEffect(() => {
    fromRef.current = from
    toRef.current = to
  }, [from, to])

  // 图表 Tab ↔ 分组双向联动:
  //   group 下拉变化 → chartTab 同步;chartTab 手动切换 → 重新发起对应 group 查询
  useEffect(() => {
    if (group === 'model') setChartTab('proportion')
    else if (group === 'user') setChartTab('rank')
    else setChartTab('trend') // day/week/month → 趋势
  }, [group])

  function onChartTabChange(v: string) {
    setChartTab(v as ChartTab)
    const g: Group = v === 'trend' ? 'day' : v === 'proportion' ? 'model' : 'user'
    if (g !== group) setGroup(g)
  }

  // 用户列表 + 全局默认配额(含金额) + 模型定价状态 + 部门预算只拉一次;
  // 配额面板提供手动刷新按钮(审计低6),不随 60s 轮询自动打接口。
  const loadQuota = useCallback(async () => {
    try {
      const [users, gw, models, depts] = await Promise.all([
        request('/api/admin/users?size=200'),
        request('/api/admin/gateway').catch(() => null),
        request('/api/admin/models').catch(() => null),
        request('/api/admin/departments').catch(() => null),
      ])
      const all: QuotaUser[] = (users.users ?? []).filter((u: QuotaUser) => !u.is_admin)
      setQuotaUsers(all)
      setUserTotal(users.total ?? 0)
      const q = gw?.monthly_quota
      setDefaultQuota(q === undefined || q === null || q === '' ? null : Number(q))
      const mq = gw?.monthly_quota_money
      setDefaultMoneyQuota(mq === undefined || mq === null || mq === '' ? null : Number(mq))
      // 未定价模型 = 输入价与输出价均未配置(审计修复 M6:口径与网关页统一,
      // 纯 embedding 模型只配输入价不算未定价)→ 金额配额可能被低估,显式提示
      const unpriced = (models?.models ?? []).some((m: any) => !isModelPriced(m))
      setHasUnpricedModels(unpriced)
      // 部门预算:只展示配置了预算(budget_money > 0)的部门(审计低7)
      const budgets = (depts?.departments ?? [])
        .filter((d: any) => d?.budget_money !== null && d?.budget_money !== undefined && Number(d.budget_money) > 0)
        .map((d: any) => ({ name: d.name, budget: Number(d.budget_money), cost: Number(d.monthly_cost ?? 0) }))
      setDeptBudgets(budgets)
    } catch { /* 配额面板失败不阻塞主查询 */ }
  }, [])
  useEffect(() => { loadQuota() }, [loadQuota])

  // 环比:与上一等长区间对比——tokens(chat 口径)与费用(cost)各自独立,
  // 分别展示在「总 tokens」卡与「总费用」卡(审计高1)
  const refreshCompare = useCallback(async () => {
    if (!fromRef.current || !toRef.current) { setCompareTokens(null); setCompareCost(null); return }
    const from = new Date(`${fromRef.current}T00:00:00`)
    const to = new Date(`${toRef.current}T00:00:00`)
    const span = Math.round((to.getTime() - from.getTime()) / 86400000) + 1
    const prevTo = new Date(from.getTime() - 86400000)
    const prevFrom = new Date(from.getTime() - span * 86400000)
    const pv = new URLSearchParams({ group })
    pv.set('from', ymd(prevFrom))
    pv.set('to', ymd(prevTo))
    try {
      const prev = await request(`/api/admin/usage?${pv}`)
      const prevRows: UsageRow[] = prev.rows ?? []
      setCompareTokens(prevRows.reduce((s, r) => s + chatTokens(r), 0))
      setCompareCost(prevRows.reduce((s, r) => s + (r.cost ?? 0), 0))
    } catch { setCompareTokens(null); setCompareCost(null) }
  }, [group])

  // 审计修复 2026-P: 请求序号防乱序——快速切换分组/查询时,
  // 旧分组的迟到响应不得覆盖新分组数据(参照 Users/Audit 的 P1-8 模式);
  // 60s 轮询 silent 与手动查询共用同一守卫。
  const loadSeq = useRef(0)

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const current = ++loadSeq.current
    if (!opts?.silent) setLoading(true)
    try {
      const params = new URLSearchParams({ group })
      if (fromRef.current) params.set('from', fromRef.current)
      if (toRef.current) params.set('to', toRef.current)
      const data = await request(`/api/admin/usage?${params}`)
      if (current !== loadSeq.current) return // 过期响应丢弃
      setRows(data.rows ?? [])
      setError('')
      // 环比查询只在手动/首次加载时执行;60s 轮询(silent)跳过,避免
      // 每轮多打一个上一区间请求(审计2026-E3 P2-2)
      if (!opts?.silent) await refreshCompare()
    } catch (err: any) {
      if (current !== loadSeq.current) return // 过期响应不写错误
      setError(err.message)
    } finally {
      if (!opts?.silent && current === loadSeq.current) setLoading(false)
    }
  }, [group, refreshCompare])

  // 只在分组变化或点击"查询"时加载,避免每次击键/改日期都发请求
  useEffect(() => { load() }, [load])

  // 实时轮询:仅短区间(≤7 天)且按日分组时每 60s 静默刷新,
  // 不闪加载态(审计2026-E2);长区间/其他分组手动查询即可。
  // 区间跨度在回调内用 ref 判断,避免 from/to 每次击键重建 timer(P2-1)。
  useEffect(() => {
    if (group !== 'day') return
    const isShort = () => {
      if (!fromRef.current || !toRef.current) return false
      return (new Date(`${toRef.current}T00:00:00`).getTime() - new Date(`${fromRef.current}T00:00:00`).getTime()) / 86400000 + 1 <= 7
    }
    const timer = setInterval(() => { if (isShort()) load({ silent: true }) }, 60000)
    const onVis = () => { if (!document.hidden && isShort()) load({ silent: true }) }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [group, load])

  function applyRange(r: { from: string; to: string }) {
    setFrom(r.from)
    setTo(r.to)
    fromRef.current = r.from
    toRef.current = r.to
    load()
  }

  // from > to 校验
  function doQuery() {
    if (from && to && from > to) {
      setError('起始日期不能晚于结束日期')
      return
    }
    setError('')
    load()
  }

  // ---- 汇总统计 ----
  const totals = useMemo(() => {
    let requests = 0, prompt = 0, completion = 0, embed = 0, embedReq = 0, cost = 0
    for (const r of rows) {
      requests += r.requests
      prompt += r.prompt_tokens
      completion += r.completion_tokens
      embed += r.embed_tokens ?? 0
      embedReq += r.embed_requests ?? 0
      cost += r.cost ?? 0
    }
    // chatTotal = 总 tokens 卡口径(不含 embedding);prompt 仍含 embedding(输入卡标注)
    return { requests, prompt, completion, total: prompt + completion, chatTotal: prompt + completion - embed, embed, embedReq, chatReq: requests - embedReq, cost }
  }, [rows])

  // ---- 配额统计(含"跟随全局默认"的员工,修复 F4;支持搜索,审计低6)----
  const quotaStats = useMemo(() => {
    const eff = (u: QuotaUser): number | null => u.quota_tokens ?? defaultQuota
    const effMoney = (u: QuotaUser): number | null => u.quota_money ?? defaultMoneyQuota
    const qs = quotaSearch.trim().toLowerCase()
    const tracked = quotaUsers.filter((u) => {
      const q = eff(u)
      const mq = effMoney(u)
      return ((q !== null && q > 0) || (mq !== null && mq > 0)) && (!qs || u.username.toLowerCase().includes(qs))
    })
    const over = tracked.filter((u) => quotaOver(u.monthly_usage, eff(u)) || moneyOver(u.monthly_cost, effMoney(u)))
    const near = tracked.filter((u) => !over.includes(u) &&
      ((!quotaOver(u.monthly_usage, eff(u)) && usageRate(u.monthly_usage, eff(u)) >= 90) ||
        (!moneyOver(u.monthly_cost, effMoney(u)) && moneyRate(u.monthly_cost, effMoney(u)) >= 90)))
    const sorted = [...tracked].sort((a, b) => {
      const ra = Math.max(usageRate(a.monthly_usage, eff(a)), moneyRate(a.monthly_cost, effMoney(a)))
      const rb = Math.max(usageRate(b.monthly_usage, eff(b)), moneyRate(b.monthly_cost, effMoney(b)))
      return rb - ra
    })
    return { over, near, sorted, eff, effMoney }
  }, [quotaUsers, defaultQuota, defaultMoneyQuota, quotaSearch])

  // ---- 图表数据 ----
  // 趋势图:服务端已按日/周/月补零(缺桶填 0),前端直接渲染
  // 口径切换:tokens(chat 口径,不含 embedding,审计高2)或 money(费用,¥)
  const trendData = useMemo(
    () => rows.map((r) => ({ label: r.label, value: metric === 'money' ? (r.cost ?? 0) : chatTokens(r) })),
    [rows, metric]
  )

  const pieData = useMemo(
    () => rows.map((r) => ({ name: r.label, value: metric === 'money' ? (r.cost ?? 0) : chatTokens(r) })),
    [rows, metric]
  )

  // 排行:Top N + "其他"桶(修复 F3,避免 group=user 时 200+ 柱)
  const rankData = useMemo(() => {
    const sorted = [...rows]
      .map((r) => ({ label: r.label, value: metric === 'money' ? (r.cost ?? 0) : chatTokens(r) }))
      .sort((a, b) => b.value - a.value)
    if (sorted.length <= RANK_TOP) return sorted
    const top = sorted.slice(0, RANK_TOP)
    const rest = sorted.slice(RANK_TOP).reduce((s, r) => s + r.value, 0)
    return [...top, { label: '其他', value: rest }]
  }, [rows, metric])

  // 明细过滤:饼图/排行点击联动
  const filteredRows = useMemo(
    () => (filterName ? rows.filter((r) => r.label === filterName) : rows),
    [rows, filterName]
  )

  const yLabel = metric === 'money' ? '费用(元)' : 'tokens(不含 embedding)'
  const axisFmt = (v: any) => (metric === 'money' ? fmtMoney(Number(v)) : fmtTokens(Number(v)))

  // tooltip 格式化:维度名 + 按口径格式化数值(审计低2)。VChart tooltip 的
  // content 回调挂在 mark(饼图)/dimension(折线/柱)活跃类型下。
  const tooltipPattern = {
    content: [
      {
        key: (datum: any) => datum?.label ?? datum?.name ?? '',
        value: (datum: any) => (metric === 'money' ? fmtMoney(Number(datum?.value)) : fmtTokens(Number(datum?.value))),
      },
    ],
  }
  const tooltip = { visible: true, mark: tooltipPattern, dimension: tooltipPattern } as const

  const trendSpec: ISpec = {
    type: 'line',
    data: { values: trendData },
    xField: 'label',
    yField: 'value',
    point: { visible: true },
    axes: [
      { orient: 'left', title: { visible: true, text: yLabel }, label: { formatMethod: axisFmt } },
      { orient: 'bottom', label: { visible: true, style: { fontSize: 11 } } },
    ],
    tooltip,
  }

  const pieSpec: ISpec = {
    type: 'pie',
    data: { values: pieData },
    categoryField: 'name',
    valueField: 'value',
    outerRadius: 0.8,
    // 修复 F1:饼图 label 是维度文本(模型名/用户名),不是数值;数值交给 tooltip
    label: { visible: true },
    tooltip,
  }

  const rankSpec: ISpec = {
    type: 'bar',
    data: { values: rankData },
    xField: 'label',
    yField: 'value',
    axes: [
      { orient: 'left', label: { visible: true, style: { fontSize: 11 }, formatMethod: axisFmt } },
      { orient: 'bottom', title: { visible: true, text: yLabel }, label: { formatMethod: axisFmt } },
    ],
    tooltip,
  }

  // 用户钻取:按用户查其日趋势(open-webui 式详情弹窗)
  async function openDrill(username: string) {
    setDrillUser(username)
    setDrillLoading(true)
    setDrillRows([])
    setDrillError('')
    try {
      const params = new URLSearchParams({ group: 'day' })
      if (fromRef.current) params.set('from', fromRef.current)
      if (toRef.current) params.set('to', toRef.current)
      params.set('username', username)
      const data = await request(`/api/admin/usage?${params}`)
      setDrillRows(data.rows ?? [])
    } catch (err: any) {
      // 弹窗内独立错误态,不污染页面级 error(审计低5)
      setDrillError(err.message || '查询失败')
    } finally {
      setDrillLoading(false)
    }
  }

  const drillSpec: ISpec = {
    type: 'line',
    data: { values: drillRows.map((r) => ({ label: r.label, value: metric === 'money' ? (r.cost ?? 0) : chatTokens(r) })) },
    xField: 'label',
    yField: 'value',
    point: { visible: true },
    axes: [
      { orient: 'left', title: { visible: true, text: yLabel }, label: { formatMethod: axisFmt } },
      { orient: 'bottom', label: { visible: true, style: { fontSize: 11 } } },
    ],
    tooltip,
  }

  // 环比 delta:金额(cost)与 tokens(chat 口径)各自独立(审计高1),0 基期显示 —
  const compareCostDelta = useMemo(() => {
    if (compareCost === null || compareCost === 0) return null
    return Math.round(((totals.cost - compareCost) / compareCost) * 100)
  }, [compareCost, totals.cost])
  const compareTokensDelta = useMemo(() => {
    if (compareTokens === null || compareTokens === 0) return null
    return Math.round(((totals.chatTotal - compareTokens) / compareTokens) * 100)
  }, [compareTokens, totals.chatTotal])

  const statCards = [
    {
      title: '总费用', value: totals.cost, icon: CircleDollarSign,
      desc: compareCostDelta === null ? '按模型定价折算(未定价模型计 0)'
        : `按模型定价折算 · 环比 ${compareCostDelta >= 0 ? '+' : ''}${compareCostDelta}%`,
      money: true,
    },
    { title: '请求数', value: totals.requests, icon: Activity, desc: `chat ${totals.chatReq.toLocaleString()} · embedding ${totals.embedReq.toLocaleString()}`, int: true },
    { title: '总 tokens', value: totals.chatTotal, icon: Coins, desc: (compareTokensDelta === null
      ? 'chat 输入+输出(不含 embedding)'
      : `chat 输入+输出(不含 embedding) · 环比 ${compareTokensDelta >= 0 ? '+' : ''}${compareTokensDelta}%`) },
    { title: '输入 tokens', value: totals.prompt, icon: ArrowDownToLine, desc: '含 embedding ' + fmtTokens(totals.embed) },
    { title: '输出 tokens', value: totals.completion, icon: ArrowUpFromLine, desc: 'completion 部分' },
  ]

  // CSV 单元格转义:逗号/引号/换行包双引号;以 = + - @ 开头的单元格加单引号
  // 前缀防公式注入(审计中1)
  function csvCell(v: string | number): string {
    let s = String(v)
    if (/^[=+\-@]/.test(s)) s = "'" + s
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
    return s
  }

  // 导出 CSV(带 BOM 保证 Excel 中文不乱码;0022 增 cost 列;total_tokens 为 chat
  // 口径不含 embedding,审计高2;导出当前过滤后的明细,审计中1)
  function exportCsv() {
    const source = filteredRows
    if (source.length === 0) return
    const head = ['label', 'requests', 'prompt_tokens', 'completion_tokens', 'cache_tokens', 'embed_tokens', 'total_tokens', 'cost']
    const lines = source.map((r) => [
      csvCell(r.label), r.requests, r.prompt_tokens, r.completion_tokens, r.cache_tokens ?? 0, r.embed_tokens ?? 0,
      chatTokens(r), (r.cost ?? 0).toFixed(4),
    ].join(','))
    const csv = '\uFEFF' + [head.join(','), ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `usage_${from || 'all'}_${to || 'all'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="用量统计"
        desc="费用与配额对照(金额/token 双维度,管理员豁免)"
      />
      {error && <div className="text-sm text-destructive">{error}</div>}
      {hasUnpricedModels && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <TriangleAlert className="h-4 w-4" />
          存在未配置价格的模型(网关「模型管理」):其费用按 0 计,金额配额可能被低估。
        </div>
      )}

      {/* 筛选区:分组 + 快捷区间 + 日期 + 统计口径 */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground">分组</Label>
            <Select value={group} onValueChange={(v) => setGroup(v as Group)}>
              <SelectTrigger className="w-32" aria-label="分组"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="day">按日</SelectItem>
                <SelectItem value="week">按周</SelectItem>
                <SelectItem value="month">按月</SelectItem>
                <SelectItem value="model">按模型</SelectItem>
                <SelectItem value="user">按用户</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground">统计口径</Label>
            <Select value={metric} onValueChange={(v) => setMetric(v as Metric)}>
              <SelectTrigger className="w-28" aria-label="统计口径"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="money">金额(元)</SelectItem>
                <SelectItem value="tokens">tokens</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground">快捷区间</Label>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => applyRange(rangePreset(7))}>近7天</Button>
              <Button size="sm" variant="outline" onClick={() => applyRange(rangePreset(30))}>近30天</Button>
              <Button size="sm" variant="outline" onClick={() => applyRange(monthRange())}>本月</Button>
            </div>
          </div>
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground" htmlFor="usage-from">起始日期</Label>
            <Input id="usage-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block text-sm text-muted-foreground" htmlFor="usage-to">结束日期</Label>
            <Input id="usage-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button onClick={doQuery}>查询</Button>
        </CardContent>
      </Card>

      {/* 汇总统计卡:总费用为第一指标(企业面板 stat-card 模式) */}
      <div data-testid="stat-cards" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {statCards.map((c) => (
          <Card key={c.title} className="h-full">
            <CardContent className="flex h-full flex-col pt-5">
              <div className="flex shrink-0 items-center gap-2">
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${c.money ? 'bg-[#1E40AF]/10 text-[#1E40AF]' : 'bg-slate-100 text-slate-500'}`}>
                  <c.icon className="h-3.5 w-3.5" />
                </div>
                <span className="whitespace-nowrap text-[13px] leading-tight text-muted-foreground">{c.title}</span>
              </div>
              <div className="mt-2.5 flex h-8 shrink-0 items-center">
                {loading ? (
                  <Skeleton className="h-7 w-24" />
                ) : (
                  <div
                    className="font-mono text-[22px] font-bold leading-tight tabular-nums tracking-tight text-slate-800"
                    title={c.money ? fmtMoneyFull(c.value) : fmtFull(c.value)}
                  >
                    {c.money ? `¥${fmtMoney(c.value)}` : c.int ? c.value.toLocaleString() : fmtTokens(c.value)}
                  </div>
                )}
              </div>
              <div className="mt-1.5 flex-1 text-[11px] leading-relaxed text-muted-foreground">{c.desc}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 图表区:趋势 / 占比 / 排行(VChart) */}
      <Card>
        <Tabs value={chartTab} onValueChange={onChartTabChange}>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">用量分析</CardTitle>
              <CardDescription>
                {metric === 'money'
                  ? `Total: ¥${fmtMoney(totals.cost)}`
                  : `Total: ${fmtTokens(totals.chatTotal)} tokens(不含 embedding)`}
              </CardDescription>
            </div>
            <TabsList>
              <TabsTrigger value="trend">趋势</TabsTrigger>
              <TabsTrigger value="proportion">占比</TabsTrigger>
              <TabsTrigger value="rank">排行</TabsTrigger>
            </TabsList>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-72 w-full" />
            ) : rows.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-muted-foreground">暂无数据</div>
            ) : (
              <>
                {/* 懒挂载:仅激活 tab 渲染对应图表,避免 display:none 容器内初始化(审计低4) */}
                <TabsContent value="trend" className="h-72">
                  {chartTab === 'trend' && <ChartLazy spec={trendSpec} />}
                </TabsContent>
                <TabsContent value="proportion" className="h-72">
                  {chartTab === 'proportion' && (
                    <ChartLazy
                      spec={pieSpec}
                      onClick={(e: any) => setFilterName(e?.datum?.name ?? '')}
                    />
                  )}
                </TabsContent>
                <TabsContent value="rank" className="h-72">
                  {chartTab === 'rank' && <ChartLazy spec={rankSpec} />}
                </TabsContent>
              </>
            )}
          </CardContent>
        </Tabs>
      </Card>

      {/* 配额占用面板(token + 金额双维度) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <WalletCards className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">本月配额占用</CardTitle>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="destructive">超额 {quotaStats.over.length}</Badge>
              <Badge variant="secondary">≥90% {quotaStats.near.length}</Badge>
              <Button size="sm" variant="outline" onClick={() => loadQuota()}>刷新</Button>
            </div>
          </div>
          <CardDescription>
            按自然月统计(每月 1 日重置),与上方查询区间无关。管理员豁免
            (统计卡与明细含管理员用量,配额仅约束普通员工,两者口径不同)。
            {defaultQuota !== null && defaultQuota > 0 && ` 默认 token 配额 ${fmtTokens(defaultQuota)}/月`}
            {defaultMoneyQuota !== null && defaultMoneyQuota > 0 && ` · 默认金额配额 ¥${fmtMoney(defaultMoneyQuota)}/月`}
            (跟随默认的员工已计入)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {userTotal > quotaUsers.length && (
            <div className="text-xs text-muted-foreground">
              共 {userTotal} 名非管理员员工,列表仅展示前 {quotaUsers.length} 名(按 id 排序);搜索可缩小范围。
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input
              placeholder="搜索用户名"
              value={quotaSearch}
              onChange={(e) => setQuotaSearch(e.target.value)}
              className="max-w-56 h-8"
              aria-label="搜索配额用户"
            />
            {quotaSearch && (
              <Button size="sm" variant="outline" onClick={() => setQuotaSearch('')}>清除</Button>
            )}
          </div>
          {quotaStats.sorted.length === 0 ? (
            <div className="text-sm text-muted-foreground">暂无配额数据</div>
          ) : (
            <div data-testid="quota-list">
              {quotaStats.sorted.map((u) => {
                const q = quotaStats.eff(u)
                const mq = quotaStats.effMoney(u)
                const rate = usageRate(u.monthly_usage, q)
                const pct = quotaPercent(u.monthly_usage, q)
                const over = quotaOver(u.monthly_usage, q) || moneyOver(u.monthly_cost, mq)
                const mRate = moneyRate(u.monthly_cost, mq)
                const mPct = moneyPercent(u.monthly_cost, mq)
                const mOver = moneyOver(u.monthly_cost, mq)
                return (
                  <div key={u.id} className="space-y-2 rounded-md border p-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5 font-medium">
                        {u.username}
                        {over && <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">超额</Badge>}
                        {!over && (rate >= 90 || mRate >= 90) && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">临近</Badge>}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {pct === null && mPct === null ? '不限'
                          : `${Math.max(pct ?? 0, mPct ?? 0)}%`}
                      </span>
                    </div>
                    {/* token 行 */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>token 流量</span>
                        <span className="tabular-nums">
                          {fmtTokens(u.monthly_usage)} / {q ? fmtTokens(q) : '—'}
                        </span>
                      </div>
                      <div
                        className="h-2 w-full overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-valuenow={pct ?? 0}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${u.username} token 配额占用 ${pct === null ? '不限' : pct + '%'}`}
                      >
                        <div
                          className={`h-full rounded-full ${quotaOver(u.monthly_usage, q) ? 'bg-destructive' : rate >= 90 ? 'bg-amber-500' : 'bg-primary'}`}
                          style={{ width: `${quotaOver(u.monthly_usage, q) ? 100 : rate}%` }}
                        />
                      </div>
                    </div>
                    {/* 金额行(0022) */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>金额(¥)</span>
                        <span className="tabular-nums">
                          ¥{fmtMoney(u.monthly_cost)} / {mq ? `¥${fmtMoney(mq)}` : '—'}
                        </span>
                      </div>
                      <div
                        className="h-2 w-full overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-valuenow={mPct ?? 0}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${u.username} 金额配额占用 ${mPct === null ? '不限' : mPct + '%'}`}
                      >
                        <div
                          className={`h-full rounded-full ${mOver ? 'bg-destructive' : mRate >= 90 ? 'bg-amber-500' : 'bg-primary'}`}
                          style={{ width: `${mOver ? 100 : mRate}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {/* 部门预算(0024):预算链 = 归属部门 + 祖先链,任一超限网关 429(审计低7) */}
          {deptBudgets.length > 0 && (
            <div className="space-y-2 rounded-md border border-dashed p-3">
              <div className="text-sm font-medium">部门月度预算(金额)</div>
              {deptBudgets.map((d) => {
                const dRate = moneyRate(d.cost, d.budget)
                const dOver = moneyOver(d.cost, d.budget)
                return (
                  <div key={d.name} className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{d.name}</span>
                      <span className="tabular-nums">
                        ¥{fmtMoney(d.cost)} / ¥{fmtMoney(d.budget)}{dOver && ' · 超预算'}
                      </span>
                    </div>
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-muted"
                      role="progressbar"
                      aria-valuenow={Math.min(100, dRate)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${d.name} 部门预算占用 ${dRate}%`}
                    >
                      <div
                        className={`h-full rounded-full ${dOver ? 'bg-destructive' : dRate >= 90 ? 'bg-amber-500' : 'bg-primary'}`}
                        style={{ width: `${dOver ? 100 : dRate}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 明细表格 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">明细</CardTitle>
          <div className="flex items-center gap-2">
            {filterName && (
              <Button size="sm" variant="outline" onClick={() => setFilterName('')}>
                清除过滤: {filterName}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="h-3.5 w-3.5" /> 导出 CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{GROUP_LABEL[group]}</TableHead>
                  <TableHead className="text-right">请求数</TableHead>
                  <TableHead className="text-right">输入 tokens</TableHead>
                  <TableHead className="text-right">输出 tokens</TableHead>
                  <TableHead className="text-right">缓存命中</TableHead>
                  <TableHead className="text-right">embedding tokens</TableHead>
                  <TableHead className={`text-right ${metric === 'tokens' ? 'font-bold' : ''}`}>合计 tokens(chat)</TableHead>
                  <TableHead className={`text-right ${metric === 'money' ? 'font-bold' : ''}`}>费用(¥)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((r) => (
                  <TableRow
                    key={r.label}
                    className={group === 'user' ? 'cursor-pointer hover:bg-accent' : undefined}
                    onClick={group === 'user' ? () => openDrill(r.label) : undefined}
                    tabIndex={group === 'user' ? 0 : undefined}
                    role={group === 'user' ? 'button' : undefined}
                    aria-label={group === 'user' ? `查看 ${r.label} 明细` : undefined}
                    onKeyDown={group === 'user' ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openDrill(r.label)
                      }
                    } : undefined}
                  >
                    <TableCell>{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.requests}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(r.prompt_tokens)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(r.completion_tokens)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(r.cache_tokens ?? 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(r.embed_tokens ?? 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(chatTokens(r))}</TableCell>
                    <TableCell className="text-right tabular-nums" title={fmtMoneyFull(r.cost ?? 0)}>¥{fmtMoney(r.cost ?? 0)}</TableCell>
                  </TableRow>
                ))}
                {filteredRows.length > 0 && (
                  <TableRow className="font-semibold">
                    <TableCell>{filterName ? `小计(${filterName})` : '合计'}</TableCell>
                    <TableCell className="text-right tabular-nums">{filteredRows.reduce((s, r) => s + r.requests, 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(filteredRows.reduce((s, r) => s + r.prompt_tokens, 0))}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(filteredRows.reduce((s, r) => s + r.completion_tokens, 0))}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(filteredRows.reduce((s, r) => s + (r.cache_tokens ?? 0), 0))}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(filteredRows.reduce((s, r) => s + (r.embed_tokens ?? 0), 0))}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTokens(filteredRows.reduce((s, r) => s + chatTokens(r), 0))}</TableCell>
                    <TableCell className="text-right tabular-nums">¥{fmtMoney(filteredRows.reduce((s, r) => s + (r.cost ?? 0), 0))}</TableCell>
                  </TableRow>
                )}
                {filteredRows.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 用户钻取弹窗:该用户的日趋势 */}
      <Dialog open={!!drillUser} onOpenChange={(o) => { if (!o) setDrillUser('') }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>用户用量 · {drillUser}</DialogTitle>
            <DialogDescription>
              区间 {from || '全部'} ~ {to || '全部'} 的日趋势({metric === 'money' ? '金额' : 'tokens'})
            </DialogDescription>
          </DialogHeader>
          {drillLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : drillError ? (
            <div className="flex h-72 flex-col items-center justify-center gap-3 text-muted-foreground">
              <span className="text-sm text-destructive">{drillError}</span>
              <Button size="sm" variant="outline" onClick={() => openDrill(drillUser)}>重试</Button>
            </div>
          ) : drillRows.length === 0 ? (
            <div className="flex h-72 items-center justify-center text-muted-foreground">该用户区间内暂无数据</div>
          ) : (
            <div className="h-72">
              <ChartLazy spec={drillSpec} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
