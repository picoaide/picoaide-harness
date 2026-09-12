/**
 * 品牌静态资源路由（`/favicon.svg` / `/manifest.webmanifest`）的单测。
 *
 * 背景（2026-09-12 真机复现）：客户端前端 dist 里的 favicon 是上游 DeepSeek 鱼形、
 * manifest 写着 `DeepSeek Harness`/`DSH`；Electron 窗口挡住了，浏览器形态读到的
 * 却是它们。桌面用 exact 路由覆盖（上游前端挂在 fallback 席位，具名路由优先）。
 * 这里钉住：渠道优先、官方兜底、可疑 SVG 丢弃、manifest 用构建声明的产品名。
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BRAND_FAVICON_PATH,
  BRAND_MANIFEST_PATH,
  OFFICIAL_SHORT_NAME,
  buildBrandWebAssets,
  handleBrandAssetRequest,
  sanitizeBrandSvg,
  svgFromDataUri,
} from '../src/brand-web-route.ts'
import { OFFICIAL_PRODUCT_NAME, type DesktopChannelProfile } from '../src/desktop-channel.ts'
import {
  PACKAGED_WEB_BRAND_FAVICON,
  PACKAGED_WEB_BRAND_OFFICIAL,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  assertBrandAssetSvg,
} from '../scripts/verify-packaged-runtime.ts'

const packageRoot = new URL('../', import.meta.url)

const ORIGIN = 'http://127.0.0.1:45678'
const OFFICIAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
const CHANNEL_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'
/** 图形工具（Inkscape/Illustrator）重存 SVG 时的默认文件头：`<?xml?>` [+ 生成器注释]。 */
const XML_DECLARED_SVG = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
  + '<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In  -->\n'
  + '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'
const BOM_XML_SVG = '\uFEFF<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 造一个含官方兜底 logo 的临时构建目录。 */
function brandDirs(options: { staged?: string; official?: string } = {}): { brandWebDir: string; officialLogoPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'brand-web-'))
  roots.push(root)
  const brandWebDir = join(root, 'web-brand')
  mkdirSync(brandWebDir, { recursive: true })
  if (options.staged !== undefined) writeFileSync(join(brandWebDir, 'favicon.svg'), options.staged)
  const officialLogoPath = join(root, 'official-logo.svg')
  writeFileSync(officialLogoPath, options.official ?? OFFICIAL_SVG)
  return { brandWebDir, officialLogoPath }
}

/** 最小渠道 profile（只填本路由用得到的字段）。 */
function profile(overrides: { logoURL?: string; shortName?: string; productName?: string } = {}): DesktopChannelProfile {
  return {
    channelId: 'acme',
    defaultServerURL: undefined,
    productName: overrides.productName ?? 'Acme Harness',
    windowTitle: undefined,
    homeDir: '.acme-harness',
    appId: undefined,
    deepLinkScheme: 'acme',
    deepLinkName: undefined,
    brand: {
      channelId: 'acme',
      title: 'Acme Harness',
      login: { displayName: 'Acme', shortName: overrides.shortName ?? 'Acme', tagline: '', welcome: '' },
      client: { displayName: 'Acme Harness', shortName: overrides.shortName ?? 'Acme', tagline: '' },
      ...(overrides.logoURL === undefined ? {} : { logoURL: overrides.logoURL }),
    },
  } as DesktopChannelProfile
}

/** 造一组最小的 req/res 假件，记录状态、头与响应体。 */
function fakeExchange(method = 'GET', headers: Record<string, string> = {}): {
  req: IncomingMessage
  res: ServerResponse
  state: { status: number; headers: Record<string, string>; body: string }
} {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' }
  const req = { method, headers } as unknown as IncomingMessage
  const res = {
    set statusCode(value: number) { state.status = value },
    get statusCode() { return state.status },
    setHeader(name: string, value: string) { state.headers[name.toLowerCase()] = value },
    end(chunk?: unknown) { if (chunk !== undefined) state.body += String(chunk) },
  } as unknown as ServerResponse
  return { req, res, state }
}

