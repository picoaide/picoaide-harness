import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Switch } from '../../components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { PageHeader } from '../../components/page-header'
import { employeeCountText, fmtY, type UserInfo } from './common'
import { fmtTokens } from '../../lib/format'
import { cn } from '../../lib/utils'
import { Coins, Gift, Check, Loader2, Wallet, ScrollText } from 'lucide-react'

// ---------------------------------------------------------------------------
// 余额(2026-09-11 收敛)—— 员工"钱"的唯一页面。
//
// 模型只剩两个概念:
//   ① 账户余额:员工账上的钱(存量、消费即减),闸门开启且余额耗尽 → 网关 429;
//   ② 按月发放:每月自动往余额里发多少(可手动补发,逐人·月幂等)。
// 部门预算 / token 配额 / 金额配额已全部下线(设计文档
// docs/planning/2026-09-11-balance-quota-consolidation.md)。
// ---------------------------------------------------------------------------

type BalanceMode = 'add' | 'deduct' | 'set' | 'clear'

interface GrantRun {
  month: string
  mode: string
  amount: number
  granted: number
  skipped: number
}

interface BalanceSummary {
  settings: { enabled: boolean; monthly_amount: number; monthly_mode: 'add' | 'cover' }
  last_grant: { month: string; mode: string; amount: number; affected: number } | null
  month_grant: { month: string; mode: string; amount: number; affected: number } | null
  status: { month: string; eligible: number; granted: number; pending: number; activated: number }
  users: number
  total_balance: number
}

interface LedgerItem {
  id: number
  kind: string
  amount: number
  balance_after: number
  reason: string
  actor: string
  usage_id: number | null
  month: string
  created_at: string
}

const KIND_LABEL: Record<string, string> = {
  grant: '月度发放',
  reset: '覆盖清零',
  adjust: '人工调整',
  consume: '消费扣减',
  refund: '费用回补',
}

