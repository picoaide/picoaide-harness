import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Switch } from '../components/ui/switch'
import { Textarea } from '../components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { PageHeader } from '../components/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { RefreshCcw, Trash2, Upload } from 'lucide-react'

// 品牌配置页(v3b): 登录页品牌 / 客户端品牌 / 门户首页 3 Tab + 实时预览。
// 生效以「保存」为准; 快照恢复内置(brand_snapshots 服务端自动保存)。
// 本页所有 logo 兜底图形必须与根目录 logo.svg 一致(黑色圆角方块 + 白色
// 花括号桥形, 花括号 1.25x 放大); 禁止字母 P 或其他编造图形(旧版 P 字
// logo 已退役)。

interface BrandCfg {
  enabled: boolean
  login: { display_name: string; tagline: string; welcome: string; logo_url?: string }
  client: { display_name: string; tagline: string; logo_url?: string }
  title: string
}

interface PortalCfg {
  enabled: boolean
  public: boolean
  welcome: string
  subtitle: string
  client_download_linux: string
  client_download_mac: string
  client_download_win: string
  client_download_note: string
  landing_path: string
}

// 默认值 = 客户端「未配置品牌」时的展示(与 dsh-enterprise 客户端
// DEFAULT 兜底一致): 名称/副标题/页面标题。占位符仅供表单提示,
// 空值提交后服务端仍按未配置处理(客户端回退默认)。
// 主题色(品牌主色)已下线(2026-09 决策): 客户端界面固定使用内置主题色。
const DEFAULT_LOGIN_NAME = 'PicoAide'
const DEFAULT_LOGIN_TAGLINE = 'Enterprise AI Gateway'
const DEFAULT_CLIENT_NAME = 'PicoAide Harness'
const DEFAULT_CLIENT_TAGLINE = '企业版'
const DEFAULT_TITLE = 'PicoAide Harness'

const EMPTY_BRAND: BrandCfg = { enabled: false, login: { display_name: '', tagline: '', welcome: '' }, client: { display_name: '', tagline: '' }, title: '' }
const EMPTY_PORTAL: PortalCfg = { enabled: true, public: true, welcome: '', subtitle: '', client_download_linux: '', client_download_mac: '', client_download_win: '', client_download_note: '', landing_path: '' }
// 三平台默认下载地址(与更新链一致: 官方 GitHub Releases)。
const DEFAULT_DOWNLOAD_URL = 'https://github.com/picoaide/picoaide-harness/releases/latest'

