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
})
