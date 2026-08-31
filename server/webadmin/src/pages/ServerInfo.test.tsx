import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import ServerInfo from './ServerInfo'
import { request } from '../api'

const mockRequest = vi.mocked(request)

const baseInfo = {
  uptime_sec: 3600,
  uptime_human: '1时0分',
  go_version: 'go1.26.6',
  num_cpu: 4,
  gomaxprocs: 4,
  goroutines: 10,
  mem: { allocated_mb: 10, total_system_mb: 20, system_memory_mb: 8192 },
  load_avg: [0.1, 0.2, 0.3] as [number, number, number],
  disk: { data_path: '/data', total_gb: 100, used_gb: 20, free_gb: 80, used_pct: 20 },
  db: { driver: 'pg', tables: { users: 2 }, total_rows: 2, disk_bytes: 1024, disk_human: '1KB', schema_migrations: 48 },
}

describe('ServerInfo update check', () => {
  beforeEach(() => {
    mockRequest.mockReset()
    // 默认 concurrency 返回空(其他用例不受影响)
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/concurrency')) {
        return { checked_at: '2026-08-31T02:00:00Z', models: [] }
      }
      return {}
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows update banner when update_available is true', async () => {
    mockRequest.mockResolvedValue({
      ...baseInfo,
      version: '2.5.1',
      update_check: {
        current: '2.5.1',
        latest: '2.6.0',
        update_available: true,
        release_url: 'https://github.com/picoaide/picoaide-harness/releases/tag/v2.6.0',
        checked_at: '2026-08-31T02:00:00Z',
      },
    })

    render(<ServerInfo />)

    expect(await screen.findByText(/发现新版本 2\.6\.0/)).toBeInTheDocument()
    expect(screen.getByText(/当前 v2\.5\.1/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /查看发行说明/ })).toHaveAttribute(
      'href',
      'https://github.com/picoaide/picoaide-harness/releases/tag/v2.6.0',
    )
  })

  it('hides banner when up to date', async () => {
    mockRequest.mockResolvedValue({
      ...baseInfo,
      version: '2.6.0',
      update_check: {
        current: '2.6.0',
        latest: '2.6.0',
        update_available: false,
        release_url: 'https://github.com/picoaide/picoaide-harness/releases/tag/v2.6.0',
        checked_at: '2026-08-31T02:00:00Z',
      },
    })

    render(<ServerInfo />)

    await waitFor(() => expect(screen.getByText(/2\.6\.0/)).toBeInTheDocument())
    expect(screen.queryByText(/发现新版本/)).not.toBeInTheDocument()
  })

  it('silently degrades when update_check is null (API unreachable)', async () => {
    mockRequest.mockResolvedValue({
      ...baseInfo,
      version: '2.5.1',
      update_check: null,
    })

    render(<ServerInfo />)

    await waitFor(() => expect(screen.getByText(/2\.5\.1/)).toBeInTheDocument())
    expect(screen.queryByText(/发现新版本/)).not.toBeInTheDocument()
  })

  it('shows per-model concurrency with goal utilization', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/concurrency')) {
        return {
          checked_at: '2026-08-31T02:00:00Z',
          models: [
            { model: 'deepseek-v4-flash', current: 120, peak_90d: 2500, target: 2500 },
            { model: 'deepseek-v4-pro', current: 30, peak_90d: 480, target: 500 },
          ],
        }
      }
      return { ...baseInfo, version: '2.5.1', update_check: null }
    })

    render(<ServerInfo />)

    expect(await screen.findByText(/模型并发/)).toBeInTheDocument()
    expect(screen.getByText('deepseek-v4-flash')).toBeInTheDocument()
    expect(screen.getByText('deepseek-v4-pro')).toBeInTheDocument()
    // flash 2500/2500 = 100% 触发 ⚠;pro 480/500 = 96%
    expect(screen.getByText('100% ⚠')).toBeInTheDocument()
    expect(screen.getByText('96%')).toBeInTheDocument()
  })

  it('renders model table even when concurrency endpoint fails (degrade)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/concurrency')) {
        throw new Error('concurrency unavailable')
      }
      return { ...baseInfo, version: '2.5.1', update_check: null }
    })

    render(<ServerInfo />)

    await waitFor(() => expect(screen.getByText(/2\.5\.1/)).toBeInTheDocument())
    expect(screen.queryByText(/模型并发/)).not.toBeInTheDocument()
  })
})
