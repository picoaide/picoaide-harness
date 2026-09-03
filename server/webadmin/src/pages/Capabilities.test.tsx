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
    description: 'find vulns', author: 'bob', owner: 'alice', status: 'pending' as const, reason: '',
    quality: '' as const, downloads: 3, calls: 5, created_at: '2026-08-25T10:00:00Z',
    base_path: '/api/server/admin/shared-skills/codeql/1.0.0',
    grants_base: '/api/server/admin/shared-skills/codeql',
    preview_path: '/api/server/admin/shared-skills/codeql/1.0.0/preview',
  },
]
const AGENT_ROWS = [
  {
    kind: 'agent' as const, name: 'ppt-gen', version: '1.0.0', display_name: 'PPT 生成',
    description: 'make ppt', author: 'bob', owner: 'alice', status: 'pending' as const, reason: '',
    quality: '' as const, downloads: 1, created_at: '2026-08-25T10:00:00Z',
    base_path: '/api/server/admin/agent-presets/ppt-gen/1.0.0',
    grants_base: '/api/server/admin/agent-presets/ppt-gen',
    preview_path: '/api/server/admin/agent-presets/ppt-gen/1.0.0/preview',
  },
]

const mockRequest = vi.mocked(request)

// 归属转移弹窗(2026-09-04 起)从用户列表搜索选择,需 mock 用户列表端点。
const USERS = [
  { username: 'alice', display_name: 'Alice' },
  { username: 'bob', display_name: 'Bob' },
  { username: 'carol', display_name: 'Carol' },
]

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/server/admin/users')) return { users: USERS, total: USERS.length }
    if (path === '/api/server/admin/capabilities/approvals?status=pending') return { approvals: [...SKILL_ROWS, ...AGENT_ROWS] }
    if (path === '/api/server/admin/capabilities/approvals?status=pending&type=skill') return { approvals: SKILL_ROWS }
    if (path === '/api/server/admin/capabilities/approvals?status=pending&type=agent') return { approvals: AGENT_ROWS }
    if (path === '/api/server/admin/capabilities/approvals?status=all') return { approvals: [...SKILL_ROWS, ...AGENT_ROWS] }
    if (path === '/api/server/admin/capabilities/approvals?status=all&type=skill') return { approvals: SKILL_ROWS }
    if (path === '/api/server/admin/departments') return { departments: [] }
    // 锁定管理面板(2026-09-01 D4)与审批队列同页,mock 需覆盖其清单端点。
    if (path === '/api/server/admin/capability-locks') return { locks: [] }
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
    // 同页还有「锁定管理」的类型下拉,这里只断言质量 Select(默认值「官方」)。
    const qualitySelect = screen.getAllByRole('combobox').find((el) => el.textContent?.includes('官方'))
    expect(qualitySelect).toBeDefined()
    expect(screen.getByTitle('授权')).toBeInTheDocument()
  })

  it('归属列显示 apps.owner(与上传者可不同)', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    expect(screen.getByRole('columnheader', { name: '归属' })).toBeInTheDocument()
    // SKILL_ROWS/AGENT_ROWS:author=bob(上传者)、owner=alice(归属人)→ 两列都渲染。
    expect(screen.getAllByText('alice', { selector: 'td' }).length).toBeGreaterThan(0)
    expect(screen.getAllByText('bob', { selector: 'td' }).length).toBeGreaterThan(0)
  })

  it('转移归属:从用户列表搜索选择负责人 → PUT apps/:kind/:name/owner', async () => {
    const u = userEvent.setup()
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click((await screen.findAllByTitle('转移归属(负责人)'))[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('转移归属')
    // 打开候选列表 → 输入搜索(防抖后服务端 q= 搜索)
    fireEvent.click(screen.getByRole('combobox'))
    const input = await screen.findByLabelText('新归属人用户名')
    await u.type(input, 'carol')
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/users?page=1&size=200&q=carol')
    })
    // 从候选点选 carol(不允许自由输入;选中后确认按钮才可用)
    fireEvent.click(await screen.findByText('carol'))
    fireEvent.click(screen.getByRole('button', { name: '确认转移' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/apps/skill/codeql/owner',
        { method: 'PUT', body: JSON.stringify({ owner: 'carol' }) },
      )
    })
  })

  it('转移归属:未选择时确认按钮禁用,当前归属人不可选', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click((await screen.findAllByTitle('转移归属(负责人)'))[0]!)
    await screen.findByRole('dialog')
    // 未选择新负责人 → 确认禁用(不预填,杜绝直接回车提交错误用户名)。
    expect(screen.getByRole('button', { name: '确认转移' })).toBeDisabled()
    // 当前归属人在候选列表中标记且不可选。
    fireEvent.click(screen.getByRole('combobox'))
    expect(await screen.findByText('当前归属')).toBeInTheDocument()
    const currentItems = screen
      .getAllByText('alice')
      .map((el) => el.closest('[cmdk-item]'))
      .filter((el) => el !== null)
    expect(currentItems.length).toBeGreaterThan(0)
    expect(currentItems[0]?.getAttribute('data-disabled')).toBe('true')
  })
})
