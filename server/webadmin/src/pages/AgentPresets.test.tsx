import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AgentPresets from './AgentPresets'
import { request } from '../api'

const mockRequest = vi.mocked(request)

const ROWS = [
  { name: 'ppt-gen', display_name: 'PPT 生成', description: '做 PPT', version: '1.0.0', author: 'alice', status: 'pending', created_at: '2026-08-01T10:00:00+08:00' },
  { name: 'code-review', display_name: '', description: '', version: '1.0.0', author: 'bob', status: 'approved', created_at: '2026-08-02T10:00:00+08:00' },
  { name: 'old', display_name: '旧版', description: '', version: '1.0.0', author: 'bob', status: 'rejected', created_at: '2026-08-03T10:00:00+08:00' },
]

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/admin/agent-presets')) return { presets: ROWS }
    return {}
  })
})

describe('AgentPresets 共享 Agent 审核页', () => {
  it('渲染列表与状态徽章', async () => {
    render(<AgentPresets />)
    expect(await screen.findByText('PPT 生成')).toBeInTheDocument()
    expect(screen.getByText('待审核')).toBeInTheDocument()
    expect(screen.getByText('已通过')).toBeInTheDocument()
    expect(screen.getByText('已拒绝')).toBeInTheDocument()
  })

  it('点击通过会调用 approve 接口并刷新', async () => {
    render(<AgentPresets />)
    const approve = await screen.findAllByText('通过')
    fireEvent.click(approve[0]!)
    // 确认弹窗
    const confirm = await screen.findByText('确定通过该共享 Agent 吗？')
    expect(confirm).toBeInTheDocument()
    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/agent-presets/ppt-gen/approve', { method: 'POST' })
    })
  })

  it('删除调用 DELETE 接口', async () => {
    render(<AgentPresets />)
    const del = await screen.findAllByText('删除')
    fireEvent.click(del[0]!)
    fireEvent.click(await screen.findByText('确认'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/agent-presets/ppt-gen', { method: 'DELETE' })
    })
  })

  it('接口错误展示提示', async () => {
    mockRequest.mockImplementation(async () => { throw new Error('查询失败') })
    render(<AgentPresets />)
    expect(await screen.findByText('查询失败')).toBeInTheDocument()
  })
})
