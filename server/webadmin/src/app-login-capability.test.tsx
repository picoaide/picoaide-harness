import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from './App'
import { login, me, request, ApiError } from './api'
import { currentAdminUser, setCurrentAdmin } from './lib/rbac'

// ---------------------------------------------------------------------------
// 审计 R7 残余(R7-RV-2):登录后**未刷新页面**时前端能力判定完全失效。
//
// 机理:挂载时那次 /me 在未登录状态下是 401(authed=false),`setCurrentAdmin`
// 因此从未被写入;`onLoggedIn` 只把 authed 置 true 就整树渲染应用壳,于是
//   - meUser=null ⇒ visibleNav([]) 把所有导航项判为不可见(空侧栏);
//   - hasPermission() 因 `Array.isArray(undefined)` 为假而**默认放行** ⇒
//     只读角色看到全套写按钮(全部注定 403)。
// 复核员的真浏览器探针:登录后第一屏 {"nav":[],"createUser":true,rowButtons:[…6 个]}。
// 刷新后才正确 —— 也就是说 branding-3 的"只读视图"承诺在管理员最常见的登录
// 路径上不生效。
//
// 修法:登录成功(含 MFA 第二步)后**重新拉取 /me**,把 meUser 与 currentAdmin
// 快照一起刷新,再进入应用壳。
// ---------------------------------------------------------------------------
const mockMe = vi.mocked(me)
const mockLogin = vi.mocked(login)
const mockRequest = vi.mocked(request)

const auditor = {
  role: 'auditor' as const,
  username: 'aud',
  display_name: '审计员',
  permissions: ['audit:read', 'usage:read', 'user:read'],
}
const boss = {
  role: 'super_admin' as const,
  username: 'boss',
  display_name: '老板',
  permissions: ['user:read', 'user:write', 'dept:read', 'dept:write', 'usage:read', 'gateway:read', 'audit:read'],
}

beforeEach(() => {
  window.history.pushState({}, '', '/admin/')
  mockMe.mockReset()
  mockLogin.mockReset()
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/server/admin/users')) return { users: [], total: 0, page: 1, size: 20 }
    return {}
  })
  // useChannel() 走原生 fetch(公开渠道端点);jsdom 里给个空渠道内容。
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentAdmin(null)
})

/** 渲染 App 并走完一次密码登录(挂载时那次 /me 是 401)。 */
async function loginThroughForm(): Promise<void> {
  mockMe.mockRejectedValueOnce(new ApiError(401, 'AUTH_REQUIRED', '未登录'))
  render(<App />)
  const user = await screen.findByLabelText('用户名')
  fireEvent.change(user, { target: { value: 'aud' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw-123456' } })
  fireEvent.click(screen.getByRole('button', { name: '登 录' }))
}

describe('登录后的能力判定(R7-RV-2)', () => {
  it('re-fetches /me after login so an auditor never sees the write surface without a reload', async () => {
    mockLogin.mockResolvedValue({ csrf_token: 'c1' })
    mockMe.mockResolvedValue({ user: auditor })
    await loginThroughForm()

    // ① 登录后必须重新拉 /me(挂载那次是 401,不能拿它当能力依据)。
    await waitFor(() => expect(mockMe).toHaveBeenCalledTimes(2))

    // ② 只读角色的侧栏立刻正确(修前是空导航)。
    expect(await screen.findByRole('link', { name: /审计日志/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /用户/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /用量中心/ })).toBeInTheDocument()
    expect(screen.getByText(/当前为审计只读视图/)).toBeInTheDocument()

    // ③ 写入口必须当场消失(修前是「新建用户」+ 6 个行内写按钮,全部注定 403)。
    await waitFor(() => expect(screen.queryByRole('button', { name: '新建用户' })).toBeNull())

    // ④ 页面判定读到的也是登录后的快照,而不是挂载期那次失败的结果。
    expect(currentAdminUser()?.role).toBe('auditor')
  })

  it('still grants the write surface to a super admin who logs in without reloading', async () => {
    mockLogin.mockResolvedValue({ csrf_token: 'c2' })
    mockMe.mockResolvedValue({ user: boss })
    await loginThroughForm()

    // 不能为了修只读角色把写入口对所有人收掉(过度纠正)。
    // 显式 5s 预算：默认 1000ms 在 CI/4 路并行负载下不够（2026-09-17 审计实测
    // 4 路并行 8 次里红 1 次，报错是 findBy* 超时而非判据错）。判据不变，只放宽上限。
    expect(await screen.findByRole('button', { name: '新建用户' }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/当前为审计只读视图/)).toBeNull()
  })
})
