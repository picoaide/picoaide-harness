import { useCallback, useEffect, useState } from 'react'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/empty-state'
import { PageHeader } from '../../components/page-header'
import { hasPermission, PERM_CAP_READ, PERM_CAP_WRITE } from '../../lib/rbac'
/** 服务端错误信封的 message + details.field + hints 统一渲染(P1-6,见 lib/api-error.ts)。 */
import { errorText } from '../../lib/api-error'
import { Settings2 } from 'lucide-react'

/**
 * 应用中心 · 设置(2026-09-19 页面合并):应用访问域名(泛域名)。
 *
 * 卡片本身是原 `/app-center` 单页顶部那张「应用域名（泛域名）」卡(2026-09-18 用户
 * 要求)的完整语义,搬进独立设置页(2026-09-19 用户要求「把应用域名放到设置页面里」)。
 *
 * **加载语义变了(有意的)**:原来域名配置与列表共用一次 load,GET 失败只在卡片里
 * 显示一行局部错误、页面其余部分照常渲染。本页只有这一件事,读不到就是**整页不可用**
 * —— 因此改成页面级错误 + 重试,不再静默降级(否则管理员会以为"域名没配"而不是
 * "没读到")。
 *
 * 保存仍按原口径:校验/自检全在服务端(启用子域要过"显式可信反代"与"内存四笔账"
 * 两条 fail-closed),不过就是保存失败 —— 因此把**服务端的 message + hints 原样显示**,
 * 让管理员知道还差什么条件,而不是给一句"保存失败"。
 */
interface DomainView {
  base_domain: string
  source: 'setting' | 'env' | 'none'
  enabled: boolean
  url_pattern: string
  setting_key: string
}

export default function Settings() {
  const [domain, setDomain] = useState<DomainView | null>(null)
  const [domainInput, setDomainInput] = useState('')
  const [loading, setLoading] = useState(true)
  /** 页面级错误:读取配置失败(本页只有这一件事,读不到=页面不可用)。 */
  const [loadError, setLoadError] = useState('')
  /** 保存失败的原文(message + hints);与读取错误分开,便于保存后原地重试。 */
  const [saveError, setSaveError] = useState('')
  const [busy, setBusy] = useState(false)

  const canRead = hasPermission(PERM_CAP_READ)
  const canWrite = hasPermission(PERM_CAP_WRITE)

  const load = useCallback(async () => {
    // 没有 capability:read 时不发这个注定 403 的请求(与用量中心同口径)。
    if (!canRead) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError('')
    try {
      const dv = await request<DomainView>(`${ADMIN_API}/wasm-apps/domain`)
      setDomain(dv)
      setDomainInput(dv.base_domain ?? '')
    } catch (err: any) {
      setLoadError(errorText(err, '读取应用域名配置失败'))
    } finally {
      setLoading(false)
    }
  }, [canRead])

  useEffect(() => { void load() }, [load])

  /**
   * 保存应用基域（空串 = 关闭应用子域）。
   */
  const saveDomain = async (next: string) => {
    if (!canWrite || busy) return
    setBusy(true)
    setSaveError('')
    try {
      const dv = await request<DomainView>(`${ADMIN_API}/wasm-apps/domain`, {
        method: 'PUT',
        body: JSON.stringify({ base_domain: next }),
      })
      setDomain(dv)
      setDomainInput(dv.base_domain ?? '')
    } catch (err: any) {
      setSaveError(errorText(err, '保存失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="设置"
        desc="应用访问域名（泛域名）等平台级配置:应用访问地址 = 应用名 + 该域名"
      />

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !canRead ? (
        <EmptyState
          icon={<Settings2 className="h-6 w-6" />}
          title="没有查看应用中心设置的权限"
          desc="需要 capability:read 权限,请联系平台管理员"
        />
      ) : loadError !== '' ? (
        // 页面级错误:读不到配置就说读不到,不渲染一张"看起来像没配"的空卡片。
        <div className="space-y-2">
          <div
            data-testid="settings-error"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {loadError}
          </div>
          <Button variant="outline" size="sm" onClick={() => { void load() }}>重试</Button>
        </div>
      ) : (
        /* 应用泛域名：应用访问地址 = 应用名 + 该域名（2026-09-18 用户要求）。
           启用需要三件外部条件（通配证书 / 通配 DNS / 显式可信反代），平台不做证书自动化，
           因此这里把条件写在卡片上，保存失败时显示服务端原话 + hints。 */
        <div className="rounded-md border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="wasm-base-domain" className="text-sm">应用域名（泛域名）</Label>
            {domain && (
              <Badge variant={domain.enabled ? 'success' : 'secondary'}>
                {domain.enabled ? '已启用' : '未启用'}
              </Badge>
            )}
            {domain && (
              <span className="text-[11px] text-muted-foreground">
                来源：
                {domain.source === 'setting' ? '控制台配置' : domain.source === 'env' ? '部署环境变量' : '未配置'}
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            填主域名本身（例如 example.com）：应用访问地址 = <span className="font-mono">应用名.该域名</span>。
            不要填 <span className="font-mono">*.example.com</span>。启用前需要：①该域名的
            <span className="font-mono">*.该域名</span> 通配证书 ②通配 DNS 解析到本服务端
            ③在部署 .env 里显式配置可信反向代理（PICOAI_TRUSTED_PROXIES）。留空 = 关闭应用子域。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="wasm-base-domain"
              aria-label="应用域名"
              className="max-w-xs"
              placeholder="example.com"
              value={domainInput}
              disabled={!canWrite || busy}
              onChange={(e) => { setDomainInput(e.target.value) }}
            />
            <Button
              size="sm"
              disabled={!canWrite || busy || domainInput === (domain?.base_domain ?? '')}
              onClick={() => { void saveDomain(domainInput.trim()) }}
            >
              保存
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canWrite || busy || !domain?.enabled}
              onClick={() => { void saveDomain('') }}
            >
              关闭应用子域
            </Button>
            {domain?.url_pattern && (
              <span className="text-[11px] text-muted-foreground">
                当前访问地址格式：<span className="font-mono">{domain.url_pattern}</span>
              </span>
            )}
          </div>
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
        </div>
      )}
    </div>
  )
}