export default function Brand() {
  const [brand, setBrand] = useState<BrandCfg>(EMPTY_BRAND)
  const [portal, setPortal] = useState<PortalCfg>(EMPTY_PORTAL)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [snapshots, setSnapshots] = useState<{ id: number; created_at: string }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadKind, setUploadKind] = useState<'login' | 'client'>('login')
  // 当前 Tab(右侧预览跟随)。
  const [tab, setTab] = useState('login')

  const load = useCallback(async () => {
    try {
      const [b, p, s] = await Promise.all([
        request(`${ADMIN_API}/brand`),
        request(`${ADMIN_API}/portal`),
        request(`${ADMIN_API}/brand/snapshots`),
      ])
      setBrand({ ...EMPTY_BRAND, ...(b as BrandCfg) })
      setPortal({ ...EMPTY_PORTAL, ...(p as PortalCfg) })
      setSnapshots((s as any)?.snapshots ?? [])
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save() {
    if (busy) return
    setBusy(true); setErr(''); setMsg('')
    try {
      await request(`${ADMIN_API}/brand`, { method: 'PUT', body: JSON.stringify(brand) })
      await request(`${ADMIN_API}/portal`, { method: 'PUT', body: JSON.stringify(portal) })
      setMsg('已保存(客户端/登录页刷新后生效)')
      setTimeout(() => setMsg(''), 4000)
      void load()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function uploadLogo(kind: 'login' | 'client') {
    const input = fileRef.current
    if (!input?.files?.[0]) return
    const fd = new FormData()
    fd.append('name', kind)
    fd.append('file', input.files[0])
    setBusy(true); setErr('')
    try {
      await request(`${ADMIN_API}/brand/logo`, { method: 'POST', body: fd })
      setMsg('Logo 已上传')
      setTimeout(() => setMsg(''), 3000)
      void load()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
      input.value = ''
    }
  }

  async function removeLogo(kind: 'login' | 'client') {
    setBusy(true)
    try {
      await request(`${ADMIN_API}/brand/logo`, { method: 'DELETE', body: JSON.stringify({ name: kind }) })
      void load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function restoreSnapshot(id: number) {
    if (!window.confirm('确认恢复到该快照?当前配置将被覆盖。')) return
    setBusy(true)
    try {
      await request(`${ADMIN_API}/brand/restore`, { method: 'POST', body: JSON.stringify({ id }) })
      setMsg('已恢复快照')
      void load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  async function resetDefault() {
    if (!window.confirm('将清空所有自定义品牌配置(log/名称/主色),恢复为 PicoAide 默认样式。确认?')) return
    setBusy(true)
    try {
      await request(`${ADMIN_API}/brand`, { method: 'PUT', body: JSON.stringify({ ...EMPTY_BRAND, enabled: false }) })
      setMsg('已恢复默认')
      void load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>

  return (
    <div className="space-y-6">
      <PageHeader
        title="品牌配置"
        desc="登录页/客户端/门户首页品牌展示(logo/名称/副标题);保存后生效"
      />

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={brand.enabled}
            onCheckedChange={(v) => setBrand({ ...brand, enabled: v === true })}
          />
          <Label htmlFor="brand-enabled">启用自定义品牌</Label>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={resetDefault} disabled={busy}>
            <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />恢复默认
          </Button>
          <Button size="sm" variant="outline" disabled={snapshots.length === 0 || busy}
            onClick={() => snapshots[0] && restoreSnapshot(snapshots[0].id)}>
            <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />恢复上一版本
          </Button>
        </div>
      </div>
      {snapshots.length > 0 && (
        <div className="text-[11px] text-muted-foreground">最近快照: {snapshots.length} 份(自动保留 10 份)</div>
      )}
      {err && <div className="text-sm text-destructive">{err}</div>}
      {msg && <div className="text-sm text-green-600">{msg}</div>}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Tabs defaultValue="login" value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="login">登录页品牌</TabsTrigger>
              <TabsTrigger value="client">客户端品牌</TabsTrigger>
              <TabsTrigger value="portal">门户首页</TabsTrigger>
            </TabsList>

            <TabsContent value="login" className="space-y-3">
              <p className="text-[12px] text-muted-foreground">
                这里是员工打开客户端时看到的<strong className="font-medium text-foreground">登录页</strong>(桌面客户端第一步:输入服务器地址后进入的登录界面)。配置的 logo/名称/副标题会显示在登录卡片顶部;不配置时使用默认 PicoAide 品牌。
              </p>
              <Card>
                <CardHeader><CardTitle className="text-base">登录页展示</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <LogoRow label="登录页 Logo" url={brand.login.logo_url as any} kind="login"
                    onPick={() => { setUploadKind('login'); fileRef.current?.click() }}
                    onRemove={() => removeLogo('login')} />
                  <Field label="产品/公司名" value={brand.login.display_name} placeholder={`留空=「${DEFAULT_LOGIN_NAME}」`} onChange={(v) => setBrand({ ...brand, login: { ...brand.login, display_name: v } })} />
                  <Field label="副标题" value={brand.login.tagline} placeholder={`留空=「${DEFAULT_LOGIN_TAGLINE}」`} onChange={(v) => setBrand({ ...brand, login: { ...brand.login, tagline: v } })} />
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">欢迎语(可选)</Label>
                    <Textarea value={brand.login.welcome} onChange={(e) => setBrand({ ...brand, login: { ...brand.login, welcome: e.target.value } })} />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="client" className="space-y-3">
              <p className="text-[12px] text-muted-foreground">
                这里是员工<strong className="font-medium text-foreground">登录后的客户端界面</strong>三处展示:左上方品牌区(侧栏 mark+名称)、新会话居中 hero 区的品牌 mark+标题、右上角小徽章(logo+名称)。配置后客户端重启或重新登录生效;不配置时使用默认 PicoAide Harness。
              </p>
              <Card>
                <CardHeader><CardTitle className="text-base">客户端展示(侧栏+hero+右上角)</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <LogoRow label="客户端 Logo" url={brand.client.logo_url as any} kind="client"
                    onPick={() => { setUploadKind('client'); fileRef.current?.click() }}
                    onRemove={() => removeLogo('client')} />
                  <Field label="展示名称" value={brand.client.display_name} placeholder={`留空=「${DEFAULT_CLIENT_NAME}」`} onChange={(v) => setBrand({ ...brand, client: { ...brand.client, display_name: v } })} />
                  <Field label="副标题" value={brand.client.tagline} placeholder={`留空=「${DEFAULT_CLIENT_TAGLINE}」`} onChange={(v) => setBrand({ ...brand, client: { ...brand.client, tagline: v } })} />
                  <Field label="页面标题后缀" value={brand.title} placeholder={`留空=「${DEFAULT_TITLE}」`} onChange={(v) => setBrand({ ...brand, title: v })} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="portal" className="space-y-3">
              <p className="text-[12px] text-muted-foreground">
                这是<strong className="font-medium text-foreground">未登录用户在浏览器访问服务器根地址(域名首页)</strong>时看到的页面。它复用登录页品牌(logo/名称/副标题),并可配置欢迎语与客户端下载地址;为访客提供下载客户端的入口。
              </p>
              <Card>
                <CardHeader><CardTitle className="text-base">门户首页(未登录默认页)</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={portal.public}
                      onCheckedChange={(v) => setPortal({ ...portal, public: v === true })}
                    />
                    <Label htmlFor="portal-public">对外公开(未登录用户可访问;关闭时跳转管理后台登录)</Label>
                  </div>
                  <Field label="欢迎语标题" value={portal.welcome} onChange={(v) => setPortal({ ...portal, welcome: v })} />
                  <Field label="副标题" value={portal.subtitle} onChange={(v) => setPortal({ ...portal, subtitle: v })} />
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">客户端下载链接(三个平台分别配置;留空=官方 Releases)</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-[18px]">🐧</span>
                      <Input value={portal.client_download_linux} placeholder={`Linux: ${DEFAULT_DOWNLOAD_URL}`} onChange={(e) => setPortal({ ...portal, client_download_linux: e.target.value })} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[18px]">🍎</span>
                      <Input value={portal.client_download_mac} placeholder={`macOS: ${DEFAULT_DOWNLOAD_URL}`} onChange={(e) => setPortal({ ...portal, client_download_mac: e.target.value })} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[18px]">🪟</span>
                      <Input value={portal.client_download_win} placeholder={`Windows: ${DEFAULT_DOWNLOAD_URL}`} onChange={(e) => setPortal({ ...portal, client_download_win: e.target.value })} />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">下载说明(可选)</Label>
                    <Textarea value={portal.client_download_note} onChange={(e) => setPortal({ ...portal, client_download_note: e.target.value })} />
                  </div>
                  <Field label="登录后默认落地页(可选)" value={portal.landing_path} onChange={(v) => setPortal({ ...portal, landing_path: v })} />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <input ref={fileRef} type="file" accept=".svg,.png,.webp,.ico" className="hidden"
            onChange={() => void uploadLogo(uploadKind)} />

          <Button onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</Button>
        </div>

        {/* 实时预览窗: 跟随当前 Tab, 渲染对应页面的迷你版 */}
        <div className="space-y-3">
          <div className="text-[11px] font-semibold text-muted-foreground">实时预览(保存后生效)</div>
          {tab === 'login' && <LoginPreview brand={brand} />}
          {tab === 'client' && <ClientPreview brand={brand} />}
          {tab === 'portal' && <PortalPreview brand={brand} portal={portal} />}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 迷你预览(与真实页面同构: 登录页卡片 / 客户端 hero / 门户首页)
// ---------------------------------------------------------------------------

const BRACE_TILE = (
  <svg viewBox="0 0 1254 1254" className="h-8 w-8" fill="none" aria-hidden="true">
    <g transform="translate(627 627) scale(1.25) translate(-627 -627)">
      <path d="M 334 409 C 300 409 273 431 273 466 V 548 C 273 582 254 607 220 620 C 254 633 273 658 273 692 V 775 C 273 810 300 843 334 843" stroke="#FFFFFF" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 920 409 C 954 409 981 431 981 466 V 548 C 981 582 1000 607 1034 620 C 1000 633 981 658 981 692 V 775 C 981 810 954 843 920 843" stroke="#FFFFFF" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="435" y1="627" x2="817" y2="627" stroke="#FFFFFF" strokeWidth="20" strokeLinecap="round" />
      <circle cx="435" cy="627" r="65" fill="#FFFFFF" />
      <circle cx="817" cy="627" r="65" fill="#FFFFFF" />
    </g>
  </svg>
)

function BrandTile({ logoUrl, size, alt }: { logoUrl?: string; size: number; alt: string }) {
  if (logoUrl) {
    return <img src={logoUrl} alt={alt} className="mx-auto mb-3 object-contain" style={{ width: size, height: size, borderRadius: Math.max(4, size * 0.143) }} />
  }
  return (
    <div className="mx-auto mb-3 flex items-center justify-center bg-slate-900" style={{ width: size, height: size, borderRadius: Math.max(4, size * 0.143) }}>
      {BRACE_TILE}
    </div>
  )
}

/** 登录页迷你预览: 居中卡片(logo+名称+副标题+两个按钮)。 */
function LoginPreview(props: { brand: BrandCfg }) {
  const { brand } = props
  return (
    <Card className="overflow-hidden">
      <div className="p-5 text-center" style={{ fontFamily: 'system-ui' }}>
        <BrandTile logoUrl={brand.login.logo_url} size={56} alt="logo" />
        <div className="text-[18px] font-bold">{brand.login.display_name || DEFAULT_LOGIN_NAME}</div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">{brand.login.tagline || DEFAULT_LOGIN_TAGLINE}</div>
        {brand.login.welcome && <div className="mt-2 text-[12px] text-foreground">{brand.login.welcome}</div>}
        <div className="mt-4 flex justify-center gap-2">
          <div className="h-9 w-36 rounded-md bg-blue-600 text-white text-[13px] leading-9">登 录</div>
          <div className="h-9 w-36 rounded-md border text-[13px] leading-9 text-muted-foreground">下载客户端</div>
        </div>
      </div>
    </Card>
  )
}

/** 客户端迷你预览: 左侧栏 + 居中 hero(mark+标题+副标题+输入卡)。 */
function ClientPreview(props: { brand: BrandCfg }) {
  const { brand } = props
  const name = brand.client.display_name || DEFAULT_CLIENT_NAME
  const tagline = brand.client.tagline || DEFAULT_CLIENT_TAGLINE
  return (
    <Card className="overflow-hidden">
      <div className="flex" style={{ fontFamily: 'system-ui' }}>
        {/* 迷你侧栏 */}
        <div className="flex w-32 shrink-0 flex-col border-r bg-slate-50 p-3">
          <div className="flex items-center gap-1.5">
            {brand.client.logo_url
              ? <img src={brand.client.logo_url} alt="logo" className="h-5 w-5 rounded-md object-contain" />
              : <div className="flex h-5 w-5 items-center justify-center rounded-md bg-slate-900">
                  <svg viewBox="0 0 1254 1254" className="h-3 w-3" fill="none" aria-hidden="true">
                    <g transform="translate(627 627) scale(1.25) translate(-627 -627)">
                      <path d="M 334 409 C 300 409 273 431 273 466 V 548 C 273 582 254 607 220 620 C 254 633 273 658 273 692 V 775 C 273 810 300 843 334 843" stroke="#FFFFFF" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M 920 409 C 954 409 981 431 981 466 V 548 C 981 582 1000 607 1034 620 C 1000 633 981 658 981 692 V 775 C 981 810 954 843 920 843" stroke="#FFFFFF" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
                      <line x1="435" y1="627" x2="817" y2="627" stroke="#FFFFFF" strokeWidth="20" strokeLinecap="round" />
                      <circle cx="435" cy="627" r="65" fill="#FFFFFF" />
                      <circle cx="817" cy="627" r="65" fill="#FFFFFF" />
                    </g>
                  </svg>
                </div>}
            <span className="truncate text-[11px] font-bold">{name}</span>
          </div>
          <div className="mt-3 h-1.5 w-full rounded bg-slate-200" />
          <div className="mt-1.5 h-1.5 w-full rounded bg-slate-200" />
          <div className="mt-1.5 h-1.5 w-3/4 rounded bg-slate-200" />
        </div>
        {/* 迷你 hero */}
        <div className="flex-1 px-4 py-6 text-center">
          <div className="flex items-center justify-center gap-2">
            {brand.client.logo_url
              ? <img src={brand.client.logo_url} alt="logo" className="h-6 w-6 rounded-md object-contain" />
              : <div className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-900">
                  <svg viewBox="0 0 1254 1254" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                    <circle cx="435" cy="627" r="65" fill="#FFFFFF" />
                    <circle cx="817" cy="627" r="65" fill="#FFFFFF" />
                  </svg>
                </div>}
            <span className="text-[14px] font-semibold">{name}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-muted-foreground">{tagline}</span>
          </div>
          <div className="mx-auto mt-4 h-9 w-[85%] rounded-lg border bg-white shadow-sm" />
        </div>
      </div>
    </Card>
  )
}

/** 门户首页迷你预览: 大卡片(logo+名称+副标题+欢迎语+三平台下载按钮)。 */
function PortalPreview(props: { brand: BrandCfg; portal: PortalCfg }) {
  const { brand, portal } = props
  return (
    <Card className="overflow-hidden">
      <div className="p-5 text-center" style={{ fontFamily: 'system-ui' }}>
        <BrandTile logoUrl={brand.login.logo_url} size={56} alt="logo" />
        <div className="text-[18px] font-bold">{brand.login.display_name || DEFAULT_LOGIN_NAME}</div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">{brand.login.tagline || DEFAULT_LOGIN_TAGLINE}</div>
        <div className="mt-2 text-[12px] text-foreground">{portal.welcome || '(门户欢迎语, 在门户首页 Tab 配置)'}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{portal.subtitle || '(副标题)'}</div>
        <div className="mt-4 flex justify-center gap-2">
          <div className="h-9 w-36 rounded-md bg-blue-600 text-white text-[13px] leading-9">管理后台</div>
        </div>
        <div className="mt-4 rounded-md border p-3 text-left">
          <div className="mb-2 text-[11px] text-muted-foreground">客户端下载</div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[14px]">🐧</span>
              <div className="flex-1 rounded-md border py-1.5 text-center text-[12px] font-medium">{portal.client_download_linux ? 'Linux' : 'Linux'}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[14px]">🍎</span>
              <div className="flex-1 rounded-md border py-1.5 text-center text-[12px] font-medium">macOS</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[14px]">🪟</span>
              <div className="flex-1 rounded-md border py-1.5 text-center text-[12px] font-medium">Windows</div>
            </div>
          </div>
        </div>
        {portal.client_download_note && <div className="mt-2 text-[11px] text-muted-foreground">{portal.client_download_note}</div>}
      </div>
    </Card>
  )
}

function Field(props: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{props.label}</Label>
      <Input value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />
    </div>
  )
}

function LogoRow(props: { label: string; url?: string; kind: string; onPick: () => void; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md border p-3">
      {props.url ? (
        <img src={props.url} alt={props.label} className="h-10 w-10 rounded-md object-contain border" />
      ) : (
        <div className="h-10 w-10 rounded-md bg-muted text-[10px] leading-5 text-muted-foreground flex items-center justify-center">无</div>
      )}
      <div className="flex-1">
        <div className="text-[13px] font-medium">{props.label}</div>
        <button type="button" className="text-[12px] text-primary hover:underline" onClick={props.onPick}>
          <Upload className="mr-1 inline h-3 w-3" />上传(≤4MB, SVG/PNG/WebP/ICO)
        </button>
        {props.url && (
          <button type="button" className="ml-3 text-[12px] text-destructive hover:underline" onClick={props.onRemove}>
            <Trash2 className="mr-1 inline h-3 w-3" />移除
          </button>
        )}
      </div>
    </div>
  )
}