describe('品牌静态资源路由', () => {
  it('渠道 logo（data: URI）优先，manifest 用渠道产品名与短名', () => {
    const dirs = brandDirs({ staged: OFFICIAL_SVG })
    const assets = buildBrandWebAssets({
      profile: profile({ logoURL: `data:image/svg+xml,${encodeURIComponent(CHANNEL_SVG)}` }),
      ...dirs,
    })
    expect(assets.favicon?.body).toBe(CHANNEL_SVG)
    const manifest = JSON.parse(String(assets.manifest.body)) as { name: string; short_name: string; icons: { src: string }[] }
    expect(manifest.name).toBe('Acme Harness')
    expect(manifest.short_name).toBe('Acme')
    expect(manifest.icons[0]?.src).toBe(BRAND_FAVICON_PATH)
  })

  it('没有渠道包时用构建期落盘的官方 logo 与官方产品名', () => {
    const dirs = brandDirs({ staged: OFFICIAL_SVG })
    const assets = buildBrandWebAssets({ profile: undefined, ...dirs })
    expect(String(assets.favicon?.body)).toBe(OFFICIAL_SVG)
    const manifest = JSON.parse(String(assets.manifest.body)) as { name: string; short_name: string }
    expect(manifest.name).toBe(OFFICIAL_PRODUCT_NAME)
    expect(manifest.short_name).toBe(OFFICIAL_SHORT_NAME)
  })

  it('base64 的 data: URI 也能解出 SVG', () => {
    const url = `data:image/svg+xml;base64,${Buffer.from(CHANNEL_SVG).toString('base64')}`
    expect(svgFromDataUri(url)).toBe(CHANNEL_SVG)
    expect(svgFromDataUri('data:image/png;base64,AAAA')).toBeUndefined()
    expect(svgFromDataUri(undefined)).toBeUndefined()
  })

  it('渠道 SVG 带脚本特征时丢弃并回落官方图形', () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>'
    expect(sanitizeBrandSvg(hostile)).toBeUndefined()
    expect(sanitizeBrandSvg('not-an-svg')).toBeUndefined()
    const dirs = brandDirs({ staged: OFFICIAL_SVG })
    const assets = buildBrandWebAssets({
      profile: profile({ logoURL: `data:image/svg+xml,${encodeURIComponent(hostile)}` }),
      ...dirs,
    })
    expect(String(assets.favicon?.body)).toBe(OFFICIAL_SVG)
  })

  it('没有任何图形来源时不提供图标（宁可继续服务上游文件，也不裂图）', () => {
    const root = mkdtempSync(join(tmpdir(), 'brand-web-empty-'))
    roots.push(root)
    const assets = buildBrandWebAssets({
      profile: undefined,
      brandWebDir: join(root, 'missing'),
      officialLogoPath: join(root, 'missing.svg'),
    })
    expect(assets.favicon).toBeUndefined()
    expect(assets.manifest.body).toBeTypeOf('string')
  })

  it('响应带 nosniff / no-store，SVG 额外带沙箱 CSP', () => {
    const dirs = brandDirs({ staged: OFFICIAL_SVG })
    const assets = buildBrandWebAssets({ profile: undefined, ...dirs })
    const icon = fakeExchange()
    handleBrandAssetRequest(icon.req, icon.res, ORIGIN, assets.favicon!)
    expect(icon.state.status).toBe(200)
    expect(icon.state.headers['content-type']).toContain('image/svg+xml')
    expect(icon.state.headers['x-content-type-options']).toBe('nosniff')
    expect(icon.state.headers['cache-control']).toBe('no-store')
    expect(icon.state.headers['content-security-policy']).toContain("default-src 'none'")

    const manifest = fakeExchange()
    handleBrandAssetRequest(manifest.req, manifest.res, ORIGIN, assets.manifest)
    expect(manifest.state.headers['content-type']).toContain('application/manifest+json')
    expect(manifest.state.headers['content-security-policy']).toBeUndefined()

    const head = fakeExchange('HEAD')
    handleBrandAssetRequest(head.req, head.res, ORIGIN, assets.manifest)
    expect(head.state.status).toBe(200)
    expect(head.state.body).toBe('')
  })

  it('只认同源读取：跨源 Origin 403，非 GET/HEAD 405', () => {
    const dirs = brandDirs({ staged: OFFICIAL_SVG })
    const assets = buildBrandWebAssets({ profile: undefined, ...dirs })
    const cross = fakeExchange('GET', { origin: 'http://evil.example' })
    handleBrandAssetRequest(cross.req, cross.res, ORIGIN, assets.manifest)
    expect(cross.state.status).toBe(403)

    const post = fakeExchange('POST')
    handleBrandAssetRequest(post.req, post.res, ORIGIN, assets.manifest)
    expect(post.state.status).toBe(405)
  })

  it('路径常量与上游 manifest 里被覆盖的那两条一致', () => {
    expect(BRAND_FAVICON_PATH).toBe('/favicon.svg')
    expect(BRAND_MANIFEST_PATH).toBe('/manifest.webmanifest')
  })
})

/**
 * 运行时判定必须与**打包门禁**同款(2026-09-12 审计 P1-12):门禁用
 * `/<svg[\s/>]/u` 放行带 `<?xml?>` 头的 SVG,而运行时的
 * `startsWith('<svg')` 拒收同一份文件 —— 于是渠道 logo(图形工具重存即带
 * `<?xml?>`)在打包期绿灯、在客户端被丢弃,标签页/PWA 图标回落到上游鱼形。
 */
