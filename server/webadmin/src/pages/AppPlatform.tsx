import { useCallback, useEffect, useMemo, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { PageHeader } from '../components/page-header'
import { useFlash } from '../lib/use-flash'
import { hasPermission, PERM_CAP_READ, PERM_CAP_WRITE } from '../lib/rbac'
import { AlertTriangle, RotateCcw, Save } from 'lucide-react'

/**
 * 应用平台限制项配置页（2026-09-19 用户要求）。
 *
 * 三件事必须一眼看清（否则运营改完不知道发生了什么）：
 *  1. **当前值与来源**：控制台保存过的设置 > 部署档位（env）> 编译期默认；
 *  2. **四笔账预览**：并发×单实例上限 + 编译峰值 + 上传峰值 + 模块缓存驻留，
 *     与可用内存的 70% 水位比较 —— 与启动自检同一判据（保存超限服务端直接拒）；
 *  3. **生效范围**：哪些字段即时生效、哪些要重启（只有单实例内存上限要重启）。
 *
 * 服务端是唯一权威：本页的实时预览只是编辑期的估算（用服务端下发的
 * available/guard 与三个常量），保存成功与否一律以 PUT 的应答为准。
 */
interface Limits {
  max_instances: number
  app_running: number
  app_queue: number
  user_global_running: number
  user_per_app_running: number
  user_per_app_queued: number
  instance_memory_mb: number
  module_cache_mb: number
  module_cache_idle_min: number
  appdb_idle_min: number
  appdb_cache_kib: number
}

interface Budget {
  profile: string
  instances_bytes: number
  compile_peak_bytes: number
  upload_peak_bytes: number
  cache_resident_bytes: number
  total_bytes: number
  available_bytes: number
  limit_bytes: number
  ok: boolean
}

interface FieldRange {
  min: number
  max: number
  unit: string
  restart: boolean
}

interface LimitsView {
  limits: Limits
  source: string
  defaults: Limits
  presets: Record<string, Limits>
  ranges: Record<string, FieldRange>
  budget: Budget
  guard_percent: number
  restart_fields: string[]
  restart_pending: string[]
  setting_key: string
}

type FieldKey = keyof Limits

const FIELDS: { key: FieldKey; label: string; group: '并发' | '内存'; hint: string }[] = [
  { key: 'max_instances', label: '全局并发实例数', group: '并发', hint: '同时运行的 wasm 实例上限；同时决定进程内应用库句柄上限' },
  { key: 'app_running', label: '单应用并发', group: '并发', hint: '同一应用同时处理的请求数（应用库是一应用一连接，串行执行）' },
  { key: 'app_queue', label: '单应用队列长度', group: '并发', hint: '超过并发后允许排队的请求数，再多的直接 429' },
  { key: 'user_global_running', label: '单用户跨应用并发', group: '并发', hint: '一个用户在所有应用里同时能占用的实例数' },
  { key: 'user_per_app_running', label: '单用户单应用并发', group: '并发', hint: '通常为 1：一个用户在同一应用内串行' },
  { key: 'user_per_app_queued', label: '单用户单应用排队', group: '并发', hint: '一个用户在同一应用队列里的占位上限' },
  { key: 'instance_memory_mb', label: '单实例内存上限', group: '内存', hint: '单个应用实例可用的线性内存上限（wazero 的硬上限，超了报 RUNTIME_MEMORY）' },
  { key: 'module_cache_mb', label: '编译模块缓存上限', group: '内存', hint: '进程内缓存已编译应用的上限；几百个应用时它是常驻内存的主要项' },
  { key: 'module_cache_idle_min', label: '模块空闲回收', group: '内存', hint: '超过这个时间没被访问就逐出并归还内存给操作系统' },
  { key: 'appdb_idle_min', label: '应用库空闲回收', group: '内存', hint: '应用数据库句柄（2 条连接）空闲多久后关闭' },
  { key: 'appdb_cache_kib', label: 'SQLite 页缓存/连接', group: '内存', hint: '每条应用库连接的页缓存上限；下一个新建连接生效' },
]

const mb = (v: number) => Math.round(v / (1 << 20))

export default function AppPlatform() {
  const [view, setView] = useState<LimitsView | null>(null)
  const [form, setForm] = useState<Limits | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [flashMsg, flash] = useFlash()
  const canWrite = hasPermission(PERM_CAP_WRITE)
  const canRead = hasPermission(PERM_CAP_READ)

  const load = useCallback(async () => {
    try {
      const data = await request<LimitsView>(`${ADMIN_API}/wasm-apps/limits`)
      setView(data)
      setForm(data.limits)
      setErr('')
    } catch (e: any) {
      setErr(e?.message || '读取平台限制项失败')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** 编辑期估算：与后端 applimits.Budget 同一公式（三个常量由服务端下发）。 */
  const preview = useMemo(() => {
    if (!view || !form) return null
    const instances = form.max_instances * form.instance_memory_mb * (1 << 20)
    const cache = form.module_cache_mb * (1 << 20)
    const total = instances + view.budget.compile_peak_bytes + view.budget.upload_peak_bytes + cache
    const limit = Math.floor((view.budget.available_bytes * view.guard_percent) / 100)
    return {
      instances, cache, total, limit,
      ok: view.budget.available_bytes <= 0 || total <= limit,
      available: view.budget.available_bytes,
    }
  }, [view, form])

  const dirty = useMemo(() => {
    if (!view || !form) return false
    return (Object.keys(form) as FieldKey[]).some((k) => form[k] !== view.limits[k])
  }, [view, form])

  const patch = (key: FieldKey, raw: string) => {
    const n = Number.parseInt(raw, 10)
    setForm((f) => (f ? { ...f, [key]: Number.isFinite(n) ? n : 0 } : f))
  }

  const save = async () => {
    if (!form || busy) return
    setBusy(true); setErr('')
    try {
      const data = await request<LimitsView>(`${ADMIN_API}/wasm-apps/limits`, {
        method: 'PUT',
        body: JSON.stringify({ limits: form }),
      })
      setView(data); setForm(data.limits)
      const pending = data.restart_pending ?? []
      // PUT 的应答本身就是保存后的完整视图（含 restart_pending）——不再补一次 GET，
      // 否则会把"刚保存的提示"冲掉，也多一次无谓往返。
      flash(pending.length > 0
        ? `已保存。需重启服务端才生效：${pending.join('、')}`
        : '已保存并即时生效')
    } catch (e: any) {
      setErr(e?.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const data = await request<LimitsView>(`${ADMIN_API}/wasm-apps/limits`, {
        method: 'PUT',
        body: JSON.stringify({ limits: null }),
      })
      setView(data); setForm(data.limits)
      flash('已清空控制台设置，回到部署档位/默认值')
    } catch (e: any) {
      setErr(e?.message || '清空失败')
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return <div className="p-6 text-sm text-muted-foreground">没有查看应用平台的权限（需要能力中心读取权限）。</div>
  }

  if (!view || !form || !preview) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const groups: ('并发' | '内存')[] = ['并发', '内存']

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title="应用平台"
        desc="员工自建 WASM 应用的并发与内存限制。改动即时下发（单实例内存上限需重启），保存时会按可用内存做四笔账自检。"
      />
      {flashMsg && (
        <div data-testid="limits-flash" className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{flashMsg}</div>
      )}
      {err && (
        <div data-testid="limits-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">当前配置</CardTitle>
            <CardDescription>
              来源：
              {view.source === 'setting' ? '控制台保存' : view.source === 'profile' ? '部署档位（环境变量）' : '默认值'}
              （{view.setting_key}）
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {(view.restart_pending ?? []).length > 0 && (
              <Badge variant="destructive" data-testid="restart-pending">
                待重启：{view.restart_pending.join('、')}
              </Badge>
            )}
            <Badge variant={preview.ok ? 'secondary' : 'destructive'} data-testid="budget-badge">
              {preview.ok ? '内存水位正常' : '超出可用内存水位'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {Object.entries(view.presets).map(([name, preset]) => (
              <Button key={name} variant="outline" size="sm" disabled={!canWrite} onClick={() => setForm(preset)}>
                套用{name === 'small' ? '小内存' : name === 'large' ? '大内存' : '默认'}档
              </Button>
            ))}
          </div>
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-muted-foreground">实例池（并发 × 单实例上限）</div>
              <div className="font-medium">{mb(preview.instances)} MiB</div>
            </div>
            <div>
              <div className="text-muted-foreground">编译峰值（固定）</div>
              <div className="font-medium">{mb(view.budget.compile_peak_bytes)} MiB</div>
            </div>
            <div>
              <div className="text-muted-foreground">上传峰值（固定）</div>
              <div className="font-medium">{mb(view.budget.upload_peak_bytes)} MiB</div>
            </div>
            <div>
              <div className="text-muted-foreground">模块缓存驻留</div>
              <div className="font-medium">{mb(preview.cache)} MiB</div>
            </div>
          </div>
          <div className={`rounded-md border px-3 py-2 text-sm ${preview.ok ? 'border-border' : 'border-destructive/40 bg-destructive/10 text-destructive'}`} data-testid="budget-line">
            理论峰值 <span className="font-semibold">{mb(preview.total)} MiB</span>
            {' / '}可用 {mb(preview.available)} MiB 的 {view.guard_percent}% = {mb(preview.limit)} MiB
            {preview.ok ? '：可以保存' : '：超出水位，保存会被拒绝（请调小并发/实例内存/模块缓存）'}
          </div>
        </CardContent>
      </Card>

      {groups.map((g) => (
        <Card key={g}>
          <CardHeader>
            <CardTitle className="text-base">{g}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {FIELDS.filter((f) => f.group === g).map((f) => {
              const r = view.ranges[f.key]
              return (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`lim-${f.key}`} className="flex items-center gap-2">
                    {f.label}
                    {r?.restart && <Badge variant="outline" className="text-[10px]">需重启</Badge>}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`lim-${f.key}`}
                      data-testid={`lim-${f.key}`}
                      type="number"
                      min={r?.min}
                      max={r?.max}
                      value={String(form[f.key])}
                      disabled={!canWrite}
                      onChange={(e) => patch(f.key, e.target.value)}
                    />
                    <span className="w-12 shrink-0 text-xs text-muted-foreground">{r?.unit}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {f.hint}
                    {r && `（${r.min}–${r.max}）`}
                  </p>
                </div>
              )
            })}
          </CardContent>
        </Card>
      ))}

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={!canWrite || busy || !dirty} data-testid="save-limits">
          <Save className="mr-1 h-4 w-4" />保存并生效
        </Button>
        <Button variant="outline" onClick={reset} disabled={!canWrite || busy} data-testid="reset-limits">
          <RotateCcw className="mr-1 h-4 w-4" />恢复默认/档位
        </Button>
        {!canWrite && (
          <span className="text-xs text-muted-foreground">
            <AlertTriangle className="mr-1 inline h-3 w-3" />当前账号只读（需要能力中心写入权限）
          </span>
        )}
      </div>
    </div>
  )
}
