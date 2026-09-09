import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { rangePreset, monthRange } from '../../lib/format'

// ---------------------------------------------------------------------------
// 用量中心共享类型/格式化/过滤器(2026-09 重构, 每页一主题的原则下复用单一真源)
// ---------------------------------------------------------------------------

export interface UsageRow {
  label: string
  prompt_tokens: number
  completion_tokens: number
  requests: number
  embed_requests?: number
  embed_tokens?: number
  cache_tokens?: number
  cost?: number
}

export interface OverviewData {
  range: { cost: number; tokens: number; requests: number }
  month: { cost: number; tokens: number; requests: number }
  today: { cost: number; tokens: number; requests: number }
  trend: UsageRow[]
  top_models: UsageRow[]
}

export interface UsageRequestRow {
  id: number
  time: string
  user_id: number
  username: string
  model: string
  kind: string
  prompt_tokens: number
  completion_tokens: number
  cache_tokens: number
  cost: number
}

export interface DeptInfo {
  id: number
  name: string
  parent_id: number
  leader_name?: string
  member_count: number
  budget_money: number | null
  monthly_cost: number
}

export interface UserInfo {
  id: number
  username: string
  display_name?: string
  role: string
  status: number
  quota_tokens: number | null
  quota_money: number | null
  /** 生效配额(服务端 users 列表下发;跟随全局默认时已折算,0 = 不限)。 */
  effective_quota_tokens?: number | null
  effective_quota_money?: number | null
  monthly_usage: number
  monthly_cost: number
  groups: string[]
}

/** 生效金额配额(P2-45):服务端已按「用户覆盖 → 全局默认」折算下发,
 *  直接用 effective_quota_money;缺失(旧服务端)才回退用户覆盖值。
 *  0 = 不限(与 moneyPercent/moneyOver 口径一致,调用方按 null 处理即可)。 */
export function effectiveQuotaMoney(u: UserInfo): number | null {
  return u.effective_quota_money ?? u.quota_money ?? null
}

/** 生效 token 配额(P2-45),口径同上。 */
export function effectiveQuotaTokens(u: UserInfo): number | null {
  return u.effective_quota_tokens ?? u.quota_tokens ?? null
}

/** 员工数文案(P3):服务端 total 含超管且无角色过滤,不可假设「仅一名超管」。
 *  单页取全量时按实际员工行数;超过单页时给下限 + 搜索提示。 */
export function employeeCountText(employees: UserInfo[], rawCount: number, total: number): string {
  if (rawCount < total) return `共 ${employees.length}+ 名员工(列表展示前 ${employees.length},搜索可缩小范围)`
  return `共 ${employees.length} 名员工`
}

export interface ModelInfo {
  id: number
  name: string
  provider_id: number
  display_name?: string
  input_price_per_1m?: number | null
  output_price_per_1m?: number | null
  cache_input_price_per_1m?: number | null
  offpeak_discount?: number | null
}

export interface ProviderInfo {
  id: number
  name: string
  base_url: string
  enabled: boolean
}

export interface ProviderBalance {
  supported?: boolean
  is_available?: boolean
  infos?: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[]
  error?: string
  fetched_at?: string
}

// chat tokens(不含 embedding):embedding 行 tokens 落在 prompt_tokens 列
export function chatTokens(r: UsageRow): number {
  return r.prompt_tokens + r.completion_tokens - (r.embed_tokens ?? 0)
}

// 区间求和(总览汇总行)
export function sumRows(rows: UsageRow[]): { cost: number; tokens: number; requests: number; prompt: number; completion: number; cache: number; embed: number } {
  let cost = 0, requests = 0, prompt = 0, completion = 0, cache = 0, embed = 0
  for (const r of rows) {
    cost += r.cost ?? 0
    requests += r.requests
    prompt += r.prompt_tokens
    completion += r.completion_tokens
    cache += r.cache_tokens ?? 0
    embed += r.embed_tokens ?? 0
  }
  return { cost, tokens: prompt + completion - embed, requests, prompt, completion, cache, embed }
}

// 导出 CSV(带 BOM;公式注入转义,与旧用量页一致)
function csvCell(v: string | number): string {
  let s = String(v)
  if (/^[=+\-@]/.test(s)) s = "'" + s
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function downloadCsv(filename: string, head: string[], lines: (string | number)[][]) {
  const csv = '\uFEFF' + [head.join(','), ...lines.map((l) => l.map((v) => csvCell(v)).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function fmtY(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// 用量中心统一请求封装
export async function fetchUsageList(params: Record<string, string>): Promise<UsageRow[]> {
  const qs = new URLSearchParams(params).toString()
  const data = await request(`${ADMIN_API}/usage?${qs}`)
  return (data.rows ?? []) as UsageRow[]
}

// 统一时间范围过滤条(快捷区间 + 自定义日期 + 查询)
export function RangeFilter({ from, to, setFrom, setTo, onQuery }: {
  from: string
  to: string
  setFrom: (v: string) => void
  setTo: (v: string) => void
  onQuery: () => void
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex gap-1">
        <Button size="sm" variant="outline" onClick={() => { const r = rangePreset(7); setFrom(r.from); setTo(r.to); onQuery() }}>近7天</Button>
        <Button size="sm" variant="outline" onClick={() => { const r = rangePreset(30); setFrom(r.from); setTo(r.to); onQuery() }}>近30天</Button>
        <Button size="sm" variant="outline" onClick={() => { const r = monthRange(); setFrom(r.from); setTo(r.to); onQuery() }}>本月</Button>
      </div>
      <div>
        <Label className="mb-1 block text-sm text-muted-foreground" htmlFor="uc-from">起始日期</Label>
        <Input id="uc-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div>
        <Label className="mb-1 block text-sm text-muted-foreground" htmlFor="uc-to">结束日期</Label>
        <Input id="uc-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Button onClick={onQuery}>查询</Button>
    </div>
  )
}

// 默认近 30 天范围
export function defaultRange() {
  return rangePreset(30)
}
