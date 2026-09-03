import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { SecretInput } from '../components/secret-input'
import { PageHeader } from '../components/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'

// 认证配置页(v3b): Tab 分区 + 启用绑定配置 + hide_local。
// 登录面矩阵: 客户端 = 全部已启用方式(local 可被 hide_local 隐藏);
// 管理后台 = 恒仅本地账户(SSO/LDAP 一律不进后台, 服务端强制)。

interface AuthConfig {
  mode?: string
  enabled?: string
  hide_local?: boolean
  /** G14: 密码最小长度(8~64,缺失=默认 10)。 */
  min_password_length?: number
  ldap?: Record<string, string>
  oidc?: Record<string, string>
  openid?: Record<string, string>
}

interface FormState {
  hideLocal: boolean
  ldap: Record<string, string>
  oidc: Record<string, string>
  openid: Record<string, string>
}

// 测试连接返回(ldap 目录统计)
interface ConnTestResult {
  ok: boolean
  message: string
  users?: number
  groups?: number
  sample?: Array<{ username: string; display_name?: string; email?: string; groups?: string[] }>
}

const EMPTY_FORM: FormState = {
  hideLocal: false,
  ldap: {},
  oidc: {},
  openid: {},
}

// 各 IdP 必填项判定(未配齐 → 启用开关禁用)
const REQUIRED: Record<'ldap' | 'oidc' | 'openid', string[]> = {
  ldap: ['server_url', 'bind_dn', 'base_dn'],
  oidc: ['issuer', 'client_id', 'redirect_url'],
  openid: ['issuer', 'client_id', 'redirect_url'],
}

const METHOD_META: Record<'local' | 'ldap' | 'oidc' | 'openid', { label: string; desc: string }> = {
  local: { label: '本地账号', desc: '后台恒启用; 客户端可隐藏' },
  ldap: { label: 'LDAP', desc: '企业目录认证(仅员工面)' },
  oidc: { label: 'OIDC', desc: '浏览器跳转登录(仅客户端)' },
  openid: { label: 'OpenID', desc: '浏览器跳转登录(仅客户端)' },
}

