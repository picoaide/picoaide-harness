import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import CapabilityCenter from './CapabilityCenter'
import { request } from '../api'

// 2026-09-02:「市场 · 技能」与「能力中心」合并为单入口(与客户端 IA 对齐)。
// 默认 Tab = 市场技能(商城管理);「组织共享」Tab = 审批队列 + 锁定管理。
const mockRequest = vi.mocked(request)

const SKILLS = [
  { id: 1, name: 'data-extract', version: '1.0.0', description: '数据提取', author: 'seed', enabled: true },
]

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/server/admin/skills') return { skills: SKILLS }
    if (path === '/api/server/admin/departments') return { departments: [] }
    if (path === '/api/server/admin/capability-locks') return { locks: [] }
    if (path.startsWith('/api/server/admin/capabilities/approvals')) {
      const status = new URLSearchParams(path.split('?')[1] ?? '').get('status') ?? 'pending'
      return { approvals: status === 'pending' ? [] : [] }
    }
    return {}
  })
})

function renderPage(initialEntry = '/capabilities') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <CapabilityCenter />
    </MemoryRouter>,
  )
}

describe('CapabilityCenter 能力中心(统一管理面)', () => {
  it('默认展示「市场技能」Tab:上架按钮与技能卡片', async () => {
    renderPage()
    expect(await screen.findByText('上架技能')).toBeInTheDocument()
    expect(await screen.findByText('data-extract')).toBeInTheDocument()
    // 卡片归属展示(2026-09-02)。
    expect(screen.getByText(/归属 seed/)).toBeInTheDocument()
  })

  it('切换「组织共享」Tab 展示审批队列与锁定管理', async () => {
    const u = userEvent.setup()
    renderPage()
    await screen.findByText('上架技能')
    // Radix Tabs 需要完整 pointer 事件(userEvent),fireEvent.click 不触发。
    await u.click(screen.getByRole('tab', { name: '组织共享' }))
    expect(await screen.findByText('锁定管理')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/capabilities/approvals?status=pending')
    })
  })

  it('?tab=org 直接定位到组织共享(旧 /marketplace 重定向兼容)', async () => {
    renderPage('/capabilities?tab=org')
    expect(await screen.findByText('锁定管理')).toBeInTheDocument()
    expect(screen.queryByText('上架技能')).not.toBeInTheDocument()
  })
})
