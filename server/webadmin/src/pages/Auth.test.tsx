import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { request } from '../api'
import Auth from './Auth'

const mockRequest = vi.mocked(request)

const AUTH_SAMPLE = {
  auth: {
    mode: 'local',
    enabled: 'local,ldap,oidc',
    hide_local: false,
    ldap: {
      server_url: 'ldap://ldap.example.com:389',
      bind_dn: 'cn=admin,dc=example,dc=com',
      bind_password: '***',
      base_dn: 'dc=example,dc=com',
      user_filter: '(uid=%s)',
      group_filter: '(memberOf=cn=%s)',
      group_attr: 'cn',
    },
    oidc: {
      issuer: 'https://idp.example.com',
      client_id: 'webadmin-client',
      client_secret: '***',
      redirect_url: 'https://picoaide.example.com/api/auth/oidc/callback',
    },
    openid: { issuer: '', client_id: '', client_secret: '', redirect_url: '' },
  },
}

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/server/admin/auth') return AUTH_SAMPLE
    return {}
  })
})

describe('Auth 认证配置页(v3b Tab 重设计)', () => {
  it('渲染启用方式与 hide_local 开关', async () => {
    render(<Auth />)
    expect(await screen.findByText('认证配置')).toBeInTheDocument()
    // 启用方式(恒有 local + 服务端 enabled 的 ldap/oidc)
    expect(screen.getByRole('checkbox', { name: /本地账号/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /LDAP/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /OIDC/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /OpenID/ })).toBeInTheDocument()
    // hide_local 开关
    const hide = screen.getByLabelText('隐藏客户端本地登录入口') as HTMLInputElement
    expect(hide.checked).toBe(false)
  })

  it('保存:提交 PUT /api/admin/auth 并提示(含 hide_local)', async () => {
    render(<Auth />)
    await screen.findByText('认证配置')
    // 直接点保存(不切换 Tab; 服务端启用方式已全配置, 前端校验通过)
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/auth', expect.objectContaining({ method: 'PUT' }))
    })
    expect(await screen.findByText('认证配置已保存(重启服务端后生效)')).toBeInTheDocument()
  })

  it('校验:启用 LDAP 但配置不完整 → 复选框禁用', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/auth') return { auth: { mode: 'local', enabled: 'local' } }
      return {}
    })
    render(<Auth />)
    await screen.findByText('认证配置')
    // 未配置 LDAP 必填 → checkbox disabled(启用绑定配置)
    const ldap = screen.getByRole('checkbox', { name: /LDAP/ }) as HTMLInputElement
    expect(ldap.disabled).toBe(true)
  })

  it('hide_local 开关: 勾选后保存提交 hide_local:true', async () => {
    render(<Auth />)
    await screen.findByText('认证配置')
    const hide = screen.getByLabelText('隐藏客户端本地登录入口')
    fireEvent.click(hide)
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/auth', expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"hide_local":true'),
      }))
    })
  })

  it('密码回显修复: 掩码不进输入框; 未改密码保存时回传 *** 保持现值', async () => {
    const user = userEvent.setup()
    render(<Auth />)
    await screen.findByText('认证配置')
    // 打开 LDAP tab(radix tabs 需要完整 pointer 事件)
    await user.click(screen.getByRole('tab', { name: 'LDAP' }))
    // Bind 密码输入框应为空(不显示 ***), 且有「已配置」徽标
    const pw = screen.getByLabelText(/Bind 密码/) as HTMLInputElement
    expect(pw.value).toBe('')
    expect(screen.getByText('已配置')).toBeInTheDocument()
    // 保存: 提交的 bind_password 必须是 *** (保持现值)
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/auth', expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"bind_password":"***"'),
      }))
    })
  })

  it('LDAP 测试连接: 返回目录统计并展示样例', async () => {
    const user = userEvent.setup()
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/auth') return AUTH_SAMPLE
      if (path === '/api/server/admin/auth/test') {
        return {
          ok: true,
          message: 'LDAP 连接成功',
          users: 128,
          groups: 9,
          sample: [
            { username: 'alice', display_name: 'Alice', email: 'alice@example.com', groups: ['admins'] },
            { username: 'bob', display_name: 'Bob', email: 'bob@example.com', groups: [] },
          ],
        }
      }
      return {}
    })
    render(<Auth />)
    await screen.findByText('认证配置')
    await user.click(screen.getByRole('tab', { name: 'LDAP' }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText(/匹配到/)).toBeInTheDocument()
    expect(screen.getByText(/128/)).toBeInTheDocument()
    expect(screen.getByText(/9/)).toBeInTheDocument()
    // 样例展示
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('admins')).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // 2026-09-23 审计 WEB-2(P0):`GET /auth` 失败时的写面闸门。
  //
  // 原缺陷:`load()` 的 `finally { setLoading(false) }` 是整页**唯一**闸门 ⇒
  // 读取失败后表单照样渲染并解锁,而初值是最空的一份(`enabled=['local']`、
  // `EMPTY_FORM`、`secrets={}`);前端校验只遍历"启用中的非 local"(空循环直接过)
  // ⇒ 一次「保存认证配置」就把 `auth.enabled` 收敛成 `local`、清空 LDAP/OIDC/
  // OpenID 全部字段,并用**空串的密文覆盖已存密钥**(不可恢复,全员 SSO/LDAP
  // 登录当场失败)。本用例锁住"读不到就不许写"。
  // -------------------------------------------------------------------------
  it('WEB-2:GET /auth 失败后写面锁定(保存禁用且不发 PUT),重新加载成功后才解锁', async () => {
    let fail = true
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/auth' && (init?.method ?? 'GET') === 'GET') {
        if (fail) throw new Error('认证配置读取失败（模拟 500/网络错误）')
        return AUTH_SAMPLE
      }
      if (path === '/api/server/admin/auth' && init?.method === 'PUT') return { ok: true }
      return {}
    })
    render(<Auth />)

    // 错误原因 + "表单已锁定"的说明都在(空表单否则读起来像"当前没有任何认证方式")。
    expect(await screen.findByText(/认证配置读取失败/)).toBeInTheDocument()
    expect(screen.getByText(/表单已锁定/)).toBeInTheDocument()
    const save = screen.getByRole('button', { name: '保存认证配置' })
    expect(save).toBeDisabled()
    // 程序化点击(绕开 disabled)也不能发出那个把 SSO 与密钥抹掉的请求。
    fireEvent.click(save)
    expect(mockRequest.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false)

    // 正向对照(防"永远禁用"式假绿):服务端恢复后「重新加载配置」解锁,
    // 保存提交的是**服务端读到的**启用方式,而不是那份空初值。
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重新加载配置' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存认证配置' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[1]?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put![1]!.body))
      expect(body.enabled).toBe('local,ldap,oidc')
      // 未重新输入密码 ⇒ 回传 *** 保持现值(不是空串覆盖)。
      expect(body.ldap.bind_password).toBe('***')
      expect(body.oidc.client_secret).toBe('***')
    })
  })
})