function fmtTime(s: string): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function UsageBalance() {
  const [users, setUsers] = useState<UserInfo[]>([])
  const [rawCount, setRawCount] = useState(0)
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [summary, setSummary] = useState<BalanceSummary | null>(null)
  const [saving, setSaving] = useState(false)
  const loadSeq = useRef(0)

  // 发放策略草稿
  const [draftEnabled, setDraftEnabled] = useState(false)
  const [draftMode, setDraftMode] = useState<'add' | 'cover'>('add')
  const [draftAmount, setDraftAmount] = useState('')

  // 单人调整
  const [target, setTarget] = useState<UserInfo | null>(null)
  const [mode, setMode] = useState<BalanceMode>('add')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialogErr, setDialogErr] = useState('')

  // 流水
  const [ledgerUser, setLedgerUser] = useState<UserInfo | null>(null)
  const [ledger, setLedger] = useState<LedgerItem[]>([])
  const [ledgerSum, setLedgerSum] = useState<number | null>(null)
  const [ledgerBusy, setLedgerBusy] = useState(false)

  const [searchParams] = useSearchParams()
  const presetUser = searchParams.get('user') ?? ''

  const loadSummary = useCallback(async () => {
    try {
      const s: BalanceSummary = await request(`${ADMIN_API}/balance`)
      setSummary(s)
      setDraftEnabled(s.settings.enabled)
      setDraftMode(s.settings.monthly_mode)
      setDraftAmount(s.settings.monthly_amount > 0 ? String(s.settings.monthly_amount) : '')
    } catch {
      /* 策略卡加载失败不阻断员工表 */
    }
  }, [])

  const load = useCallback(async (query: string) => {
    const current = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const ul = await request<{ users: UserInfo[]; total: number }>(
        `${ADMIN_API}/users?size=200${query ? `&q=${encodeURIComponent(query)}` : ''}`)
      if (current !== loadSeq.current) return
      const all = ul.users ?? []
      setUsers(all.filter((u) => u.role !== 'super_admin'))
      setRawCount(all.length)
      setTotal(ul.total ?? 0)
    } catch (e: any) {
      if (current === loadSeq.current) setError(e.message || '查询失败')
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSummary()
    if (presetUser) {
      setQ(presetUser)
      void load(presetUser)
    } else {
      void load('')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ?user= 预填后自动打开该用户的调整弹窗(用户管理页「余额」按钮跳转入口)
  useEffect(() => {
    if (!presetUser || target || users.length === 0) return
    const hit = users.find((u) => u.username.toLowerCase() === presetUser.toLowerCase())
    if (hit) openAdjust(hit)
  }, [users]) // eslint-disable-line react-hooks/exhaustive-deps

  async function saveSettings() {
    if (saving) return
    const n = draftAmount.trim() === '' ? 0 : Number(draftAmount)
    if (!Number.isFinite(n) || n < 0) { setError('每人每月额度必须是不小于 0 的数字'); return }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const r = await request<any>(`${ADMIN_API}/balance`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: draftEnabled, monthly_amount: n, monthly_mode: draftMode }),
      })
      const run: GrantRun | null = r?.run ?? null
      setNotice(run && run.granted > 0
        ? `已保存,并补发本月 ${run.granted} 人 × ¥${Number(run.amount).toFixed(2)}`
        : '发放策略已保存')
      await loadSummary()
      await load(q)
    } catch (e: any) {
      setError(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function grantNow() {
    if (saving) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const r = await request<any>(`${ADMIN_API}/balance/grant`, { method: 'POST' })
      const run: GrantRun | null = r?.run ?? null
      setNotice(run && run.granted > 0
        ? `已发放 ${run.granted} 人 × ¥${Number(run.amount).toFixed(2)}${run.skipped ? `(另有 ${run.skipped} 人本月已发)` : ''}`
        : '本月所有员工都已发放过,无需重复发放')
      await loadSummary()
      await load(q)
    } catch (e: any) {
      setError(e.message || '发放失败')
    } finally {
      setSaving(false)
    }
  }

  function openAdjust(u: UserInfo) {
    setTarget(u)
    setMode('add')
    setAmount('')
    setReason('')
    setDialogErr('')
  }

  const parsed = (() => {
    const n = Number(amount)
    return amount.trim() !== '' && Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN
  })()
  const preview = useMemo(() => {
    if (!target) return null
    const cur = target.balance_money ?? 0
    if (mode === 'clear') return 0
    if (Number.isNaN(parsed)) return null
    if (mode === 'add') return cur + parsed
    if (mode === 'deduct') return cur - parsed
    return parsed
  }, [target, mode, parsed])
  const previewNegative = preview !== null && preview < 0
  const valid = mode === 'clear'
    ? true
    : !Number.isNaN(parsed) && (mode === 'set' ? parsed >= 0 : parsed > 0) && (mode !== 'deduct' || (preview ?? -1) >= 0)

  async function saveAdjust() {
    if (!target || busy) return
    if (!valid) { setDialogErr(mode === 'deduct' ? '扣减金额不能超过当前余额' : '请输入有效金额'); return }
    setBusy(true)
    setDialogErr('')
    try {
      await request(`${ADMIN_API}/users/${target.id}/balance`, {
        method: 'POST',
        body: JSON.stringify({ mode, amount: mode === 'clear' ? 0 : parsed, reason: reason.trim() }),
      })
      const label = mode === 'add' ? '充值' : mode === 'deduct' ? '扣减' : mode === 'clear' ? '清零' : '设为'
      setNotice(`已为 ${target.username} ${label}${mode === 'clear' ? '' : ` ¥${parsed.toFixed(2)}`}`)
      setTarget(null)
      await load(q)
      await loadSummary()
    } catch (e: any) {
      setDialogErr(e.message || '调整失败')
    } finally {
      setBusy(false)
    }
  }

  async function openLedger(u: UserInfo) {
    setLedgerUser(u)
    setLedgerBusy(true)
    setLedger([])
    setLedgerSum(null)
    try {
      const r = await request<any>(`${ADMIN_API}/users/${u.id}/balance/ledger?size=50`)
      setLedger(r.items ?? [])
      setLedgerSum(typeof r.ledger_sum === 'number' ? r.ledger_sum : null)
    } catch (e: any) {
      setDialogErr(e.message || '流水加载失败')
    } finally {
      setLedgerBusy(false)
    }
  }

  const st = summary?.status
  const monthly = summary?.settings.monthly_amount ?? 0

  return (
    <div className="space-y-6">
      <PageHeader title="余额" desc="员工的账户余额与按月发放:余额是唯一的消费闸门,花完即停" />
      {error && <div className="text-sm text-destructive">{error}</div>}
      {notice && <div className="text-sm text-emerald-600">{notice}</div>}

      {/* 发放策略:启用闸门 / 发放方式 / 每人额度 / 立即发放 */}
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700"><Coins className="h-5 w-5" /></div>
            <div>
              <CardTitle className="text-base">按月发放余额</CardTitle>
              <CardDescription>
                每月自动向全部启用员工发放一次(每人 ¥{monthly > 0 ? monthly.toFixed(2) : '—'});
                新入职员工当天补发。发放与闸门独立:可以先只发钱不拦人。
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={grantNow} disabled={saving || monthly <= 0}>
              <Gift className="mr-1 h-4 w-4" />立即补发本月
            </Button>
            <Button onClick={saveSettings} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}保存
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="bal-enabled" className="text-sm font-medium">余额闸门</Label>
              <Switch id="bal-enabled" checked={draftEnabled} onCheckedChange={setDraftEnabled} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {draftEnabled
                ? '开启:余额耗尽的员工调用 AI 时被拦截(未开通余额的员工不受影响)。'
                : '关闭:只记账不拦截 —— 余额照样随消费扣减,便于先观察再启用。'}
            </p>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">发放方式</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setDraftMode('add')}
                className={cn('rounded-md border p-2 text-left text-xs', draftMode === 'add' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50')}>
                <div className="text-sm font-medium">累加</div>
                <div className="text-muted-foreground">余额 + 月额度</div>
              </button>
              <button type="button" onClick={() => setDraftMode('cover')}
                className={cn('rounded-md border p-2 text-left text-xs', draftMode === 'cover' ? 'border-primary bg-primary/5' : 'hover:bg-muted/50')}>
                <div className="text-sm font-medium">覆盖</div>
                <div className="text-muted-foreground">清零后重置为月额度</div>
              </button>
            </div>
            {draftMode === 'cover' && (
              <p className="mt-1 text-xs text-amber-600">覆盖会清零全部结余与手工充值(清零金额会记入流水,可追溯)。</p>
            )}
          </div>
          <div className="rounded-md border p-3">
            <Label htmlFor="bal-amount" className="text-sm font-medium">每人每月额度(元)</Label>
            <Input id="bal-amount" className="mt-2" inputMode="decimal" placeholder="例如 100"
              value={draftAmount} onChange={(e) => setDraftAmount(e.target.value)} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[50, 100, 200, 500].map((v) => (
                <Button key={v} type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
                  onClick={() => setDraftAmount(String(v))}>¥{v}</Button>
              ))}
            </div>
          </div>
        </CardContent>
        {st && (
          <div className="border-t px-6 py-3 text-xs text-muted-foreground">
            本月({st.month}):已发 <span className="font-medium text-foreground">{st.granted}</span> / {st.eligible} 人
            {st.pending > 0 && <span className="ml-2 text-amber-600">待发 {st.pending} 人</span>}
            <span className="ml-4">已开通余额 {st.activated} 人</span>
            <span className="ml-4">余额合计 ¥{(summary?.total_balance ?? 0).toFixed(2)}</span>
          </div>
        )}
      </Card>

      {/* 员工余额表 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">员工余额</CardTitle>
            <CardDescription>
              未开通 = 从未入账(不受余额闸门约束,也不随消费扣减);开通后消费即扣、余额耗尽即停
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Input placeholder="搜索用户名" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void load(q) }} className="h-8 w-48" aria-label="搜索员工" />
            <Button size="sm" variant="outline" onClick={() => void load(q)}>查询</Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-72 w-full" /> : (
            <>
              <div className="mb-2 text-xs text-muted-foreground">{employeeCountText(users, rawCount, total)}</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>员工</TableHead>
                    <TableHead>部门</TableHead>
                    <TableHead className="text-right">账户余额</TableHead>
                    <TableHead className="text-right">本月消费</TableHead>
                    <TableHead className="text-right">本月 tokens</TableHead>
                    <TableHead className="w-56">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">
                        {u.display_name || u.username}
                        {u.status !== 1 && <Badge variant="destructive" className="ml-2">停用</Badge>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {(u.groups ?? []).filter((g) => g !== '全员').join(', ') || '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {u.balance_activated ? (
                          <span className={cn('font-medium', (u.balance_money ?? 0) <= 0 ? 'text-destructive' : 'text-emerald-600')}>
                            {fmtY(u.balance_money ?? 0)}
                          </span>
                        ) : <span className="text-xs text-muted-foreground">未开通</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtY(u.monthly_cost ?? 0)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtTokens(u.monthly_usage ?? 0)}</TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => openAdjust(u)}>
                            <Wallet className="mr-1 h-3.5 w-3.5" />调整
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void openLedger(u)}>
                            <ScrollText className="mr-1 h-3.5 w-3.5" />流水
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {users.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无数据</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      {/* 单人调整:充值 / 扣减 / 设为 / 清零 */}
      <Dialog open={!!target} onOpenChange={(o) => { if (!o) setTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>调整余额 · {target?.username}</DialogTitle>
            <DialogDescription>
              当前余额 {target?.balance_activated ? fmtY(target?.balance_money ?? 0) : '未开通(首次入账即开通)'}。调整立即生效并写入流水与审计。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>操作</Label>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {([['add', '充值', '加到余额'], ['deduct', '扣减', '从余额扣除'],
                   ['set', '设为', '重置为指定值'], ['clear', '清零', '余额归零']] as const).map(([m, label, hint]) => (
                  <button key={m} type="button" onClick={() => { setMode(m as BalanceMode); setDialogErr('') }}
                    className={cn('rounded-md border p-2 text-left text-xs', mode === m ? 'border-primary bg-primary/5' : 'hover:bg-muted/50')}>
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-muted-foreground">{hint}</div>
                  </button>
                ))}
              </div>
            </div>
            {mode !== 'clear' && (
              <div>
                <Label htmlFor="bal-dialog-amount">金额(元)</Label>
                <Input id="bal-dialog-amount" autoFocus inputMode="decimal" className="mt-2 text-base"
                  placeholder={mode === 'set' ? '例如 0' : '例如 100'} value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) void saveAdjust() }} />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[10, 50, 100, 500].map((v) => (
                    <Button key={v} type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
                      onClick={() => setAmount(String(v))}>
                      {mode === 'deduct' ? '-' : mode === 'set' ? '设为 ' : '+'}¥{v}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className={cn('flex items-center justify-between rounded-md px-3 py-2 text-sm',
              previewNegative ? 'bg-destructive/10 text-destructive' : 'bg-muted/50')}>
              <span>调整后余额</span>
              <span className="font-mono font-medium">
                {preview === null ? '—' : preview < 0 ? `-¥${Math.abs(preview).toFixed(2)}` : `¥${preview.toFixed(2)}`}
                {previewNegative && ' (扣减超过当前余额)'}
              </span>
            </div>
            <div>
              <Label htmlFor="bal-reason">备注(可选,写入流水与审计)</Label>
              <Input id="bal-reason" className="mt-2" maxLength={200} placeholder="例如:9 月充值 / 项目冲刺追加"
                value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            {dialogErr && <div className="text-sm text-destructive">{dialogErr}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setTarget(null)}>取消</Button>
              <Button disabled={!valid || busy} onClick={() => void saveAdjust()}>
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wallet className="mr-1 h-4 w-4" />}确认
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 余额流水 */}
      <Dialog open={!!ledgerUser} onOpenChange={(o) => { if (!o) setLedgerUser(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>余额流水 · {ledgerUser?.username}</DialogTitle>
            <DialogDescription>
              每一笔余额变动都可追溯(发放 / 清零 / 人工调整 / 消费 / 回补)。
              {ledgerSum !== null && <> 流水合计 <span className="font-mono">{fmtY(ledgerSum)}</span>,应等于当前余额。</>}
            </DialogDescription>
          </DialogHeader>
          {ledgerBusy ? <Skeleton className="h-64 w-full" /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead className="text-right">变动</TableHead>
                  <TableHead className="text-right">余额</TableHead>
                  <TableHead>说明</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtTime(e.created_at)}</TableCell>
                    <TableCell><Badge variant="outline">{KIND_LABEL[e.kind] ?? e.kind}</Badge></TableCell>
                    <TableCell className={cn('text-right font-mono tabular-nums', e.amount < 0 ? 'text-destructive' : 'text-emerald-600')}>
                      {e.amount >= 0 ? '+' : ''}{e.amount.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{e.balance_after.toFixed(2)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {e.reason || '—'}{e.actor ? ` · ${e.actor}` : ''}{e.month ? ` · ${e.month}` : ''}
                      {e.usage_id ? ` · usage#${e.usage_id}` : ''}
                    </TableCell>
                  </TableRow>
                ))}
                {ledger.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无流水</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          )}
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setLedgerUser(null)}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
