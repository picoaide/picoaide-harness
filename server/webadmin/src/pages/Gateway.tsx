import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Switch } from '../components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Badge } from '../components/ui/badge'
import { Skeleton } from '../components/ui/skeleton'
import { PageHeader } from '../components/page-header'
import { SecretInput } from '../components/secret-input'
import { Lock } from 'lucide-react'
import { isModelPriced } from '../lib/format'

interface Provider {
  id: number
  name: string
  base_url: string
  api_key: string
  models: string[]
  enabled: boolean
  channel: string
  protocol: string // 0043: openai(默认 chat/embeddings) | anthropic(/v1/messages)
}

interface Channel {
  name: string
  base_url: string
}

interface Model {
  id: number
  name: string
  provider_id?: number
  display_name: string
  default_params: string
  // 0058:模型接受的输入模态('text'/'image');客户端据此渲染图片支持
  input_modalities?: string[]
  input_price_per_1m?: number | null // 0022:元/百万 token,nil = 未定价
  output_price_per_1m?: number | null
  cache_input_price_per_1m?: number | null // 0029:缓存命中输入价(元/百万 token),nil = 未配置
  offpeak_discount?: number | null // 0023:0<d<1 低谷折扣;nil/1 = 无峰谷价
  provider_name?: string // 审计修复 M3:上游名(管理端展示全部模型)
  provider_channel?: string
  provider_enabled?: boolean
}

// 手动型渠道占位值:Radix Select 不允许空串 value
const MANUAL_CHANNEL = '__manual__'

// 高峰时段结构化编辑(审计修复 M4):时间段行列表替代手填 JSON
// weekdays: 适用星期(1=周一…7=周日);空 = 每天(兼容旧数据)。
interface PeakWindowRow {
  /** 行稳定 id(审计 2026-08-25 B2):替换 index key,防删除中间行时 DOM/焦点错位。 */
  keyId: string
  start: string
  end: string
  weekdays: number[]
}

// WEEKDAY_LABELS:星期选择器的显示标签(周一…周日)。
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

// ALL_WEEKDAYS:全部 7 天(旧数据缺省 = 每天)。
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]

function parsePeakWindows(s: string): PeakWindowRow[] {
  try {
    const arr = JSON.parse(s)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((w: any) => w && typeof w.start === 'string' && typeof w.end === 'string')
      .map((w: any) => ({
        keyId: `pk-${crypto.randomUUID()}`,
        start: w.start,
        end: w.end,
        weekdays: Array.isArray(w.weekdays) && w.weekdays.length > 0
          ? w.weekdays.filter((d: any) => Number.isInteger(d) && d >= 1 && d <= 7)
          : ALL_WEEKDAYS,
      }))
  } catch {
    return []
  }
}

