import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { SecretInput } from '../components/secret-input'
import { PageHeader } from '../components/page-header'

// 认证配置页:员工登录方式(本地恒启用 / LDAP / OpenID / OIDC,可多选)
// 与各 IdP 参数配置。原为网关页底部卡片,独立成菜单便于管理。
// 修改后重启服务端生效(服务端启动时注册对应 provider)。

interface AuthForm {
  mode: string
  enabled: string[]
  ldap_server_url: string
  ldap_bind_dn: string
  ldap_bind_password: string
  ldap_base_dn: string
  ldap_user_filter: string
  ldap_group_filter: string
  ldap_group_attr: string
  oidc_issuer: string
  oidc_client_id: string
  oidc_client_secret: string
  oidc_redirect_url: string
  openid_issuer: string
  openid_client_id: string
  openid_client_secret: string
  openid_redirect_url: string
}

interface AuthConfig {
  mode?: string
  enabled?: string
  ldap?: Record<string, string>
  oidc?: Record<string, string>
  openid?: Record<string, string>
}

const EMPTY_FORM: AuthForm = {
  mode: 'local',
  enabled: ['local'],
  ldap_server_url: '', ldap_bind_dn: '', ldap_bind_password: '', ldap_base_dn: '',
  ldap_user_filter: '', ldap_group_filter: '', ldap_group_attr: '',
  oidc_issuer: '', oidc_client_id: '', oidc_client_secret: '', oidc_redirect_url: '',
  openid_issuer: '', openid_client_id: '', openid_client_secret: '', openid_redirect_url: '',
}

const METHODS = [
  { key: 'local', label: '本地账号', desc: '用户名+密码(admin 回退,恒启用)' },
  { key: 'ldap', label: 'LDAP', desc: '企业目录认证' },
  { key: 'openid', label: 'OpenID', desc: '浏览器跳转登录(独立 IdP)' },
  { key: 'oidc', label: 'OIDC', desc: '浏览器跳转登录(独立 IdP)' },
]

