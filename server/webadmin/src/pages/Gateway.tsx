import React, { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
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
import { Lock, Eye, EyeOff } from 'lucide-react'
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
  display_name: string
  default_params: string
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

// http(s) URL 校验(审计修复 L3):base_url/search_endpoint/server_base_url 前置拦截
function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// 密码/密钥输入(审计修复 P3-4):显隐切换按钮,复用 Input 样式;密码管理工具与粘贴不受影响
function SecretInput(props: React.ComponentProps<'input'>) {
  const [show, setShow] = React.useState(false)
  return (
    <div className="relative">
      <Input
        {...props}
        type={show ? 'text' : 'password'}
        className={`pr-9 ${props.className ?? ''}`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={show ? '隐藏' : '显示'}
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

export default function Gateway() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [cfg, setCfg] = useState({ default_model: '', rate_limit: '60', monthly_quota: '0', monthly_quota_money: '0', peak_windows: '', retention_months: '6', allow_private: false, search_endpoint: '', default_thinking_level: 'max', server_base_url: '' })
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
  const [modelForm, setModelForm] = useState({ name: '', provider_id: '', display_name: '', input_price_per_1m: '', output_price_per_1m: '', cache_input_price_per_1m: '', offpeak_discount: '' })
  // 上游编辑(审计修复 M3):复用创建字段 + enabled 开关
  const [editProv, setEditProv] = useState<Provider | null>(null)
  const [editProvForm, setEditProvForm] = useState({ name: '', channel: '', base_url: '', api_key: '', models: '', enabled: true, protocol: '' })

  // ---- 认证配置(LDAP/OIDC) ----
  const [authForm, setAuthForm] = useState({
    mode: 'local',
    ldap_server_url: '', ldap_bind_dn: '', ldap_bind_password: '', ldap_base_dn: '',
    ldap_user_filter: '', ldap_group_filter: '', ldap_group_attr: '',
    oidc_issuer: '', oidc_client_id: '', oidc_client_secret: '', oidc_redirect_url: '',
  })
  const [authErr, setAuthErr] = useState('')
  const [authMsg, setAuthMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const [p, m, g, ch, au] = await Promise.all([
        request('/api/admin/providers'),
        request('/api/admin/models'),
        request('/api/admin/gateway'),
        request('/api/admin/channels'),
        request('/api/admin/auth'),
      ])
      setProviders(p.providers ?? [])
      setModels(m.models ?? [])
      setCfg(g)
      setPeakList(parsePeakWindows(g.peak_windows ?? ''))
      setCfg(cfg => ({ ...cfg, retention_months: g.retention_months ?? '6' }))
      setChannels(ch.channels ?? [])
      // 认证配置回填(密码类为 "***" 掩码,保存时留空 = 不更换)
      const a = au.auth ?? {}
      const ldap = a.ldap ?? {}
      const oidc = a.oidc ?? {}
      setAuthForm({
        mode: a.mode || 'local',
        ldap_server_url: ldap.server_url ?? '', ldap_bind_dn: ldap.bind_dn ?? '',
        ldap_bind_password: ldap.bind_password ?? '', ldap_base_dn: ldap.base_dn ?? '',
        ldap_user_filter: ldap.user_filter ?? '', ldap_group_filter: ldap.group_filter ?? '',
        ldap_group_attr: ldap.group_attr ?? '',
        oidc_issuer: oidc.issuer ?? '', oidc_client_id: oidc.client_id ?? '',
        oidc_client_secret: oidc.client_secret ?? '', oidc_redirect_url: oidc.redirect_url ?? '',
      })
      setError('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 保存认证配置:*** / 空 = 保持现值(密码类字段留在掩码态)
  async function saveAuth() {
    if (busy) return
    setAuthErr('')
    if (authForm.mode === 'ldap' || authForm.mode === 'both') {
      if (!authForm.ldap_server_url.trim() || !authForm.ldap_base_dn.trim()) {
        setAuthErr('LDAP 模式必须填写服务器地址与 Base DN'); return
      }
    }
    if (authForm.mode === 'oidc') {
      if (!authForm.oidc_issuer.trim() || !authForm.oidc_client_id.trim() || !authForm.oidc_redirect_url.trim()) {
        setAuthErr('OIDC 模式必须填写 Issuer、Client ID 与 Redirect URL'); return
      }
    }
    setBusy('save-auth')
    try {
      await request('/api/admin/auth', {
        method: 'PUT',
        body: JSON.stringify({
          mode: authForm.mode,
          ldap: {
            server_url: authForm.ldap_server_url,
            bind_dn: authForm.ldap_bind_dn,
            bind_password: authForm.ldap_bind_password,
            base_dn: authForm.ldap_base_dn,
            user_filter: authForm.ldap_user_filter,
            group_filter: authForm.ldap_group_filter,
            group_attr: authForm.ldap_group_attr,
          },
          oidc: {
            issuer: authForm.oidc_issuer,
            client_id: authForm.oidc_client_id,
            client_secret: authForm.oidc_client_secret,
            redirect_url: authForm.oidc_redirect_url,
          },
        }),
      })
      setAuthMsg('认证配置已保存(重启服务端后生效)')
      setTimeout(() => setAuthMsg(''), 4000)
      load()
    } catch (err: any) {
      setAuthErr(err.message)
    } finally {
      setBusy(null)
    }
  }

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
    if (cfg.monthly_quota !== '') {
      const mq = Number(cfg.monthly_quota)
      if (!Number.isInteger(mq) || mq < 0) { setError('月 token 配额必须是非负整数'); return }
    }
    if (cfg.monthly_quota_money !== '') {
      const mm = Number(cfg.monthly_quota_money)
      if (Number.isNaN(mm) || mm < 0) { setError('月金额配额必须是非负数字'); return }
    }
    if (cfg.retention_months !== '') {
      const rm = Number(cfg.retention_months)
      if (!Number.isInteger(rm) || rm < 0 || rm > 120) { setError('明细保留必须 0-120 个月(0=永不删除)'); return }
    }
    if (cfg.search_endpoint && !isHttpUrl(cfg.search_endpoint)) { setError('web_search 端点必须是 http(s) URL'); return }
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
      await request('/api/admin/gateway', { method: 'PUT', body: JSON.stringify(body) })
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
      const r = await request('/api/admin/providers', {
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
      await request(`/api/admin/providers/${editProv.id}`, { method: 'PUT', body: JSON.stringify(body) })
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
      }
      // 价格留空 = 未定价(NULL);输入 0 = 定价 0(等价未定价);正数 = 元/百万 token
      if (modelForm.input_price_per_1m.trim() !== '') body.input_price_per_1m = Number(modelForm.input_price_per_1m)
      if (modelForm.output_price_per_1m.trim() !== '') body.output_price_per_1m = Number(modelForm.output_price_per_1m)
      // 缓存命中输入价(0029):留空 = 未配置;输入 0 = 清空(未配置)
      if (modelForm.cache_input_price_per_1m.trim() !== '') body.cache_input_price_per_1m = Number(modelForm.cache_input_price_per_1m)
      // 低谷折扣(0023):留空 = 无峰谷价;0<d<1 = 低谷窗口内 ×d
      if (modelForm.offpeak_discount.trim() !== '') body.offpeak_discount = Number(modelForm.offpeak_discount)
      await request('/api/admin/models', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setModelDialog(false)
      setModelForm({ name: '', provider_id: '', display_name: '', input_price_per_1m: '', output_price_per_1m: '', cache_input_price_per_1m: '', offpeak_discount: '' })
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
      await request(`/api/admin/providers/${id}`, { method: 'DELETE' })
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
      await request(`/api/admin/models/${m.id}`, { method: 'DELETE' })
      setError('')
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  // 模型编辑:价格补录/修改(0022 金额计费前提 + 0023 峰谷折扣);其余字段留空不覆盖
  const [editModel, setEditModel] = useState<Model | null>(null)
  const [editPriceForm, setEditPriceForm] = useState({ input: '', output: '', cache: '', offpeak: '' })
  function openModelPricing(m: Model) {
    setEditModel(m)
    setEditPriceForm({
      input: m.input_price_per_1m === null || m.input_price_per_1m === undefined ? '' : String(m.input_price_per_1m),
      output: m.output_price_per_1m === null || m.output_price_per_1m === undefined ? '' : String(m.output_price_per_1m),
      cache: m.cache_input_price_per_1m === null || m.cache_input_price_per_1m === undefined ? '' : String(m.cache_input_price_per_1m),
      offpeak: m.offpeak_discount === null || m.offpeak_discount === undefined ? '' : String(m.offpeak_discount),
    })
  }
  async function saveModelPricing() {
    if (busy || !editModel) return // P1-6: 双击守卫
    setPriceErr('')
    // 价格/折扣前置校验(审计修复 2026-P,与 createModel 同一函数)
    const priceErr =
      validatePriceField('输入价格', editPriceForm.input) ??
      validatePriceField('输出价格', editPriceForm.output) ??
      validatePriceField('缓存命中输入价', editPriceForm.cache) ??
      validatePriceField('低谷折扣率', editPriceForm.offpeak, true)
    if (priceErr) { setPriceErr(priceErr); return }
    setBusy('save-model-pricing')
    try {
      const body: Record<string, any> = { name: editModel.name }
      // 留空 = 保持现值(服务端对缺省字段不覆盖);输入 0 = 定价 0(计费为 0)
      if (editPriceForm.input.trim() !== '') body.input_price_per_1m = Number(editPriceForm.input)
      if (editPriceForm.output.trim() !== '') body.output_price_per_1m = Number(editPriceForm.output)
      if (editPriceForm.cache.trim() !== '') body.cache_input_price_per_1m = Number(editPriceForm.cache)
      if (editPriceForm.offpeak.trim() !== '') body.offpeak_discount = Number(editPriceForm.offpeak)
      await request(`/api/admin/models/${editModel.id}`, { method: 'PUT', body: JSON.stringify(body) })
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
      const r = await request('/api/admin/providers/sync-all', { method: 'POST' })
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
      await request(`/api/admin/providers/${p.id}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
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
        desc="模型与上游接入、限流配额、峰谷计费与认证方式"
      />
      {error && <div className="text-sm text-destructive">{error}</div>}
      {okMsg && <div className="text-sm text-green-600">{okMsg}</div>}
      {syncMsg && <div className="text-sm text-green-600">{syncMsg}</div>}

      <Card>
        <CardHeader>
          <CardTitle>全局设置</CardTitle>
          <CardDescription>默认模型与 web 工具配置,随客户端启动配置下发</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>默认模型</Label>
              <Select value={cfg.default_model} onValueChange={(v) => setCfg({ ...cfg, default_model: v })}>
                <SelectTrigger><SelectValue placeholder="选择默认模型" /></SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.name}>{m.display_name || m.name} ({m.name})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rate-limit">每用户网关限流(次/分钟)</Label>
              <Input id="rate-limit" type="number" min={1} max={100000} value={cfg.rate_limit}
                onChange={(e) => setCfg({ ...cfg, rate_limit: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="monthly-quota">每用户默认月配额(token)</Label>
              <Input id="monthly-quota" type="number" min={0} value={cfg.monthly_quota}
                onChange={(e) => setCfg({ ...cfg, monthly_quota: e.target.value })} />
              <p className="text-xs text-muted-foreground">0 = 不限;员工默认按月统计,可在用户页单独覆盖</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="monthly-quota-money">每用户默认月金额配额(元)</Label>
              <Input id="monthly-quota-money" type="number" min={0} step="0.01" value={cfg.monthly_quota_money}
                onChange={(e) => setCfg({ ...cfg, monthly_quota_money: e.target.value })} />
              <Label htmlFor="usage-retention" className="mt-4">调用明细保留时长(月)</Label>
              <Input id="usage-retention" type="number" min={0} max={120} value={cfg.retention_months}
                onChange={(e) => setCfg({ ...cfg, retention_months: e.target.value })} />
              <p className="text-xs text-muted-foreground">
                0 = 永不删除;超出保留期的明细分区被自动清理;日账/月账统计永久保留
              </p>
              <p className="text-xs text-muted-foreground">
                0 = 不限;按模型定价折算费用统计,可在用户页单独覆盖
              </p>
            </div>
          </div>
          {/* 高峰时段结构化编辑(审计修复 M4):时间段行列表,替代手填 JSON;weekdays 按天配置 */}
          <div className="space-y-1">
            <Label>高峰时段(北京时间)</Label>
            <div className="space-y-2">
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
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>按北京时间判定,半开区间 [start,end);时段可勾选适用星期(周一…周日),未勾选 = 该天无峰谷。</li>
              <li>高峰窗口外(空闲时段)且模型配置了低谷折扣率时,费用按折扣率打折。</li>
              <li>清空 = 无峰谷价(全天标准价)。</li>
              <li>DeepSeek 官方当前政策(2026-08 起):高峰 = 北京时间<strong>周一至周五</strong> 09:00-12:00、14:00-18:00(其余为空闲,含周末),空闲价 = 高峰价 × 50%。</li>
            </ul>
          </div>
          <div className="grid grid-cols-2 items-start gap-4">
            <div className="flex items-center gap-2">
              <Switch checked={cfg.allow_private} onCheckedChange={(v) => setCfg({ ...cfg, allow_private: v })} />
              <Label>允许 web_fetch 访问私有网段</Label>
            </div>
            <div className="space-y-1">
              <Label htmlFor="search-endpoint">web_search 端点</Label>
              <Input id="search-endpoint" type="url" placeholder="https://search.example.com/q" value={cfg.search_endpoint}
                onChange={(e) => setCfg({ ...cfg, search_endpoint: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="default-thinking-level">默认思考强度(客户端默认模型,登录自动应用)</Label>
            <Select value={cfg.default_thinking_level} onValueChange={(v) => setCfg({ ...cfg, default_thinking_level: v })}>
              <SelectTrigger id="default-thinking-level" aria-label="默认思考强度"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="max">max(最大思考)</SelectItem>
                <SelectItem value="high">high(高)</SelectItem>
                <SelectItem value="low">low(低)</SelectItem>
                <SelectItem value="off">off(关闭思考)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              登录后客户端默认模型自动使用该思考强度;用户仍可在模型选择器单独调整当前对话
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="server-base-url">对外访问地址 (Server Base URL)</Label>
            <Input id="server-base-url" type="url" placeholder="https://picoaide.example.com" value={cfg.server_base_url}
              onChange={(e) => setCfg({ ...cfg, server_base_url: e.target.value })} />
            <p className="text-xs text-muted-foreground">
              客户端登录与员工访问入口(经 Caddy HTTPS 反代后的地址);填写后管理页顶部展示;清空保存可移除
            </p>
          </div>
          <Button onClick={saveGateway} disabled={busy !== null}>{busy === 'save-gateway' ? '处理中…' : '保存'}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>上游 Provider</CardTitle>
          <CardDescription>LLM 上游密钥只存服务端(AES-GCM 加密)</CardDescription>
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
                        <span className="font-mono text-xs">{p.api_key}</span>
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
                <TableHead>价格(元/百万 token)</TableHead>
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
                    <TableCell className="font-mono">{m.name}</TableCell>
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
                      <Button size="sm" variant="outline" onClick={() => openModelPricing(m)}>价格</Button>
                      <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => deleteModel(m)}>{busy === `del-model-${m.id}` ? '删除中…' : '删除'}</Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 认证配置(LDAP/OIDC):webadmin 配置入口,服务端启动时注册对应 provider */}
      <Card>
        <CardHeader>
          <CardTitle>认证配置</CardTitle>
          <CardDescription>员工登录方式:本地账号 / LDAP / OIDC;修改后重启服务端生效(下拉框提示)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {authErr && <div className="text-sm text-destructive">{authErr}</div>}
          {authMsg && <div className="text-sm text-green-600">{authMsg}</div>}
          <div className="space-y-1">
            <Label>登录模式</Label>
            <Select value={authForm.mode} onValueChange={(v) => setAuthForm({ ...authForm, mode: v })}>
              <SelectTrigger aria-label="登录模式"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="local">仅本地账号</SelectItem>
                <SelectItem value="ldap">仅 LDAP</SelectItem>
                <SelectItem value="both">本地 + LDAP</SelectItem>
                <SelectItem value="oidc">OIDC(浏览器登录)</SelectItem>
              </SelectContent>
            </Select>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>ldap/both 模式需填写 LDAP 服务器;oidc 模式需填写 OIDC 配置。</li>
              <li>密码类字段留空 = 保持现值。</li>
            </ul>
          </div>

          {(authForm.mode === 'ldap' || authForm.mode === 'both') && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="text-sm font-medium">LDAP 配置</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="ldap-url">服务器地址(ldap://ldap.example.com:389)</Label>
                  <Input id="ldap-url" value={authForm.ldap_server_url} placeholder="ldap://ldap.example.com:389"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_server_url: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-bind-dn">Bind DN</Label>
                  <Input id="ldap-bind-dn" value={authForm.ldap_bind_dn} placeholder="cn=admin,dc=example,dc=com"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_bind_dn: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-bind-pw">Bind 密码(未改=保持现值;清空=清除密码)</Label>
                  <SecretInput id="ldap-bind-pw" value={authForm.ldap_bind_password}
                    onChange={(e) => setAuthForm({ ...authForm, ldap_bind_password: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-base-dn">Base DN</Label>
                  <Input id="ldap-base-dn" value={authForm.ldap_base_dn} placeholder="dc=example,dc=com"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_base_dn: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-user-filter">用户过滤器(默认 (uid=%s))</Label>
                  <Input id="ldap-user-filter" value={authForm.ldap_user_filter} placeholder="(uid=%s)"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_user_filter: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-group-filter">组过滤器(可选)</Label>
                  <Input id="ldap-group-filter" value={authForm.ldap_group_filter} placeholder="(memberOf=cn=%s)"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_group_filter: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-group-attr">组属性(默认 cn)</Label>
                  <Input id="ldap-group-attr" value={authForm.ldap_group_attr}
                    onChange={(e) => setAuthForm({ ...authForm, ldap_group_attr: e.target.value })} />
                </div>
              </div>
            </div>
          )}

          {authForm.mode === 'oidc' && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="text-sm font-medium">OIDC 配置</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="oidc-issuer">Issuer(如 https://idp.example.com)</Label>
                  <Input id="oidc-issuer" value={authForm.oidc_issuer} placeholder="https://idp.example.com"
                    onChange={(e) => setAuthForm({ ...authForm, oidc_issuer: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-client-id">Client ID</Label>
                  <Input id="oidc-client-id" value={authForm.oidc_client_id}
                    onChange={(e) => setAuthForm({ ...authForm, oidc_client_id: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-secret">Client Secret(未改=保持现值;清空=清除密钥)</Label>
                  <SecretInput id="oidc-secret" value={authForm.oidc_client_secret}
                    onChange={(e) => setAuthForm({ ...authForm, oidc_client_secret: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-redirect">Redirect URL</Label>
                  <Input id="oidc-redirect" value={authForm.oidc_redirect_url} placeholder="https://picoaide.example.com/api/auth/oidc/callback"
                    onChange={(e) => setAuthForm({ ...authForm, oidc_redirect_url: e.target.value })} />
                </div>
              </div>
            </div>
          )}

          <Button onClick={saveAuth} disabled={busy !== null}>{busy === 'save-auth' ? '保存中…' : '保存认证配置'}</Button>
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
          <DialogHeader><DialogTitle>模型价格 · {editModel?.name}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {priceErr && <div className="text-sm text-destructive">{priceErr}</div>}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-price-in">输入价格(元/百万 token)</Label>
                <Input
                  id="edit-price-in"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="留空 = 保持现值"
                  value={editPriceForm.input}
                  onChange={(e) => setEditPriceForm({ ...editPriceForm, input: e.target.value })}
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
                  value={editPriceForm.output}
                  onChange={(e) => setEditPriceForm({ ...editPriceForm, output: e.target.value })}
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
                  value={editPriceForm.cache}
                  onChange={(e) => setEditPriceForm({ ...editPriceForm, cache: e.target.value })}
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
                value={editPriceForm.offpeak}
                onChange={(e) => setEditPriceForm({ ...editPriceForm, offpeak: e.target.value })}
              />
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
