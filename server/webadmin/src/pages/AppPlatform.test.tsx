import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
// 2026-09-19 页面合并:原「应用平台」页(`/app-platform`)并入应用中心成为「限制项」
// 子页 —— 组件与全部 data-testid 未变,只是换了承载它的路由与文件位置。
import Limits from './app-center/Limits'
import { ApiError, request } from '../api'
import { setCurrentAdmin, type MeUser } from '../lib/rbac'

const mockRequest = vi.mocked(request)

/**
 * 时间预算（2026-10-01 服务端新增的六项）。
 *
 * 值取服务端的**默认值**，且满足服务端保存时校验的序关系
 * （guest 30 < 端到端墙钟 60；干跑 30 / 宿主调用 5 ≤ guest；SQL 5 ≤ 墙钟；
 * 编译 60 = 服务端 ReadTimeout）。单独抽出来是因为下面有**两处**（夹具与
 * 断言）要用同一份数字 —— 抄两份必然漂移。
 */
const TIME_BUDGETS = {
  guest_budget_seconds: 30,
  dry_run_budget_seconds: 30,
  host_call_budget_seconds: 5,
  request_wall_clock_seconds: 60,
  sql_statement_budget_seconds: 5,
  compile_timeout_seconds: 60,
}

/**
 * 夹具与后端 applimits/applimits.go 的 JSON 形状逐字对齐（跨语言契约）：
 * 视图 = { limits, source, profile, source_label, defaults, presets, ranges, budget,
 *          guard_percent, restart_fields, restart_pending, setting_key }。
 */
const LIMITS = {
  max_instances: 3,
  app_running: 4,
  app_queue: 32,
  user_global_running: 4,
  user_per_app_running: 1,
  user_per_app_queued: 4,
  instance_memory_mb: 64,
  module_cache_mb: 64,
  module_cache_idle_min: 10,
  appdb_idle_min: 3,
  appdb_cache_kib: 1024,
  app_db_readers: 4,
  // 时间预算必须排在最后：表单分组顺序 = 服务端下发的字段顺序，新组要落在「内存」之后。
  ...TIME_BUDGETS,
}

const VIEW = {
  limits: LIMITS,
  source: 'setting',
  profile: 'small',
  source_label: '控制台保存（wasm.limits）',
  defaults: { ...LIMITS, max_instances: 32, module_cache_mb: 128 },
  presets: {
    default: { ...LIMITS, max_instances: 32, module_cache_mb: 128 },
    small: LIMITS,
    large: { ...LIMITS, max_instances: 64, module_cache_mb: 256 },
  },
  ranges: {
    // 与 applimits.Ranges() **全字段**对齐（键集由下面的门禁用例对拍 Go 源码）：
    // 少一项 ⇒ 「这一格的区间/单位/重启标记」就没有任何渲染判据。
    // 上下限是对 Go 常量的逐字转写（MinInstances/MaxInstances/MaxAppQueue/…）。
    max_instances: { min: 1, max: 256, unit: '个', restart: false },
    app_running: { min: 1, max: 256, unit: '个', restart: false },
    app_queue: { min: 1, max: 4096, unit: '个', restart: false },
    user_global_running: { min: 1, max: 256, unit: '个', restart: false },
    user_per_app_running: { min: 1, max: 256, unit: '个', restart: false },
    user_per_app_queued: { min: 1, max: 4096, unit: '个', restart: false },
    instance_memory_mb: { min: 16, max: 1024, unit: 'MiB', restart: true },
    module_cache_mb: { min: 8, max: 4096, unit: 'MiB', restart: false },
    module_cache_idle_min: { min: 1, max: 1440, unit: '分钟', restart: false },
    appdb_idle_min: { min: 1, max: 1440, unit: '分钟', restart: false },
    appdb_cache_kib: { min: 128, max: 65536, unit: 'KiB', restart: false },
    app_db_readers: { min: 1, max: 16, unit: '个', restart: false },
    // 六个时间预算：下限 MinBudgetSeconds(1)；guest 上限 MaxGuestBudgetSeconds(120)，
    // 其余 MaxBudgetSeconds(300)。**restart 全 false** —— 这六项在每个请求/每次编译的
    // 入口处读当前值（只有单实例内存上限住在 wazero 的 RuntimeConfig 里）。
    guest_budget_seconds: { min: 1, max: 120, unit: '秒', restart: false },
    dry_run_budget_seconds: { min: 1, max: 300, unit: '秒', restart: false },
    host_call_budget_seconds: { min: 1, max: 300, unit: '秒', restart: false },
    request_wall_clock_seconds: { min: 1, max: 300, unit: '秒', restart: false },
    sql_statement_budget_seconds: { min: 1, max: 300, unit: '秒', restart: false },
    compile_timeout_seconds: { min: 1, max: 300, unit: '秒', restart: false },
  },
  budget: {
    // 服务端 P0-2 起 budget.profile 是 limits/setting 或 limits/profile:<name>，
    // 不再是硬写的 "settings"（这一行就是那次分叉的回归点）。
    profile: 'limits/setting',
    instances_bytes: 192 << 20,
    compile_peak_bytes: 256 << 20,
    upload_peak_bytes: 118 << 20,
    cache_resident_bytes: 64 << 20,
    // 页缓存这笔（R1-rt-8）：3 句柄 × (1+4) 条连接 × 1 MiB = 15 MiB ⇒ 四笔账 630 + 15 = 645。
    appdb_cache_bytes: 15 << 20,
    total_bytes: 645 << 20,
    available_bytes: 992 << 20,
    known: true,
    limit_bytes: 694 << 20,
    ok: true,
  },
  guard_percent: 70,
  restart_fields: ['instance_memory_mb'],
  restart_pending: [] as string[],
  setting_key: 'wasm.limits',
}

/** 平台级运行时水位（P2-4 的新端点）。 */
const RUNTIME = {
  captured_at: '2026-09-19T03:00:00Z',
  compile: {
    queue_depth: 1, queue_capacity: 64, compiling: false, child_running: true,
    cache_bytes: 128 << 20, cache_entries: 7, cache_max_bytes: 512 << 20, cache_max_entries: 256,
    compiles: 42, failures: 1, timeouts: 2, last_compile_ms: 1234,
  },
  events: { written: 900, dropped: 3, failed: 1 },
  exec: { running: 2, waiting: 5 },
  disk: { free_bytes: 8 * 1024 ** 3 },
  ready: true,
  ready_reasons: [] as string[],
  unavailable: [
    { name: 'module_cache', reason: '进程内模块缓存没有导出访问器', wiring: 'appserver.Server 增加 ModuleCacheStats()' },
    { name: 'anon_limit', reason: 'Limiter.Stats() 未注入', wiring: 'cmd/server 装配注入' },
  ],
}

/** 按路径分派:限制项视图与运行时水位是两个独立请求(互不依赖)。 */
function defaultMock() {
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
    if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
    return {} as any
  })
}

beforeEach(() => {
  mockRequest.mockReset()
  defaultMock()
})

afterEach(() => {
  setCurrentAdmin(null)
})