function formatCaps(defaultParams: string): string {
  try {
    const p = JSON.parse(defaultParams)
    const fmt = (n?: number) => {
      if (!n) return ''
      if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}M`
      if (n % 1024 === 0) return `${n / 1024}K`
      return `${Math.round(n / 1024)}K`
    }
    const cl = fmt(p.context_length)
    const mo = fmt(p.max_output)
    if (cl && mo) return `${cl} / ${mo}`
    return cl || mo || '-'
  } catch {
    return '-'
  }
}

// http(s) URL 校验(审计修复 L3):base_url/server_base_url 前置拦截
function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// 密码/密钥输入(审计修复 P3-4):显隐切换按钮,复用 Input 样式;密码管理工具与粘贴不受影响
// 已在 components/secret-input.tsx 提取为共享组件(Gateway 与 Auth 页共用)。
// 删除本地实现,使用共享导入。

export default function Gateway() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [cfg, setCfg] = useState({ default_model: '', rate_limit: '60', peak_windows: '', retention_months: '6', default_thinking_level: 'max', server_base_url: '' })
  const [peakList, setPeakList] = useState<PeakWindowRow[]>([])
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [syncMsg, setSyncMsg] = useState('')
  const [loading, setLoading] = useState(true) // 审计修复 L2
  // P1-6: 提交中操作标识(双击守卫 + 按钮禁用/loading)。null = 空闲,值为操作 key。
  const [busy, setBusy] = useState<string | null>(null)

  const [provDialog, setProvDialog] = useState(false)
  const [provForm, setProvForm] = useState({ name: '', channel: '', base_url: '', api_key: '', models: '', protocol: '' })
  // 对话框内联错误(UX 改进):操作失败信息必须显示在用户操作处,而非页面顶部
  const [provErr, setProvErr] = useState('')
  const [editProvErr, setEditProvErr] = useState('')
  const [modelErr, setModelErr] = useState('')
  const [priceErr, setPriceErr] = useState('')
  const [modelDialog, setModelDialog] = useState(false)
  const [modelForm, setModelForm] = useState({ name: '', provider_id: '', display_name: '', input_modalities: 'text', input_price_per_1m: '', output_price_per_1m: '', cache_input_price_per_1m: '', offpeak_discount: '' })
  // 上游编辑(审计修复 M3):复用创建字段 + enabled 开关
  const [editProv, setEditProv] = useState<Provider | null>(null)
  const [editProvForm, setEditProvForm] = useState({ name: '', channel: '', base_url: '', api_key: '', models: '', enabled: true, protocol: '' })

  const load = useCallback(async () => {
    try {
      const [p, m, g, ch] = await Promise.all([
        request(`${ADMIN_API}/providers`),
        request(`${ADMIN_API}/models`),
        request(`${ADMIN_API}/gateway`),
        request(`${ADMIN_API}/channels`),
      ])
      setProviders(p.providers ?? [])
      setModels(m.models ?? [])
      setCfg(g)
      setPeakList(parsePeakWindows(g.peak_windows ?? ''))
      setCfg(cfg => ({ ...cfg, retention_months: g.retention_months ?? '6' }))
      setChannels(ch.channels ?? [])
      setError('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function flash(msg: string) {
    setOkMsg(msg)
    setTimeout(() => setOkMsg(''), 2000)
  }

  async function saveGateway() {
    if (busy) return // P1-6: 双击守卫
    // 前端校验(审计修复 L3):限流/配额数值、URL 格式
    const rl = Number(cfg.rate_limit)
    if (!Number.isInteger(rl) || rl <= 0 || rl > 100000) {
      setError('每用户限流必须是正整数(1-100000)')
      return
    }
    // 全局默认配额已迁至「用量中心 → 配额与预算」页(2026-09 重构),
    // 网关页不再承载 monthly_quota/monthly_quota_money(避免双入口)。
    if (cfg.retention_months !== '') {
      const rm = Number(cfg.retention_months)
      if (!Number.isInteger(rm) || rm < 0 || rm > 120) { setError('明细保留必须 0-120 个月(0=永不删除)'); return }
    }
    if (cfg.server_base_url && !isHttpUrl(cfg.server_base_url)) { setError('对外访问地址必须是 http(s) URL'); return }
    if (peakList.some((w) => !w.start || !w.end || w.start >= w.end)) {
      setError('高峰时段每行的开始时间必须早于结束时间')
      return
    }
    setBusy('save-gateway')
    try {
      // 高峰时段由结构化列表序列化;空列表 = 清空(无峰谷价,审计修复 H1/M4)
      // 审计 2026-08-25 B2:线上只存业务字段,keyId 是纯 UI 稳定键,不落库。
      const peaked = peakList.map(({ keyId: _drop, ...fields }) => fields)
      const body = { ...cfg, peak_windows: peaked.length ? JSON.stringify(peaked) : '' }
      await request(`${ADMIN_API}/gateway`, { method: 'PUT', body: JSON.stringify(body) })
      setError('')
      flash('已保存')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function createProvider() {
    if (busy) return // P1-6: 双击守卫
    setProvErr('')
    // 前端校验(审计修复 L3/L4):名称/URL 必填、渠道型 key 必填
    if (!provForm.name.trim()) { setProvErr('请填写上游名称'); return }
    if (!isHttpUrl(provForm.base_url)) { setProvErr('Base URL 必须是 http(s) URL'); return }
    if (provForm.channel && !provForm.api_key) { setProvErr('渠道型上游必须填写 API Key'); return }
    setBusy('create-provider')
    try {
      const r = await request(`${ADMIN_API}/providers`, {
        method: 'POST',
        body: JSON.stringify({
          name: provForm.name.trim(),
          channel: provForm.channel,
          base_url: provForm.base_url,
          api_key: provForm.api_key,
          models: provForm.models.split(',').map((s) => s.trim()).filter(Boolean),
          protocol: provForm.protocol || 'openai',
        }),
      })
      const sync = r.sync
      setError('')
      if (sync?.error) {
        setSyncMsg(`已保存,但模型同步失败:${sync.error}(可稍后点"立即同步"重试)`)
        setTimeout(() => setSyncMsg(''), 4000)
      } else if (sync && sync.added > 0) {
        flash(`已上架 ${sync.added} 个模型(移除 ${sync.removed ?? 0})`)
      } else if (sync) {
        flash('已保存,上游未返回新模型')
      } else {
        flash('已保存')
      }
      setProvDialog(false)
      setProvForm({ name: '', channel: '', base_url: '', api_key: '', models: '', protocol: '' })
      load()
    } catch (err: any) {
      setProvErr(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function saveProviderEdit() {
    if (busy || !editProv) return // P1-6: 双击守卫
    setEditProvErr('')
    if (!editProvForm.name.trim()) { setEditProvErr('请填写上游名称'); return }
    if (!isHttpUrl(editProvForm.base_url)) { setEditProvErr('Base URL 必须是 http(s) URL'); return }
    // 编辑时 API Key 留空 = 不更换;仅当上游原本无 key 且选了渠道时才强制
    if (editProvForm.channel && editProvForm.api_key.trim() === '' && (!editProv.api_key || editProv.api_key === '')) {
      setEditProvErr('渠道型上游必须填写 API Key')
      return
    }
    setBusy('save-provider-edit')
    try {
      const body: Record<string, any> = {
        name: editProvForm.name.trim(),
        channel: editProvForm.channel,
        base_url: editProvForm.base_url,
        enabled: editProvForm.enabled,
        protocol: editProvForm.protocol || 'openai',
      }
      // 密钥留空 = 不更换;模型清单渠道型不提交(服务端切渠道时自动清空手动清单)
      if (editProvForm.api_key.trim() !== '') body.api_key = editProvForm.api_key
      if (!editProvForm.channel && editProvForm.models.trim() !== '') {
        body.models = editProvForm.models.split(',').map((s) => s.trim()).filter(Boolean)
      }
      await request(`${ADMIN_API}/providers/${editProv.id}`, { method: 'PUT', body: JSON.stringify(body) })
      setEditProv(null)
      setError('')
      flash('已保存')
      load()
    } catch (err: any) {
      setEditProvErr(err.message)
    } finally {
      setBusy(null)
    }
  }

  // 审计修复 2026-P: 价格/折扣前端合法性校验(服务端有兜底,但前端提前
  // 拦截避免把 NaN/越界值提交):价格非负有限;折扣必须 0<d<1。
  function validatePriceField(label: string, raw: string, isDiscount = false): string | null {
    if (raw.trim() === '') return null // 留空 = 不覆盖/未定价
    const n = Number(raw)
    if (!Number.isFinite(n)) return `${label}必须是有效数字`
    if (n < 0) return `${label}不能为负数`
    if (isDiscount && (n <= 0 || n >= 1)) return `${label}必须在 (0,1) 之间`
    return null
  }

  async function createModel() {
    if (busy) return // P1-6: 双击守卫
    setModelErr('')
    // 未选上游直接提示(审计2026-W10),不把 provider_id=0 提交给服务端
    if (!modelForm.provider_id) {
      setModelErr('请选择所属上游')
      return
    }
    // 价格/折扣前置校验(审计修复 2026-P)
    const priceErr =
      validatePriceField('输入价格', modelForm.input_price_per_1m) ??
      validatePriceField('输出价格', modelForm.output_price_per_1m) ??
      validatePriceField('缓存命中输入价', modelForm.cache_input_price_per_1m) ??
      validatePriceField('低谷折扣率', modelForm.offpeak_discount, true)
    if (priceErr) { setModelErr(priceErr); return }
    setBusy('create-model')
    try {
      const body: Record<string, any> = {
        name: modelForm.name,
        provider_id: Number(modelForm.provider_id),
        display_name: modelForm.display_name,
        // 0058:输入模态(仅文本 / 文本+图片)。模型不上传图片时无需勾选图片。
        input_modalities: modelForm.input_modalities === 'image' ? ['text', 'image'] : ['text'],
      }
      // 价格留空 = 未定价(NULL);输入 0 = 定价 0(等价未定价);正数 = 元/百万 token
      if (modelForm.input_price_per_1m.trim() !== '') body.input_price_per_1m = Number(modelForm.input_price_per_1m)
      if (modelForm.output_price_per_1m.trim() !== '') body.output_price_per_1m = Number(modelForm.output_price_per_1m)
      // 缓存命中输入价(0029):留空 = 未配置;输入 0 = 清空(未配置)
      if (modelForm.cache_input_price_per_1m.trim() !== '') body.cache_input_price_per_1m = Number(modelForm.cache_input_price_per_1m)
      // 低谷折扣(0023):留空 = 无峰谷价;0<d<1 = 低谷窗口内 ×d
      if (modelForm.offpeak_discount.trim() !== '') body.offpeak_discount = Number(modelForm.offpeak_discount)
      await request(`${ADMIN_API}/models`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setModelDialog(false)
      setModelForm({ name: '', provider_id: '', display_name: '', input_modalities: 'text', input_price_per_1m: '', output_price_per_1m: '', cache_input_price_per_1m: '', offpeak_discount: '' })
      setError('')
      load()
    } catch (err: any) {
      setModelErr(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function deleteProvider(id: number) {
    if (busy) return // P1-6: 双击守卫
    if (!window.confirm('删除该上游?其模型将一并删除')) return
    setBusy(`del-provider-${id}`)
    try {
      await request(`${ADMIN_API}/providers/${id}`, { method: 'DELETE' })
      setError('')
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function deleteModel(m: Model) {
    if (busy) return // P1-6: 双击守卫
    // 审计修复 H2:渠道同步模型删除后不会随同步复活(服务端记入排除名单)
    const hint = m.provider_channel
      ? '该模型由上游同步;删除后同步不会自动恢复,如需恢复请重新添加。'
      : '客户端建议清单将移除。'
    if (!window.confirm(`删除该模型?${hint}`)) return
    setBusy(`del-model-${m.id}`)
    try {
      await request(`${ADMIN_API}/models/${m.id}`, { method: 'DELETE' })
      setError('')
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  // 模型编辑:价格补录/修改(0022 金额计费前提 + 0023 峰谷折扣)与输入模态(0058);
  // 其余字段留空不覆盖
  const [editModel, setEditModel] = useState<Model | null>(null)
  // G1/G2: 模型编辑(价格 + 显示名/所属上游/default_params 结构化)。
  function parseDefaultParams(raw: string): { contextLength: string; maxOutput: string; concurrencyTarget: string } {
    try {
      const p = JSON.parse(raw) as Record<string, unknown>
      return {
        contextLength: typeof p.context_length === 'number' && p.context_length > 0 ? String(p.context_length) : '',
        maxOutput: typeof p.max_output === 'number' && p.max_output > 0 ? String(p.max_output) : '',
        concurrencyTarget: typeof p.concurrency_target === 'number' && p.concurrency_target > 0 ? String(p.concurrency_target) : '',
      }
    } catch {
      return { contextLength: '', maxOutput: '', concurrencyTarget: '' }
    }
  }
  const [editModelForm, setEditModelForm] = useState({
    input: '', output: '', cache: '', offpeak: '', modalities: 'text',
    displayName: '', providerId: '', contextLength: '', maxOutput: '', concurrencyTarget: '',
    originalDefaultParams: '{}',
  })
  function openModelPricing(m: Model) {
    setEditModel(m)
    const dp = parseDefaultParams(m.default_params)
    setEditModelForm({
      input: m.input_price_per_1m === null || m.input_price_per_1m === undefined ? '' : String(m.input_price_per_1m),
      output: m.output_price_per_1m === null || m.output_price_per_1m === undefined ? '' : String(m.output_price_per_1m),
      cache: m.cache_input_price_per_1m === null || m.cache_input_price_per_1m === undefined ? '' : String(m.cache_input_price_per_1m),
      offpeak: m.offpeak_discount === null || m.offpeak_discount === undefined ? '' : String(m.offpeak_discount),
      modalities: m.input_modalities?.includes('image') ? 'image' : 'text',
      displayName: m.display_name,
      providerId: m.provider_id !== undefined && m.provider_id > 0 ? String(m.provider_id) : '',
      ...dp,
      originalDefaultParams: m.default_params || '{}',
    })
  }
  async function saveModelPricing() {
    if (busy || !editModel) return // P1-6: 双击守卫
    setPriceErr('')
    // 价格/折扣前置校验(审计修复 2026-P,与 createModel 同一函数)
    const priceErr =
      validatePriceField('输入价格', editModelForm.input) ??
      validatePriceField('输出价格', editModelForm.output) ??
      validatePriceField('缓存命中输入价', editModelForm.cache) ??
      validatePriceField('低谷折扣率', editModelForm.offpeak, true)
    if (priceErr) { setPriceErr(priceErr); return }
    // G1/G2: default_params 结构化字段数值校验
    for (const [label, value] of [
      ['上下文窗口', editModelForm.contextLength],
      ['最大输出', editModelForm.maxOutput],
      ['并发目标', editModelForm.concurrencyTarget],
    ] as const) {
      if (value.trim() !== '' && (!Number.isInteger(Number(value)) || Number(value) <= 0)) {
        setPriceErr(`${label} 必须是正整数`)
        return
      }
    }
    setBusy('save-model-pricing')
    try {
      const body: Record<string, any> = { name: editModel.name }
      // 留空 = 保持现值(服务端对缺省字段不覆盖);输入 0 = 定价 0(计费为 0)
      if (editModelForm.input.trim() !== '') body.input_price_per_1m = Number(editModelForm.input)
      if (editModelForm.output.trim() !== '') body.output_price_per_1m = Number(editModelForm.output)
      if (editModelForm.cache.trim() !== '') body.cache_input_price_per_1m = Number(editModelForm.cache)
      if (editModelForm.offpeak.trim() !== '') body.offpeak_discount = Number(editModelForm.offpeak)
      // 输入模态:仅两项选择,显式随保存提交(服务端校验后写入)
      body.input_modalities = editModelForm.modalities === 'image' ? ['text', 'image'] : ['text']
      // G1: 显示名/所属上游(服务端: display_name 非空覆盖; provider_id>0 覆盖)
      if (editModelForm.displayName.trim() !== '') body.display_name = editModelForm.displayName.trim()
      if (editModelForm.providerId !== '') body.provider_id = Number(editModelForm.providerId)
      // G2: default_params 仅当结构字段有改动时提交(JSON 合并保留其它键)
      const dp = parseDefaultParams(editModelForm.originalDefaultParams)
      const changed = dp.contextLength !== editModelForm.contextLength.trim()
        || dp.maxOutput !== editModelForm.maxOutput.trim()
        || dp.concurrencyTarget !== editModelForm.concurrencyTarget.trim()
      if (changed) {
        let merged: Record<string, unknown>
        try {
          merged = JSON.parse(editModelForm.originalDefaultParams) as Record<string, unknown>
        } catch {
          merged = {}
        }
        const num = (v: string): number | undefined =>
          v.trim() === '' ? undefined : Number(v.trim())
        const next: Record<string, unknown> = { ...merged }
        const cl = num(editModelForm.contextLength)
        const mo = num(editModelForm.maxOutput)
        const ct = num(editModelForm.concurrencyTarget)
        if (cl === undefined) delete next.context_length; else next.context_length = cl
        if (mo === undefined) delete next.max_output; else next.max_output = mo
        if (ct === undefined) delete next.concurrency_target; else next.concurrency_target = ct
        body.default_params = JSON.stringify(next)
      }
      await request(`${ADMIN_API}/models/${editModel.id}`, { method: 'PUT', body: JSON.stringify(body) })
      setEditModel(null)
      setError('')
      load()
    } catch (err: any) {
      setPriceErr(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function syncAll() {
    if (busy) return // P1-6: 双击守卫
    setBusy('sync-all')
    try {
      const r = await request(`${ADMIN_API}/providers/sync-all`, { method: 'POST' })
      const results: { provider: string; added: number; removed: number; skipped?: boolean; error?: string }[] = r.results ?? []
      // 审计修复 L5/L8:手动型上游折叠为一行汇总,不再逐条当错误展示
      const skipped = results.filter((x) => x.skipped).length
      const active = results.filter((x) => !x.skipped)
      const parts: string[] = []
      const summary = active
        .map((x) => (x.error ? `${x.provider}: ${x.error}` : `${x.provider}: +${x.added}/-${x.removed}`))
        .filter(Boolean)
      if (summary.length) parts.push(summary.join('; '))
      if (skipped > 0) parts.push(`${skipped} 个手动型上游跳过`)
      setSyncMsg(parts.join('; ') || '同步完成,无变化')
      setTimeout(() => setSyncMsg(''), 4000)
      setError('')
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  function openProviderEdit(p: Provider) {
    setEditProv(p)
    setEditProvForm({
      name: p.name,
      channel: p.channel,
      base_url: p.base_url,
      api_key: '',
      models: p.models.join(', '),
      enabled: p.enabled,
      protocol: p.protocol || 'openai',
    })
  }

  async function toggleProviderEnabled(p: Provider, enabled: boolean) {
    if (busy) return // P1-6: 双击守卫(Switch 无按钮态,handler 层防连点)
    setBusy(`toggle-${p.id}`)
    try {
      await request(`${ADMIN_API}/providers/${p.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
      setError('')
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const addPeak = () => setPeakList((l) => [...l, { keyId: `pk-${crypto.randomUUID()}`, start: '09:00', end: '12:00', weekdays: [1, 2, 3, 4, 5] }])
  const removePeak = (i: number) => setPeakList((l) => l.filter((_, idx) => idx !== i)) // keyId 保证 DOM 稳定,index 仅定位数据
  // DeepSeek 官方当前政策(2026-08 起):高峰 = 北京时间周一至周五 09:00-12:00、14:00-18:00。
  const presetPeak = () => setPeakList([
    { keyId: `pk-${crypto.randomUUID()}`, start: '09:00', end: '12:00', weekdays: [1, 2, 3, 4, 5] },
    { keyId: `pk-${crypto.randomUUID()}`, start: '14:00', end: '18:00', weekdays: [1, 2, 3, 4, 5] },
  ])
  const updatePeak = (i: number, field: 'start' | 'end', v: string) =>
    setPeakList((l) => l.map((w, idx) => (idx === i ? { ...w, [field]: v } : w)))
  const togglePeakDay = (i: number, d: number) =>
    setPeakList((l) => l.map((w, idx) => (
      idx === i
        ? { ...w, weekdays: w.weekdays.includes(d) ? w.weekdays.filter((x) => x !== d) : [...w.weekdays, d].sort() }
        : w
    )))

  return (
    <div className="space-y-6">
      <PageHeader
        title="网关配置"
        desc="上游接入与模型管理、限流配额与峰谷计费、客户端默认配置"
      />
      {error && <div className="text-sm text-destructive">{error}</div>}
      {okMsg && <div className="text-sm text-green-600">{okMsg}</div>}
      {syncMsg && <div className="text-sm text-green-600">{syncMsg}</div>}

      {/* ① 上游 Provider */}
      <Card>
        <CardHeader>
          <CardTitle>上游 Provider</CardTitle>
          <CardDescription>LLM 上游密钥只存服务端(AES-GCM 加密);协议「共用(both)」时搜索与对话共用同一 key</CardDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setProvDialog(true)}>添加上游</Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>渠道</TableHead>
                <TableHead>协议</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>API Key</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>启用</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={8}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
              ) : providers.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">暂无上游,点击「添加上游」开始接入</TableCell></TableRow>
              ) : providers.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.enabled ? 'bg-green-500' : 'bg-slate-300'}`} />
                      <span className="font-medium">{p.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>{p.channel ? <Badge variant="secondary">{p.channel}</Badge> : '—'}</TableCell>
                  <TableCell>{p.protocol === 'anthropic' ? <Badge variant="outline">Anthropic</Badge> : p.protocol === 'both' ? <Badge variant="secondary">共用</Badge> : <Badge variant="secondary">OpenAI</Badge>}</TableCell>
                  <TableCell className="max-w-56 truncate font-mono text-xs">{p.base_url}</TableCell>
                  <TableCell>
                    {p.api_key ? (
                      p.api_key === '***' ? (
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                          <Lock className="h-3 w-3" />••••••••••{(p.channel ? ' (AES)' : '')}
                        </span>
                      ) : (
                        // G11: 任何非掩码值都不明文渲染——密钥只透传(编辑框留空不更换)
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                          <Lock className="h-3 w-3" />••••••••••••••••(已配置)
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-amber-600">未设置</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.channel ? <span className="text-xs text-muted-foreground">自动同步</span> : p.models.join(', ')}
                  </TableCell>
                  <TableCell>
                    <Switch checked={p.enabled} onCheckedChange={(v) => toggleProviderEnabled(p, v)} aria-label={`启用 ${p.name}`} />
                  </TableCell>
                  <TableCell className="text-right space-x-2">
                    <Button size="sm" variant="outline" onClick={() => openProviderEdit(p)}>编辑</Button>
                    <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => deleteProvider(p.id)}>{busy === `del-provider-${p.id}` ? '删除中…' : '删除'}</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型管理</CardTitle>
          <CardDescription>对客户端可见的模型列表(含已停用上游的模型,停用后客户端不可见)</CardDescription>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={syncAll}>{busy === 'sync-all' ? '同步中…' : '立即同步'}</Button>
            <Button size="sm" onClick={() => setModelDialog(true)}>新增模型</Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型名</TableHead>
                <TableHead>显示名</TableHead>
                <TableHead>上游</TableHead>
                <TableHead>能力</TableHead>
                <TableHead>计费(元/百万 token)</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={6}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
              ) : models.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无模型,添加手动型上游或点击「立即同步」</TableCell></TableRow>
              ) : models.map((m) => {
                const priced = isModelPriced(m) // 审计修复 M6:输入价>0 或 输出价>0 即已定价
                const offpeak = m.offpeak_discount !== null && m.offpeak_discount !== undefined && m.offpeak_discount > 0 && m.offpeak_discount < 1
                return (
                  <TableRow key={m.id}>
                    <TableCell className="font-mono">
                      {m.name}
                      {m.input_modalities?.includes('image') && (
                        <Badge variant="secondary" className="ml-1 text-[10px]">图片</Badge>
                      )}
                    </TableCell>
                    <TableCell>{m.display_name}</TableCell>
                    <TableCell>
                      <span className="text-xs">{m.provider_name || '—'}</span>
                      {m.provider_enabled === false && (
                        <Badge variant="outline" className="ml-1 text-[10px] text-muted-foreground">停用</Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{formatCaps(m.default_params)}</TableCell>
                    <TableCell>
                      {priced ? (
                        <span className="font-mono text-xs">
                          入 {m.input_price_per_1m} / 出 {m.output_price_per_1m}
                          {m.cache_input_price_per_1m !== null && m.cache_input_price_per_1m !== undefined && m.cache_input_price_per_1m > 0 && (
                            <span className="text-emerald-600"> · 缓存 {m.cache_input_price_per_1m}</span>
                          )}
                          {offpeak && <span className="text-amber-600"> · 谷 {Number(m.offpeak_discount) * 10}折</span>}
                        </span>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">未定价</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button size="sm" variant="outline" title="编辑显示名/上游/参数/模态/价格" onClick={() => openModelPricing(m)}>配置</Button>
                      <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => deleteModel(m)}>{busy === `del-model-${m.id}` ? '删除中…' : '删除'}</Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ③ 全局设置(分组) */}
      <Card>
        <CardHeader>
          <CardTitle>全局设置</CardTitle>
          <CardDescription>随客户端启动配置下发,员工登录后自动应用</CardDescription>
          <div className="flex justify-end">
            <Button onClick={saveGateway} disabled={busy !== null}>{busy === 'save-gateway' ? '处理中…' : '保存'}</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 客户端默认 */}
          <section className="space-y-1">
            <h3 className="text-sm font-medium text-muted-foreground">客户端默认</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="default-model">默认模型</Label>
                <Select value={cfg.default_model} onValueChange={(v) => setCfg({ ...cfg, default_model: v })}>
                  <SelectTrigger id="default-model"><SelectValue placeholder="选择默认模型" /></SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.name}>{m.display_name || m.name} ({m.name})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">员工登录后的默认聊天模型</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="default-thinking-level">默认思考强度</Label>
                <Select value={cfg.default_thinking_level} onValueChange={(v) => setCfg({ ...cfg, default_thinking_level: v })}>
                  <SelectTrigger id="default-thinking-level"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="max">max(最大思考)</SelectItem>
                    <SelectItem value="high">high(高)</SelectItem>
                    <SelectItem value="low">low(低)</SelectItem>
                    <SelectItem value="off">off(关闭思考)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">登录后默认模型自动使用该强度;用户可在模型选择器单独调整</p>
              </div>
            </div>
          </section>

          {/* 网关防护 */}
          <section className="space-y-1">
            <h3 className="text-sm font-medium text-muted-foreground">网关防护</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="rate-limit">每用户网关限流(次/分钟)</Label>
                <Input id="rate-limit" type="number" min={1} max={100000} value={cfg.rate_limit}
                  onChange={(e) => setCfg({ ...cfg, rate_limit: e.target.value })} />
              </div>
            </div>
          </section>

          {/* 用量中心迁出:全局默认配额(monthly_quota/monthly_quota_money)已移入
              「用量中心 → 配额与预算」页(2026-09 重构);本页仅保留明细保留时长 */}
          <section className="space-y-1">
            <h3 className="text-sm font-medium text-muted-foreground">用量策略</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="usage-retention">调用明细保留时长(月)</Label>
                <Input id="usage-retention" type="number" min={0} max={120} value={cfg.retention_months}
                  onChange={(e) => setCfg({ ...cfg, retention_months: e.target.value })} />
                <p className="text-xs text-muted-foreground">0 = 永不删除;超出保留期的明细分区被自动清理;日账/月账统计永久保留</p>
              </div>
            </div>
          </section>

          {/* 计费(峰谷折扣) */}
          <section className="space-y-1">
            <h3 className="text-sm font-medium text-muted-foreground">计费（峰谷折扣）</h3>
            <div className="space-y-2">
              <Label>高峰时段(北京时间)</Label>
              {peakList.map((w, i) => (
                <div key={w.keyId} className="flex flex-wrap items-center gap-2">
                  <Input
                    type="time"
                    aria-label={`高峰开始 ${i + 1}`}
                    className="w-40 shrink-0"
                    value={w.start}
                    onChange={(e) => updatePeak(i, 'start', e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">至</span>
                  <Input
                    type="time"
                    aria-label={`高峰结束 ${i + 1}`}
                    className="w-40 shrink-0"
                    value={w.end}
                    onChange={(e) => updatePeak(i, 'end', e.target.value)}
                  />
                  {/* 星期多选:1=周一…7=周日;空 = 每天 */}
                  <div className="flex items-center gap-0.5" aria-label={`星期选择 ${i + 1}`}>
                    {WEEKDAY_LABELS.map((lbl, idx) => {
                      const d = idx + 1
                      const on = w.weekdays.includes(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          aria-label={`周${lbl}`}
                          onClick={() => togglePeakDay(i, d)}
                          className={`flex h-7 w-7 items-center justify-center rounded text-[11px] transition-colors ${on
                            ? 'bg-blue-600 font-semibold text-white'
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                        >
                          {lbl}
                        </button>
                      )
                    })}
                  </div>
                  <Button size="sm" variant="outline" type="button" className="ml-2 shrink-0" onClick={() => removePeak(i)}>移除</Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" type="button" onClick={addPeak}>添加时段</Button>
                <Button size="sm" variant="outline" type="button" onClick={presetPeak}>DeepSeek 当前政策(工作日)</Button>
                {peakList.length > 0 && (
                  <Button size="sm" variant="ghost" type="button" onClick={() => setPeakList([])}>清空(无峰谷价)</Button>
                )}
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>按北京时间判定,半开区间 [start,end);时段可勾选适用星期(周一…周日),未勾选 = 该天无峰谷。</li>
                <li>高峰窗口外(空闲时段)且模型配置了低谷折扣率时,费用按折扣率打折。</li>
                <li>清空 = 无峰谷价(全天标准价)。</li>
                <li>DeepSeek 官方当前政策(2026-08 起):高峰 = 北京时间<strong>周一至周五</strong> 09:00-12:00、14:00-18:00(其余为空闲,含周末),空闲价 = 高峰价 × 50%。</li>
              </ul>
            </div>
          </section>

          {/* Web 工具 */}
          <section className="space-y-1">
            <h3 className="text-sm font-medium text-muted-foreground">Web 工具</h3>
            <p className="text-xs text-muted-foreground">
              web_search / web_fetch 已随客户端默认启用（web_search 走网关 /v1/messages 服务端代理,web_fetch 由客户端直连抓取网页,支持内网访问）。无需额外配置。
            </p>
          </section>

          {/* 部署 */}
          <section className="space-y-1">
            <h3 className="text-sm font-medium text-muted-foreground">部署</h3>
            <div className="space-y-1">
              <Label htmlFor="server-base-url">对外访问地址 (Server Base URL)</Label>
              <Input id="server-base-url" type="url" placeholder="https://picoaide.example.com" value={cfg.server_base_url}
                onChange={(e) => setCfg({ ...cfg, server_base_url: e.target.value })} />
              <p className="text-xs text-muted-foreground">
                客户端登录与员工访问入口(经 Caddy HTTPS 反代后的地址);填写后管理页顶部展示;清空保存可移除
              </p>
            </div>
          </section>
        </CardContent>
      </Card>

      <Dialog open={provDialog} onOpenChange={(v) => { setProvDialog(v); if (!v) setProvErr('') }}>
        <DialogContent>
          <DialogHeader><DialogTitle>添加上游</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {provErr && <div className="text-sm text-destructive">{provErr}</div>}
            <div className="space-y-1">
              <Label>渠道</Label>
              <Select
                value={provForm.channel || MANUAL_CHANNEL}
                onValueChange={(v) => {
                  const ch = v === MANUAL_CHANNEL ? undefined : channels.find((c) => c.name === v)
                  setProvForm((prev) => ({
                    ...prev,
                    channel: ch ? ch.name : '',
                    // 渠道默认地址自动回填(未手填时)
                    base_url: prev.base_url === '' && ch ? ch.base_url : prev.base_url,
                  }))
                }}
              >
                <SelectTrigger><SelectValue placeholder="选择渠道" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={MANUAL_CHANNEL}>手动型(无渠道)</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                渠道型(如 deepseek):模型自动从上游同步,无需手填;手动型:模型来自下方列表
              </p>
            </div>
            <div className="space-y-1">
              <Label>协议</Label>
              <Select
                value={provForm.protocol || 'openai'}
                onValueChange={(v) => setProvForm({ ...provForm, protocol: v })}
              >
                <SelectTrigger><SelectValue placeholder="选择协议" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI 兼容(chat/completions、embeddings)</SelectItem>
                  <SelectItem value="anthropic">Anthropic 兼容(/v1/messages,web 搜索)</SelectItem>
                  <SelectItem value="both">共用(both:同一 key 双端点,chat+搜索)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Anthropic 协议上游供 web_search 走服务端代理使用(如 https://api.deepseek.com/anthropic/v1)
              </p>
            </div>
            <div className="space-y-1">
              <Label>名称(如 deepseek)</Label>
              <Input placeholder="如 deepseek" value={provForm.name} onChange={(e) => setProvForm({ ...provForm, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Base URL(渠道型留空自动使用渠道默认地址)</Label>
              <Input
                type="url"
                value={provForm.base_url}
                placeholder={provForm.channel ? channels.find((c) => c.name === provForm.channel)?.base_url ?? '' : 'https://api.example.com'}
                onChange={(e) => setProvForm({ ...provForm, base_url: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>API Key{provForm.channel ? '(必填)' : ''}</Label>
              <SecretInput placeholder="sk-..." value={provForm.api_key} onChange={(e) => setProvForm({ ...provForm, api_key: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>模型(逗号分隔,渠道型自动同步无需填写)</Label>
              <Input
                value={provForm.models}
                disabled={!!provForm.channel}
                placeholder={provForm.channel ? '保存后自动同步' : 'deepseek-chat, deepseek-reasoner'}
                onChange={(e) => setProvForm({ ...provForm, models: e.target.value })}
              />
            </div>
            <Button className="w-full" disabled={busy !== null} onClick={createProvider}>{busy === 'create-provider' ? '处理中…' : '添加'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 上游编辑(审计修复 M3) */}
      <Dialog open={!!editProv} onOpenChange={(open) => { if (!open) setEditProv(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>编辑上游 · {editProv?.name}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {editProvErr && <div className="text-sm text-destructive">{editProvErr}</div>}
            <div className="space-y-1">
              <Label>渠道</Label>
              <Select
                value={editProvForm.channel || MANUAL_CHANNEL}
                onValueChange={(v) => {
                  const ch = v === MANUAL_CHANNEL ? undefined : channels.find((c) => c.name === v)
                  setEditProvForm((prev) => ({
                    ...prev,
                    channel: ch ? ch.name : '',
                    base_url: ch && prev.base_url === '' ? ch.base_url : prev.base_url,
                  }))
                }}
              >
                <SelectTrigger><SelectValue placeholder="选择渠道" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={MANUAL_CHANNEL}>手动型(无渠道)</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                渠道型自动同步上游模型,手动模型清单将被清空;手动型可维护模型列表
              </p>
            </div>
            <div className="space-y-1">
              <Label>协议</Label>
              <Select
                value={editProvForm.protocol || 'openai'}
                onValueChange={(v) => setEditProvForm({ ...editProvForm, protocol: v })}
              >
                <SelectTrigger><SelectValue placeholder="选择协议" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI 兼容(chat/completions、embeddings)</SelectItem>
                  <SelectItem value="anthropic">Anthropic 兼容(/v1/messages,web 搜索)</SelectItem>
                  <SelectItem value="both">共用(both:同一 key 双端点,chat+搜索)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>名称</Label>
              <Input value={editProvForm.name} onChange={(e) => setEditProvForm({ ...editProvForm, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Base URL</Label>
              <Input type="url" value={editProvForm.base_url}
                placeholder={editProvForm.channel ? channels.find((c) => c.name === editProvForm.channel)?.base_url ?? '' : 'https://api.example.com'}
                onChange={(e) => setEditProvForm({ ...editProvForm, base_url: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>API Key(留空 = 不更换)</Label>
              <SecretInput placeholder="sk-..." value={editProvForm.api_key} onChange={(e) => setEditProvForm({ ...editProvForm, api_key: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>模型(逗号分隔,渠道型自动同步无需填写)</Label>
              <Input
                value={editProvForm.models}
                disabled={!!editProvForm.channel}
                placeholder={editProvForm.channel ? '保存后自动同步' : 'deepseek-chat, deepseek-reasoner'}
                onChange={(e) => setEditProvForm({ ...editProvForm, models: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={editProvForm.enabled} onCheckedChange={(v) => setEditProvForm({ ...editProvForm, enabled: v })} />
              <Label>启用该上游(停用后不参与模型路由,但模型仍可在本页管理)</Label>
            </div>
            <Button className="w-full" disabled={busy !== null} onClick={saveProviderEdit}>{busy === 'save-provider-edit' ? '处理中…' : '保存'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={modelDialog} onOpenChange={(v) => { setModelDialog(v); if (!v) setModelErr('') }}>
        <DialogContent>
          <DialogHeader><DialogTitle>新增模型</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {modelErr && <div className="text-sm text-destructive">{modelErr}</div>}
            <div className="space-y-1">
              <Label>模型名(如 deepseek-chat)</Label>
              <Input value={modelForm.name} onChange={(e) => setModelForm({ ...modelForm, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>显示名</Label>
              <Input value={modelForm.display_name} onChange={(e) => setModelForm({ ...modelForm, display_name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>所属上游</Label>
              <Select value={modelForm.provider_id} onValueChange={(v) => {
                const p = providers.find((x) => String(x.id) === v)
                setModelForm((prev) => ({
                  ...prev,
                  provider_id: v,
                  // deepseek 渠道预填官方错峰折扣 0.5(未手填时);其它渠道留空 = 无峰谷
                  offpeak_discount: prev.offpeak_discount === '' && p?.channel === 'deepseek' ? '0.5' : prev.offpeak_discount,
                }))
              }}>
                <SelectTrigger><SelectValue placeholder="选择上游" /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>输入模态(0058:客户端据此允许图片上传)</Label>
              <Select value={modelForm.input_modalities} onValueChange={(v) => setModelForm({ ...modelForm, input_modalities: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">仅文字</SelectItem>
                  <SelectItem value="image">文字 + 图片</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="model-price-in">输入价格(元/百万 token)</Label>
                <Input
                  id="model-price-in"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 未定价"
                  value={modelForm.input_price_per_1m}
                  onChange={(e) => setModelForm({ ...modelForm, input_price_per_1m: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="model-price-out">输出价格(元/百万 token)</Label>
                <Input
                  id="model-price-out"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 未定价"
                  value={modelForm.output_price_per_1m}
                  onChange={(e) => setModelForm({ ...modelForm, output_price_per_1m: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="model-price-cache">缓存命中输入价(元/百万 token)</Label>
                <Input
                  id="model-price-cache"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 未配置(按输入价计费)"
                  value={modelForm.cache_input_price_per_1m}
                  onChange={(e) => setModelForm({ ...modelForm, cache_input_price_per_1m: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">仅作定价展示;命中 token 仍按输入价计费。</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="model-offpeak">低谷折扣率(0-1,留空 = 无峰谷价)</Label>
                <Input
                  id="model-offpeak"
                  type="number"
                  min={0}
                  max={1}
                  step="0.05"
                  placeholder="DeepSeek 官方错峰五折 = 0.5"
                  value={modelForm.offpeak_discount}
                  onChange={(e) => setModelForm({ ...modelForm, offpeak_discount: e.target.value })}
                />
              </div>
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>配置价格后,用量页按 输入token×输入价 + 输出token×输出价 折算费用;未定价模型费用按 0 计。</li>
              <li>低谷折扣:配置「全局设置 → 高峰时段」后,高峰窗口外(空闲时段)费用 × 折扣率,高峰时段按标准价。</li>
              <li>DeepSeek 官方错峰五折(2026-08 起):高峰 = 北京**周一至周五** 09:00-12:00、14:00-18:00,空闲价 = 高峰价 × 50%。</li>
            </ul>
            <Button className="w-full" disabled={busy !== null} onClick={createModel}>{busy === 'create-model' ? '处理中…' : '新增'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 模型价格编辑(0022) */}
      <Dialog open={!!editModel} onOpenChange={(open) => { if (!open) setEditModel(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>模型编辑 · {editModel?.name}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {priceErr && <div className="text-sm text-destructive">{priceErr}</div>}
            {/* G1/G2: 显示名 / 所属上游 / default_params 结构化 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-display-name">显示名</Label>
                <Input
                  id="edit-display-name"
                  placeholder="留空 = 保持现值"
                  value={editModelForm.displayName}
                  onChange={(e) => setEditModelForm({ ...editModelForm, displayName: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>所属上游</Label>
                <Select value={editModelForm.providerId} onValueChange={(v) => setEditModelForm({ ...editModelForm, providerId: v })}>
                  <SelectTrigger><SelectValue placeholder="保持现值" /></SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-ctx">上下文窗口(token)</Label>
                <Input id="edit-ctx" type="number" min={1} placeholder="如 131072" value={editModelForm.contextLength}
                  onChange={(e) => setEditModelForm({ ...editModelForm, contextLength: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-max-out">最大输出 token 数</Label>
                <Input id="edit-max-out" type="number" min={1} placeholder="如 64000" value={editModelForm.maxOutput}
                  onChange={(e) => setEditModelForm({ ...editModelForm, maxOutput: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-conc">并发目标(参考)</Label>
                <Input id="edit-conc" type="number" min={1} placeholder="如 100" value={editModelForm.concurrencyTarget}
                  onChange={(e) => setEditModelForm({ ...editModelForm, concurrencyTarget: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-price-in">输入价格(元/百万 token)</Label>
                <Input
                  id="edit-price-in"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 保持现值"
                  value={editModelForm.input}
                  onChange={(e) => setEditModelForm({ ...editModelForm, input: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-price-out">输出价格(元/百万 token)</Label>
                <Input
                  id="edit-price-out"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 保持现值"
                  value={editModelForm.output}
                  onChange={(e) => setEditModelForm({ ...editModelForm, output: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-price-cache">缓存命中输入价(元/百万 token)</Label>
                <Input
                  id="edit-price-cache"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 保持现值"
                  value={editModelForm.cache}
                  onChange={(e) => setEditModelForm({ ...editModelForm, cache: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-offpeak">低谷折扣率(0-1,留空 = 保持现值;1 = 取消峰谷)</Label>
              <Input
                id="edit-offpeak"
                type="number"
                min={0}
                max={1}
                step="0.05"
                placeholder="DeepSeek 官方错峰五折 = 0.5"
                value={editModelForm.offpeak}
                onChange={(e) => setEditModelForm({ ...editModelForm, offpeak: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>输入模态(0058:客户端据此允许图片上传)</Label>
              <Select value={editModelForm.modalities} onValueChange={(v) => setEditModelForm({ ...editModelForm, modalities: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">仅文字</SelectItem>
                  <SelectItem value="image">文字 + 图片</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              修改价格/折扣只影响之后产生的用量费用(历史费用按记录时定价留存)。
              低谷折扣 = 高峰窗口外(空闲时段)费用 × 折扣率;需先在「全局设置」配置高峰时段。
              DeepSeek 官方:高峰 = 北京 09:00-12:00、14:00-18:00,空闲价 = 高峰价 × 50%。
            </p>
            <Button className="w-full" disabled={busy !== null} onClick={saveModelPricing}>{busy === 'save-model-pricing' ? '处理中…' : '保存'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
