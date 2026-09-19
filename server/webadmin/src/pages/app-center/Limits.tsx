import { useCallback, useEffect, useMemo, useState } from 'react'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Skeleton } from '../../components/ui/skeleton'
import { PageHeader } from '../../components/page-header'
import { useFlash } from '../../lib/use-flash'
import { hasPermission, PERM_CAP_READ, PERM_CAP_WRITE } from '../../lib/rbac'
/** 服务端错误信封统一渲染(message + details.field + hints,P1-6)。 */
import { errorText } from '../../lib/api-error'
import { AlertTriangle, RotateCcw, RefreshCw, Save } from 'lucide-react'

/**
 * 应用中心 · 限制项(2026-09-19 页面合并):并发与内存限制。
 *
 * 主体是原「应用平台」页(`pages/AppPlatform.tsx`,`/app-platform`)原样搬入
 * (2026-09-19 用户要求「应用平台并入应用中心」);**服务端与全部 data-testid 未动**,
 * 只换了承载它的路由与页面标题。老路径 `/app-platform` 由 `App.tsx` 重定向到
 * 应用中心子页,老书签不 404。
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
  /**
   * 每个应用库句柄的只读连接数（WAL 下并发读；写仍串行）。
   *
   * ⚠️ **下一个应用库句柄生效**：只读连接只能在"一次性令牌窗口"内建满
   * （每条都要单独设 SQLITE_LIMIT_ATTACHED=0 并跑金丝雀），所以运行期不能弹性扩缩，
   * 已有句柄要等空闲回收后重建才拿到新值 —— 与 appdb_cache_kib 同一档语义。
   */
  app_db_readers: number
  /**
   * 服务端**新加**的旋钮也走这里。
   *
   * R1-uxw-10：字段集以服务端下发的 JSON 为准（`applimits.Limits` 的 json tag），
   * 前端不认得的字段也要在表单里出现（用字段名占位 + 提示待补），否则"服务端加了第 13
   * 个旋钮、控制台静默少一格、门禁全绿"就是一而再的现场。跨语言覆盖门禁见
   * `AppPlatform.test.tsx` 的「表单字段集覆盖 applimits.Limits 的全部 json 字段」。
   */
  [key: string]: number
}

interface Budget {
  profile: string
  instances_bytes: number
  compile_peak_bytes: number
  upload_peak_bytes: number
  cache_resident_bytes: number
  /**
   * 应用库页缓存这笔账（R1-rt-8）：(1 + app_db_readers) × appdb_cache_kib × max_instances。
   *
   * 它过去不在账里，于是控制台能把组合配到 272 GiB 而保存判据一字不变 —— 现在它既进
   * 服务端判定，也进这里的编辑期估算（否则界面显示"未超水位"而保存被服务端拒绝）。
   */
  appdb_cache_bytes: number
  total_bytes: number
  available_bytes: number
  /** known=false 表示服务端**没读到**可用内存（available_bytes = -1）⇒ 只算不判。 */
  known: boolean
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
  /** 部署档位名(memprofile.Name)：与 source 一起解释"当前值来自哪里"。 */
  profile: string
  /**
   * 服务端给的**来源标签**一句话("控制台保存（wasm.limits）"/"部署档位 small（…）"/
   * "编译期默认"）。档位名与来源语义都住在服务端,前端各拼一次就会出现两套口径 ——
   * 因此直接显示服务端这句话,本地不再自己推断(只在字段缺失时回落旧文案)。
   */
  source_label: string
  defaults: Limits
  presets: Record<string, Limits>
  ranges: Record<string, FieldRange>
  budget: Budget
  guard_percent: number
  restart_fields: string[]
  restart_pending: string[]
  setting_key: string
}

/** 平台级运行时水位(P2-4):`GET /wasm-apps/runtime`。 */
interface RuntimeView {
  captured_at: string
  compile?: {
    queue_depth: number
    queue_capacity: number
    compiling: boolean
    child_running: boolean
    cache_bytes: number
    cache_entries: number
    cache_max_bytes: number
    cache_max_entries: number
    compiles: number
    failures: number
    timeouts: number
    last_compile_ms: number
  }
  events?: { written: number; dropped: number; failed: number }
  exec?: { running: number; waiting: number }
  disk?: { free_bytes: number }
  ready?: boolean
  ready_reasons?: string[]
  /**
   * 还没有出口的水位(服务端如实列出"缺哪个 + 接哪里")。
   * 页面上必须显示这一段:否则管理员会把"没有这个数"读成"这个数是 0"。
   */
  unavailable?: { name: string; reason: string; wiring: string }[]
}