// ---------------------------------------------------------------------------
// 跨语言覆盖门禁(R1-uxw-10):表单字段集与账目项必须覆盖**服务端真源**。
//
// 为什么直接读 Go 源码,而不是在测试里再手写一份清单:两边各写一份 = 自证式夹具
// (审计 R1-uxw-3 的 SERVER_ACTIONS 就是这么失效的:拿自己当判据,永远绿)。
// 字段的真源是 `applimits.Limits` 的 json tag,账目项的真源是
// `readyz.MemoryBudget` 的 json tag —— 2026-09-19 服务端给内存账加了第五笔
// `appdb_cache_bytes`,既有 421 条用例一条都没红,正是这条门禁要拦的缺口。
// ---------------------------------------------------------------------------

/** 取出 Go 结构体声明里的 json tag(按声明顺序)。 */
function goStructJSONTags(relPath: string, structName: string): string[] {
  const src = readFileSync(new URL(relPath, import.meta.url), 'utf8')
  const start = src.indexOf(`type ${structName} struct {`)
  if (start < 0) throw new Error(`未在 ${relPath} 找到 type ${structName} struct`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`未在 ${relPath} 找到 type ${structName} struct 的结尾`)
  return [...src.slice(start, end).matchAll(/json:"([^",]+)"/g)].map((m) => m[1]!)
}

/**
 * 取值来源：**默认永远是仓库里的 Go 真源**。
 *
 * 环境变量只服务一件事——"门禁真会红"的变异验证：把一份被改过的 Go 源副本喂给
 * 用例（例如给 `applimits.Limits` 加一个 `future_knob` 字段），断言门禁立刻点名。
 * CI 不设这两个变量，因此门禁读的就是真源本身。
 */
const GO_FIELD_SOURCE = process.env.PICOAI_GO_LIMITS_SRC ?? '../../../internal/wasmapp/applimits/applimits.go'
const GO_BUDGET_SOURCE = process.env.PICOAI_GO_BUDGET_SRC ?? '../../../internal/wasmapp/readyz/readyz.go'

/** 服务端 Limits 的 wire 字段集(= 前端表单必须覆盖的那个集合)。 */
function goLimitFields(): string[] {
  return goStructJSONTags(GO_FIELD_SOURCE, 'Limits')
}

/**
 * 取出 Go 源码里某个函数的**函数体**（从签名起到下一个顶层 `}` 为止）。
 *
 * 只用来读**带引号的 map 键**，不求值任何表达式 —— 数字仍由 Go 持有（前端抄常量
 * 就是第二份真源）。取不到签名/结尾一律 throw（夹具早就漂了，静默返回空数组会让
 * 下游门禁变成空转）。
 */
function goFuncBody(relPath: string, signature: string): string {
  const src = readFileSync(new URL(relPath, import.meta.url), 'utf8')
  const start = src.indexOf(signature)
  if (start < 0) throw new Error(`未在 ${relPath} 找到 ${signature}`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`未在 ${relPath} 找到 ${signature} 的结尾`)
  return src.slice(start, end)
}

/**
 * `applimits.Ranges()` 里的字段集 = 控制台必须能渲染「区间/单位/重启标记」的字段集。
 *
 * 按行取键（Go 的 map 字面量一行一项），比正则扫全文稳。
 *
 * ⚠️ 双引号写成 `\x22` 是**刻意的**，不是炫技：`src/lib/nav.test.ts` 的掩码器
 * （maskSource）按字符扫描引号维持状态机，正则字面量里的**裸引号**会让它错进字符串态，
 * 于是它扫不到后面的用例体、把那条守卫判成「登记的测试名不存在」。本文件里已有的
 * 那个 json tag 正则就是这种形态（三个引号、奇数），基线只是靠「很快又遇到下一个引号」
 * 侥幸重新同步。这里一个裸引号都不放，别让它再被带偏。
 */
function goRangeFields(): string[] {
  const body = goFuncBody(GO_FIELD_SOURCE, 'func Ranges() map[string]Range {')
  const keys: string[] = []
  for (const line of body.split('\n')) {
    const m = /^\s*\x22([a-z0-9_]+)\x22\s*:/.exec(line)
    if (m !== null) keys.push(m[1]!)
  }
  return keys
}

/** 预算里"不是账目项"的三个 `*_bytes`:入参 available、派生上限 limit、合计 total。 */
const NON_ACCOUNT_BUDGET_KEYS = new Set(['available_bytes', 'limit_bytes', 'total_bytes'])

/** 预算里的账目项(每一笔都必须有明细行)。 */
function budgetAccountKeys(budget: Record<string, unknown>): string[] {
  return Object.keys(budget).filter((k) => k.endsWith('_bytes') && !NON_ACCOUNT_BUDGET_KEYS.has(k))
}

function goBudgetAccounts(): string[] {
  return budgetAccountKeys(
    Object.fromEntries(goStructJSONTags(GO_BUDGET_SOURCE, 'MemoryBudget').map((t) => [t, 0])),
  )
}

/** 页面上"一行"的三要素(缺失记 null)。 */
interface RenderedRow {
  input: unknown
  label: string | null
  def: string | null
}

/**
 * 覆盖判定(抽成纯函数,便于自证"门禁不是空转")。
 *
 * 返回服务端字段里**页面没覆盖到**的那些:没有表单格(看不见的旋钮)、只有裸 key
 * (没有可读标签)、没有默认值。生产实现里这个列表必须为空。
 */
function uncoveredFields(goFields: string[], row: (key: string) => RenderedRow): string[] {
  const problems: string[] = []
  for (const f of goFields) {
    const r = row(f)
    if (r.input === null || r.input === undefined) problems.push(`${f}: 表单里没有这一格(看不见的旋钮)`)
    else if (r.label === null || r.label === f) problems.push(`${f}: 只有裸 key,没有可读标签`)
    else if (r.def === null || !r.def.includes('默认')) problems.push(`${f}: 没有显示默认值`)
  }
  return problems
}

/** 账目项覆盖判定:服务端每一笔账都必须有明细行。 */
function uncoveredAccounts(goAccounts: string[], has: (key: string) => boolean): string[] {
  return goAccounts.filter((k) => !has(k)).map((k) => `${k}: 没有明细行`)
}