describe('品牌 SVG 判定与打包门禁同源(P1-12)', () => {
  it('接受带 XML 声明/注释/BOM 头的 SVG 文档', () => {
    expect(sanitizeBrandSvg(XML_DECLARED_SVG)).toBe(XML_DECLARED_SVG)
    expect(sanitizeBrandSvg(BOM_XML_SVG)).toBe(BOM_XML_SVG)
    expect(sanitizeBrandSvg('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg/>')).not.toBeUndefined()
  })

  it('运行时与打包门禁对同一组样本给出一致结论', () => {
    const samples = [
      OFFICIAL_SVG,
      CHANNEL_SVG,
      XML_DECLARED_SVG,
      BOM_XML_SVG,
      '  \n<svg xmlns="http://www.w3.org/2000/svg"/>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg/>',
      'not-an-svg',
      '{"name":"Acme"}',
      '<html><body/></html>',
    ]
    for (const sample of samples) {
      const runtimeAccepts = sanitizeBrandSvg(sample) !== undefined
      let gateAccepts = true
      try {
        assertBrandAssetSvg(sample, 'sample')
      } catch {
        gateAccepts = false
      }
      expect({ sample, runtimeAccepts }).toEqual({ sample, runtimeAccepts: gateAccepts })
    }
  })

  it('带脚本特征的 SVG 两个判定都拒收(沙箱 CSP 之外的静态检查)', () => {
    const hostile = '<svg onload="alert(1)"><script>alert(2)</script></svg>'
    expect(sanitizeBrandSvg(hostile)).toBeUndefined()
    // 事件属性判定的边界:XML 里属性之间必须有空白,所以裸的 `on[a-z]+=` 会误伤
    // `standalone="no"`(Inkscape 默认的 XML 声明),必须加边界;而真正的 `onload=`
    // 无论前面是空白、引号还是斜杠都要继续命中。
    for (const sample of [
      '<svg onload="alert(1)"/>',
      "<svg onload='alert(1)'/>",
      '<svg/onload="alert(1)"/>',
      '<svg xmlns="http://www.w3.org/2000/svg" ONLOAD="alert(1)"/>',
      '<a xlink:href="javascript:alert(1)"/>',
      '<foreignObject/>',
    ]) {
      expect({ sample, rejected: sanitizeBrandSvg(sample) === undefined }).toEqual({ sample, rejected: true })
    }
    // XML 声明里的 standalone 不是事件属性。
    expect(sanitizeBrandSvg('<?xml version="1.0" standalone="no"?><svg/>')).not.toBeUndefined()
  })

  it('渠道 logo 带 XML 声明时 favicon 仍然生效(不再回落上游鱼形)', () => {
    const dirs = brandDirs({ staged: XML_DECLARED_SVG })
    const assets = buildBrandWebAssets({
      profile: profile({ logoURL: `data:image/svg+xml,${encodeURIComponent(XML_DECLARED_SVG)}` }),
      ...dirs,
    })
    expect(assets.favicon?.body).toBe(XML_DECLARED_SVG)

    // 渠道 logo 缺失、只有构建期落盘的那份(staged)时同样生效。
    const stagedOnly = buildBrandWebAssets({ profile: profile(), ...brandDirs({ staged: XML_DECLARED_SVG }) })
    expect(stagedOnly.favicon?.body).toBe(XML_DECLARED_SVG)
  })

  it('官方兜底指向打包态真实随包的 build/web-brand/official.svg', () => {
    // 旧路径 `../../../brands/official/logo.svg` 在 src/lib/app.asar 三套布局下
    // **都不存在**(仓库真源在 <repo>/brands/,而包内没有 brands/**)⇒ 兜底是死代码。
    // 兜底必须落在 build/(唯一随包分发的品牌目录),且与 brandWebDir 同源。
    const source = readFileSync(new URL('src/index.ts', packageRoot), 'utf8')
    expect(source).toContain("new URL('../build/web-brand/official.svg', import.meta.url)")
    expect(source).not.toContain("new URL('../../../brands/official/logo.svg'")
  })

  it('打包门禁要求两份品牌几何都随包(少了兜底就没有兜底)', () => {
    expect([...REQUIRED_PACKAGED_RUNTIME_ENTRIES]).toContain(PACKAGED_WEB_BRAND_FAVICON)
    expect([...REQUIRED_PACKAGED_RUNTIME_ENTRIES]).toContain(PACKAGED_WEB_BRAND_OFFICIAL)
  })
})