type FieldKey = string

/** 表单分组：两组已知字段 + 一组"服务端新加、本页还没有描述"的兜底分组。 */
type FieldGroup = '并发' | '内存' | '服务端新增'

interface FieldRow {
  key: FieldKey
  label: string
  group: FieldGroup
  hint: string
}

/**
 * 已知字段的**元数据**（标签/分组/说明）。
 *
 * 注意它只是元数据：**字段集**的真源是服务端下发的 `limits`（见 fieldRows）。
 * 这里少写一项，字段仍会出现在表单里（占位分组），并由覆盖门禁要求补上标签。
 */
const FIELDS: FieldRow[] = [
  { key: 'max_instances', label: '全局并发实例数', group: '并发', hint: '同时运行的 wasm 实例上限；同时决定进程内应用库句柄上限' },
  { key: 'app_running', label: '单应用并发', group: '并发', hint: '同一应用最多 N 个请求同时在跑（读并发；写仍串行；某请求在事务中时其他请求的读写会被拒并需重试）；超限进队列。调大不增加内存上界（实例池乘数是全局并发）' },
  { key: 'app_queue', label: '单应用队列长度', group: '并发', hint: '超过并发后允许排队的请求数，再多的直接 429' },
  { key: 'user_global_running', label: '单用户跨应用并发', group: '并发', hint: '一个用户在所有应用里同时能占用的实例数' },
  { key: 'user_per_app_running', label: '单用户单应用并发', group: '并发', hint: '通常为 1：单个用户在同一应用内仍串行（并发放宽的是读并发与不同用户之间）' },
  { key: 'user_per_app_queued', label: '单用户单应用排队', group: '并发', hint: '一个用户在同一应用队列里的占位上限' },
  { key: 'instance_memory_mb', label: '单实例内存上限', group: '内存', hint: '单个应用实例可用的线性内存上限（wazero 的硬上限，超了报 RUNTIME_MEMORY）' },
  { key: 'module_cache_mb', label: '编译模块缓存上限', group: '内存', hint: '进程内缓存已编译应用的上限；几百个应用时它是常驻内存的主要项' },
  { key: 'module_cache_idle_min', label: '模块空闲回收', group: '内存', hint: '超过这个时间没被访问就逐出并归还内存给操作系统' },
  { key: 'appdb_idle_min', label: '应用库空闲回收', group: '内存', hint: '应用数据库句柄（1 条写连接 + N 条只读连接）空闲多久后关闭' },
  { key: 'appdb_cache_kib', label: 'SQLite 页缓存/连接', group: '内存', hint: '每条应用库连接的页缓存上限；下一个新建连接生效' },
  { key: 'app_db_readers', label: '应用库只读连接数', group: '内存', hint: '每个应用库句柄的只读连接数：库已开启 WAL，多个读请求可真正并发（写仍串行）。值越大并发读越高，代价是每句柄多占 (1+N) 份页缓存与文件描述符；**下一个应用库句柄生效**（不是立即）' },
]

/** 按 key 索引的元数据（未知 key ⇒ 用兜底行，见 fieldRows）。 */
const FIELD_META: Record<string, FieldRow> = Object.fromEntries(FIELDS.map((f) => [f.key, f]))

/** 服务端新增字段的兜底分组名（标签留空会让人以为"没这一项"，这里显式占位）。 */
const UNKNOWN_FIELD_GROUP: FieldGroup = '服务端新增'

/**
 * 账目项 key（与 `readyz.MemoryBudget` 的 json tag 逐字一致，五笔）。
 *
 * 覆盖门禁（AppPlatform.test.tsx）从 Go 源码里读这组 tag 并要求每笔都有渲染行 ——
 * 2026-09-19 服务端把"应用库页缓存"加成第五笔时，既有 421 条用例一条都没红，正是缺口。
 */