describe('应用中心 · 限制项（原应用平台页）', () => {
  it('渲染当前值、来源与四笔账预览', async () => {
    render(<Limits />)

    expect(await screen.findByRole('heading', { name: '限制项' })).toBeTruthy()
    expect(screen.getByTestId('lim-max_instances')).toHaveProperty('value', '3')
    expect(screen.getByTestId('lim-instance_memory_mb')).toHaveProperty('value', '64')
    // 理论峰值 = 四笔账 630 + 页缓存 15（编辑期按表单值重算）＝ 645 MiB（R1-rt-8）。
    expect(screen.getByTestId('budget-line').textContent).toContain('645 MiB')
    expect(screen.getByTestId('budget-line').textContent).toContain('694 MiB')
    expect(screen.getByTestId('budget-badge').textContent).toContain('正常')
  })

  it('来源显示服务端的 source_label(含档位/设置键),而不是前端自己推断', async () => {
    render(<Limits />)
    await screen.findByTestId('lim-max_instances')
    // P1-6 的一部分:管理员要能一眼看出"当前值来自哪个档位/设置"。
    // 服务端的 limitsSourceLabel 是唯一真源(档位名与设置键都住在服务端)。
    expect(screen.getByTestId('limits-source').textContent).toContain('控制台保存（wasm.limits）')
    // P2-2(2026-09-20 本机实测):这里曾经再追加一个 `（{setting_key}）`,而服务端 label
    // 已经把设置键拼进去了 ⇒ 渲染成「控制台保存（wasm.limits）（wasm.limits）」。
    // 判据必须是**出现次数**(toContain 对重复显示没有任何牙齿)。
    const sourceText = screen.getByTestId('limits-source').textContent ?? ''
    const hits = sourceText.split('wasm.limits').length - 1
    expect(hits).toBe(1)
  })

  it('source_label 缺失时回落旧文案(不显示空白)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') {
        return { ...VIEW, source: 'profile', source_label: '' } as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)
    await screen.findByTestId('lim-max_instances')
    expect(screen.getByTestId('limits-source').textContent).toContain('部署档位')
  })

  it('编辑后才允许保存，并把新值以 PUT 提交', async () => {
    render(<Limits />)
    const save = await screen.findByTestId('save-limits') as HTMLButtonElement
    expect(save.disabled).toBe(true) // 未改动 ⇒ 不可保存

    fireEvent.change(screen.getByTestId('lim-max_instances'), { target: { value: '8' } })
    expect(save.disabled).toBe(false)

    // F5 起保存前会先重读一次服务端真值（GET），因此 PUT 的应答按 method 分派，
    // 不能再用 mockImplementationOnce（那会被重读吃掉）。
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        return { ...VIEW, limits: { ...LIMITS, max_instances: 8 } } as any
      }
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    fireEvent.click(save)

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/limits',
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    const put = mockRequest.mock.calls.find(
      ([p, init]) => p === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT',
    )
    const body = JSON.parse(String((put![1] as RequestInit).body))
    expect(body.limits.max_instances).toBe(8)
    // 保存成功后给出即时生效的提示（无重启项）。
    expect(await screen.findByTestId('limits-flash')).toBeTruthy()
  })

  it('需重启的字段：保存后展示待重启徽标与提示', async () => {
    render(<Limits />)
    const mem = await screen.findByTestId('lim-instance_memory_mb')
    fireEvent.change(mem, { target: { value: '128' } })

    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        return {
          ...VIEW,
          limits: { ...LIMITS, instance_memory_mb: 128 },
          restart_pending: ['instance_memory_mb'],
        } as any
      }
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    fireEvent.click(screen.getByTestId('save-limits'))

    expect((await screen.findByTestId('restart-pending')).textContent).toContain('instance_memory_mb')
    expect(screen.getByTestId('limits-flash').textContent).toContain('需重启')
  })

  it('超出水位时保存按钮仍可点，但错误提示如实展示服务端拒绝', async () => {
    render(<Limits />)
    fireEvent.change(await screen.findByTestId('lim-max_instances'), { target: { value: '200' } })

    // 编辑期预览应立即变成"超出水位"（同一公式的本地估算）
    expect(screen.getByTestId('budget-line').textContent).toContain('超出水位')

    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        // 真实信封:message + details.field + hints（P1-6 之后全部要显示出来）
        throw new ApiError(
          400, 'VALIDATION',
          '这组限制项的理论内存峰值超过可用内存的安全水位',
          undefined,
          ['把全局并发实例数调到 4 以内'],
          { field: 'max_instances' },
        )
      }
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    fireEvent.click(screen.getByTestId('save-limits'))
    const err = await screen.findByTestId('limits-error')
    expect(err.textContent).toContain('超过可用内存')
    // hints 与被拒字段也要显示(服务端说清楚了原因,页面不能只留一句 message)
    expect(err.textContent).toContain('把全局并发实例数调到 4 以内')
    expect(err.textContent).toContain('字段 max_instances')
  })

  it('保存被拒后重新拉取服务端真值(P2-2:红字与绿色水位不能同屏)', async () => {
    render(<Limits />)
    fireEvent.change(await screen.findByTestId('lim-max_instances'), { target: { value: '200' } })
    expect(screen.getByTestId('budget-badge').textContent).toContain('超出')

    const getsBefore = mockRequest.mock.calls.filter(
      ([p, init]) => p === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === undefined,
    ).length
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        throw new ApiError(400, 'VALIDATION', '超过可用内存的安全水位', undefined, [], { field: 'max_instances' })
      }
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    fireEvent.click(screen.getByTestId('save-limits'))

    // 保存失败 ⇒ 必须重新 GET 一次,把表单与水位拉回服务端的真值。
    // F5 起 GET 有两次：**保存前的重读**（防覆盖）与失败后的回拉。计数断言按 2 计，
    // 并额外钉住顺序（失败回拉发生在 PUT 之后）。
    await waitFor(() => {
      const calls = mockRequest.mock.calls.filter(
        ([p, init]) => p === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === undefined,
      )
      expect(calls.length).toBe(getsBefore + 2)
    })
    const putIndex = mockRequest.mock.calls.findIndex(
      ([p, init]) => p === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT',
    )
    const lastGetIndex = mockRequest.mock.calls.reduce(
      (last, [, init], i) => ((init as RequestInit | undefined)?.method === undefined ? i : last), -1,
    )
    expect(putIndex).toBeGreaterThan(-1)
    expect(lastGetIndex).toBeGreaterThan(putIndex)
    // 表单回到服务端的 3(不再停在被拒的 200 上),绿色水位也随之回到"正常"
    await waitFor(() => {
      expect(screen.getByTestId('lim-max_instances')).toHaveProperty('value', '3')
      expect(screen.getByTestId('budget-badge').textContent).toContain('正常')
    })
    // 错误仍然可见(重拉不是"把错误吞掉")
    expect(screen.getByTestId('limits-error').textContent).toContain('超过可用内存')
  })

  it('首屏读取失败 → 错误态 + 重试按钮(P2-1:此前是永久骨架屏)', async () => {
    let fail = true
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') {
        if (fail) throw new ApiError(503, 'INTERNAL', '服务暂时不可用,请稍后再试', undefined, ['稍后重试或联系运维'])
        return VIEW as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)

    // 错误块此前写在 `return <Skeleton/>` 之后 —— 永远不可达(用户只看到骨架屏)。
    const err = await screen.findByTestId('limits-error')
    expect(err.textContent).toContain('服务暂时不可用')
    expect(err.textContent).toContain('稍后重试或联系运维')
    // 重试按钮是唯一出路(否则只能刷新整页)
    const retry = screen.getByTestId('limits-retry')

    fail = false
    fireEvent.click(retry)
    expect(await screen.findByTestId('lim-max_instances')).toHaveProperty('value', '3')
    expect(screen.queryByTestId('limits-error')).toBeNull()
  })

  it('刷新按钮重新拉取限制项与运行时水位(P2-2 的刷新入口)', async () => {
    render(<Limits />)
    await screen.findByTestId('lim-max_instances')
    const limitsBefore = mockRequest.mock.calls.filter(([p]) => p === '/api/server/admin/wasm-apps/limits').length
    const runtimeBefore = mockRequest.mock.calls.filter(([p]) => p === '/api/server/admin/wasm-apps/runtime').length

    fireEvent.click(screen.getByTestId('limits-refresh'))
    await waitFor(() => {
      expect(mockRequest.mock.calls.filter(([p]) => p === '/api/server/admin/wasm-apps/limits').length).toBe(limitsBefore + 1)
      expect(mockRequest.mock.calls.filter(([p]) => p === '/api/server/admin/wasm-apps/runtime').length).toBe(runtimeBefore + 1)
    })
  })

  it('套用档位预设会填充表单（不直接保存）', async () => {
    render(<Limits />)
    fireEvent.click(await screen.findByText('套用大内存档'))
    expect(screen.getByTestId('lim-max_instances')).toHaveProperty('value', '64')
    expect(screen.getByTestId('lim-module_cache_mb')).toHaveProperty('value', '256')
    // 仍在编辑态：没有发任何写请求
    const writes = mockRequest.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET',
    )
    expect(writes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 管理端并发（F5，审计第二轮 A2-F5）：限制项的 PUT 是**整份覆盖**（服务端
// applimits.Parse 要求完整对象、无版本号/ETag），打开页面时的快照直接提交会把
// 另一位管理员刚保存的字段静默改回。修法 = 保存前重读 + 只提交我改过的字段；
// 重读失败一律不发 PUT（fail-closed）。
// ---------------------------------------------------------------------------

describe('应用中心 · 限制项 · 并发保存(F5)', () => {
  /** 另一位管理员保存后的服务端状态（app_queue 32 → 99）。 */
  const OTHER_ADMIN = { ...LIMITS, app_queue: 99 }

  it('只覆盖我改过的字段：别人刚改的 app_queue 不被改回（PUT body 里是 99，不是 32）', async () => {
    let limitsGets = 0
    let putBody: { limits: Record<string, number> } | null = null
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        putBody = JSON.parse(String((init as RequestInit).body)) as { limits: Record<string, number> }
        return { ...VIEW, limits: { ...OTHER_ADMIN, max_instances: 8 } } as any
      }
      if (path === '/api/server/admin/wasm-apps/limits') {
        limitsGets += 1
        // 第 1 次 = 打开页面（32）；之后的 = 保存前重读（别人已经改成 99）。
        return { ...VIEW, limits: limitsGets === 1 ? LIMITS : OTHER_ADMIN } as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)
    fireEvent.change(await screen.findByTestId('lim-max_instances'), { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('save-limits'))

    await waitFor(() => { expect(putBody).not.toBeNull() })
    expect(putBody!.limits.max_instances).toBe(8) // 我改的
    // 旧实现这里会是 32 ⇒ 把别人的 99 静默改回去。
    expect(putBody!.limits.app_queue).toBe(99)
    expect(limitsGets).toBeGreaterThanOrEqual(2) // 保存前的重读真的发生了
  })

  it('我改的字段也被别人改过 ⇒ 以我输入的值提交，但必须在反馈里说出来（不静默覆盖）', async () => {
    let limitsGets = 0
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        return { ...VIEW, limits: { ...LIMITS, max_instances: 8 } } as any
      }
      if (path === '/api/server/admin/wasm-apps/limits') {
        limitsGets += 1
        return { ...VIEW, limits: limitsGets === 1 ? LIMITS : { ...LIMITS, max_instances: 5 } } as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)
    fireEvent.change(await screen.findByTestId('lim-max_instances'), { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('save-limits'))

    const flash = await screen.findByTestId('limits-flash')
    expect(flash.textContent).toContain('max_instances')
    expect(flash.textContent).toContain('也被改过')
  })

  it('保存前重读失败 ⇒ 不发 PUT（宁可拒绝，也不拿旧快照覆盖别人）', async () => {
    let limitsGets = 0
    let puts = 0
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        puts += 1
        return VIEW as any
      }
      if (path === '/api/server/admin/wasm-apps/limits') {
        limitsGets += 1
        if (limitsGets > 1) throw new ApiError(503, 'INTERNAL', '暂时读不到限制项')
        return VIEW as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)
    fireEvent.change(await screen.findByTestId('lim-max_instances'), { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('save-limits'))

    const err = await screen.findByTestId('limits-error')
    expect(err.textContent).toContain('保存已取消')
    expect(puts).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 未识别账目项必须真的进总账（F1，审计第二轮 A2-F1）：旧实现只把它显示出来，
// 理论峰值/水位徽标一字不变，而提示语却写着"已计入" ⇒ 管理员照着"可以保存"
// 去点保存会被服务端 400 拒。
// ---------------------------------------------------------------------------

describe('应用中心 · 限制项 · 未识别账目项进总账(F1)', () => {
  const EXTRA = 100 << 20

  function withFutureAccount(value: unknown) {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') {
        return {
          ...VIEW,
          budget: { ...VIEW.budget, future_account_bytes: value, total_bytes: (645 << 20) + EXTRA },
        } as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
  }

  it('加 100 MiB 新账目项 ⇒ 理论峰值 645 → 745 MiB，水位判定跟着翻成"超出"', async () => {
    withFutureAccount(EXTRA)
    render(<Limits />)
    await screen.findByTestId('budget-unknown-accounts')

    const line = screen.getByTestId('budget-line')
    expect(line.textContent).toContain('745 MiB') // 645 + 100（旧实现恒为 645）
    expect(line.textContent).toContain('超出水位')
    const badge = screen.getByTestId('budget-badge')
    expect(badge.textContent).not.toContain('正常')
    // 提示语必须给出金额（"已计入"要能被核对，而不是一句话）
    const box = screen.getByTestId('budget-unknown-accounts')
    expect(box.textContent).toContain('future_account_bytes')
    expect(box.textContent).toContain('100 MiB')
    expect(box.textContent).toContain('已计入')
  })

  it('值不是数字 ⇒ 不得声称已计入（形状漂移与"已计入"必须分开说）', async () => {
    withFutureAccount('100MiB')
    render(<Limits />)
    const box = await screen.findByTestId('budget-unknown-accounts')
    expect(box.textContent).toContain('future_account_bytes')
    expect(box.textContent).toContain('不是数字')
    expect(box.textContent).toContain('没有')
    // 未计入 ⇒ 峰值仍是 645（不含那个解析不出的值）
    expect(screen.getByTestId('budget-line').textContent).toContain('645 MiB')
  })

  // 预览与服务端必须是**同一判据**（同一份账目集合 + 同一份水位规则）：
  // 页面说"可以保存" ⇔ 服务端 budget.ok。这是"改回宽松判据必红"的对照用例 ——
  // 本地只要漏掉任何一笔账（例如新账目项），边界上就会与服务端结论相反。
  it('预览结论 ⇔ 服务端 budget.ok（同一判据，边界两侧都测）', async () => {
    const cases = [
      { extra: 0, serverOk: true },          // 645 ≤ 694
      { extra: 49 << 20, serverOk: true },   // 694 ≤ 694（正好在水位上）
      { extra: 50 << 20, serverOk: false },  // 695 > 694（越界 1 MiB）
      { extra: 100 << 20, serverOk: false }, // 745 > 694
    ]
    for (const c of cases) {
      mockRequest.mockReset()
      mockRequest.mockImplementation(async (path: string) => {
        if (path === '/api/server/admin/wasm-apps/limits') {
          return {
            ...VIEW,
            budget: {
              ...VIEW.budget,
              future_account_bytes: c.extra,
              total_bytes: (645 << 20) + c.extra,
              ok: c.serverOk,
            },
          } as any
        }
        if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
        return {} as any
      })
      const { unmount } = render(<Limits />)
      await screen.findByTestId('lim-max_instances')
      const line = screen.getByTestId('budget-line').textContent ?? ''
      const localOk = line.includes('可以保存')
      expect(localOk, `新账目项 ${c.extra / (1 << 20)} MiB：本地说"${localOk ? '可以保存' : '会被拒绝'}"`).toBe(c.serverOk)
      // 未编辑时显示的总账必须就是服务端那一份 total_bytes（不是"另一套算法凑出来的数"）
      expect(line).toContain(`${Math.round(((645 << 20) + c.extra) / (1 << 20))} MiB`)
      unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// 运行时水位卡片(P2-4:水位此前零出口;放在限制项页是因为它正是限制项在运行期
// 的表现 —— 管理员调完并发/内存,下一步就是看实际水位)
// ---------------------------------------------------------------------------

describe('应用中心 · 限制项 · 运行时水位', () => {
  it('渲染编译队列/缓存、执行槽、事件计数与磁盘余量', async () => {
    render(<Limits />)
    await screen.findByTestId('runtime-card')

    expect(screen.getByTestId('runtime-compile-queue').textContent).toContain('1 / 64')
    expect(screen.getByTestId('runtime-compile-cache').textContent).toContain('7 条')
    expect(screen.getByTestId('runtime-compile-cache').textContent).toContain('128 MiB')
    expect(screen.getByTestId('runtime-exec').textContent).toContain('2 / 5')
    expect(screen.getByTestId('runtime-disk').textContent).toContain('8192 MiB')
    expect(screen.getByTestId('runtime-compile-counters').textContent).toContain('42')
    expect(screen.getByTestId('runtime-events').textContent).toContain('丢弃 3')
  })

  it('缺口清单如实显示(没有出口的水位不能被读成 0)', async () => {
    render(<Limits />)
    const box = await screen.findByTestId('runtime-unavailable')
    expect(box).toHaveTextContent('module_cache')
    expect(box).toHaveTextContent('anon_limit')
    expect(box).toHaveTextContent('不是 0，是取不到')
  })

  it('运行时水位读取失败只影响这张卡(限制项照常可用,且错误可读)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') {
        throw new ApiError(403, 'FORBIDDEN', '没有权限执行该操作', undefined, ['需要 capability:read 权限'])
      }
      return {} as any
    })
    render(<Limits />)
    expect(await screen.findByTestId('runtime-error')).toHaveTextContent('需要 capability:read 权限')
    // 限制项本身照常渲染(两块信息互不依赖)
    expect(screen.getByTestId('lim-max_instances')).toHaveProperty('value', '3')
  })
})

// ---------------------------------------------------------------------------
// 内存水位口径(R1-uxw-6):服务端是 "available<0 ⇒ 未知、不判定;==0 ⇒ 真的没有 ⇒
// 判定失败"(readyz.ComputeMemoryBudgetFor 是唯一真源)。旧实现把两者都写成
// `available_bytes <= 0 || total <= limit` ⇒ 同一屏上绿徽标 + "可以保存"。
// ---------------------------------------------------------------------------

describe('应用中心 · 限制项 · 可用内存口径(R1-uxw-6)', () => {
  /** 换一份预算(其余视图字段照旧)。 */
  function withBudget(patch: Record<string, unknown>) {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') {
        return { ...VIEW, budget: { ...VIEW.budget, ...patch } } as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
  }

  it('available_bytes=0(真的没有可用内存)⇒ 判定失败,绝不显示"正常/可以保存"', async () => {
    withBudget({ available_bytes: 0, known: true, limit_bytes: 0, ok: false })
    render(<Limits />)
    await screen.findByTestId('lim-max_instances')

    const badge = screen.getByTestId('budget-badge')
    const line = screen.getByTestId('budget-line')
    // 0 是"确实没有余量",不是"内存充足"
    expect(badge.textContent).not.toContain('正常')
    expect(badge.textContent).toContain('超出')
    expect(line.textContent).not.toContain('可以保存')
    expect(line.textContent).toContain('可用 0 MiB')
    expect(line.textContent).toContain('超出水位')
    expect(line.textContent).toContain('确实没有余量')
  })

  it('available_bytes=-1 且 known=false(读不到)⇒ 显式"未判定",且不得把未知显示成 0', async () => {
    withBudget({ available_bytes: -1, known: false, limit_bytes: 0, ok: true })
    render(<Limits />)
    await screen.findByTestId('lim-max_instances')

    const badge = screen.getByTestId('budget-badge')
    const line = screen.getByTestId('budget-line')
    // 未知既不是"正常"也不是"0 MiB"
    expect(badge.textContent).toContain('未知')
    expect(badge.textContent).toContain('未判定')
    expect(badge.textContent).not.toContain('正常')
    expect(line.textContent).toContain('读不到')
    expect(line.textContent).toContain('不是 0')
    expect(line.textContent).toContain('不判定')
    expect(line.textContent).not.toContain('-1 MiB')
    expect(line.textContent).not.toContain('可以保存')
  })

  it('available_bytes 正常且未超水位时仍然说"可以保存"(没有把正常路径改坏)', async () => {
    render(<Limits />)
    await screen.findByTestId('lim-max_instances')
    expect(screen.getByTestId('budget-badge').textContent).toContain('正常')
    expect(screen.getByTestId('budget-line').textContent).toContain('可以保存')
  })
})

// ---------------------------------------------------------------------------
// 覆盖门禁(R1-uxw-10):字段集/账目项以服务端为真源。
// ---------------------------------------------------------------------------

describe('应用中心 · 限制项 · 字段集覆盖门禁(R1-uxw-10)', () => {
  it('applimits.Limits 的每个 json 字段都有表单行 + 描述的标签 + 默认值(Go 加旋钮必红)', async () => {
    const goFields = goLimitFields()
    expect(goFields.length, '解析 Go 结构体失败 ⇒ 本用例失去意义').toBeGreaterThanOrEqual(12)
    // 夹具 = "服务端会下发的字段集":它必须与 Go 的 wire 契约逐字一致。
    // 服务端加字段时这条**先**红,而不是像 appdb_cache_bytes 那次一样一条都不红。
    expect(Object.keys(LIMITS).sort()).toEqual([...goFields].sort())

    render(<Limits />)
    await screen.findByTestId('lim-max_instances')
    const row = (f: string): RenderedRow => ({
      input: screen.queryByTestId(`lim-${f}`),
      label: screen.queryByTestId(`lim-label-${f}`)?.textContent ?? null,
      def: screen.queryByTestId(`lim-default-${f}`)?.textContent ?? null,
    })
    // 空数组 = 服务端每个字段都有格、有标签、有默认值
    expect(uncoveredFields(goFields, row)).toEqual([])
  })

  it('applimits.Ranges() 的每个字段都有区间/单位/重启标记(夹具键集与 Go 逐字一致)', async () => {
    const goRanges = goRangeFields()
    expect(goRanges.length, '解析 Go Ranges() 失败 ⇒ 本用例失去意义').toBeGreaterThanOrEqual(12)
    // 三方对链:Go 的 Ranges() 键集 == 夹具的 ranges 键集 == 字段集(Go 的 json tag/LIMITS)。
    // 服务端加一个带区间的旋钮而夹具没跟上 ⇒ 这条**先**红;否则那一格的
    // 区间/单位/重启标记就成了没有任何渲染判据的死角(2026-10-01 的六个时间预算
    // 正是这么进来的:页面渲染的是服务端下发的 ranges,夹具不补就测不到)。
    expect(Object.keys(VIEW.ranges).sort()).toEqual([...goRanges].sort())
    expect([...goRanges].sort()).toEqual(Object.keys(LIMITS).sort())

    render(<Limits />)
    await screen.findByTestId('lim-max_instances')
    for (const f of goRanges) {
      expect(screen.queryByTestId(`lim-${f}`), `${f} 没有表单格`).not.toBeNull()
    }
  })

  it('门禁不是空转:同一个判定对"服务端多出来的字段"会当场点名', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') {
        return { ...VIEW, limits: { ...LIMITS, future_knob: 7 } } as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)
    await screen.findByTestId('lim-future_knob')
    const row = (f: string): RenderedRow => ({
      input: screen.queryByTestId(`lim-${f}`),
      label: screen.queryByTestId(`lim-label-${f}`)?.textContent ?? null,
      def: screen.queryByTestId(`lim-default-${f}`)?.textContent ?? null,
    })
    // ① 完全没有渲染过的字段 ⇒ 点名"看不见的旋钮"(这就是 Go 加字段而前端没跟上的形态)
    expect(uncoveredFields(['brand_new_knob'], row)).toEqual(['brand_new_knob: 表单里没有这一格(看不见的旋钮)'])
    // ② 渲染了但只有裸 key(动态兜底行)⇒ 点名"没有可读标签",要求补元数据
    expect(uncoveredFields(['future_knob'], row)).toEqual(['future_knob: 只有裸 key,没有可读标签'])
  })

  it('readyz.MemoryBudget 的每一笔账都有明细行(第五笔 appdb_cache_bytes 就这么被抓住)', async () => {
    const goAccounts = goBudgetAccounts()
    expect(goAccounts.length, '解析 Go 账目项失败 ⇒ 本用例失去意义').toBeGreaterThanOrEqual(5)
    expect(goAccounts).toContain('appdb_cache_bytes')
    // 夹具的账目项必须与 Go 结构体逐字一致(加第六笔 ⇒ 这条先红)
    expect(budgetAccountKeys(VIEW.budget).sort()).toEqual([...goAccounts].sort())

    render(<Limits />)
    await screen.findByTestId('budget-account-instances_bytes')
    expect(uncoveredAccounts(goAccounts, (k) => screen.queryByTestId(`budget-account-${k}`) !== null)).toEqual([])
    // 判定本身有效:不存在的账目项会被点名
    expect(uncoveredAccounts(['brand_new_account_bytes'], (k) => screen.queryByTestId(`budget-account-${k}`) !== null))
      .toEqual(['brand_new_account_bytes: 没有明细行'])
  })

  it('服务端下发了前端不认识的旋钮时也必须出现在表单里(不能隐形)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') {
        return { ...VIEW, limits: { ...LIMITS, future_knob: 7 } } as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)
    // 动态渲染:字段集以响应为准(旧实现按前端手写的 12 项渲染 ⇒ 这一格根本不存在)
    const input = await screen.findByTestId('lim-future_knob')
    expect(input).toHaveProperty('value', '7')
    expect(screen.getByTestId('lim-label-future_knob').textContent).toContain('future_knob')
    expect(screen.getByText('服务端新增')).toBeTruthy()
  })

  it('服务端新增了未识别的账目项时页面必须明说(不能静静计入 total)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') {
        return { ...VIEW, budget: { ...VIEW.budget, future_account_bytes: 3 << 20 } } as any
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)
    const box = await screen.findByTestId('budget-unknown-accounts')
    expect(box.textContent).toContain('future_account_bytes')
  })
})

// ---------------------------------------------------------------------------
// 时间预算（2026-10-01 服务端新增的六项）：过去是 limits 包的编译期常量，
// 「某个应用就是慢」只能重建镜像；现在收进控制台。这一组在**服务端保存时**按序关系
// fail-loud（applimits.Validate），页面只做两件事：
//   1. 如实渲染服务端下发的值/区间/单位（不自己写第二份判据）；
//   2. 把服务端的拒绝（400 + details.field）原样转达给操作员。
// ---------------------------------------------------------------------------

describe('应用中心 · 限制项 · 时间预算(2026-10-01 新增)', () => {
  /**
   * 本页给这六项的元数据（标签/单位/上下限/语义提示）。
   *
   * 提示必须**逐字**是页面渲染的那份：这六项只有「服务端 ranges + 本页 hint」
   * 两处解释，说错一句运维就会把预算调反（例如把干跑调得比 guest 短 = 发布被误拒）。
   */
  const ROWS: { key: string; label: string; unit: string; min: number; max: number; hint: string }[] = [
    {
      key: 'guest_budget_seconds', label: 'guest 执行预算', unit: '秒', min: 1, max: 120,
      hint: '应用单次请求里真正执行的时长上限；等数据库/等宿主调用时暂停计时。调大等于允许更长的单次计算，端到端墙钟仍然封顶',
    },
    {
      key: 'dry_run_budget_seconds', label: '发布干跑预算', unit: '秒', min: 1, max: 300,
      hint: '发布/预检时用合成帧跑一次真实实例化的预算；建议与 guest 预算一致，调得比它短会把线上跑得动的应用挡在发布门外',
    },
    {
      key: 'host_call_budget_seconds', label: '宿主调用预算', unit: '秒', min: 1, max: 300,
      hint: 'db.* / log / assets.read 等宿主调用的硬超时；它不被 guest 的暂停计时覆盖，两者独立',
    },
    {
      key: 'request_wall_clock_seconds', label: '请求端到端墙钟', unit: '秒', min: 1, max: 300,
      hint: '含排队等待；到点即拒。必须严格大于 guest 预算。注意：客户端应用请求的出站预算是随包固定的 75 秒（必须晚于本值，否则员工只会看到网络错误）',
    },
    {
      key: 'sql_statement_budget_seconds', label: '单条 SQL 硬超时', unit: '秒', min: 1, max: 300,
      hint: '到点由看门狗回滚并打污染标记；不得超过端到端墙钟',
    },
    {
      key: 'compile_timeout_seconds', label: '编译超时', unit: '秒', min: 1, max: 300,
      hint: '单次编译（含执行侧装载模块）的超时；不得超过服务端 ReadTimeout（60 秒，传输层常量不可配置）',
    },
  ]

  it('六个字段按服务端下发值渲染(值/标签/单位/区间/语义,且都不需要重启)', async () => {
    // 表与夹具必须同集合：漏一项就等于「这一格没有被断言过」。
    expect(ROWS.map((r) => r.key).sort()).toEqual(Object.keys(TIME_BUDGETS).sort())

    render(<Limits />)
    await screen.findByTestId('lim-max_instances')

    for (const row of ROWS) {
      const input = screen.getByTestId(`lim-${row.key}`)
      // 值来自**服务端下发的 limits**（页面不自己算默认值）
      expect(input, `${row.key} 没有渲染`).toHaveProperty('value', String(TIME_BUDGETS[row.key as keyof typeof TIME_BUDGETS]))
      // 区间也要落到 input 的 min/max 上（浏览器侧校验与提示同源）
      expect(input).toHaveAttribute('min', String(row.min))
      expect(input).toHaveAttribute('max', String(row.max))
      // 标签 + 即时生效：六项 restart 全 false ⇒ 不得挂「需重启」徽标
      const label = screen.getByTestId(`lim-label-${row.key}`)
      expect(label.textContent).toContain(row.label)
      expect(label.textContent).not.toContain('需重启')
      // 单位（秒）、区间文本与语义提示都在同一格里（管理员要能看出能填多大、填了会怎样）
      const cell = input.parentElement!.parentElement!
      expect(cell.textContent, `${row.key} 缺单位`).toContain(row.unit)
      expect(cell.textContent, `${row.key} 缺区间`).toContain(`（${row.min}–${row.max}）`)
      expect(cell.textContent, `${row.key} 的语义提示不是本页写的那份`).toContain(row.hint)
    }
    // 六项都归「时间预算」分组（新组落在「内存」之后），因此默认夹具下不该出现兜底分组
    expect(screen.getByText('时间预算')).toBeTruthy()
    expect(screen.queryByText('服务端新增')).toBeNull()
    // 分组顺序 = 服务端下发的字段顺序：新组必须落在最后（不是插在并发/内存中间）
    const [g1, g2, g3] = ['并发', '内存', '时间预算'].map((g) => screen.getByText(g))
    expect(g1!.compareDocumentPosition(g2!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(g2!.compareDocumentPosition(g3!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('PUT 提交的是完整对象(服务端拒收片段):六个时间预算字段一个都不少', async () => {
    let putBody: { limits: Record<string, number> } | null = null
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        putBody = JSON.parse(String((init as RequestInit).body)) as { limits: Record<string, number> }
        return { ...VIEW, limits: { ...LIMITS, max_instances: 8 } } as any
      }
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)
    fireEvent.change(await screen.findByTestId('lim-max_instances'), { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('save-limits'))

    await waitFor(() => { expect(putBody).not.toBeNull() })
    // 字段集必须与 Go 的 wire 契约逐字一致：少一个服务端就 400「限制项缺少字段」
    // （applimits.Parse 要求**完整对象**）。body 是按「重读的服务端对象」拼的，
    // 不是按 FIELDS 拼的 —— 这条就是那个不变量的判据。
    expect(Object.keys(putBody!.limits).sort()).toEqual([...goLimitFields()].sort())
    expect(putBody!.limits.max_instances).toBe(8) // 我改的那一格
    for (const row of ROWS) {
      // 没改过的六个时间预算必须原样带上服务端的当前值（不是缺省、不是 0、不是 null）
      expect(putBody!.limits[row.key], `${row.key} 在 PUT body 里丢了`).toBe(TIME_BUDGETS[row.key as keyof typeof TIME_BUDGETS])
    }
  })

  it('序关系被服务端拒绝(400 + details.field)⇒ message/字段/hints 原样转达给操作员', async () => {
    render(<Limits />)
    const wall = await screen.findByTestId('lim-request_wall_clock_seconds')
    // 墙钟改到 ≤ guest 预算：前端**不**自己拦（判据只有服务端一份），照常发 PUT
    fireEvent.change(wall, { target: { value: '20' } })

    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        // 真实信封（applimits.Validate 的 details.field + hints）
        throw new ApiError(
          400, 'VALIDATION',
          '端到端墙钟必须严格大于 guest 预算：否则应用还没跑完就被墙钟拒掉',
          undefined,
          ['当前 guest=30 s ⇒ 墙钟至少要 31 s'],
          { field: 'request_wall_clock_seconds' },
        )
      }
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    fireEvent.click(screen.getByTestId('save-limits'))

    // 走的是**既有那条错误通道**（页内错误块/role=alert），没有第二套提示
    const err = await screen.findByTestId('limits-error')
    expect(err).toHaveAttribute('role', 'alert')
    expect(err.textContent).toContain('必须严格大于 guest 预算') // 结论
    expect(err.textContent).toContain('字段 request_wall_clock_seconds') // 是**哪一项**越界
    expect(err.textContent).toContain('至少要 31 s') // 下一步改什么
    // 被拒的值不留在表单里（失败即回拉服务端真值，R2-2 的既有语义）
    await waitFor(() => {
      expect(screen.getByTestId('lim-request_wall_clock_seconds')).toHaveProperty('value', '60')
    })
  })
})

describe('应用中心 · 限制项 · 默认值(R1-uxw-10)', () => {
  it('每个字段显示服务端下发的默认值,并标出已偏离默认的字段', async () => {
    render(<Limits />)
    await screen.findByTestId('lim-max_instances')

    // defaults.max_instances = 32(当前 3)/ module_cache_mb = 128(当前 64)
    expect(screen.getByTestId('lim-default-max_instances').textContent).toContain('默认 32')
    expect(screen.getByTestId('lim-default-module_cache_mb').textContent).toContain('默认 128')
    expect(screen.getByTestId('lim-deviated-max_instances')).toBeTruthy()
    expect(screen.getByTestId('lim-deviated-module_cache_mb')).toBeTruthy()

    // 已经等于默认值的字段不标"已偏离"(否则标记本身就失去意义)
    expect(screen.getByTestId('lim-default-app_running').textContent).toContain('默认 4')
    expect(screen.queryByTestId('lim-deviated-app_running')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 运行时水位卡的 ready/缓存上限(R1-uxw-11):服务端一直在下发,前端声明未用。
// ---------------------------------------------------------------------------

describe('应用中心 · 限制项 · 运行时就绪与缓存上限(R1-uxw-11)', () => {
  function withRuntime(patch: Record<string, unknown>) {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') {
        return { runtime: { ...RUNTIME, ...patch } } as any
      }
      return {} as any
    })
  }

  it('ready=false 时红色横幅 + 逐条渲染 ready_reasons(平台不健康时这一页不能最安静)', async () => {
    withRuntime({ ready: false, ready_reasons: ['磁盘余量不足：1024 字节 < 1048576', '数据库不可达: dial tcp'] })
    render(<Limits />)
    const box = await screen.findByTestId('runtime-ready')
    expect(box.textContent).toContain('未就绪')
    const reasons = screen.getByTestId('runtime-ready-reasons')
    expect(reasons.textContent).toContain('磁盘余量不足')
    expect(reasons.textContent).toContain('数据库不可达')
  })

  it('ready=true 时明说"就绪",非阻塞说明(ready_reasons)同样要显示', async () => {
    withRuntime({ ready: true, ready_reasons: ['内存来源读不到（mem_source=none），内存自检被跳过'] })
    render(<Limits />)
    const box = await screen.findByTestId('runtime-ready')
    expect(box.textContent).toContain('就绪')
    expect(box.textContent).not.toContain('未就绪')
    // "没读到"必须说出来,而不是与健康态同形
    expect(screen.getByTestId('runtime-ready-reasons').textContent).toContain('内存自检被跳过')
  })

  it('服务端没下发 ready 时明说"未下发",而不是静默省略(与"健康"不同形)', async () => {
    withRuntime({ ready: undefined, ready_reasons: [] })
    render(<Limits />)
    const box = await screen.findByTestId('runtime-ready')
    expect(box.textContent).toContain('未下发')
    expect(box.textContent).not.toContain('平台就绪')
  })

  it('编译缓存同时显示用量与上限(只报 7 条看不到离上限多远)', async () => {
    render(<Limits />)
    const cache = await screen.findByTestId('runtime-compile-cache')
    expect(cache.textContent).toContain('7 条')
    expect(cache.textContent).toContain('128 MiB')
    expect(cache.textContent).toContain('上限 256 条')
    expect(cache.textContent).toContain('512 MiB')
  })

  it('缺口清单把 wiring(接哪里)也显示出来(排障工单要的就是这一行)', async () => {
    render(<Limits />)
    const box = await screen.findByTestId('runtime-unavailable')
    expect(box.textContent).toContain('接线位置')
    expect(box.textContent).toContain('ModuleCacheStats')
  })
})

// ---------------------------------------------------------------------------
// 无障碍(R1-uxw-14):反馈进 live 区;禁用原因必须是可读文本。
// ---------------------------------------------------------------------------

describe('应用中心 · 限制项 · 无障碍(R1-uxw-14)', () => {
  const READONLY: MeUser = { role: 'user', permissions: ['capability:read'] }

  it('保存成功/失败的反馈都进 live 区(读屏用户能听到结果)', async () => {
    render(<Limits />)
    const save = await screen.findByTestId('save-limits')
    fireEvent.change(screen.getByTestId('lim-max_instances'), { target: { value: '8' } })
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        return { ...VIEW, limits: { ...LIMITS, max_instances: 8 } } as any
      }
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    fireEvent.click(save)

    const flash = await screen.findByTestId('limits-flash')
    expect(flash).toHaveAttribute('role', 'status')
    expect(flash).toHaveAttribute('aria-live', 'polite')
  })

  it('首屏读取失败的错误块与保存失败同形(F4:同一个 testid 的两个出口不能一个进 live 区、一个不进)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/wasm-apps/limits') {
        throw new ApiError(503, 'INTERNAL', '服务暂时不可用,请稍后再试')
      }
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    render(<Limits />)
    // 早退分支（首屏读取失败）渲染的是**同一个**错误块：读屏用户必须能听到它。
    const err = await screen.findByTestId('limits-error')
    expect(err).toHaveAttribute('role', 'alert')
    expect(err).toHaveAttribute('aria-live', 'assertive')
    expect(screen.getByTestId('limits-retry')).toBeTruthy()
  })

  it('保存失败的红字是 alert live 区(不是普通 div)', async () => {
    render(<Limits />)
    const save = await screen.findByTestId('save-limits')
    fireEvent.change(screen.getByTestId('lim-max_instances'), { target: { value: '8' } })
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === 'PUT') {
        throw new ApiError(400, 'VALIDATION', '超过可用内存的安全水位')
      }
      if (path === '/api/server/admin/wasm-apps/limits') return VIEW as any
      if (path === '/api/server/admin/wasm-apps/runtime') return { runtime: RUNTIME } as any
      return {} as any
    })
    fireEvent.click(save)
    const err = await screen.findByTestId('limits-error')
    expect(err).toHaveAttribute('role', 'alert')
    expect(err).toHaveAttribute('aria-live', 'assertive')
  })

  it('只读账号:禁用的保存/恢复按钮指向可读的原因(不是只藏在 title 里)', async () => {
    setCurrentAdmin(READONLY)
    render(<Limits />)
    await screen.findByTestId('lim-max_instances')

    const note = screen.getByTestId('limits-readonly-note')
    expect(note.textContent).toContain('只读')
    for (const id of ['save-limits', 'reset-limits']) {
      const btn = screen.getByTestId(id) as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      expect(btn.getAttribute('aria-describedby')).toBe('limits-readonly-note')
    }
  })

  // 第三十二轮 FIX-47 子泳道 B：上一条是**负例**（只读 ⇒ 按钮禁用）。负例对
  // "权限点写错"不敏感 —— `hasPermission` 在实参匹配不上任何权限点时对**所有角色**
  // 恒 false，只读账号看到的界面与"权限点写错"时**一模一样**，所以那一条照样绿。
  // 这一条是它的另一半：显式授予 `capability:write` 时保存/档位按钮必须真的解锁
  // （只读说明整块不存在）。实参写错 ⇒ 本用例当场红。
  it('持有 capability:write 时保存与档位按钮解锁(正向夹具)', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['capability:read', 'capability:write'] })
    render(<Limits />)
    await screen.findByTestId('lim-max_instances')

    expect(screen.queryByTestId('limits-readonly-note')).toBeNull()
    const save = screen.getByTestId('save-limits') as HTMLButtonElement
    const reset = screen.getByTestId('reset-limits') as HTMLButtonElement
    // 未编辑 ⇒ 保存仍因 !dirty 禁用（那是业务规则，不是权限），但**不得**再挂只读说明。
    expect(save.getAttribute('aria-describedby')).toBeNull()
    expect(reset.disabled).toBe(false)
    for (const btn of screen.getAllByRole('button', { name: /^套用/ }) as HTMLButtonElement[]) {
      expect(btn.disabled).toBe(false)
    }
    // 改一格 ⇒ 保存解锁（证明确实是权限通过、而不是"什么都点不动"）。
    fireEvent.change(screen.getByTestId('lim-max_instances'), { target: { value: '8' } })
    expect((screen.getByTestId('save-limits') as HTMLButtonElement).disabled).toBe(false)
  })
})