export default function Auth() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [enabled, setEnabled] = useState<string[]>(['local'])
  const [minPasswordLength, setMinPasswordLength] = useState(10)
  const [authErr, setAuthErr] = useState('')
  const [authMsg, setAuthMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('local')
  // 密码/密钥是否「已设置」(服务端掩码 *** 表示已存值,不能回填进输入框)
  const [secrets, setSecrets] = useState<Record<string, 'has-value' | 'unset'>>({})
  // 用户显式"清空"的密钥(保存时提交空串覆盖)
  const [clearedSecrets, setClearedSecrets] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      const r = await request(`${ADMIN_API}/auth`) as { auth?: AuthConfig }
      const a = r.auth ?? {}
      setMinPasswordLength(a.min_password_length || 10)
      setEnabled((a.enabled ?? 'local').split(',').map((s) => s.trim()).filter(Boolean))
      setForm({
        hideLocal: a.hide_local ?? false,
        ldap: nonSecret(a.ldap ?? {}),
        oidc: nonSecret(a.oidc ?? {}),
        openid: nonSecret(a.openid ?? {}),
      })
      // 服务端对已配置的密钥返回 *** → 标记「已设置」,输入框显示占位
      setSecrets({
        ldap_password: isSet(a.ldap?.bind_password),
        oidc_secret: isSet(a.oidc?.client_secret),
        openid_secret: isSet(a.openid?.client_secret),
      })
    } catch (err: any) {
      setAuthErr(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 掩码值不得回填进表单:回显 *** 会让下一次保存把 *** 当新密码写回
  // (服务端把 *** 解释为「保持现值」,但用户改过其它字段再保存时,输入框
  // 里的 *** 会被当密码……实测行:掩码只用于状态,不进 value)。
  function nonSecret(cfg: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(cfg)) out[k] = v === '***' ? '' : v
    return out
  }
  function isSet(v?: string): 'has-value' | 'unset' {
    return v === '***' ? 'has-value' : 'unset'
  }

  const isReady = (key: 'local' | 'ldap' | 'oidc' | 'openid'): boolean => {
    if (key === 'local') return true
    const need = REQUIRED[key] ?? []
    return need.every((f) => (form[key]?.[f] ?? '').trim() !== '')
  }

  const toggle = (key: 'local' | 'ldap' | 'oidc' | 'openid', on: boolean) => {
    if (key === 'local') return // 恒启用
    setEnabled((prev) => on ? [...prev.filter((x) => x !== key), key] : prev.filter((x) => x !== key))
  }

  const [testMsg, setTestMsg] = useState('')
  const [testDetail, setTestDetail] = useState<ConnTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  // v3b §1.2: 测试当前 Tab 提供方连接(不保存)。LDAP 传完整配置(含
  // 过滤器),密码留空/占位 = 用已保存的(服务端回读),不再把 *** 当密码。
  async function testConnection() {
    setTesting(true); setTestMsg(''); setAuthErr(''); setTestDetail(null)
    try {
      const body: any = { type: tab }
      if (tab === 'ldap') {
        body.ldap = {
          server_url: form.ldap.server_url,
          bind_dn: form.ldap.bind_dn,
          bind_password: form.ldap.bind_password,
          base_dn: form.ldap.base_dn,
          user_filter: form.ldap.user_filter,
          user_attr: form.ldap.user_attr,
          group_filter: form.ldap.group_filter,
          group_attr: form.ldap.group_attr,
        }
      }
      if (tab === 'oidc' || tab === 'openid') body.oidc = { issuer: tab === 'oidc' ? form.oidc.issuer : form.openid.issuer }
      const r = await request(`${ADMIN_API}/auth/test`, { method: 'POST', body: JSON.stringify(body) }) as ConnTestResult
      setTestMsg(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`)
      if (r.sample) setTestDetail(r)
    } catch (e: any) {
      setTestMsg(`✗ ${e.message}`)
    } finally { setTesting(false) }
  }

  async function saveAuth() {
    if (busy) return
    setAuthErr('')
    // 启用中的 IdP 必须配置完整(前端校验; 服务端亦有校验)
    for (const key of enabled.filter((k) => k !== 'local')) {
      if (!isReady(key as 'ldap' | 'oidc' | 'openid')) {
        setAuthErr(`${METHOD_META[key as 'local' | 'ldap' | 'oidc' | 'openid']?.label} 配置不完整, 请完成必填项后再保存`)
        return
      }
    }
    setBusy(true)
    try {
      // 密码字段语义(服务端契约):未输入(空)且已存在保存值 → 提交 ***
      // 保持现值; 用户输入新值 → 提交新值。空串仅在用户显式清空时提交。
      // 此前把服务端掩码 *** 回显进输入框,用户一保存就把 *** 当密码/清空
      // 密码写回 ——「每次保存后用不了」的根因。
      const secretField = (value: string, preset: 'has-value' | 'unset', cleared: boolean): string => {
        // 用户显式清空 → 提交空串(服务端清空保存值)
        if (cleared) return ''
        // 已设置且未输入新值 → *** 保持现值
        if (value === '') return preset === 'has-value' ? '***' : ''
        // 用户输入了新值(或初次配置) → 提交
        return value
      }
      const ldapBody = { ...form.ldap, bind_password: secretField(form.ldap.bind_password ?? '', secrets.ldap_password, !!clearedSecrets.ldap_password) }
      const oidcBody = { ...form.oidc, client_secret: secretField(form.oidc.client_secret ?? '', secrets.oidc_secret, !!clearedSecrets.oidc_secret) }
      const openidBody = { ...form.openid, client_secret: secretField(form.openid.client_secret ?? '', secrets.openid_secret, !!clearedSecrets.openid_secret) }
      const body: any = {
        enabled: enabled.join(','),
        hide_local: form.hideLocal,
        min_password_length: minPasswordLength,
        ldap: ldapBody,
        oidc: oidcBody,
        openid: openidBody,
      }
      await request(`${ADMIN_API}/auth`, { method: 'PUT', body: JSON.stringify(body) })
      setAuthMsg('认证配置已保存(重启服务端后生效)')
      setClearedSecrets({})
      setTimeout(() => setAuthMsg(''), 4000)
      void load()
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
        desc="员工登录方式(本地/LDAP/OpenID/OIDC); 管理后台恒仅本地账户(SSO/LDAP 不进后台)"
      />
      <Card>
        <CardHeader>
          <CardTitle>启用方式</CardTitle>
          <CardDescription>勾选的方式出现在客户端登录页; 管理后台不受影响。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {authErr && <div className="text-sm text-destructive">{authErr}</div>}
          {authMsg && <div className="text-sm text-green-600">{authMsg}</div>}
          <div className="flex flex-wrap gap-3 rounded-md border p-3">
            {Object.keys(METHOD_META).map((keyRaw) => {
              const key = keyRaw as 'local' | 'ldap' | 'oidc' | 'openid'
              const on = enabled.includes(key)
              const ready = isReady(key)
              return (
                <label key={key} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${on ? 'border-primary/40 bg-accent' : 'hover:bg-muted'}`}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#4176E6]"
                    checked={on}
                    disabled={key === 'local' || !ready}
                    onChange={(e) => toggle(key, e.target.checked)}
                  />
                  <span className="font-medium">{METHOD_META[key].label}</span>
                  <span className="text-xs text-muted-foreground">{!ready ? '(配置不完整)' : METHOD_META[key].desc}</span>
                </label>
              )
            })}
          </div>

          {/* hide_local 开关 */}
          <div className="flex items-start gap-3 rounded-md border p-3">
            <input
              type="checkbox"
              id="hide-local"
              className="mt-1 h-4 w-4 accent-[#4176E6]"
              checked={form.hideLocal}
              onChange={(e) => setForm({ ...form, hideLocal: e.target.checked })}
            />
            <div className="space-y-0.5">
              <Label htmlFor="hide-local" className="text-[13px] text-foreground">隐藏客户端本地登录入口</Label>
              <p className="text-xs text-muted-foreground">
                启用后客户端登录页不显示本地账号方式(仅 IdP); 管理后台本地登录恒可用, 不受此开关影响。
              </p>
            </div>
          </div>

          {/* Tab 分区配置 */}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="local">本地账号</TabsTrigger>
              <TabsTrigger value="ldap">LDAP</TabsTrigger>
              <TabsTrigger value="oidc">OIDC</TabsTrigger>
              <TabsTrigger value="openid">OpenID</TabsTrigger>
            </TabsList>

            <TabsContent value="local" className="space-y-2">
              <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                本地账号恒启用(管理员回退)。此页无需配置; 新建/管理账户请在「用户」页操作。
              </div>
              <div className="space-y-1 rounded-md border p-3">
                <Label htmlFor="min-password-length">密码最小长度(G14)</Label>
                <Input
                  id="min-password-length"
                  type="number"
                  min={8}
                  max={64}
                  value={minPasswordLength}
                  onChange={(e) => setMinPasswordLength(Number(e.target.value) || 10)}
                />
                <p className="text-xs text-muted-foreground">
                  新建用户/重置密码/自助改密的最短密码位数(8~64,默认 10); 改动只影响密码校验, 不追溯既有密码。
                </p>
              </div>
            </TabsContent>

            <TabsContent value="ldap" className="space-y-3">
              <div className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">LDAP 配置(仅员工面)</div>
                <div className="mb-2 text-xs text-muted-foreground">
                  配置保存后每 1 小时自动同步一次用户与组(新员工/离职/组调整 1 小时内生效); 也可在「测试连接」后立即保存以当场同步。
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field abbr="ldap" label="服务器地址(ldap://...)" value={form.ldap.server_url ?? ''} ph="ldap://ldap.example.com:389" k="server_url" set={(v) => setForm({ ...form, ldap: { ...form.ldap, server_url: v } })} />
                  <Field abbr="ldap" label="Bind DN" value={form.ldap.bind_dn ?? ''} ph="cn=admin,dc=example,dc=com" k="bind_dn" set={(v) => setForm({ ...form, ldap: { ...form.ldap, bind_dn: v } })} />
                  <SecretField label="Bind 密码(已设置=保持现值)" preset={secrets.ldap_password} value={form.ldap.bind_password ?? ''} onChange={(v) => setForm({ ...form, ldap: { ...form.ldap, bind_password: v } })} onClear={() => { setForm({ ...form, ldap: { ...form.ldap, bind_password: '' } }); setClearedSecrets({ ...clearedSecrets, ldap_password: true }) }} />
                  <Field abbr="ldap" label="Base DN" value={form.ldap.base_dn ?? ''} ph="dc=example,dc=com" k="base_dn" set={(v) => setForm({ ...form, ldap: { ...form.ldap, base_dn: v } })} />
                  <Field abbr="ldap" label="用户过滤器(默认 (uid=%s))" value={form.ldap.user_filter ?? ''} ph="(uid=%s)" k="user_filter" set={(v) => setForm({ ...form, ldap: { ...form.ldap, user_filter: v } })} />
                  <Field abbr="ldap" label="用户名字段(属性,默认 uid)" value={form.ldap.user_attr ?? ''} ph="uid / cn / sAMAccountName / mail" k="user_attr" set={(v) => setForm({ ...form, ldap: { ...form.ldap, user_attr: v } })} />
                  <Field abbr="ldap" label="组过滤器(可选)" value={form.ldap.group_filter ?? ''} ph="(memberOf=cn=%s)" k="group_filter" set={(v) => setForm({ ...form, ldap: { ...form.ldap, group_filter: v } })} />
                  <Field abbr="ldap" label="组属性(默认 cn)" value={form.ldap.group_attr ?? ''} k="group_attr" set={(v) => setForm({ ...form, ldap: { ...form.ldap, group_attr: v } })} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="oidc" className="space-y-3">
              <div className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">OIDC 配置(仅客户端)</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field abbr="oidc" label="Issuer" value={form.oidc.issuer ?? ''} ph="https://idp.example.com" k="issuer" set={(v) => setForm({ ...form, oidc: { ...form.oidc, issuer: v } })} />
                  <Field abbr="oidc" label="Client ID" value={form.oidc.client_id ?? ''} k="client_id" set={(v) => setForm({ ...form, oidc: { ...form.oidc, client_id: v } })} />
                  <SecretField label="Client Secret(已设置=保持现值)" preset={secrets.oidc_secret} value={form.oidc.client_secret ?? ''} onChange={(v) => setForm({ ...form, oidc: { ...form.oidc, client_secret: v } })} onClear={() => { setForm({ ...form, oidc: { ...form.oidc, client_secret: '' } }); setClearedSecrets({ ...clearedSecrets, oidc_secret: true }) }} />
                  <Field abbr="oidc" label="Redirect URL" value={form.oidc.redirect_url ?? ''} ph="https://picoaide.example.com/api/client/v2/auth/oidc/callback" k="redirect_url" set={(v) => setForm({ ...form, oidc: { ...form.oidc, redirect_url: v } })} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="openid" className="space-y-3">
              <div className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">OpenID 配置(独立 IdP, 仅客户端)</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field abbr="openid" label="Issuer" value={form.openid.issuer ?? ''} ph="https://openid.example.com" k="issuer" set={(v) => setForm({ ...form, openid: { ...form.openid, issuer: v } })} />
                  <Field abbr="openid" label="Client ID" value={form.openid.client_id ?? ''} k="client_id" set={(v) => setForm({ ...form, openid: { ...form.openid, client_id: v } })} />
                  <SecretField label="Client Secret(已设置=保持现值)" preset={secrets.openid_secret} value={form.openid.client_secret ?? ''} onChange={(v) => setForm({ ...form, openid: { ...form.openid, client_secret: v } })} onClear={() => { setForm({ ...form, openid: { ...form.openid, client_secret: '' } }); setClearedSecrets({ ...clearedSecrets, openid_secret: true }) }} />
                  <Field abbr="openid" label="Redirect URL" value={form.openid.redirect_url ?? ''} ph="https://picoaide.example.com/api/client/v2/auth/openid/callback" k="redirect_url" set={(v) => setForm({ ...form, openid: { ...form.openid, redirect_url: v } })} />
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex gap-2">
            <Button variant="outline" onClick={testConnection} disabled={testing || tab === 'local'}>
              {testing ? '测试中…' : '测试连接'}
            </Button>
            <Button onClick={saveAuth} disabled={busy}>{busy ? '保存中…' : '保存认证配置'}</Button>
          </div>
          {testMsg && <div className={`text-[13px] ${testMsg.startsWith('✓') ? 'text-green-600' : 'text-red-600'}`}>{testMsg}</div>}
          {testDetail && testDetail.ok && (
            <div className="rounded-md border bg-muted/20 p-3 text-[13px]">
              <div className="mb-1 font-medium">
                目录统计: 匹配到 <span className="text-green-700 font-semibold">{testDetail.users ?? 0}</span> 个用户,
                {' '}<span className="text-green-700 font-semibold">{testDetail.groups ?? 0}</span> 个组
              </div>
              {(testDetail.sample?.length ?? 0) > 0 && (
                <div className="space-y-0.5">
                  <div className="text-muted-foreground">用户样例(前 {testDetail.sample!.length} 个):</div>
                  {testDetail.sample!.map((u, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="font-mono">{u.username}</span>
                      <span className="text-muted-foreground">{u.display_name || u.email || ''}</span>
                      {u.groups && u.groups.length > 0 && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{u.groups.join(', ')}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-xs text-muted-foreground">保存后立即同步一次, 之后每 1 小时自动同步(新员工/离职/组变更 1 小时内生效)。</div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Field(props: { label: string; value: string; ph?: string; k: string; abbr?: string; set: (v: string) => void }) {
  const id = `auth-field-${props.abbr ?? 'x'}-${props.k}`
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{props.label}</Label>
      <Input id={id} value={props.value} placeholder={props.ph ?? ''} onChange={(e) => props.set(e.target.value)} />
    </div>
  )
}

function SecretField(props: {
  label: string
  value: string
  preset?: 'has-value' | 'unset'
  onChange: (v: string) => void
  onClear?: () => void
}) {
  const id = `auth-secret-${Math.random().toString(36).slice(2, 8)}`
  const preset = props.preset ?? 'unset'
  // 已设置且未输入新值: 显示「已配置」徽标, 输入框留空(不显示 ***,
  // 避免用户把 *** 当密码; 留空 + 已设置 = 服务端保持现值)。
  const configured = preset === 'has-value' && props.value === ''
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs text-muted-foreground">{props.label}</Label>
        {configured && props.onClear && (
          <button
            type="button"
            onClick={props.onClear}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            清空已保存密码
          </button>
        )}
      </div>
      <div className="relative">
        <SecretInput
          id={id}
          value={props.value}
          placeholder={configured ? '已配置(重新输入可覆盖)' : ''}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {configured && (
          <span className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
            已配置
          </span>
        )}
      </div>
    </div>
  )
}
