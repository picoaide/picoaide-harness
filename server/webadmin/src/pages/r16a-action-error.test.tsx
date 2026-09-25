import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { request } from '../api'
import { ROUTER_FUTURE } from '@/lib/router-future'
import Capabilities from './Capabilities'
import Connectors from './Connectors'

// R16A-18（审计 2026-09-25，P3；泳道 A 报告 §4.3）：**读取失败**与**动作失败**必须是
// 两个状态。
//
// 缺陷形态：`Capabilities.tsx` 与 `Connectors.tsx` 各自只有**一个** `error` state，
// 列表 GET 失败写它、**写动作失败也写它**，而渲染分支是
// `error ? <EmptyState「…未读取成功 / 读取失败时不渲染任何行」>` ⇒ 一次**写**请求失败
// （拒绝理由是空 / approve / reject / delete / 上下架 / 连接器开关 / 删除）就把整张表
// 换成"读取失败"，文案还反过来说"为避免把上一页的数据当成当前结果"—— 而列表读**从未**
// 失败。修前对照（`git show 9b22871fe4^:server/webadmin/src/pages/Capabilities.tsx`）：
// 同一段是 `{error && <p …>}` + **表格照常渲染** ⇒ 这是 R15C-W-02 修复**新引入**的误伤。
//
// 口径（同族 T 处已就位：Departments/Apps/Balance/Audit 用独立的 `loadError`）：
//   - `loadError` 非空 ⇒ 页面级确定态，不渲染任何行（W-02 的判据，本文件仍钉住）；
//   - `error` 非空 ⇒ 只显示横幅，**表格与行内控件照常渲染**。
//
// 判据（本文件）：写动作失败后（a）列表仍在、（b）行内控件仍在、（c）页面**不得**出现
// "读取成功"字样的失败态。反向对照：读取失败后必须撤下列表并显示失败态（防"把闸门
// 一起拆了"造成的假绿）。

const mockRequest = vi.mocked(request)
const API = '/api/server/admin'

beforeEach(() => {
  mockRequest.mockReset()
  window.confirm = vi.fn(() => true) as unknown as typeof window.confirm
})

function renderInRouter(node: React.ReactElement) {
  return render(<MemoryRouter future={ROUTER_FUTURE}>{node}</MemoryRouter>)
}

const PENDING_ROW = {
  kind: 'skill' as const,
  name: 'pend-skill-r16a',
  version: '1.0.0',
  display_name: '待审技能R16A',
  description: 'd',
  author: 'alice',
  owner: 'alice',
  status: 'pending' as const,
  reason: '',
  quality: '' as const,
  downloads: 0,
  created_at: '2026-09-24T10:00:00Z',
  base_path: `${API}/shared-skills/pend-skill-r16a/1.0.0`,
  grants_base: `${API}/shared-skills/pend-skill-r16a`,
  preview_path: `${API}/shared-skills/pend-skill-r16a/1.0.0/preview`,
}

