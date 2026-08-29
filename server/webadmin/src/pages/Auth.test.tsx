import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { request } from '../api'
import Auth from './Auth'

const mockRequest = vi.mocked(request)

const AUTH_SAMPLE = {
  auth: {
    mode: 'local',
    enabled: 'local,ldap,oidc',
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
    if (path === '/api/admin/auth') return AUTH_SAMPLE
    return {}
  })
})

describe('Auth 认证配置页', () => {
  it('渲染登录方式与已配置的 LDAP/OIDC 表单(按 enabled 显示)', async () => {
    render(<Auth />)
    expect(await screen.findByText('认证配置')).toBeInTheDocument()
    // 登录方式开关
    expect(screen.getByText('登录方式(可多选;本地 admin 恒启用)')).toBeInTheDocument()
    expect(screen.getByText('本地账号')).toBeInTheDocument()
    expect(screen.getByText('LDAP')).toBeInTheDocument()
    expect(screen.getByText('OpenID')).toBeInTheDocument()
    expect(screen.getByText('OIDC')).toBeInTheDocument()
    // enabled 含 ldap/oidc → 对应表单显示;openid 未启用 → 不显示
    expect(screen.getByLabelText('服务器地址(ldap://ldap.example.com:389)')).toHaveValue('ldap://ldap.example.com:389')
    expect(screen.getByLabelText('Bind DN')).toHaveValue('cn=admin,dc=example,dc=com')
    expect(screen.getByLabelText('Issuer(如 https://idp.example.com)')).toHaveValue('https://idp.example.com')
    expect(screen.getByLabelText('Client ID')).toHaveValue('webadmin-client')
    expect(screen.queryByLabelText(/OpenID 配置/)).not.toBeInTheDocument()
  })

  it('保存:提交 PUT /api/admin/auth 并提示(密码留空=保持现值)', async () => {
    render(<Auth />)
    await screen.findByText('认证配置')
    // 修改一个字段后保存
    const url = screen.getByLabelText('服务器地址(ldap://ldap.example.com:389)')
    fireEvent.change(url, { target: { value: 'ldap://new.example.com:389' } })
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/admin/auth', {
        method: 'PUT',
        body: JSON.stringify({
          mode: 'local',
          enabled: 'local,ldap,oidc',
          ldap: {
            server_url: 'ldap://new.example.com:389',
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
        }),
      })
    })
    expect(await screen.findByText('认证配置已保存(重启服务端后生效)')).toBeInTheDocument()
  })

  it('校验:勾选 LDAP 但缺必填项 → 阻止保存并提示', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/admin/auth') return { auth: { mode: 'local', enabled: 'local' } }
      return {}
    })
    render(<Auth />)
    await screen.findByText('认证配置')
    // 勾选 LDAP(默认未勾选时不显示表单;勾选后必填校验生效)
    fireEvent.click(screen.getByRole('checkbox', { name: /LDAP/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    expect(await screen.findByText('LDAP 模式必须填写服务器地址与 Base DN')).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalledWith('/api/admin/auth', expect.objectContaining({ method: 'PUT' }))
  })
})
