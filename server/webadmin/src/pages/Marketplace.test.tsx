import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Marketplace from './Marketplace'
import { request } from '../api'

const mockRequest = vi.mocked(request)
const confirmSpy = vi.fn(() => true)

const SKILLS = [
  { id: 1, name: 'data-extract', version: '1.0.0', description: '数据提取', author: 'seed', enabled: true },
  { id: 2, name: 'legacy', version: '0.9.0', description: '旧版', author: 'seed', enabled: false },
]
const DEPTS = [{ id: 1, name: '研发部', parent_id: 0 }, { id: 2, name: '人事部', parent_id: 0 }]

function defaultMock() {
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/server/admin/departments') return { departments: DEPTS }
    if (path === '/api/server/admin/skills') return { skills: SKILLS }
    if (path === '/api/server/admin/skills/data-extract/grants') return { grants: [{ grantee_type: 'group', grantee: '研发部' }] }
    return {}
  })
}

beforeEach(() => {
  window.confirm = confirmSpy as any
  mockRequest.mockReset()
  defaultMock()
})

describe('Marketplace 商城页', () => {
  it('渲染技能卡片,状态徽标按 enabled 展示', async () => {
    render(<Marketplace />)
    expect(await screen.findByText('data-extract')).toBeInTheDocument()
    // H1: enabled=true → 上架;enabled=false → 已下架
    const extractCard = screen.getByText('data-extract').closest('[class*="group"]')!
    expect(extractCard.textContent).toContain('上架')
    const legacyCard = screen.getByText('legacy').closest('[class*="group"]')!
    expect(legacyCard.textContent).toContain('已下架')
    expect(screen.queryByText('MCP 插件')).not.toBeInTheDocument()
  })

  it('技能卡片显示归属人,并可通过「归属」按钮转移负责人', async () => {
    const u = userEvent.setup()
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/server/admin/users')) {
        return { users: [{ username: 'alice', display_name: 'Alice' }, { username: 'carol', display_name: 'Carol' }], total: 2 }
      }
      if (path === '/api/server/admin/departments') return { departments: DEPTS }
      if (path === '/api/server/admin/skills') return { skills: SKILLS }
      if (path === '/api/server/admin/apps/skill/data-extract/owner' && init?.method === 'PUT') return { ok: true }
      return {}
    })
    render(<Marketplace />)
    await screen.findByText('data-extract')
    // 归属展示:author 字段 = apps.owner。
    const extractCard = screen.getByText('data-extract').closest<HTMLElement>('[class*="group"]')! as HTMLElement
    expect(extractCard.textContent).toContain('归属 seed')
    // 转移归属:弹窗从用户列表搜索选择 → PUT /apps/:kind/:name/owner。
    fireEvent.click(within(extractCard).getByRole('button', { name: '归属' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('转移归属')).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('combobox'))
    const input = await screen.findByLabelText('新归属人用户名')
    await u.type(input, 'carol')
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/users?page=1&size=200&q=carol')
    })
    fireEvent.click(await screen.findByText('carol'))
    fireEvent.click(dialog.getByRole('button', { name: '确认转移' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/apps/skill/data-extract/owner',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ owner: 'carol' }) }),
      )
    })
  })

  it('技能授权对话框:展示已有组授权并可撤销', async () => {
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('@研发部')).toBeInTheDocument()
    expect(dialog.queryByText(/未授权:所有用户均不可见/)).not.toBeInTheDocument()
    fireEvent.click(dialog.getAllByRole('button', { name: '撤销' })[0])
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/skills/data-extract/grant',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ group: '研发部' }) }),
    )
  })

  it('技能授权对话框:勾选部门多选保存(整组替换,保存前需确认)', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/skills/data-extract/grants' && init?.method === 'PUT') return { ok: true }
      if (path === '/api/server/admin/departments') return { departments: DEPTS }
      if (path === '/api/server/admin/skills') return { skills: SKILLS }
      if (path === '/api/server/admin/skills/data-extract/grants') return { grants: [] }
      return {}
    })
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText(/一个资源可授权多个部门/)).toBeInTheDocument()
    // 授权列表落地前写面是锁的（R3 闸门）：必须等到按钮真的可点再点，否则负载下
    // 这一击会被 disabled 吞掉（+400ms 注入即红）。
    const saveBtn = dialog.getByRole('button', { name: '保存部门授权' })
    await waitFor(() => expect(saveBtn).toBeEnabled())
    fireEvent.click(dialog.getByLabelText(/研发部/))
    fireEvent.click(saveBtn)
    expect(confirmSpy).toHaveBeenCalled()
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/skills/data-extract/grants',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ groups: ['研发部'] }) }),
    )
  })

  it('M6: 部门整组替换在用户取消确认时不发请求', async () => {
    window.confirm = vi.fn(() => false) as any
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    await dialog.findByText('@研发部')
    fireEvent.click(dialog.getByRole('button', { name: '保存部门授权' }))
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/server/admin/skills/data-extract/grants',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('R3: 授权列表读取失败时不可保存(否则空列表会清空全部部门授权)', async () => {
    // 2026-09-17 独立验证 R3：`grants` 初值是空数组，读取失败时页面照样渲染
    // 「未授权:所有用户均不可见(严格默认)」且保存可点 ⇒ PUT {groups: []} 清空部门授权。
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/skills/data-extract/grants') throw new Error('授权列表读取失败')
      if (path === '/api/server/admin/skills/data-extract/grants' && init?.method === 'PUT') return { ok: true }
      if (path === '/api/server/admin/departments') return { departments: DEPTS }
      if (path === '/api/server/admin/skills') return { skills: SKILLS }
      return {}
    })
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '授权' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText(/授权列表未加载成功/)).toBeInTheDocument()
    // 不得把"没读到"渲染成"未授权"（那正是会诱导管理员点保存的假状态）。
    expect(dialog.queryByText(/未授权:所有用户均不可见/)).not.toBeInTheDocument()
    const saveBtn = dialog.getByRole('button', { name: '保存部门授权' })
    expect(saveBtn).toBeDisabled()
    fireEvent.click(saveBtn)
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/server/admin/skills/data-extract/grants',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('5-1: 换资源后不得展示上一份资源的授权(否则撤销会打到新资源上)', async () => {
    // 2026-09-17 第二轮独立验证 P2：对话框是常挂载的，`grants` 只在请求成功后才覆盖 ⇒
    // "打开 A（已加载完）→ 关闭 → 打开 B（B 还在路上）"的窗口里显示的是 **A 的授权**，
    // 撤销按钮可点，实测发出 `DELETE /skills/legacy/grant {"group":"研发部"}` —— 把 A 的
    // 授权对象删到了 B 上。修法=资源切换时在渲染期同步归零 + 列表/撤销都过 grantsLoaded。
    // 注：jsdom 里 act() 会把 effect 一并冲掉，所以"渲染期归零"与"列表闸门"两种机制
    // 单看都能让本用例通过（变异验证：只拆任一个仍绿，两个一起拆才红）。真实浏览器里
    // effect 在绘制之后，那一帧的窗口只有渲染期归零能关上。
    let releaseB!: () => void
    const gateB = new Promise<void>((resolve) => { releaseB = resolve })
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/skills/data-extract/grants') return { grants: [{ grantee_type: 'group', grantee: '研发部' }] }
      if (path === '/api/server/admin/skills/legacy/grants') { await gateB; return { grants: [] } }
      if (path === '/api/server/admin/departments') return { departments: DEPTS }
      if (path === '/api/server/admin/skills') return { skills: SKILLS }
      return {}
    })
    render(<Marketplace />)
    await screen.findByText('data-extract')
    const cardOf = (name: string) => within(screen.getByText(name).closest<HTMLElement>('[class*="group"]')!)
    // 打开 A，等它的授权落地
    fireEvent.click(cardOf('data-extract').getByRole('button', { name: '授权' }))
    expect(await within(await screen.findByRole('dialog')).findByText('@研发部')).toBeInTheDocument()
    // 关闭，再打开 B（B 的列表挂起）
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(cardOf('legacy').getByRole('button', { name: '授权' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.queryByText('@研发部')).toBeNull()
    expect(dialog.queryByRole('button', { name: '撤销' })).toBeNull()
    expect(dialog.getByRole('button', { name: '保存部门授权' })).toBeDisabled()
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/server/admin/skills/legacy/grant',
      expect.objectContaining({ method: 'DELETE' }),
    )
    releaseB()
  })

  it('M1: 已下架技能显示「重新上架」并调用 enable 端点', async () => {
    render(<Marketplace />)
    await screen.findByText('legacy')
    fireEvent.click(screen.getAllByRole('button', { name: '重新上架' })[0])
    expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/skills/legacy/enable', { method: 'POST' })
  })

  it('M2: 编辑技能对话框回填并提交 PUT', async () => {
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    const nameInput = dialog.getByLabelText('名称') as HTMLInputElement
    expect(nameInput.value).toBe('data-extract')
    // 2026-09-01「包内即真相」:版本只能随归档由「上传新版」写入,编辑态不再暴露;
    // 展示名/描述/作者也一律取自包内,元数据 PUT 只保留兼容语义。
    fireEvent.click(dialog.getByRole('button', { name: '保存修改' }))
    expect(mockRequest).toHaveBeenCalledWith(
      '/api/server/admin/skills/data-extract',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('L3: 空列表显示空态文案', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/departments') return { departments: DEPTS }
      if (path === '/api/server/admin/skills') return { skills: [] }
      return {}
    })
    render(<Marketplace />)
    expect(await screen.findByText(/暂无技能/)).toBeInTheDocument()
  })

  it('0040: 上传新版压缩包调用 archive 端点', async () => {
    render(<Marketplace />)
    await screen.findByText('data-extract')
    fireEvent.click(screen.getAllByRole('button', { name: '上传新版' })[0]!)
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('版本'), { target: { value: '2.0.0' } })
    const file = new File(['x'], 'skill.zip', { type: 'application/zip' })
    const input = document.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    fireEvent.click(dialog.getByRole('button', { name: '上传' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/skills/data-extract/archive',
        expect.objectContaining({ method: 'POST', body: expect.stringContaining('"version":"2.0.0"') }),
      )
    })
  })

  it('M4: 技能加载失败显示错误与重试,重试成功恢复列表', async () => {
    let fail = true
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/departments') return { departments: DEPTS }
      if (path === '/api/server/admin/skills') {
        if (fail) throw new Error('skills 加载失败')
        return { skills: SKILLS }
      }
      return {}
    })
    render(<Marketplace />)
    expect(await screen.findByText(/技能加载失败/)).toBeInTheDocument()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('data-extract')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// org 渠道(员工上传、审批通过,并入本页并打「员工上传」徽标)