const ACCOUNT_KEYS = [
  'instances_bytes', 'compile_peak_bytes', 'upload_peak_bytes', 'cache_resident_bytes', 'appdb_cache_bytes',
] as const

/** 不是"账目项"的 `*_bytes`：预算入参 available、派生上限 limit、合计 total。 */
const NON_ACCOUNT_BYTES = new Set(['available_bytes', 'limit_bytes', 'total_bytes'])

const mb = (v: number) => Math.round(v / (1 << 20))

/**
 * 页内错误块的**唯一实现**。
 *
 * 本页有两个渲染点：首屏读取失败（早退分支，带重试按钮）与页内保存失败（内联）。
 * 审计 A2-F4 实测：同一个 `data-testid="limits-error"` 的两个出口各写一份 JSX，
 * 于是"保存失败那条"补了 live 区断言、"首屏读取失败那条"去掉 `role/aria-live`
 * 用例仍然全绿（读屏用户听不到首屏失败）。共用同一个组件后语义不可能再分叉。
 */
function LimitsErrorBlock({ text }: { text: string }) {
  return (
    <div
      data-testid="limits-error"
      role="alert"
      aria-live="assertive"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {text}
    </div>
  )
}

/** 采集时间:`YYYY/MM/DD HH:mm:ss`(本地时区,与列表页同一格式)。 */
function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function Limits() {
  const [view, setView] = useState<LimitsView | null>(null)
  const [form, setForm] = useState<Limits | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [runtime, setRuntime] = useState<RuntimeView | null>(null)
  const [runtimeErr, setRuntimeErr] = useState('')
  const [flashMsg, flash] = useFlash()
  const canWrite = hasPermission(PERM_CAP_WRITE)
  const canRead = hasPermission(PERM_CAP_READ)

  const fetchView = useCallback(async () => {
    const data = await request<LimitsView>(`${ADMIN_API}/wasm-apps/limits`)
    setView(data)
    setForm(data.limits)
    return data
  }, [])

  const load = useCallback(async () => {
    try {
      await fetchView()
      setErr('')
    } catch (e: any) {
      // P1-6:统一渲染 message + details.field + hints(此前只显示 message,
      // 服务端"还差什么条件"的那段建议被整段丢掉)。
      setErr(errorText(e, '读取平台限制项失败'))
    }
  }, [fetchView])

  /** 平台级运行时水位:独立请求,失败不影响限制项的读写(两块信息互不依赖)。 */
  const loadRuntime = useCallback(async () => {
    try {
      const data = await request<{ runtime: RuntimeView }>(`${ADMIN_API}/wasm-apps/runtime`)
      setRuntime(data.runtime)
      setRuntimeErr('')
    } catch (e: any) {
      setRuntime(null)
      setRuntimeErr(errorText(e, '读取运行时水位失败'))
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadRuntime() }, [loadRuntime])

  /**
   * 服务端新增、本页还没有明细的账目项：必须在页面上占位（又是一枚"看不见的旋钮"），
   * 且**金额要进理论峰值**（F1）—— 下面 unknownAccountsTotal 是它的唯一求和点。
   */
  const unknownAccounts = useMemo(
    () => (view
      ? Object.keys(view.budget).filter((k) =>
        k.endsWith('_bytes') &&
        !NON_ACCOUNT_BYTES.has(k) &&
        !(ACCOUNT_KEYS as readonly string[]).includes(k))
      : []),
    [view],
  )

  /**
   * 未识别账目项的金额（F1，审计 A2 实测：注入 100 MiB 新账目项后理论峰值一字不变）。
   *
   * 只有**有限数值**才计入：形状漂移（字符串/缺席）的项无法求和，必须与"已计入"分开
   * 表述 —— 否则提示语又会变成一句与事实相反的话（这正是 F1 的形态）。
   */
  const unknownAccountsTotal = useMemo(() => {
    const counted: string[] = []
    const uncounted: string[] = []
    let bytes = 0
    for (const key of unknownAccounts) {
      const value = (view?.budget as Record<string, unknown> | undefined)?.[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        bytes += value
        counted.push(key)
      } else {
        uncounted.push(key)
      }
    }
    return { bytes, counted, uncounted }
  }, [view, unknownAccounts])

  /**
   * 编辑期估算：与后端 applimits.Budget 同一公式（固定项由服务端下发，随限制项变化的
   * 三项按**表单当前值**重算）。
   *
   * 页缓存那笔（R1-rt-8）的公式与 Go 侧 applimits.Limits.AppDBPageCachePerHandleBytes 一致：
   * (1 写 + app_db_readers 读) × 每条连接 appdb_cache_kib × 句柄数（≤ max_instances）。
   * 必须按表单值重算而不是直接用服务端的 appdb_cache_bytes —— 后者是**已保存值**的账，
   * 管理员改这两个旋钮时它不会动，界面就会在"马上要被拒"的组合上显示正常。
   */
  const preview = useMemo(() => {
    if (!view || !form) return null
    const instances = form.max_instances * form.instance_memory_mb * (1 << 20)
    const cache = form.module_cache_mb * (1 << 20)
    const appdbCache = (1 + form.app_db_readers) * form.appdb_cache_kib * 1024 * form.max_instances
    const total = instances + view.budget.compile_peak_bytes + view.budget.upload_peak_bytes + cache + appdbCache
      // F1（审计 A2）：服务端新增、本页还没有明细的账目项**必须进总账**。旧实现只加
      // 四笔已知账 + 表单三项，而下面的提示语却写着"已计入上面的理论峰值" —— 服务端加
      // 第六笔账时页面显示的水位比真实值低，管理员看到"可以保存"后撞上服务端 400。
      + unknownAccountsTotal.bytes
    const available = view.budget.available_bytes
    // 服务端语义（readyz.ComputeMemoryBudgetFor 是唯一真源）：
    //   available < 0（MemoryUnknown）⇒ 读不到可用内存 ⇒ **不判定**（known=false）；
    //   available == 0 ⇒ 真的没有可用内存 ⇒ **判定失败**（fail-loud）。
    // 旧实现 `available <= 0 || total <= limit` 把两者混成一种，于是"读不到"与
    // "可用内存恰好是 0"都被显示成"内存水位正常 / 可以保存"（R1-uxw-6 的实测现场）。
    const judged = view.budget.known !== false && available >= 0
    const limit = judged ? Math.floor((available * view.guard_percent) / 100) : 0
    return {
      instances, cache, appdbCache, total, limit,
      available,
      judged,
      /** 判定通过；没判定时恒 false —— 界面必须用 judged 区分"没判"与"判过没过"。 */
      ok: judged && total <= limit,
    }
  }, [view, form, unknownAccountsTotal])

  /**
   * 表单行 = 已知字段（FIELDS 给标签/分组/hint）**∪ 服务端实际下发的字段**。
   *
   * R1-uxw-10：此前字段集是前端手写的 12 项，服务端加第 13 个旋钮时控制台静默少一格、
   * 而 Go 门禁只覆盖生成物 ⇒ "看不见的旋钮"。现在按响应里的字段集渲染：不认识的字段
   * 也会出现（字段名占位 + "待补描述"），另有跨语言覆盖门禁要求补上标签与默认值。
   */
  const fieldRows = useMemo<FieldRow[]>(() => {
    if (!form) return []
    return Object.keys(form).map((key) => FIELD_META[key] ?? {
      key,
      label: key,
      group: UNKNOWN_FIELD_GROUP,
      hint: '服务端下发了本页尚未描述的限制项：名称/语义待补（数值与取值范围一律以服务端为准）。',
    })
  }, [form])

  const dirty = useMemo(() => {
    if (!view || !form) return false
    return (Object.keys(form) as FieldKey[]).some((k) => form[k] !== view.limits[k])
  }, [view, form])

  const patch = (key: FieldKey, raw: string) => {
    const n = Number.parseInt(raw, 10)
    setForm((f) => (f ? { ...f, [key]: Number.isFinite(n) ? n : 0 } : f))
  }

  const save = async () => {
    if (!form || !view || busy) return
    setBusy(true); setErr('')
    try {
      /**
       * 并发/多标签（F5，审计 A2 实测：另一位管理员把 app_queue 改成 99，我只改
       * max_instances 就保存 ⇒ 请求体里 app_queue 仍是打开页面时的 32，服务端整份覆盖
       * ⇒ 99 被静默改回）。
       *
       * PUT 是**整份覆盖**（服务端 applimits.Parse 要求完整对象，没有版本号/ETag），
       * 所以保存前重读一次服务端真值，只提交"我实际改过"的字段，其余以最新值为准。
       */
      let next: Limits
      /** 我改过、且服务端当前值与我打开页面时不同的字段（同一字段被别人也改过）。 */
      let staleFields: string[] = []
      try {
        const fresh = await request<LimitsView>(`${ADMIN_API}/wasm-apps/limits`)
        const mine: Record<string, number> = {}
        for (const key of Object.keys(form)) {
          if (form[key] !== view.limits[key]) mine[key] = form[key]
        }
        next = { ...fresh.limits, ...mine }
        // 我也改过、且服务端当前值与我打开页面时不同 ⇒ 同一字段被别人改过。
        // 仍然以我输入的值提交（那是我明确的意图），但必须在反馈里说出来。
        staleFields = Object.keys(mine).filter((k) => fresh.limits[k] !== view.limits[k])
      } catch {
        // 重读失败 ⇒ **不发 PUT**：拿不到最新值就无法保证不覆盖别人（fail-closed）。
        // 旧行为是直接提交旧快照，那正是"静默回滚他人改动"的成因。
        setErr('保存已取消：读不到服务端最新的限制项，直接提交会把其他管理员刚保存的值覆盖掉。请点「刷新」后重试。')
        return
      }
      const data = await request<LimitsView>(`${ADMIN_API}/wasm-apps/limits`, {
        method: 'PUT',
        body: JSON.stringify({ limits: next }),
      })
      setView(data); setForm(data.limits)
      const pending = data.restart_pending ?? []
      // PUT 的应答本身就是保存后的完整视图（含 restart_pending）——不再补一次 GET，
      // 否则会把"刚保存的提示"冲掉，也多一次无谓往返。
      const base = pending.length > 0
        ? `已保存。需重启服务端才生效：${pending.join('、')}`
        : '已保存并即时生效'
      flash(staleFields.length > 0
        ? `${base}；注意：${staleFields.join('、')} 在你编辑期间也被改过，本次以你输入的值覆盖`
        : base)
    } catch (e: any) {
      // P2-2:保存被拒后界面必须**自洽**。此前只把红字打出来,表单仍停在被拒的值上,
      // 而绿色的"内存水位正常"徽标/预览是按本地表单算的 ⇒ 同一屏上红字与绿标互相
      // 矛盾,且没有任何入口回到服务端的真实值。
      // 现在:失败即以服务端为准重新拉取(预算判定的真源在服务端)。
      setErr(errorText(e, '保存失败'))
      try {
        await fetchView()
      } catch {
        // 重新拉取也失败:保留上面的保存错误(它才是用户刚触发的动作),
        // 页面仍可通过「刷新」按钮重试。
      }
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
      setErr(errorText(e, '清空失败'))
      try {
        await fetchView()
      } catch { /* 同上:保留原错误 */ }
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return <div className="p-6 text-sm text-muted-foreground">没有查看应用中心限制项的权限（需要能力中心读取权限）。</div>
  }

  // P2-1:首屏读取失败此前 = **永久骨架屏** —— 错误块写在 `return <Skeleton/>` 之后,
  // 永远不可达(骨架屏把错误态整段挡在后面)。现在错误态**先于**骨架屏判定,
  // 并给一个重试按钮(否则唯一的出路是刷新整页)。
  if (err !== '' && (!view || !form)) {
    return (
      <div className="space-y-4 p-6">
        <PageHeader
          title="限制项"
          desc="员工自建 WASM 应用的并发与内存限制"
        />
        {/* F4：与页内保存失败共用同一个错误块（role/aria-live 不会只在一条出口上）。 */}
        <LimitsErrorBlock text={err} />
        <Button variant="outline" size="sm" data-testid="limits-retry" onClick={() => { void load() }}>
          重试
        </Button>
      </div>
    )
  }

  if (!view || !form || !preview) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const groups = Array.from(new Set(fieldRows.map((f) => f.group)))

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title="限制项"
        desc="员工自建 WASM 应用的并发与内存限制。改动即时下发（单实例内存上限需重启），保存时会按可用内存做四笔账自检。"
        actions={
          <Button variant="outline" size="sm" onClick={() => { void load(); void loadRuntime() }} data-testid="limits-refresh">
            <RefreshCw className="mr-1 h-4 w-4" />刷新
          </Button>
        }
      />
      {/* R1-uxw-14：保存成功/失败都必须进 live 区，否则读屏用户点完"保存并生效"
          听不到任何结果（保存失败此前只有一个普通 div）。 */}
      {flashMsg && (
        <div
          data-testid="limits-flash"
          role="status"
          aria-live="polite"
          className="rounded-md border border-border bg-muted px-3 py-2 text-sm"
        >
          {flashMsg}
        </div>
      )}
      {err && <LimitsErrorBlock text={err} />}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">当前配置</CardTitle>
            <CardDescription data-testid="limits-source">
              {/* 来源直接显示服务端的 source_label（档位名 + 设置键都在服务端拼好）：
                  前端自己推断"是设置还是档位"就会与服务端出现两套口径。 */}
              来源：{view.source_label
                || (view.source === 'setting' ? '控制台保存' : view.source === 'profile' ? '部署档位（环境变量）' : '默认值')}
              （{view.setting_key}）
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {(view.restart_pending ?? []).length > 0 && (
              <Badge variant="destructive" data-testid="restart-pending">
                待重启：{view.restart_pending.join('、')}
              </Badge>
            )}
            <Badge
              variant={!preview.judged ? 'outline' : preview.ok ? 'secondary' : 'destructive'}
              data-testid="budget-badge"
            >
              {!preview.judged
                ? '可用内存未知，未判定'
                : preview.ok ? '内存水位正常' : '超出可用内存水位'}
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
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <div data-testid="budget-account-instances_bytes">
              <div className="text-muted-foreground">实例池（并发 × 单实例上限）</div>
              <div className="font-medium">{mb(preview.instances)} MiB</div>
            </div>
            <div data-testid="budget-account-compile_peak_bytes">
              <div className="text-muted-foreground">编译峰值（固定）</div>
              <div className="font-medium">{mb(view.budget.compile_peak_bytes)} MiB</div>
            </div>
            <div data-testid="budget-account-upload_peak_bytes">
              <div className="text-muted-foreground">上传峰值（固定）</div>
              <div className="font-medium">{mb(view.budget.upload_peak_bytes)} MiB</div>
            </div>
            <div data-testid="budget-account-cache_resident_bytes">
              <div className="text-muted-foreground">模块缓存驻留</div>
              <div className="font-medium">{mb(preview.cache)} MiB</div>
            </div>
            <div data-testid="budget-account-appdb_cache_bytes">
              <div className="text-muted-foreground">应用库页缓存（SQLite）</div>
              <div className="font-medium">{mb(preview.appdbCache)} MiB</div>
            </div>
          </div>
          {/* 服务端新增了本页还不认识的账目项 ⇒ 明说，且金额**真的**计入理论峰值（F1）。 */}
          {unknownAccounts.length > 0 && (
            <div
              className="rounded-md border border-dashed border-destructive/40 px-3 py-2 text-xs text-destructive"
              data-testid="budget-unknown-accounts"
            >
              服务端下发了本页尚未列出明细的账目项：{unknownAccounts.join('、')}
              {unknownAccountsTotal.counted.length > 0
                ? `（共 ${mb(unknownAccountsTotal.bytes)} MiB，已计入上面的理论峰值；本页看不到它的明细 —— 请补齐这一页的明细行）。`
                : '（本页看不到它的明细 —— 请补齐这一页的明细行）。'}
              {unknownAccountsTotal.uncounted.length > 0
                ? `其中 ${unknownAccountsTotal.uncounted.join('、')} 的值不是数字，**没有**计入理论峰值（服务端响应形状异常，请先核对接口）。`
                : ''}
            </div>
          )}
          {/* 三种形态必须互不同形（R1-uxw-6）：判定通过 / 判定失败 / **没有判定**。
              "读不到可用内存"绝不能再显示成"可以保存" —— 服务端是 fail-loud：
              available<0 未知 ⇒ 不判定；available==0 ⇒ 真的没有 ⇒ 判定失败。 */}
          <div className={`rounded-md border px-3 py-2 text-sm ${preview.judged && !preview.ok ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border'}`} data-testid="budget-line">
            理论峰值 <span className="font-semibold">{mb(preview.total)} MiB</span>
            {' / '}
            {preview.judged
              ? `可用 ${mb(preview.available)} MiB 的 ${view.guard_percent}% = ${mb(preview.limit)} MiB`
              : '可用内存：读不到（不是 0，是取不到）'}
            {!preview.judged
              ? '：不判定水位、保存时不拦（服务端同样跳过内存自检；请确认部署给了 /proc/meminfo 或 cgroup 限额）'
              : preview.ok
                ? '：可以保存'
                : `：超出水位，保存会被拒绝（请调小并发/实例内存/模块缓存/页缓存${preview.available === 0 ? '；当前可用内存为 0，确实没有余量' : ''}）`}
          </div>
        </CardContent>
      </Card>

      {/* 平台级运行时水位（P2-4 的管理面出口）。
          放在**限制项**页而不是设置页：这些水位（执行槽/编译队列/模块缓存/调用事件）
          正是上面这些限制项在运行期的表现 —— 管理员调完并发/内存，下一步就是看
          "现在的实际水位如何"。设置页讲的是应用访问域名，与运行时无关。 */}
      <Card data-testid="runtime-card">
        <CardHeader>
          <CardTitle className="text-base">运行时水位（只读）</CardTitle>
          <CardDescription>
            编译队列与缓存、执行槽、调用事件与磁盘余量
            {runtime?.captured_at ? `（采集于 ${fmtTime(runtime.captured_at)}）` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {runtimeErr && (
            <p className="text-destructive" role="alert" aria-live="assertive" data-testid="runtime-error">{runtimeErr}</p>
          )}
          {!runtimeErr && !runtime && <p className="text-muted-foreground">读取中…</p>}
          {!runtimeErr && runtime && (
            <>
              {/* 平台是否就绪（R1-uxw-11）：`/readyz` 的同一份判定（ready + ready_reasons）
                  此前没有任何管理面出口 —— 平台不健康时这一页反而最安静。
                  ready_reasons 里既有阻塞原因也有非阻塞说明（如"内存来源读不到"），
                  因此**按 ready 着色但一律显示**：把"没读到"读成"健康"正是旧实现的 fail-open。 */}
              {runtime.ready === undefined && (
                <div
                  className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
                  data-testid="runtime-ready"
                >
                  平台状态：服务端未下发这一项（不是"健康"，是这一项没有出口）—— 请核对 /readyz 探针的装配。
                </div>
              )}
              {runtime.ready !== undefined && (
                <div
                  data-testid="runtime-ready"
                  className={`rounded-md border px-3 py-2 ${runtime.ready
                    ? 'border-border'
                    : 'border-destructive/40 bg-destructive/10 text-destructive'}`}
                >
                  <div className="font-medium">
                    {runtime.ready ? '平台就绪' : '平台未就绪'}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      /readyz：{runtime.ready ? '可以服务应用请求' : '应用请求会被拒绝或降级'}
                    </span>
                  </div>
                  {(runtime.ready_reasons ?? []).length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs" data-testid="runtime-ready-reasons">
                      {(runtime.ready_reasons ?? []).map((r) => <li key={r}>{r}</li>)}
                    </ul>
                  )}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <div className="text-muted-foreground">编译队列</div>
                  <div className="font-medium" data-testid="runtime-compile-queue">
                    {runtime.compile ? `${runtime.compile.queue_depth} / ${runtime.compile.queue_capacity}` : '—'}
                    {runtime.compile?.compiling ? '（编译中）' : ''}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">编译缓存</div>
                  {/* 上限也要显示（R1-uxw-11）：只报"7 条 / 128 MiB"看不出离上限多远，
                      而 cache_max_bytes/cache_max_entries 服务端一直在下发。 */}
                  <div className="font-medium" data-testid="runtime-compile-cache">
                    {runtime.compile
                      ? `${runtime.compile.cache_entries} 条 / ${mb(runtime.compile.cache_bytes)} MiB`
                        + `（上限 ${runtime.compile.cache_max_entries} 条 / ${mb(runtime.compile.cache_max_bytes)} MiB）`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">执行槽（在跑 / 排队）</div>
                  <div className="font-medium" data-testid="runtime-exec">
                    {runtime.exec ? `${runtime.exec.running} / ${runtime.exec.waiting}` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">磁盘余量</div>
                  <div className="font-medium" data-testid="runtime-disk">
                    {runtime.disk ? `${mb(runtime.disk.free_bytes)} MiB` : '—'}
                  </div>
                </div>
              </div>
              {runtime.compile && (
                <p className="text-xs text-muted-foreground" data-testid="runtime-compile-counters">
                  累计编译 {runtime.compile.compiles} 次，失败 {runtime.compile.failures}，
                  超时 {runtime.compile.timeouts}，最近一次 {runtime.compile.last_compile_ms} ms
                </p>
              )}
              {runtime.events && (
                <p className="text-xs text-muted-foreground" data-testid="runtime-events">
                  调用事件：已写 {runtime.events.written}，丢弃 {runtime.events.dropped}，失败 {runtime.events.failed}
                </p>
              )}
              {/* 缺口清单必须显示：把"没有出口"读成"数值为 0"是这类页面最坏的误导。 */}
              {(runtime.unavailable ?? []).length > 0 && (
                <div className="rounded-md border border-dashed px-3 py-2" data-testid="runtime-unavailable">
                  <div className="text-xs font-medium text-muted-foreground">
                    以下水位当前没有管理面出口（不是 0，是取不到）：
                  </div>
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                    {(runtime.unavailable ?? []).map((u) => (
                      <li key={u.name}>
                        <span className="font-mono">{u.name}</span>：{u.reason}
                        {/* wiring 是"接哪里"（排障工单要的就是这一行），服务端一直在下发。 */}
                        {u.wiring ? <span className="block pl-4">接线位置：{u.wiring}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {groups.map((g) => (
        <Card key={g}>
          <CardHeader>
            <CardTitle className="text-base">{g}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {fieldRows.filter((f) => f.group === g).map((f) => {
              const r = view.ranges[f.key]
              const def = view.defaults?.[f.key]
              const deviated = typeof def === 'number' && form[f.key] !== def
              return (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`lim-${f.key}`} data-testid={`lim-label-${f.key}`} className="flex flex-wrap items-center gap-2">
                    {f.label}
                    {r?.restart && <Badge variant="outline" className="text-[10px]">需重启</Badge>}
                    {deviated && (
                      <Badge variant="outline" className="text-[10px]" data-testid={`lim-deviated-${f.key}`}>
                        已偏离默认
                      </Badge>
                    )}
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
                  {/* 默认值（R1-uxw-10）：服务端 `defaults` 一直在下发却从不渲染，
                      "恢复默认/档位"因此是盲操作 —— 不知道默认是多少、当前是否已是默认。 */}
                  <p className="text-xs text-muted-foreground" data-testid={`lim-default-${f.key}`}>
                    {typeof def === 'number' ? `默认 ${def}${r?.unit ? ` ${r.unit}` : ''}` : '默认值：服务端未下发'}
                  </p>
                </div>
              )
            })}
          </CardContent>
        </Card>
      ))}

      <div className="flex items-center gap-2">
        {/* R1-uxw-14：禁用原因不能只写在 title 上（禁用按钮不可聚焦 ⇒ 键盘/读屏
            用户拿不到"为什么点不动"）。可读原因放常驻节点，禁用按钮用
            aria-describedby 指过去；只读说明本身是**可见文本**，不藏在 tooltip 里。 */}
        <Button
          onClick={save}
          disabled={!canWrite || busy || !dirty}
          aria-describedby={!canWrite ? 'limits-readonly-note' : undefined}
          data-testid="save-limits"
        >
          <Save className="mr-1 h-4 w-4" />保存并生效
        </Button>
        <Button
          variant="outline"
          onClick={reset}
          disabled={!canWrite || busy}
          aria-describedby={!canWrite ? 'limits-readonly-note' : undefined}
          data-testid="reset-limits"
        >
          <RotateCcw className="mr-1 h-4 w-4" />恢复默认/档位
        </Button>
        {!canWrite && (
          <span id="limits-readonly-note" data-testid="limits-readonly-note" className="text-xs text-muted-foreground">
            <AlertTriangle className="mr-1 inline h-3 w-3" />当前账号只读（需要能力中心写入权限），保存/恢复默认都已禁用
          </span>
        )}
      </div>
    </div>
  )
}
