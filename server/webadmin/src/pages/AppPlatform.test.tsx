import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
// 2026-09-19 页面合并:原「应用平台」页(`/app-platform`)并入应用中心成为「限制项」
// 子页 —— 组件与全部 data-testid 未变,只是换了承载它的路由与文件位置。
import Limits from './app-center/Limits'
import { ApiError, request } from '../api'

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

    mockRequest.mockImplementationOnce(async () => ({ ...VIEW, limits: { ...LIMITS, max_instances: 8 } }) as any)
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

    mockRequest.mockImplementationOnce(async () => ({
      ...VIEW,
      limits: { ...LIMITS, instance_memory_mb: 128 },
      restart_pending: ['instance_memory_mb'],
    }) as any)
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

    // 保存失败 ⇒ 必须重新 GET 一次,把表单与水位拉回服务端的真值
    await waitFor(() => {
      const gets = mockRequest.mock.calls.filter(
        ([p, init]) => p === '/api/server/admin/wasm-apps/limits' && (init as RequestInit | undefined)?.method === undefined,
      ).length
      expect(gets).toBe(getsBefore + 1)
    })
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
