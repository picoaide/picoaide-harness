import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import Agents from './Agents'
import { request } from '../api'

const mockRequest = vi.mocked(request)
const confirmSpy = vi.fn(() => true)

const DEPTS = [{ id: 1, name: '研发部', parent_id: 0 }]

/** 市场行:服务端 agentJSON 把 apps.owner 投影到 `author` 键。 */
const MARKET_AGENTS = [
  {
    id: 0, name: 'ppt-gen', title: 'PPT 生成', version: '1.0.0', description: '做 PPT',
    author: 'seed', enabled: true, official: false, quality: '', downloads: 7,
  },
  {
    id: 0, name: 'retired-market', title: '已下架市场智能体', version: '0.5.0', description: '老包',
    author: 'seed', enabled: false, official: false, quality: '', downloads: 0,
  },
]

/** 组织共享行:author(上传者) 与 owner(apps.owner) **不同**,便于判"归属用哪个字段"。 */
const ORG_ROWS = [
  {
    name: 'code-reviewer', version: '1.1.0', display_name: '代码评审', description: 'review',
    author: 'bob', owner: 'alice', enabled: true, downloads: 2, official: false, quality: '',
  },
  {
    name: 'retired-org', version: '0.9.0', display_name: '退役组织智能体', description: '老包',
    author: 'carol', owner: 'dave', enabled: false, downloads: 0, official: false, quality: '',
  },
]

const ORG_ROOT = '/api/server/admin/agent-presets'

function mockRows() {
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/server/admin/departments') return { departments: DEPTS }
    if (path === '/api/server/admin/agents') return { agents: MARKET_AGENTS }
    if (path === '/api/server/admin/capabilities/approvals?status=approved&type=agent') return { approvals: ORG_ROWS }
    if (path.startsWith('/api/server/admin/users')) {
      return { users: [{ username: 'alice', display_name: 'Alice' }, { username: 'bob', display_name: 'Bob' }], total: 2 }
    }
    if (path.startsWith('/api/server/admin/agents/')) {
      if (path.endsWith('/preview')) return { files: ['agent.cordis.yml'], composition: 'id: ppt-gen\n' }
      if (path.endsWith('/grants')) return { grants: [{ grantee_type: 'group', grantee: '研发部' }] }
      return { ok: true }
    }
    if (path.startsWith(ORG_ROOT)) {
      if (path.endsWith('/preview')) return { files: ['agent.cordis.yml', 'preset.yml'], composition: 'id: code-reviewer\n' }
      if (path.endsWith('/grants')) return { grants: [{ grantee_type: 'group', grantee: '研发部' }] }
      if (path.includes('/file?path=')) return { content: 'x', size: 1, binary: false, too_large: false }
      return { ok: true }
    }
    return {}
  })
}

function card(name: string): HTMLElement {
  return screen.getByText(name).closest<HTMLElement>('[class*="group"]')!
}

beforeEach(() => {
  window.confirm = confirmSpy as any
  mockRequest.mockReset()
  mockRows()
})

