import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { request } from '../api'
import Capabilities from './Capabilities'

// 2026-08-28 定案:能力中心只承载共享智能体审核,type=agent 由服务端过滤。
const ROWS = [
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
    if (path === '/api/admin/capabilities/approvals?type=agent') return { approvals: ROWS }
    if (path === '/api/admin/departments') return { departments: [] }
    return {}
  })
})

describe('Capabilities 能力中心(共享智能体审核)', () => {
  it('只请求 type=agent 并渲染智能体队列', async () => {
    render(<Capabilities />)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/capabilities/approvals?type=agent')
    })
    expect(await screen.findByText('PPT 生成')).toBeInTheDocument()
    expect(screen.getByText(/共享智能体的统一审核队列/)).toBeInTheDocument()
  })

  it('点击通过调用各域 approve 端点', async () => {
    render(<Capabilities />)
    await screen.findByText('PPT 生成')
    fireEvent.click(screen.getAllByText('通过')[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '确认' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/agent-presets/ppt-gen/1.0.0/approve', { method: 'POST' })
    })
  })

  it('拒绝必填理由', async () => {
    render(<Capabilities />)
    await screen.findByText('PPT 生成')
    const rejectBtns = screen.getAllByText('拒绝')
    fireEvent.click(rejectBtns[0]!)
    // 确认弹窗出现且确认按钮在理由为空时禁用。
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    const confirmBtn = screen.getByRole('button', { name: '确认' })
    await waitFor(() => {
      expect(confirmBtn).toBeDisabled()
    })
  })

  it('点击文件清单中的文件可查看其内容(审核全部内容)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/capabilities/approvals?type=agent') return { approvals: ROWS }
      if (path === '/api/admin/departments') return { departments: [] }
      if (path.endsWith('/preview')) return { files: ['agent.cordis.yml', 'scripts/run.sh'], composition: '---\nid: ppt-gen\n---\n' }
      if (path.includes('/file?path=scripts%2Frun.sh')) {
        return { path: 'scripts/run.sh', size: 14, binary: false, too_large: false, content: '#!/bin/sh\necho hi\n' }
      }
      return {}
    })
    render(<Capabilities />)
    await screen.findByText('PPT 生成')
    const btns = await screen.findAllByTitle('查看内容预览')
    fireEvent.click(btns[0]!)
    const fileChip = await screen.findByText('scripts/run.sh')
    fireEvent.click(fileChip)
    expect(await screen.findByText(/echo hi/u)).toBeInTheDocument()
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/agent-presets/ppt-gen/1.0.0/file?path=scripts%2Frun.sh')
    })
  })
})