describe('R16A-18 Capabilities：动作失败不得被渲染成"审批列表未读取成功"', () => {
  it('删除动作失败 ⇒ 横幅报错、行仍在（表格未被撤下），且不出现"未读取成功"', async () => {
    mockRequest.mockImplementation(async (p: string, init?: any) => {
      if (p.startsWith(`${API}/capabilities/approvals`)) return { approvals: [PENDING_ROW] } as any
      if (p === `${API}/departments`) return { departments: [] } as any
      if (p === PENDING_ROW.base_path && init?.method === 'DELETE') throw new Error('删除失败: 409')
      return {} as any
    })
    renderInRouter(<Capabilities />)

    // 前置：读到行 + 行内「删除」可点。
    expect(await screen.findByText('待审技能R16A')).toBeInTheDocument()
    const del = screen.getAllByRole('button', { name: '删除' })
    expect(del.length).toBe(1)

    const user = userEvent.setup()
    await user.click(del[0])
    // 确认对话框（删除是不可恢复动作）→ 点**对话框里**的「确认」。
    // 注意：动作失败时对话框**不自动关闭**（既有行为），而 Radix 的模态会把背景
    // 置为 aria-hidden ⇒ 背景里的行内按钮对 ByRole 不可见。所以先关掉对话框再断言
    // "行与行内控件仍在"（这才是本判据要看的：表格没有被撤下）。
    await user.click(await screen.findByRole('button', { name: '确认' }))

    // 动作失败的横幅出现（错误信息可见）。
    await waitFor(() => expect(screen.getByText(/删除失败/)).toBeInTheDocument())
    // 核心（不依赖 aria-hidden）：列表**没有**被渲染成"读取失败"的页面级确定态。
    expect(screen.queryByText('审批列表未读取成功')).toBeNull()
    expect(screen.getByText('待审技能R16A')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 关掉对话框后：行内「删除」仍在（表格照常渲染，不是空态、不是失败态）。
    expect(screen.getAllByRole('button', { name: '删除' }).length).toBe(1)
    expect(screen.queryByText('审批列表未读取成功')).toBeNull()
    expect(screen.queryByText('暂无待处理能力')).toBeNull()
  })

  it('反向对照：列表读取失败 ⇒ 行撤下 + 页面级失败态（W-02 判据不退化）', async () => {
    let call = 0
    mockRequest.mockImplementation(async (p: string) => {
      if (p.startsWith(`${API}/capabilities/approvals`)) {
        call += 1
        if (call === 1) return { approvals: [PENDING_ROW] } as any
        throw new Error('查询失败: 500')
      }
      if (p === `${API}/departments`) return { departments: [] } as any
      return {} as any
    })
    renderInRouter(<Capabilities />)
    expect(await screen.findByText('待审技能R16A')).toBeInTheDocument()

    // 切 tab ⇒ 触发重拉（第二次 GET 失败）。
    await userEvent.setup().click(screen.getByRole('tab', { name: /已拒绝/ }))
    await waitFor(() => expect(screen.getByText('审批列表未读取成功')).toBeInTheDocument())
    expect(screen.queryByText('待审技能R16A')).toBeNull()
    expect(screen.queryByText('暂无待处理能力')).toBeNull()
  })
})

describe('R16A-18 Connectors：动作失败不得把整表换成"连接器列表未读取成功"', () => {
  const CONNECTOR = {
    id: 'example-mcp', name: 'CRM R16A', description: '', auth_mode: 'token',
    definition: '{"mcp":[]}', enabled: true,
    updated_at: '2026-09-24T10:00:00Z', created_at: '2026-09-24T10:00:00Z',
  }

  it('删除动作失败 ⇒ 行仍在，"连接器列表未读取成功"不出现', async () => {
    mockRequest.mockImplementation(async (p: string, init?: any) => {
      if (p === `${API}/connectors` && (!init || init.method === undefined || init.method === 'GET')) {
        return { connectors: [CONNECTOR] } as any
      }
      if (p === `${API}/connectors/${CONNECTOR.id}` && init?.method === 'DELETE') throw new Error('删除失败: 409')
      return {} as any
    })
    renderInRouter(<Connectors />)
    expect(await screen.findByText('CRM R16A')).toBeInTheDocument()

    const user = userEvent.setup()
    // 行内删除按钮是图标按钮（aria-label="删除"），确认弹窗里那颗按钮的文案就是
    // 「删除」⇒ 用弹窗标题定位后再在弹窗内点确认，避免歧义。
    await user.click(screen.getByRole('button', { name: '删除' }))
    const dialog = await screen.findByRole('dialog')
    const confirmBtn = within(dialog).getByRole('button', { name: /删除/ })
    await user.click(confirmBtn)
    await waitFor(() => expect(screen.getByText(/删除失败/)).toBeInTheDocument())

    // 列表没有被换成"读取失败"的页面级确定态（ByText 不受模态 aria-hidden 影响）。
    expect(screen.queryByText('连接器列表未读取成功')).toBeNull()
    expect(screen.getByText('CRM R16A')).toBeInTheDocument()
  })

  it('反向对照：刷新读取失败 ⇒ 旧行撤下 + 页面级失败态（W-03 判据不退化）', async () => {
    let call = 0
    mockRequest.mockImplementation(async (p: string) => {
      if (p === `${API}/connectors`) {
        call += 1
        if (call === 1) return { connectors: [CONNECTOR] } as any
        throw new Error('查询失败: 500')
      }
      return {} as any
    })
    renderInRouter(<Connectors />)
    expect(await screen.findByText('CRM R16A')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /刷新/ }))
    await waitFor(() => expect(screen.getByText('连接器列表未读取成功')).toBeInTheDocument())
    expect(screen.queryByText('CRM R16A')).toBeNull()
  })
})