//
// 现场 P1:这些行此前每个按钮都打**市场命名空间**(`/api/server/admin/skills/<name>…`),
// 而服务端对 org 行在该命名空间下正确 404(serverstore.GetSkill 要求 channel=market)。
// 下面的用例断言每个动作**真的**打到共享命名空间,且服务端没有的入口被禁用。
// 路径与动词的穷举对拍在 src/lib/capability-endpoints.spec.ts(读 Go 路由声明)。
// ---------------------------------------------------------------------------

const MARKET_SKILLS = [
  { id: 1, name: 'data-extract', version: '1.0.0', description: '数据提取', author: 'seed', enabled: true },
]

/** 组织共享行:author(上传者) 与 owner(apps.owner) **不同**,便于判"归属用哪个字段"。 */
const ORG_ROWS = [
  {
    name: 'codeql', version: '1.2.0', display_name: 'CodeQL 审计', description: 'find vulns',
    author: 'bob', owner: 'alice', enabled: true, downloads: 4, calls: 9, official: false, quality: '',
  },
  {
    name: 'retired-org', version: '0.9.0', display_name: '退役组织技能', description: '老包',
    author: 'carol', owner: 'dave', enabled: false, downloads: 0, calls: 0, official: false, quality: '',
  },
]

const ORG_ROOT = '/api/server/admin/shared-skills'

