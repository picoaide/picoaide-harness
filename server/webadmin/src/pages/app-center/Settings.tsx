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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
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
  /**
   * 「关闭应用子域」的待确认状态(R1-uxw-13)。
   *
   * 关闭 = 立即清空基域 ⇒ **全部**应用子域名当场失效(员工端所有 .应用名.域名 打不开),
   * 与「下架」同级的可见性破坏;而冻结/审批开关/拒绝/下架都有二次确认,只有它是一键生效
   * ⇒ 同一页里同类风险的动作一个要确认一个不要,管理员学不到稳定预期。
   * 规则收敛为:**可见性下降/破坏性动作要确认(冻结、下架、关闭子域、拒绝),
   * 恢复类动作不打扰(解冻、上架、重新填域名)**。
   */
  const [closingDomain, setClosingDomain] = useState(false)

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
            role="alert"
            aria-live="assertive"
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
          {/* 保存期的两条硬要求（2026-09-19 第三轮对抗审计 A-6）：服务端保存时会 fail-closed
              校验这两条（判据与换票签发侧同一份），这里把结论讲给管理员。
              只做**告知**，不在前端拦（服务端才是权威，前端硬校验反而会挡住合法形态）。 */}
          <p className="text-[11px] text-muted-foreground" data-testid="settings-domain-rules">
            <strong>两条硬要求</strong>（不满足时保存会被拒绝；已经在跑旧配置的部署会让
            <strong>登录可见 / 白名单应用一律拒绝签发票</strong> —— 员工打开就是 500，日志里带原因）：
            <br />
            ① <strong>能承载 Cookie 的域名</strong>：两级以上的普通域名。不能是 IP、单标签
            （<span className="font-mono">intranet</span>）、公网后缀（<span className="font-mono">co.uk</span>）、
            保留名（<span className="font-mono">localhost</span>）、含下划线，也不能多写结尾点
            （<span className="font-mono">example.com..</span>）。
            <br />
            ② <strong>必须与对外地址同域</strong>：控制台里的
            <span className="font-mono">server.base_url</span> 或部署环境的
            <span className="font-mono">PICOAI_PUBLIC_BASE_URL</span> 要写成
            <span className="font-mono">https://该域名</span> 本身（应用地址是它的子域，
            同一张通配证书覆盖两者）。两者不同域时保存会被拒绝；要保留原来的对外地址，
            就得把基域改成那个地址的主机名，或留空关闭应用子域。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="wasm-base-domain"
              aria-label="应用域名"
              aria-describedby={!canWrite ? 'settings-readonly-note' : undefined}
              className="max-w-xs"
              placeholder="example.com"
              value={domainInput}
              disabled={!canWrite || busy}
              onChange={(e) => { setDomainInput(e.target.value) }}
            />
            <Button
              size="sm"
              disabled={!canWrite || busy || domainInput === (domain?.base_domain ?? '')}
              aria-describedby={!canWrite ? 'settings-readonly-note' : undefined}
              onClick={() => { void saveDomain(domainInput.trim()) }}
            >
              保存
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canWrite || busy || !domain?.enabled}
              aria-describedby={!canWrite ? 'settings-readonly-note' : undefined}
              onClick={() => { setClosingDomain(true) }}
            >
              关闭应用子域
            </Button>
            {/* R1-uxw-14:禁用原因必须是可读文本(禁用控件不可聚焦,title 里的原因
                键盘/读屏用户拿不到)。 */}
            {!canWrite && (
              <span id="settings-readonly-note" data-testid="settings-readonly-note" className="text-[11px] text-muted-foreground">
                当前账号只读（需要 capability:write 权限）：域名输入与保存/关闭按钮已禁用。
              </span>
            )}
            {domain?.url_pattern && (
              <span className="text-[11px] text-muted-foreground">
                当前访问地址格式：<span className="font-mono">{domain.url_pattern}</span>
              </span>
            )}
          </div>
          {saveError && (
            <p className="text-sm text-destructive" role="alert" aria-live="assertive" data-testid="settings-save-error">
              {saveError}
            </p>
          )}
        </div>
      )}

      {/* 关闭应用子域的二次确认(R1-uxw-13):影响面是**全部**应用域名,与下架同级。
          说清影响谁、数据是否保留、如何回滚 —— 与冻结/下架确认同一套口径。 */}
      <Dialog open={closingDomain} onOpenChange={(open) => { if (!open) setClosingDomain(false) }}>
        <DialogContent data-testid="close-domain-confirm-dialog">
          <DialogHeader>
            <DialogTitle>关闭应用子域?</DialogTitle>
            <DialogDescription>
              将清空当前基域{domain?.base_domain ? `（${domain.base_domain}）` : ''},关闭后需要重新填写才能再启用。
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li><strong>全部应用域名立即失效</strong>:员工端所有 <span className="font-mono">应用名.{domain?.base_domain || '当前域名'}</span> 当场打不开。</li>
            <li><strong>应用与数据不受影响</strong>:已发布版本、应用数据、访问级别都不变,只是入口域名消失。</li>
            <li><strong>如何回滚</strong>:在本页重新填入同一个基域并保存即可恢复(恢复类动作不需要再确认)。</li>
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setClosingDomain(false) }}>取消</Button>
            <Button
              variant="destructive"
              data-testid="close-domain-confirm"
              disabled={!canWrite || busy}
              onClick={() => {
                setClosingDomain(false)
                void saveDomain('')
              }}
            >
              确认关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
