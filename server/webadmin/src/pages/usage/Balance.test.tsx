import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { request } from '../../api'
import { setCurrentAdmin, type MeUser } from '../../lib/rbac'
import UsageBalance from './Balance'

// ---------------------------------------------------------------------------
// 审计 R7-RV-2 残留(RECHECK3 R7RV2-1):R2 只按报告点名的 5 个文件接线,
// 「余额」页(写按钮最密集的一页,含金额对话框)整个漏了 —— auditor 看到
// 「立即补发本月 / 保存 / ¥50…¥500 / 行内调整」全套可点控件,点下去每个都是
// 403(PUT /balance、POST /balance/grant、POST /users/:id/balance 都要
// user:write),与 App 的"所有修改已禁用"横幅直接矛盾。
//
// 口径与已修页面一致:前端按权限点判定(**不请求**必然 403 的写接口、不渲染写
// 控件),服务端 RequirePermission 仍是唯一护栏。test 的对照:同一份实现下
// super_admin(全量权限)必须**照旧**看到这些控件 —— 修 auditor 不能误伤别人。
// ---------------------------------------------------------------------------
const mockRequest = vi.mocked(request)

const AUDITOR: MeUser = { role: 'auditor', permissions: ['audit:read', 'usage:read', 'user:read'] }
const ADMIN: MeUser = { role: 'user', permissions: ['user:read', 'user:write'] }
const SUPER: MeUser = { role: 'super_admin', permissions: undefined }
const EMPLOYEE: MeUser = { role: 'user', permissions: [] }
/** 有 user:read、没有 user:write 的部分权限集（等价形态：不是"空权限"才算只读）。 */
const READONLY: MeUser = { role: 'user', permissions: ['user:read', 'usage:read'] }

const USERS = [
  { id: 1, username: 'alice', display_name: 'Alice', status: 1, groups: ['研发部'], balance_money: 50, balance_activated: true, monthly_cost: 1.5, monthly_usage: 100 },
  { id: 2, username: 'bob', display_name: 'Bob', status: 1, groups: [], balance_money: 0, balance_activated: false, monthly_cost: 0, monthly_usage: 0 },
]

const SUMMARY = {
  settings: { enabled: true, monthly_amount: 100, monthly_mode: 'add' as const },
  last_grant: null,
  month_grant: null,
  status: { month: '2026-09', eligible: 2, granted: 2, pending: 0, activated: 1 },
  users: 2,
  total_balance: 50,
}

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/server/admin/balance')) return SUMMARY
    if (path.startsWith('/api/server/admin/users?')) return { users: USERS, total: USERS.length }
    if (path.startsWith('/api/server/admin/users/1/balance/ledger')) {
      return { items: [{ id: 9, kind: 'grant', amount: 50, balance_after: 50, reason: '9 月发放', actor: 'admin', usage_id: null, month: '2026-09', created_at: '2026-09-01T10:00:00+08:00' }], ledger_sum: 50 }
    }
    return {}
  })
})

afterEach(() => setCurrentAdmin(null))

function renderPage() {
  return render(<MemoryRouter><UsageBalance /></MemoryRouter>)
}

describe('审计员访问余额页(R7-RV-2 残留):写控件必须缺席', () => {
  it('auditor 看不到任何注定 403 的写控件(按钮/输入框/发放方式),但读面照常', async () => {
    setCurrentAdmin(AUDITOR)
    renderPage()

    // 读面(user:read)照常:员工行与余额、流水入口都在。
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()

    // 写控件缺席:补发/保存/调整/额度输入/发放方式全都不渲染或已禁用。
    expect(screen.queryByRole('button', { name: /立即补发本月/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^保存$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /调整/ })).toBeNull()
    const amount = screen.getByLabelText('每人每月额度(元)') as HTMLInputElement
    expect(amount.disabled || amount.readOnly).toBe(true)
    for (const v of ['¥50', '¥100', '¥200', '¥500']) {
      expect(screen.queryByRole('button', { name: v })).toBeNull()
    }
    // 只读说明要说明"为什么"(权限点),而不是只有一句 403。
    expect(screen.getByText(/user:write/)).toBeInTheDocument()

    // 前端不请求必然 403 的写接口(读面照常请求)。
    const paths = mockRequest.mock.calls.map(([p]) => String(p))
    expect(paths).toContain('/api/server/admin/balance')
    expect(paths.some((p) => p.includes('/balance/grant'))).toBe(false)
    expect(paths.some((p) => p.startsWith('/api/server/admin/users/1/balance'))).toBe(false)

    // 流水是 user:read,auditor 仍可打开(不误伤读面)。
    fireEvent.click(screen.getAllByRole('button', { name: /流水/ })[0]!)
    await waitFor(() => {
      expect(mockRequest.mock.calls.map(([p]) => String(p)).some((p) => p.includes('/balance/ledger'))).toBe(true)
    })
  })

  it('auditor 点击行内区域不会弹出金额调整对话框', async () => {
    setCurrentAdmin(AUDITOR)
    renderPage()
    await screen.findByText('Alice')
    // 没有任何元素能打开「调整余额」对话框(名字都不该出现)。
    expect(screen.queryByText(/调整余额/)).toBeNull()
    fireEvent.click(screen.getByText('Alice'))
    expect(screen.queryByText(/调整余额/)).toBeNull()
  })

  it('auditor 不会因为 ?user= 深链自动打开调整对话框', async () => {
    setCurrentAdmin(AUDITOR)
    render(<MemoryRouter initialEntries={['/usage/balance?user=alice']}><UsageBalance /></MemoryRouter>)
    await screen.findByText('Alice')
    expect(screen.queryByText(/调整余额/)).toBeNull()
  })
})

describe('非 auditor 角色不受影响(角色矩阵)', () => {
  it('user:write(admin)仍能看到全部写控件', async () => {
    setCurrentAdmin(ADMIN)
    renderPage()
    await screen.findByText('Alice')
    expect(screen.getByRole('button', { name: /立即补发本月/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^保存$/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /调整/ }).length).toBe(2)
    expect((screen.getByLabelText('每人每月额度(元)') as HTMLInputElement).disabled).toBe(false)
  })

  it('super_admin(未下发 permissions 的白名单分支)仍能看到全部写控件', async () => {
    setCurrentAdmin(SUPER)
    renderPage()
    await screen.findByText('Alice')
    expect(screen.getByRole('button', { name: /立即补发本月/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /调整/ }).length).toBe(2)
  })

  it('普通员工(无任何管理权限)同样看不到写控件', async () => {
    setCurrentAdmin(EMPLOYEE)
    renderPage()
    await screen.findByText('Alice')
    expect(screen.queryByRole('button', { name: /立即补发本月/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /调整/ })).toBeNull()
  })

  it('只有 user:read 的部分权限集同样是只读视图(等价形态)', async () => {
    setCurrentAdmin(READONLY)
    renderPage()
    await screen.findByText('Alice')
    expect(screen.queryByRole('button', { name: /立即补发本月/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^保存$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /调整/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: /流水/ }).length).toBe(2)
  })
})
