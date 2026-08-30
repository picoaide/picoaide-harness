import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { request } from '../api'
import Capabilities from './Capabilities'

// 2026-09 恢复统一审批:能力中心承载共享技能+共享 Agent 审核(技能/智能体
// 类型可筛选;approve/reject/delete 走服务端下发的 base_path = /api/server/admin/*)。
const SKILL_ROWS = [
  {
    kind: 'skill' as const, name: 'codeql', version: '1.0.0', display_name: 'CodeQL 审计',
    description: 'find vulns', author: 'bob', status: 'pending' as const, reason: '',
    quality: '' as const, downloads: 3, calls: 5, created_at: '2026-08-25T10:00:00Z',
    base_path: '/api/server/admin/shared-skills/codeql/1.0.0',
    preview_path: '/api/server/admin/shared-skills/codeql/1.0.0/preview',
  },
]
const AGENT_ROWS = [
  {
    kind: 'agent' as const, name: 'ppt-gen', version: '1.0.0', display_name: 'PPT 生成',
    description: 'make ppt', author: 'bob', status: 'pending' as const, reason: '',
    quality: '' as const, downloads: 1, created_at: '2026-08-25T10:00:00Z',
    base_path: '/api/server/admin/agent-presets/ppt-gen/1.0.0',
    preview_path: '/api/server/admin/agent-presets/ppt-gen/1.0.0/preview',
  },
]

const mockRequest = vi.mocked(request)

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/server/admin/capabilities/approvals?status=pending') return { approvals: [...SKILL_ROWS, ...AGENT_ROWS] }
    if (path === '/api/server/admin/capabilities/approvals?status=pending&type=skill') return { approvals: SKILL_ROWS }
    if (path === '/api/server/admin/capabilities/approvals?status=pending&type=agent') return { approvals: AGENT_ROWS }
    if (path === '/api/server/admin/capabilities/approvals?status=all') return { approvals: [...SKILL_ROWS, ...AGENT_ROWS] }
    if (path === '/api/server/admin/capabilities/approvals?status=all&type=skill') return { approvals: SKILL_ROWS }
    if (path === '/api/server/admin/departments') return { departments: [] }
    if (path.endsWith('/preview')) {
      return { files: ['SKILL.md', 'scripts/run.sh'], skill_md: '# codeql\n', composition: '---\nid: ppt-gen\n---\n' } as any
    }
    return {}
  })
})

describe('Capabilities 能力中心(统一审批)', () => {
  it('默认请求 pending 全类型并渲染技能+智能体', async () => {
    render(<Capabilities />)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/capabilities/approvals?status=pending')
    })
    expect(await screen.findByText('CodeQL 审计')).toBeInTheDocument()
    expect(screen.getByText('PPT 生成')).toBeInTheDocument()
    expect(screen.getByText(/共享技能与共享 Agent 的统一审核队列/)).toBeInTheDocument()
  })

  it('类型筛选只请求对应 kind', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click(screen.getByRole('button', { name: '智能体' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/capabilities/approvals?status=pending&type=agent')
    })
  })

  it('点击技能通过调用共享技能 approve 端点', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    const rows = screen.getAllByText('通过')
    fireEvent.click(rows[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '确认' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/shared-skills/codeql/1.0.0/approve', { method: 'POST' })
    })
  })

  it('拒绝必填理由', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    const rejectBtns = screen.getAllByText('拒绝')
    fireEvent.click(rejectBtns[0]!)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    const confirmBtn = screen.getByRole('button', { name: '确认' })
    await waitFor(() => {
      expect(confirmBtn).toBeDisabled()
    })
  })

  it('技能预览主文件为 SKILL.md 且文件可点击查看内容', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    const btns = await screen.findAllByTitle('查看内容预览')
    fireEvent.click(btns[0]!)
    // 主标题 h4 与文件清单 chip 均含 SKILL.md,用 heading role 精确匹配主标题。
    expect(await screen.findByRole('heading', { name: 'SKILL.md' })).toBeInTheDocument()
    const fileChip = await screen.findByText('scripts/run.sh')
    fireEvent.click(fileChip)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/shared-skills/codeql/1.0.0/file?path=scripts%2Frun.sh')
    })
  })

  it('智能体预览主文件为 agent.cordis.yml', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click(screen.getByRole('button', { name: '智能体' }))
    await waitFor(() => { expect(screen.queryByText('CodeQL 审计')).not.toBeInTheDocument() })
    const btns = await screen.findAllByTitle('查看内容预览')
    fireEvent.click(btns[0]!)
    expect(await screen.findByText('agent.cordis.yml')).toBeInTheDocument()
  })

  it('已通过行展示质量 Select 与授权按钮', async () => {
    const u = userEvent.setup()
    const approvedSkill = {
      ...SKILL_ROWS[0]!, status: 'approved' as const, quality: 'official' as const,
    }
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=approved') return { approvals: [approvedSkill] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    render(<Capabilities />)
    // 默认 tab=pending,切到「已通过」触发 status=approved 请求。
    await u.click(screen.getByRole('tab', { name: '已通过（0）' }))
    await screen.findByText('CodeQL 审计')
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByTitle('授权')).toBeInTheDocument()
  })
})
