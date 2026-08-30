import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Switch } from '../components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { PageHeader } from '../components/page-header'

/**
 * 客户端错误监控配置(决策 2026-08):从「网关」页拆分为独立页面。
 * 仅保存错误监控域字段(开关/DSN/等级/GlitchTip 预填),其余网关配置不受影响:
 * 服务端 setGatewayConfig 用指针字段,缺省(null)不覆盖。
 */
export default function ErrorMonitoring() {
  const [cfg, setCfg] = useState({
    error_reporting_enabled: false,
    error_reporting_dsn: '',
    error_reporting_level: 'error',
    glitchtip_base_url: '',
    glitchtip_organization: '',
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const g = await request('/api/server/admin/gateway')
      setCfg({
        error_reporting_enabled: g.error_reporting_enabled === true,
        error_reporting_dsn: g.error_reporting_dsn ?? '',
        error_reporting_level: g.error_reporting_level ?? 'error',
        glitchtip_base_url: g.glitchtip_base_url ?? '',
        glitchtip_organization: g.glitchtip_organization ?? '',
      })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function save() {
    if (busy) return
    setError('')
    if (cfg.error_reporting_dsn && !/^https?:\/\//i.test(cfg.error_reporting_dsn.trim())) {
      setError('错误上报 DSN 必须是 http(s) URL(如 https://glitchtip.example.com/...或留空)')
      return
    }
    if (cfg.glitchtip_base_url && !/^https?:\/\//i.test(cfg.glitchtip_base_url.trim())) {
      setError('GlitchTip 服务地址必须是 http(s) URL(或留空)')
      return
    }
    setBusy(true)
    try {
      // 仅提交错误监控域字段;其余网关配置(默认模型/思考强度/限流等)不动。
      await request('/api/server/admin/gateway', {
        method: 'PUT',
        body: JSON.stringify({
          error_reporting_enabled: cfg.error_reporting_enabled,
          error_reporting_dsn: cfg.error_reporting_dsn.trim(),
          error_reporting_level: cfg.error_reporting_level,
          glitchtip_base_url: cfg.glitchtip_base_url.trim(),
          glitchtip_organization: cfg.glitchtip_organization.trim(),
        }),
      })
      setError('')
      setOkMsg('已保存')
      setTimeout(() => setOkMsg(''), 3000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="错误监控"
        desc="客户端错误上报与 GlitchTip 连接器预填:登录自动应用,无需用户手动连接"
      />
      {error && <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</div>}
      {okMsg && <div className="rounded-md border border-green-500/40 p-3 text-sm text-green-600">{okMsg}</div>}

      <Card>
        <CardHeader>
          <CardTitle>客户端错误上报</CardTitle>
          <CardDescription>开关 + DSN + 等级,随客户端配置下发(登录自动启用)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Switch checked={cfg.error_reporting_enabled} onCheckedChange={(v) => setCfg({ ...cfg, error_reporting_enabled: v })} />
                <Label>启用客户端错误上报(未捕获异常/未处理 rejection)</Label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="error-reporting-dsn">错误上报 DSN(客户端 Sentry 上报地址,如 GlitchTip)</Label>
                  <Input id="error-reporting-dsn" type="text" placeholder="https://glitchtip.example.com/...或空=不启用"
                    value={cfg.error_reporting_dsn}
                    onChange={(e) => setCfg({ ...cfg, error_reporting_dsn: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="error-reporting-level">上报等级({'>= '}该等级才上报)</Label>
                  <Select value={cfg.error_reporting_level} onValueChange={(v) => setCfg({ ...cfg, error_reporting_level: v })}>
                    <SelectTrigger id="error-reporting-level" aria-label="上报等级"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="debug">debug(全部)</SelectItem>
                      <SelectItem value="info">info(debug+info)</SelectItem>
                      <SelectItem value="warning">warning(含 error)</SelectItem>
                      <SelectItem value="error">error(仅错误)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                开关开启 + DSN 非空时,客户端登录后自动启用错误上报(无需用户手动连接);
                等级阈值:如 warning = 上报 warning 与 error。仅支持 Sentry 兼容服务(如自托管 GlitchTip)。
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>GlitchTip 连接器预填</CardTitle>
          <CardDescription>客户端连接器自动预填服务地址与组织,用户只需填 API Token</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="glitchtip-base-url">GlitchTip 服务地址(连接器预填)</Label>
              <Input id="glitchtip-base-url" type="text" placeholder="https://glitchtip.example.com 或空=不预填"
                value={cfg.glitchtip_base_url}
                onChange={(e) => setCfg({ ...cfg, glitchtip_base_url: e.target.value })} />
              <p className="text-xs text-muted-foreground">客户端连接器自动预填,用户只需填 API Token</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="glitchtip-organization">GlitchTip 组织 slug(连接器预填)</Label>
              <Input id="glitchtip-organization" type="text" placeholder="如 picoaide 或空=不预填"
                value={cfg.glitchtip_organization}
                onChange={(e) => setCfg({ ...cfg, glitchtip_organization: e.target.value })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</Button>
      </div>
    </div>
  )
}
