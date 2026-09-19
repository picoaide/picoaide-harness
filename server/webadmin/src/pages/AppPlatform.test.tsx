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
    max_instances: { min: 1, max: 256, unit: '个', restart: false },
    instance_memory_mb: { min: 16, max: 1024, unit: 'MiB', restart: true },
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
    expect(screen.getByTestId('limits-source').textContent).toContain('wasm.limits')
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
})