function mockOrgRows() {
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/server/admin/departments') return { departments: DEPTS }
    if (path === '/api/server/admin/skills') return { skills: MARKET_SKILLS }
    if (path === '/api/server/admin/capabilities/approvals?status=approved&type=skill') return { approvals: ORG_ROWS }
    if (path.startsWith('/api/server/admin/users')) {
      return { users: [{ username: 'alice', display_name: 'Alice' }, { username: 'bob', display_name: 'Bob' }], total: 2 }
    }
    if (path.startsWith(ORG_ROOT)) {
      if (path.endsWith('/preview')) return { files: ['SKILL.md', 'scripts/run.sh'], skill_md: '# codeql\n' }
      if (path.endsWith('/grants')) return { grants: [{ grantee_type: 'group', grantee: '研发部' }] }
      if (path.includes('/file?path=')) return { content: '# codeql', size: 9, binary: false, too_large: false }
      return { ok: true, enabled: String(init?.body ?? '').includes('true') }
    }
    return {}
  })
}

function orgCard(name: string): HTMLElement {
  return screen.getByText(name).closest<HTMLElement>('[class*="group"]')!
}

describe('Marketplace 商城页 · org 行按 channel 走共享命名空间', () => {
  beforeEach(mockOrgRows)

  it('预览打到 shared-skills 的 name@version 端点(不是市场 /skills/:name/preview)', async () => {
    render(<Marketplace />)
    await screen.findByText('codeql')
    fireEvent.click(within(orgCard('codeql')).getByRole('button', { name: '预览' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${ORG_ROOT}/codeql/1.2.0/preview`)
    })
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/skills/codeql/preview')
  })

  it('预览弹窗的单文件端点同样带版本段(市场形状会 404)', async () => {
    render(<Marketplace />)
    await screen.findByText('codeql')
    fireEvent.click(within(orgCard('codeql')).getByRole('button', { name: '预览' }))
    fireEvent.click(await screen.findByRole('button', { name: 'SKILL.md' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${ORG_ROOT}/codeql/1.2.0/file?path=SKILL.md`)
    })
  })

  it('授权对话框基路径走 shared-skills(名级,不带版本)且撤销落同一前缀', async () => {
    render(<Marketplace />)
    await screen.findByText('codeql')
    fireEvent.click(within(orgCard('codeql')).getByRole('button', { name: '授权' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText('@研发部')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${ORG_ROOT}/codeql/grants`)
    })
    fireEvent.click(dialog.getAllByRole('button', { name: '撤销' })[0])
    expect(mockRequest).toHaveBeenCalledWith(
      `${ORG_ROOT}/codeql/grant`,
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ group: '研发部' }) }),
    )
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/skills/codeql/grants')
  })

  it('下架/重新上架走 PUT /shared-skills/:name/enabled 并透传真实上下架状态', async () => {
    render(<Marketplace />)
    await screen.findByText('codeql')
    // 服务端下发 enabled=false 的行必须显示「已下架」并给「重新上架」(此前硬编码 true)。
    expect(orgCard('retired-org').textContent).toContain('已下架')
    expect(orgCard('codeql').textContent).toContain('上架')
    fireEvent.click(within(orgCard('codeql')).getByRole('button', { name: '下架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${ORG_ROOT}/codeql/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      })
    })
    fireEvent.click(within(orgCard('retired-org')).getByRole('button', { name: '重新上架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(`${ORG_ROOT}/retired-org/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
      })
    })
    // 市场命名空间的两个上下架动词一律不许出现在 org 行上。
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/skills/codeql', expect.objectContaining({ method: 'DELETE' }))
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/skills/retired-org/enable', expect.objectContaining({ method: 'POST' }))
  })

  it('服务端没有的端点(编辑/上传新版/规范化)对 org 行禁用并给文案,市场行仍可点', async () => {
    render(<Marketplace />)
    await screen.findByText('codeql')
    const org = within(orgCard('codeql'))
    for (const name of ['编辑', '上传新版', '规范化']) {
      const btn = org.getByRole('button', { name })
      expect(btn, `org 行的「${name}」必须禁用(服务端无该端点)`).toBeDisabled()
      expect(btn.getAttribute('title')).toBeTruthy()
    }
    expect(orgCard('codeql').textContent).toContain('组织共享技能')
    // 市场行不受影响。
    const market = within(orgCard('data-extract'))
    expect(market.getByRole('button', { name: '编辑' })).toBeEnabled()
    expect(market.getByRole('button', { name: '上传新版' })).toBeEnabled()
    expect(market.getByRole('button', { name: '规范化' })).toBeEnabled()
  })

  it('归属显示与转移预填用 apps.owner(不是本行上传者 author)', async () => {
    render(<Marketplace />)
    await screen.findByText('codeql')
    // 展示:owner=alice,author=bob ⇒ 必须是 alice。
    expect(orgCard('codeql').textContent).toContain('归属 alice')
    expect(orgCard('codeql').textContent).not.toContain('归属 bob')
    // 预填:转移弹窗把 alice 标为「当前归属」(若误用 author,标中的会是 bob)。
    fireEvent.click(within(orgCard('codeql')).getByRole('button', { name: '归属' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('combobox'))
    // 候选列表走 Popover portal(在 dialog 子树之外),按整页查。
    const marker = await screen.findByText('当前归属')
    expect(marker.closest('[role="option"]')?.textContent).toContain('alice')
  })
})
