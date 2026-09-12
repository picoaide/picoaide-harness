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
