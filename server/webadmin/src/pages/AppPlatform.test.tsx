import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AppPlatform from './AppPlatform'
import { request } from '../api'

const mockRequest = vi.mocked(request)

/**
 * 夹具与后端 applimits/applimits.go 的 JSON 形状逐字对齐（跨语言契约）：
 * 视图 = { limits, source, defaults, presets, ranges, budget, guard_percent,
 *          restart_fields, restart_pending, setting_key }。
 */
const LIMITS = {
  max_instances: 3,
  app_running: 1,
  app_queue: 32,
  user_global_running: 4,
  user_per_app_running: 1,
  user_per_app_queued: 4,
  instance_memory_mb: 64,
  module_cache_mb: 64,
  module_cache_idle_min: 10,
  appdb_idle_min: 3,
  appdb_cache_kib: 1024,
}

const VIEW = {
  limits: LIMITS,
  source: 'setting',
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
    profile: 'settings',
    instances_bytes: 192 << 20,
    compile_peak_bytes: 256 << 20,
    upload_peak_bytes: 118 << 20,
    cache_resident_bytes: 64 << 20,
    total_bytes: 630 << 20,
    available_bytes: 992 << 20,
    limit_bytes: 694 << 20,
    ok: true,
  },
  guard_percent: 70,
  restart_fields: ['instance_memory_mb'],
  restart_pending: [] as string[],
  setting_key: 'wasm.limits',
}

beforeEach(() => {
  mockRequest.mockReset()
})

describe('AppPlatform（应用平台限制项）', () => {
  it('渲染当前值、来源与四笔账预览', async () => {
    mockRequest.mockResolvedValueOnce(VIEW as any)
    render(<AppPlatform />)

    expect(await screen.findByText('应用平台')).toBeTruthy()
    expect(screen.getByTestId('lim-max_instances')).toHaveProperty('value', '3')
    expect(screen.getByTestId('lim-instance_memory_mb')).toHaveProperty('value', '64')
    expect(screen.getByTestId('budget-line').textContent).toContain('630 MiB')
    expect(screen.getByTestId('budget-line').textContent).toContain('694 MiB')
    expect(screen.getByTestId('budget-badge').textContent).toContain('正常')
  })

  it('编辑后才允许保存，并把新值以 PUT 提交', async () => {
    mockRequest.mockResolvedValueOnce(VIEW as any)
    render(<AppPlatform />)
    const save = await screen.findByTestId('save-limits') as HTMLButtonElement
    expect(save.disabled).toBe(true) // 未改动 ⇒ 不可保存

    fireEvent.change(screen.getByTestId('lim-max_instances'), { target: { value: '8' } })
    expect(save.disabled).toBe(false)

    mockRequest.mockResolvedValueOnce({ ...VIEW, limits: { ...LIMITS, max_instances: 8 } } as any)
    fireEvent.click(save)

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/limits',
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    const body = JSON.parse((mockRequest.mock.calls[1][1] as RequestInit).body as string)
    expect(body.limits.max_instances).toBe(8)
    // 保存成功后给出即时生效的提示（无重启项）。
    expect(await screen.findByTestId('limits-flash')).toBeTruthy()
  })

  it('需重启的字段：保存后展示待重启徽标与提示', async () => {
    mockRequest.mockResolvedValueOnce(VIEW as any)
    render(<AppPlatform />)
    const mem = await screen.findByTestId('lim-instance_memory_mb')
    fireEvent.change(mem, { target: { value: '128' } })

    mockRequest.mockResolvedValueOnce({
      ...VIEW,
      limits: { ...LIMITS, instance_memory_mb: 128 },
      restart_pending: ['instance_memory_mb'],
    } as any)
    fireEvent.click(screen.getByTestId('save-limits'))

    expect((await screen.findByTestId('restart-pending')).textContent).toContain('instance_memory_mb')
    expect(screen.getByTestId('limits-flash').textContent).toContain('需重启')
  })

  it('超出水位时保存按钮仍可点，但错误提示如实展示服务端拒绝', async () => {
    mockRequest.mockResolvedValueOnce(VIEW as any)
    render(<AppPlatform />)
    fireEvent.change(await screen.findByTestId('lim-max_instances'), { target: { value: '200' } })

    // 编辑期预览应立即变成"超出水位"（同一公式的本地估算）
    expect(screen.getByTestId('budget-line').textContent).toContain('超出水位')

    mockRequest.mockRejectedValueOnce(new Error('这组限制项的理论内存峰值超过可用内存的安全水位'))
    fireEvent.click(screen.getByTestId('save-limits'))
    expect((await screen.findByTestId('limits-error')).textContent).toContain('超过可用内存')
  })

  it('套用档位预设会填充表单（不直接保存）', async () => {
    mockRequest.mockResolvedValueOnce(VIEW as any)
    render(<AppPlatform />)
    fireEvent.click(await screen.findByText('套用大内存档'))
    expect(screen.getByTestId('lim-max_instances')).toHaveProperty('value', '64')
    expect(screen.getByTestId('lim-module_cache_mb')).toHaveProperty('value', '256')
    // 仍在编辑态：没有发第二次请求
    expect(mockRequest).toHaveBeenCalledTimes(1)
  })
})