describe('Agents 智能体市场页 · 市场行', () => {
  it('编辑与上下架走市场命名空间（PUT / DELETE / POST enable）', async () => {
    render(<Agents />)
    await screen.findByText('PPT 生成')
    fireEvent.click(within(card('PPT 生成')).getByRole('button', { name: '编辑' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/agents/ppt-gen',
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    fireEvent.click(within(card('PPT 生成')).getByRole('button', { name: '下架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/agents/ppt-gen', { method: 'DELETE' })
    })
    fireEvent.click(within(card('已下架市场智能体')).getByRole('button', { name: '重新上架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/agents/retired-market/enable', { method: 'POST' })
    })
  })

  it('上传新版走市场归档端点', async () => {
    render(<Agents />)
    await screen.findByText('PPT 生成')
    fireEvent.click(within(card('PPT 生成')).getByRole('button', { name: '上传新版' }))
    const dialog = within(await screen.findByRole('dialog'))
    const file = new File(['x'], 'agent.zip', { type: 'application/zip' })
    const input = document.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    fireEvent.click(dialog.getByRole('button', { name: '发布' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/agents/ppt-gen/archive',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('预览走市场命名空间（name 级，无版本段）', async () => {
    render(<Agents />)
    await screen.findByText('PPT 生成')
    fireEvent.click(within(card('PPT 生成')).getByRole('button', { name: '预览' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/agents/ppt-gen/preview')
    })
  })

  it('授权对话框基路径走市场命名空间', async () => {
    render(<Agents />)
    await screen.findByText('PPT 生成')
    fireEvent.click(within(card('PPT 生成')).getByRole('button', { name: '授权' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('@研发部')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/agents/ppt-gen/grants')
    })
    fireEvent.click(dialog.getAllByRole('button', { name: '撤销' })[0])
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/agents/ppt-gen/grant',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ group: '研发部' }) }),
    )
  })
})

// ---------------------------------------------------------------------------
// org 行(员工上传、审批通过,并入本页并打「员工上传」徽标)
//
// 与市场技能页同源缺陷:这些行此前每个按钮都打**市场命名空间**
// (`/api/server/admin/agents/<name>…`),而服务端对 org 行在该命名空间下正确 404
// (marketplace 的渠道守卫)。生产当前 0 个 org 智能体 ⇒ 未触发,但同源必修。
// 路径与动词的穷举对拍在 src/lib/capability-endpoints.spec.ts(读 Go 路由声明)。
// ---------------------------------------------------------------------------

describe('Agents 智能体市场页 · org 行按 channel 走共享命名空间', () => {
  it('预览打到 agent-presets 的 name@version 端点', async () => {
    render(<Agents />)
    await screen.findByText('代码评审')
    fireEvent.click(within(card('代码评审')).getByRole('button', { name: '预览' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${ORG_ROOT}/code-reviewer/1.1.0/preview`)
    })
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/agents/code-reviewer/preview')
  })

  it('授权对话框基路径走 agent-presets(名级,不带版本)', async () => {
    render(<Agents />)
    await screen.findByText('代码评审')
    fireEvent.click(within(card('代码评审')).getByRole('button', { name: '授权' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('@研发部')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${ORG_ROOT}/code-reviewer/grants`)
    })
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/agents/code-reviewer/grants')
  })

  it('下架/重新上架走 PUT /agent-presets/:name/enabled 并透传真实上下架状态', async () => {
    render(<Agents />)
    await screen.findByText('代码评审')
    expect(card('退役组织智能体').textContent).toContain('已下架')
    expect(card('代码评审').textContent).toContain('上架')
    fireEvent.click(within(card('代码评审')).getByRole('button', { name: '下架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${ORG_ROOT}/code-reviewer/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })
    })
    fireEvent.click(within(card('退役组织智能体')).getByRole('button', { name: '重新上架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${ORG_ROOT}/retired-org/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
      })
    })
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/agents/code-reviewer', expect.objectContaining({ method: 'DELETE' }))
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/agents/retired-org/enable', expect.objectContaining({ method: 'POST' }))
  })

  it('服务端没有的端点(编辑/上传新版)对 org 行禁用并给文案,市场行仍可点', async () => {
    render(<Agents />)
    await screen.findByText('代码评审')
    const org = within(card('代码评审'))
    for (const name of ['编辑', '上传新版']) {
      const btn = org.getByRole('button', { name })
      expect(btn, `org 行的「${name}」必须禁用(服务端无该端点)`).toBeDisabled()
      expect(btn.getAttribute('title')).toBeTruthy()
    }
    expect(card('代码评审').textContent).toContain('组织共享智能体')
    const market = within(card('PPT 生成'))
    expect(market.getByRole('button', { name: '编辑' })).toBeEnabled()
    expect(market.getByRole('button', { name: '上传新版' })).toBeEnabled()
  })

  it('归属显示与转移预填用 apps.owner(不是本行上传者 author)', async () => {
    render(<Agents />)
    await screen.findByText('代码评审')
    expect(card('代码评审').textContent).toContain('归属 alice')
    expect(card('代码评审').textContent).not.toContain('归属 bob')
    fireEvent.click(within(card('代码评审')).getByRole('button', { name: '归属' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('combobox'))
    // 候选列表走 Popover portal(在 dialog 子树之外),按整页查。
    const marker = await screen.findByText('当前归属')
    expect(marker.closest('[role="option"]')?.textContent).toContain('alice')
  })
})
