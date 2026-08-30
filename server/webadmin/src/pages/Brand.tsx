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
  client: { display_name: string; tagline: string; accent: string; logo_url?: string }
  title: string
}

interface PortalCfg {
  enabled: boolean
  welcome: string
  subtitle: string
  client_download_url: string
  client_download_note: string
  landing_path: string
}

const EMPTY_BRAND: BrandCfg = { enabled: false, login: { display_name: '', tagline: '', welcome: '' }, client: { display_name: '', tagline: '', accent: '' }, title: '' }
const EMPTY_PORTAL: PortalCfg = { enabled: true, welcome: '', subtitle: '', client_download_url: '', client_download_note: '', landing_path: '' }

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

  const previewAccent = brand.client.accent || '#4176E6'

  return (
    <div className="space-y-6">
      <PageHeader
        title="品牌配置"
        desc="登录页/客户端/门户首页品牌展示(logo/名称/主色/下载地址);保存后生效"
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
          <Tabs defaultValue="login">
            <TabsList>
              <TabsTrigger value="login">登录页品牌</TabsTrigger>
              <TabsTrigger value="client">客户端品牌</TabsTrigger>
              <TabsTrigger value="portal">门户首页</TabsTrigger>
            </TabsList>

            <TabsContent value="login" className="space-y-3">
              <Card>
                <CardHeader><CardTitle className="text-base">登录页展示</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <LogoRow label="登录页 Logo" url={brand.login.logo_url as any} kind="login"
                    onPick={() => { setUploadKind('login'); fileRef.current?.click() }}
                    onRemove={() => removeLogo('login')} />
                  <Field label="产品/公司名" value={brand.login.display_name} onChange={(v) => setBrand({ ...brand, login: { ...brand.login, display_name: v } })} />
                  <Field label="副标题" value={brand.login.tagline} onChange={(v) => setBrand({ ...brand, login: { ...brand.login, tagline: v } })} />
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">欢迎语(可选)</Label>
                    <Textarea value={brand.login.welcome} onChange={(e) => setBrand({ ...brand, login: { ...brand.login, welcome: e.target.value } })} />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="client" className="space-y-3">
              <Card>
                <CardHeader><CardTitle className="text-base">客户端展示(侧栏+hero+右上角)</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <LogoRow label="客户端 Logo" url={brand.client.logo_url as any} kind="client"
                    onPick={() => { setUploadKind('client'); fileRef.current?.click() }}
                    onRemove={() => removeLogo('client')} />
                  <Field label="展示名称" value={brand.client.display_name} onChange={(v) => setBrand({ ...brand, client: { ...brand.client, display_name: v } })} />
                  <Field label="副标题" value={brand.client.tagline} onChange={(v) => setBrand({ ...brand, client: { ...brand.client, tagline: v } })} />
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">品牌主色(#RRGGBB)</Label>
                    <div className="flex items-center gap-2">
                      <input type="color" className="h-9 w-12 rounded-md border" value={previewAccent}
                        onChange={(e) => setBrand({ ...brand, client: { ...brand.client, accent: e.target.value } })} />
                      <Input value={brand.client.accent} placeholder="#4176E6" onChange={(e) => setBrand({ ...brand, client: { ...brand.client, accent: e.target.value } })} />
                    </div>
                  </div>
                  <Field label="页面标题后缀" value={brand.title} onChange={(v) => setBrand({ ...brand, title: v })} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="portal" className="space-y-3">
              <Card>
                <CardHeader><CardTitle className="text-base">门户首页(未登录默认页)</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <Field label="欢迎语标题" value={portal.welcome} onChange={(v) => setPortal({ ...portal, welcome: v })} />
                  <Field label="副标题" value={portal.subtitle} onChange={(v) => setPortal({ ...portal, subtitle: v })} />
                  <Field label="客户端下载地址" value={portal.client_download_url} onChange={(v) => setPortal({ ...portal, client_download_url: v })} />
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

        {/* 实时预览窗 */}
        <div className="space-y-3">
          <div className="text-[11px] font-semibold text-muted-foreground">实时预览(保存后生效)</div>
          <Card className="overflow-hidden">
            <div className="p-5 text-center" style={{ fontFamily: 'system-ui' }}>
              {brand.login.logo_url ? (
                <img src={brand.login.logo_url} alt="logo" className="mx-auto mb-3 h-14 w-14 rounded-lg object-contain" />
              ) : (
                <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-lg bg-slate-900">
                  <svg viewBox="0 0 1254 1254" className="h-8 w-8" fill="none" aria-hidden="true">
                    <g transform="translate(627 627) scale(1.25) translate(-627 -627)">
                      <path d="M 334 409 C 300 409 273 431 273 466 V 548 C 273 582 254 607 220 620 C 254 633 273 658 273 692 V 775 C 273 810 300 843 334 843" stroke="#FFFFFF" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M 920 409 C 954 409 981 431 981 466 V 548 C 981 582 1000 607 1034 620 C 1000 633 981 658 981 692 V 775 C 981 810 954 843 920 843" stroke="#FFFFFF" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
                      <line x1="435" y1="627" x2="817" y2="627" stroke="#FFFFFF" strokeWidth="20" strokeLinecap="round" />
                      <circle cx="435" cy="627" r="65" fill="#FFFFFF" />
                      <circle cx="817" cy="627" r="65" fill="#FFFFFF" />
                    </g>
                  </svg>
                </div>
              )}
              <div className="text-[20px] font-bold" style={{ color: previewAccent }}>
                {brand.login.display_name || 'PicoAide'}
              </div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">{brand.login.tagline || 'Enterprise AI Gateway'}</div>
              {brand.login.welcome && <div className="mt-2 text-[12px] text-foreground">{brand.login.welcome}</div>}
              <div className="mt-4 flex justify-center gap-2">
                <div className="h-9 w-36 rounded-md text-white text-[13px] leading-9" style={{ backgroundColor: previewAccent }}>登 录</div>
                <div className="h-9 w-36 rounded-md border text-[13px] leading-9 text-muted-foreground">下载客户端</div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Field(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{props.label}</Label>
      <Input value={props.value} onChange={(e) => props.onChange(e.target.value)} />
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