export default function Auth() {
  const [authForm, setAuthForm] = useState<AuthForm>(EMPTY_FORM)
  const [authErr, setAuthErr] = useState('')
  const [authMsg, setAuthMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const au = await request('/api/admin/auth') as { auth?: AuthConfig }
      const a = au.auth ?? {}
      const ldap = a.ldap ?? {}
      const oidc = a.oidc ?? {}
      const openid = a.openid ?? {}
      setAuthForm({
        mode: a.mode || 'local',
        enabled: (a.enabled ? String(a.enabled).split(',').map((s) => s.trim()).filter(Boolean) : ['local']),
        ldap_server_url: ldap.server_url ?? '', ldap_bind_dn: ldap.bind_dn ?? '',
        ldap_bind_password: ldap.bind_password ?? '', ldap_base_dn: ldap.base_dn ?? '',
        ldap_user_filter: ldap.user_filter ?? '', ldap_group_filter: ldap.group_filter ?? '',
        ldap_group_attr: ldap.group_attr ?? '',
        oidc_issuer: oidc.issuer ?? '', oidc_client_id: oidc.client_id ?? '',
        oidc_client_secret: oidc.client_secret ?? '', oidc_redirect_url: oidc.redirect_url ?? '',
        openid_issuer: openid.issuer ?? '', openid_client_id: openid.client_id ?? '',
        openid_client_secret: openid.client_secret ?? '', openid_redirect_url: openid.redirect_url ?? '',
      })
    } catch (err: any) {
      setAuthErr(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 保存认证配置:*** / 空 = 保持现值(密码类字段留在掩码态)
  async function saveAuth() {
    if (busy) return
    setAuthErr('')
    const enabled = authForm.enabled.filter((s) => s !== '')
    if (!enabled.includes('local')) enabled.unshift('local') // 本地 admin 恒启用
    if (enabled.includes('ldap')) {
      if (!authForm.ldap_server_url.trim() || !authForm.ldap_base_dn.trim()) {
        setAuthErr('LDAP 模式必须填写服务器地址与 Base DN'); return
      }
    }
    if (enabled.includes('oidc')) {
      if (!authForm.oidc_issuer.trim() || !authForm.oidc_client_id.trim() || !authForm.oidc_redirect_url.trim()) {
        setAuthErr('OIDC 模式必须填写 Issuer、Client ID 与 Redirect URL'); return
      }
    }
    if (enabled.includes('openid')) {
      if (!authForm.openid_issuer.trim() || !authForm.openid_client_id.trim() || !authForm.openid_redirect_url.trim()) {
        setAuthErr('OpenID 模式必须填写 Issuer、Client ID 与 Redirect URL'); return
      }
    }
    setBusy(true)
    try {
      await request('/api/admin/auth', {
        method: 'PUT',
        body: JSON.stringify({
          mode: authForm.mode,
          enabled: enabled.join(','),
          ldap: {
            server_url: authForm.ldap_server_url,
            bind_dn: authForm.ldap_bind_dn,
            bind_password: authForm.ldap_bind_password,
            base_dn: authForm.ldap_base_dn,
            user_filter: authForm.ldap_user_filter,
            group_filter: authForm.ldap_group_filter,
            group_attr: authForm.ldap_group_attr,
          },
          oidc: {
            issuer: authForm.oidc_issuer,
            client_id: authForm.oidc_client_id,
            client_secret: authForm.oidc_client_secret,
            redirect_url: authForm.oidc_redirect_url,
          },
          openid: {
            issuer: authForm.openid_issuer,
            client_id: authForm.openid_client_id,
            client_secret: authForm.openid_client_secret,
            redirect_url: authForm.openid_redirect_url,
          },
        }),
      })
      setAuthMsg('认证配置已保存(重启服务端后生效)')
      setTimeout(() => setAuthMsg(''), 4000)
      load()
    } catch (err: any) {
      setAuthErr(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>

  return (
    <div className="space-y-6">
      <PageHeader
        title="认证配置"
        desc="员工登录方式:本地账号(恒启用) / LDAP / OpenID / OIDC,可多选;修改后重启服务端生效"
      />
      <Card>
        <CardHeader>
          <CardTitle>登录方式</CardTitle>
          <CardDescription>勾选的方式会出现在登录页;未配置的 IdP 下方表单留空即可</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {authErr && <div className="text-sm text-destructive">{authErr}</div>}
          {authMsg && <div className="text-sm text-green-600">{authMsg}</div>}
          <div className="space-y-1">
            <Label>登录方式(可多选;本地 admin 恒启用)</Label>
            <div className="flex flex-wrap gap-3 rounded-md border p-3">
              {METHODS.map((o) => {
                const on = authForm.enabled.includes(o.key)
                return (
                  <label key={o.key} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${on ? 'border-primary/40 bg-accent' : 'hover:bg-muted'}`}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#4176E6]"
                      checked={on}
                      disabled={o.key === 'local'} // 本地 admin 不可关
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...authForm.enabled, o.key]
                          : authForm.enabled.filter((s) => s !== o.key)
                        setAuthForm({ ...authForm, enabled: next })
                      }}
                    />
                    <span className="font-medium">{o.label}</span>
                    <span className="text-xs text-muted-foreground">{o.desc}</span>
                  </label>
                )
              })}
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>勾选的方式会出现在登录页;未配置的下方表单留空即可。</li>
              <li>密码/密钥字段留空 = 保持现值,清空 = 清除。</li>
            </ul>
          </div>

          {authForm.enabled.includes('ldap') && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="text-sm font-medium">LDAP 配置</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="ldap-url">服务器地址(ldap://ldap.example.com:389)</Label>
                  <Input id="ldap-url" value={authForm.ldap_server_url} placeholder="ldap://ldap.example.com:389"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_server_url: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-bind-dn">Bind DN</Label>
                  <Input id="ldap-bind-dn" value={authForm.ldap_bind_dn} placeholder="cn=admin,dc=example,dc=com"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_bind_dn: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-bind-pw">Bind 密码(未改=保持现值;清空=清除密码)</Label>
                  <SecretInput id="ldap-bind-pw" value={authForm.ldap_bind_password}
                    onChange={(e) => setAuthForm({ ...authForm, ldap_bind_password: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-base-dn">Base DN</Label>
                  <Input id="ldap-base-dn" value={authForm.ldap_base_dn} placeholder="dc=example,dc=com"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_base_dn: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-user-filter">用户过滤器(默认 (uid=%s))</Label>
                  <Input id="ldap-user-filter" value={authForm.ldap_user_filter} placeholder="(uid=%s)"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_user_filter: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-group-filter">组过滤器(可选)</Label>
                  <Input id="ldap-group-filter" value={authForm.ldap_group_filter} placeholder="(memberOf=cn=%s)"
                    onChange={(e) => setAuthForm({ ...authForm, ldap_group_filter: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ldap-group-attr">组属性(默认 cn)</Label>
                  <Input id="ldap-group-attr" value={authForm.ldap_group_attr}
                    onChange={(e) => setAuthForm({ ...authForm, ldap_group_attr: e.target.value })} />
                </div>
              </div>
            </div>
          )}

          {authForm.enabled.includes('oidc') && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="text-sm font-medium">OIDC 配置</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="oidc-issuer">Issuer(如 https://idp.example.com)</Label>
                  <Input id="oidc-issuer" value={authForm.oidc_issuer} placeholder="https://idp.example.com"
                    onChange={(e) => setAuthForm({ ...authForm, oidc_issuer: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-client-id">Client ID</Label>
                  <Input id="oidc-client-id" value={authForm.oidc_client_id}
                    onChange={(e) => setAuthForm({ ...authForm, oidc_client_id: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-secret">Client Secret(未改=保持现值;清空=清除密钥)</Label>
                  <SecretInput id="oidc-secret" value={authForm.oidc_client_secret}
                    onChange={(e) => setAuthForm({ ...authForm, oidc_client_secret: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="oidc-redirect">Redirect URL</Label>
                  <Input id="oidc-redirect" value={authForm.oidc_redirect_url} placeholder="https://picoaide.example.com/api/auth/oidc/callback"
                    onChange={(e) => setAuthForm({ ...authForm, oidc_redirect_url: e.target.value })} />
                </div>
              </div>
            </div>
          )}

          {authForm.enabled.includes('openid') && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="text-sm font-medium">OpenID 配置(独立 IdP)</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="openid-issuer">Issuer(如 https://openid.example.com)</Label>
                  <Input id="openid-issuer" value={authForm.openid_issuer} placeholder="https://openid.example.com"
                    onChange={(e) => setAuthForm({ ...authForm, openid_issuer: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="openid-client-id">Client ID</Label>
                  <Input id="openid-client-id" value={authForm.openid_client_id}
                    onChange={(e) => setAuthForm({ ...authForm, openid_client_id: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="openid-secret">Client Secret(未改=保持现值;清空=清除密钥)</Label>
                  <SecretInput id="openid-secret" value={authForm.openid_client_secret}
                    onChange={(e) => setAuthForm({ ...authForm, openid_client_secret: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="openid-redirect">Redirect URL</Label>
                  <Input id="openid-redirect" value={authForm.openid_redirect_url} placeholder="https://picoaide.example.com/api/auth/openid/callback"
                    onChange={(e) => setAuthForm({ ...authForm, openid_redirect_url: e.target.value })} />
                </div>
              </div>
            </div>
          )}

          <Button onClick={saveAuth} disabled={busy}>{busy ? '保存中…' : '保存认证配置'}</Button>
        </CardContent>
      </Card>
    </div>
  )
}
