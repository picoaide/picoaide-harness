import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { request } from '../../api'
import UsageReports from './Reports'

const mockRequest = vi.mocked(request)

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/server/admin/report-subscriptions' && init?.method === 'POST') return { id: 1 }
    if (path === '/api/server/admin/report-subscriptions/1' && init?.method === 'PUT') return { ok: true }
    if (path === '/api/server/admin/report-subscriptions') {
      return { subscriptions: [{ id: 1, name: '企微群', enabled: true, hook_url: '***', last_error: '' }] }
    }
    return {}
  })
})

describe('报表订阅 · hook_url 不回显明文(FIX-13)', () => {
  it('列表不显示明文地址,只显示「已配置(不回显)」', async () => {
    render(<UsageReports />)
    expect(await screen.findByText('企微群')).toBeInTheDocument()
    expect(screen.getByText('已配置(不回显)')).toBeInTheDocument()
    expect(screen.queryByText('***')).toBeNull()
  })

  it('编辑时地址框留空;保持留空提交时 hook_url 为空串(服务端保持现值)', async () => {
    render(<UsageReports />)
    await screen.findByText('企微群')
    fireEvent.click(screen.getByRole('button', { name: '编辑订阅' }))
    const url = (await screen.findByLabelText('推送地址(webhook URL)')) as HTMLInputElement
    expect(url.value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/report-subscriptions/1', expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"hook_url":""'),
      }))
    })
  })

  it('启用开关改用空 hook_url 提交(不再回传不可用的哨兵)', async () => {
    render(<UsageReports />)
    await screen.findByText('企微群')
    fireEvent.click(screen.getByRole('switch', { name: '启用 企微群' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/report-subscriptions/1', expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"hook_url":""'),
      }))
    })
    expect(mockRequest.mock.calls.some((c) => String((c[1] as RequestInit | undefined)?.body ?? '').includes('***'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// R21C-03（审计 2026-09-26，P2）：退避窗口与欠投期号必须在界面上看得见。
//
// 缺陷形态：管理员改好 webhook 后发现「最近错误 = —」以为已恢复，而服务端
// `next_attempt_at` 还停在旧地址算出的 24 小时窗口里 ⇒ 最长干等一天才有下一次
// 投递；界面既不显示欠投期号也不显示退避时刻，"改好了但没反应"与"一切正常"同形。
//
// 变异（必须变红）：删掉表头/单元格里的「欠投期号」「下次重试」两列，或让
// `retryLabel` 不再区分退避中 ⇒ 下面两条用例红。
// ---------------------------------------------------------------------------
describe('报表订阅 · 欠投期号与退避窗口可见(R21C-03)', () => {
  // 这一组自带夹具（含一条"退避中 + 有欠投期号"的订阅）：上面的共享夹具保持
  // 单行不变，免得把按 role 取按钮的既有用例变成"多个匹配"。
  beforeEach(() => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/report-subscriptions') {
        return {
          subscriptions: [
            { id: 1, name: '企微群', enabled: true, hook_url: '***', last_error: '' },
            {
              id: 2, name: '财务群', enabled: true, hook_url: '***', last_error: 'webhook 返回非 2xx',
              pending_period: '2026-07', fail_streak: 3,
              next_attempt_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
            },
          ],
        }
      }
      return {}
    })
  })

  it('列出欠投期号与「退避中 · 时刻」,而不是把欠投说成健康', async () => {
    render(<UsageReports />)
    expect(await screen.findByText('财务群')).toBeInTheDocument()
    expect(screen.getByText('欠投期号')).toBeInTheDocument()
    expect(screen.getByText('下次重试')).toBeInTheDocument()
    expect(screen.getByText('2026-07')).toBeInTheDocument()
    expect(screen.getByText(/^退避中 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument()
  })

  it('没有欠投也没有退避的订阅显示「—」,不显示伪造的时刻', async () => {
    render(<UsageReports />)
    await screen.findByText('企微群')
    const row = screen.getByText('企微群').closest('tr') as HTMLElement
    expect(row.textContent).toContain('—')
    expect(row.textContent).not.toContain('退避中')
  })
})
