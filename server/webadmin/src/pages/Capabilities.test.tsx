import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { request } from '../api'
import Capabilities from './Capabilities'

const ROWS = [
  {
    kind: 'skill' as const, name: 'codeql', version: '1.0.0', display_name: 'CodeQL 审计',
    description: 'audit', author: 'alice', status: 'pending' as const, reason: '',
    quality: '' as const, created_at: '2026-08-25T10:00:00Z', base_path: '/api/admin/shared-skills/codeql/1.0.0',
    preview_path: '/api/admin/shared-skills/codeql/1.0.0/preview',
  },
  {
    kind: 'agent' as const, name: 'ppt-gen', version: '1.0.0', display_name: 'PPT 生成',
    description: 'make ppt', author: 'bob', status: 'pending' as const, reason: '',
    quality: '' as const, created_at: '2026-08-25T10:00:00Z', base_path: '/api/admin/agent-presets/ppt-gen/1.0.0',
    preview_path: '/api/admin/agent-presets/ppt-gen/1.0.0/preview',
  },
]

const mockRequest = vi.mocked(request)

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path) => {
    if (path === '/api/admin/capabilities/approvals') return { approvals: ROWS }
    if (path === '/api/admin/departments') return { departments: [] }
    return {}
  })
})

describe('Capabilities 统一审批页', () => {
  it('渲染统一队列并区分技能/智能体', async () => {
    render(<Capabilities />)
    expect(await screen.findByText('CodeQL 审计')).toBeInTheDocument()
    expect(screen.getByText('PPT 生成')).toBeInTheDocument()
    expect(screen.getAllByText('技能').length).toBeGreaterThan(0)
    expect(screen.getAllByText('智能体').length).toBeGreaterThan(0)
  })

  it('点击通过调用各域 approve 端点', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    const approveBtns = screen.getAllByText('通过')
    fireEvent.click(approveBtns[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '确认' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/shared-skills/codeql/1.0.0/approve', { method: 'POST' })
    })
  })

  it('拒绝必填理由', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    const rejectBtns = screen.getAllByText('拒绝')
    fireEvent.click(rejectBtns[0]!)
    // 确认弹窗出现且确认按钮在理由为空时禁用。
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    const confirmBtn = screen.getByRole('button', { name: '确认' })
    await waitFor(() => {
      expect(confirmBtn).toBeDisabled()
    })
  })

  it('类型筛选只显示智能体', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click(screen.getByRole('button', { name: '智能体' }))
    await waitFor(() => {
      expect(screen.queryByText('CodeQL 审计')).not.toBeInTheDocument()
      expect(screen.getByText('PPT 生成')).toBeInTheDocument()
    })
  })
})
