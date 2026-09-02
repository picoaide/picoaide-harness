import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Login from './Login'
import { login, loginMFA } from '../api'

const mockLogin = vi.mocked(login)
const mockLoginMFA = vi.mocked(loginMFA)

// 0057: 管理员两步登录状态机(密码 → MFA 动态码)。
// 网络层行为由 Go 侧测试覆盖, 这里只验证 UI 状态机与交互。
beforeEach(() => {
  mockLogin.mockReset()
  mockLoginMFA.mockReset()
})

describe('Login 两步登录', () => {
  it('常规登录: 密码表单提交后直接回调(无 MFA)', async () => {
    mockLogin.mockResolvedValue({ csrf_token: 'c1', user: { username: 'boss' } })
    const onLoggedIn = vi.fn()
    render(<Login onLoggedIn={onLoggedIn} />)
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'boss' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw123456' } })
    fireEvent.click(screen.getByRole('button', { name: '登 录' }))
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1))
    expect(mockLogin).toHaveBeenCalledWith('boss', 'pw123456')
  })

  it('MFA 两步: 密码通过后切换动态码表单, 校验后回调', async () => {
    mockLogin.mockResolvedValue({ mfa_required: true, mfa_ticket: 't1' })
    mockLoginMFA.mockResolvedValue({ csrf_token: 'c2', user: { username: 'boss' } })
    const onLoggedIn = vi.fn()
    render(<Login onLoggedIn={onLoggedIn} />)
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'boss' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw123456' } })
    fireEvent.click(screen.getByRole('button', { name: '登 录' }))
    // 进入动态码表单
    await waitFor(() => expect(screen.getByLabelText('动态验证码')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('动态验证码'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: '验 证' }))
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1))
    expect(mockLoginMFA).toHaveBeenCalledWith('t1', '123456')
  })

  it('MFA 失败可返回重新登录', async () => {
    mockLogin.mockResolvedValue({ mfa_required: true, mfa_ticket: 't1' })
    mockLoginMFA.mockRejectedValue(new Error('动态码错误或已失效'))
    const onLoggedIn = vi.fn()
    render(<Login onLoggedIn={onLoggedIn} />)
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'boss' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw123456' } })
    fireEvent.click(screen.getByRole('button', { name: '登 录' }))
    await waitFor(() => expect(screen.getByLabelText('动态验证码')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('动态验证码'), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: '验 证' }))
    await waitFor(() => expect(screen.getByText('动态码错误或已失效')).toBeInTheDocument())
    expect(onLoggedIn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回重新登录' }))
    await waitFor(() => expect(screen.getByLabelText('用户名')).toBeInTheDocument())
  })
})
