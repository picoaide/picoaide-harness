/**
 * 品牌静态资源路由：`/favicon.svg` 与 `/manifest.webmanifest`。
 *
 * **为什么需要它**（2026-09-12 打包版真机复现）：客户端前端资源随
 * `@deepseek-ai/dsh-web-frontend` 分发，里面那份 `favicon.svg` 是**上游 DeepSeek
 * 鱼形**、`manifest.webmanifest` 写着 `DeepSeek Harness` / `DSH`。Electron 窗口
 * 图标与窗口标题由桌面自己挡（`window-options.ts` / `page-title-updated`），
 * 浏览器形态（`dsh web` 标签页、PWA「安装为应用」、部分 shell 的 touch icon）
 * 却直接读这两个文件；运行时改 `<link rel=icon>` 只救得了图标，**manifest 没有
 * 任何运行时覆盖点**（`enterprise/src/client/favicon.ts` 里改 manifest 的代码
 * 改的是 `fetch()` 之后丢掉的副本，是死代码）。
 *
 * 上游把前端目录挂在 web server 的 **fallback 席位**上（`dsh-host-frontend-static`
 * 的 "fallback seat"），具名路由优先命中，所以桌面在这里注册两个 exact 路由即可
 * 覆盖，且无需改动 node_modules 里的 dist。
 *
 * 资源来源（按优先级）：
 *  1. 随包渠道 logo（`build/channel.json` 的 `assets.logo_inline`，data: URI）；
 *  2. 构建期落盘的 `build/web-brand/favicon.svg`（官方构建＝`brands/official/logo.svg`）；
 *  3. 构建期落盘的 `build/web-brand/official.svg`（**始终是官方几何**，渠道 logo
 *     被判定为不可信/损坏时的兜底；2026-09-12 审计 P1-12：它必须落在随包的
 *     `build/` 里 —— 旧路径 `brands/official/logo.svg` 在任何布局下都不存在，
 *     于是这条兜底是死代码）；
 *  4. 都没有时**不注册路由**，让上游 fallback 继续服务（宁可显示旧图形，也不裂图）。
 *
 * SVG 是**渠道包内容**（构建期输入，但按仓库既有口径渠道包属不可信输入）：服务前
 * 做一次脚本特征检查，命中即丢弃并回落官方图形；响应同时带
 * `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` 与
 * `X-Content-Type-Options: nosniff`，杜绝"直接打开 /favicon.svg 时在我们源上执行脚本"。
 * @module dsh-plugin-desktop/brand-web-route
 */

import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { OFFICIAL_PRODUCT_NAME, type DesktopChannelProfile } from './desktop-channel.ts'

/** 浏览器/系统读取的图标地址。 */
export const BRAND_FAVICON_PATH = '/favicon.svg'
/** PWA manifest 地址。 */
export const BRAND_MANIFEST_PATH = '/manifest.webmanifest'

/** 官方构建的短名（与 `@picoaide/dsh-enterprise` 的 `DEFAULT_CHANNEL.client.short_name` 同值）。 */
export const OFFICIAL_SHORT_NAME = 'PicoAide'

/**
 * 渠道包内容里的脚本特征：命中即视为不可信，丢弃并回落。
 *
 * 事件处理属性那一条要求前面是**空白/引号/斜杠/文档开头**（2026-09-12 审计
 * P1-12 的第二半）：裸的 `on[a-z]+\s*=` 会误伤 XML 声明里的 `standalone="no"`
 * —— Inkscape 默认输出就带它，于是"合法渠道 logo 被当成可疑内容丢弃"又回到
 * 标签页显示厂商图形。XML 里属性之间必须有空白，所以加上这个边界不会漏掉真正
 * 的 `onload=`（`<svg onload=` / `<svg/onload=` 都仍然命中）。
 */
const SCRIPTISH_SVG = /<\s*script|<\s*foreignObject|(?:^|[\s"'/<])on[a-z]+\s*=|javascript:/iu

/**
 * "这是一份 SVG 文档"的最小判定，**与打包门禁同源**
 * （`scripts/verify-packaged-runtime.ts` 的 `assertBrandAssetSvg` 用同一条正则）。
 *
 * 为什么不能用 `startsWith('<svg')`（2026-09-12 审计 P1-12）：图形工具重存 SVG 时
 * 默认带 `<?xml …?>` 声明（Inkscape / Adobe Illustrator 还会加一行生成器注释），
 * 首段不是 `<svg` —— 那份文件在**打包门禁放行**、运行时却被丢弃，于是渠道包的
 * 标签页/PWA 图标回落到上游厂商图形，而 `manifest.name` 已经是渠道名。真正的
 * 安全边界是下面的脚本特征检查与响应上的沙箱 CSP，不是文档头的形状。
 */
const SVG_DOCUMENT = /<svg[\s/>]/iu

/** 一个可直接写进响应的静态资源。 */
export interface BrandWebAsset {
  /** 响应体。 */
  readonly body: Buffer | string
  /** 响应 Content-Type。 */
  readonly contentType: string
  /** 是否额外加 SVG 沙箱 CSP（只对 SVG 需要）。 */
  readonly sandboxed: boolean
}

/** 品牌资源集合；`favicon` 缺失时调用方不应注册图标路由。 */
export interface BrandWebAssets {
  readonly favicon: BrandWebAsset | undefined
  readonly manifest: BrandWebAsset
}

/**
 * 从 `data:` URI 里取出 SVG 文本（渠道 logo 随包内联后的形态）。
 * @param url - 渠道 profile 里的 `brand.logoURL` / `brand.logoDarkURL`。
 * @returns SVG 文本；不是 SVG 形态的 data URI 时返回 undefined。
 */
export function svgFromDataUri(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const match = /^data:image\/svg\+xml(?:;charset=[a-z0-9-]+)?(;base64)?,(.*)$/isu.exec(url)
  if (match === null) return undefined
  const [, base64, payload] = match
  if (payload === undefined) return undefined
  try {
    return base64 === undefined
      ? decodeURIComponent(payload)
      : Buffer.from(payload, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * 渠道 SVG 的最小可信检查。
 * @param svg - 待服务的 SVG 文本。
 * @returns 可安全服务时返回原文，否则 undefined。
 */
export function sanitizeBrandSvg(svg: string): string | undefined {
  // 去掉 BOM 只是为了匹配;返回的仍是原文(逐字节服务渠道素材)。
  if (!SVG_DOCUMENT.test(svg.replace(/^\uFEFF/u, ''))) return undefined
  if (SCRIPTISH_SVG.test(svg)) return undefined
  return svg
}

/** 读取一个可能存在的 UTF-8 文件。 */
function readOptional(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 组装品牌资源。
 * @param options - 渠道 profile、`build/web-brand` 目录与官方 logo 兜底路径。
 * @returns 图标（可能缺失）与 manifest。
 */
export function buildBrandWebAssets(options: {
  readonly profile?: DesktopChannelProfile | undefined
  readonly brandWebDir: string
  readonly officialLogoPath?: string | undefined
}): BrandWebAssets {
  const staged = readOptional(join(options.brandWebDir, 'favicon.svg'))
  const official = options.officialLogoPath === undefined ? undefined : readOptional(options.officialLogoPath)
  const candidates = [
    svgFromDataUri(options.profile?.brand.logoURL),
    svgFromDataUri(options.profile?.brand.logoDarkURL),
    staged,
    official,
  ]
  let svg: string | undefined
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    svg = sanitizeBrandSvg(candidate)
    if (svg !== undefined) break
  }

  const productName = options.profile?.productName ?? OFFICIAL_PRODUCT_NAME
  const profileShortName = options.profile?.brand.client.shortName
  const shortName = profileShortName !== undefined && profileShortName.length > 0
    ? profileShortName
    : OFFICIAL_SHORT_NAME
  const manifest = {
    id: '/',
    name: productName,
    short_name: shortName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    icons: [{ src: BRAND_FAVICON_PATH, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }

  return {
    favicon: svg === undefined
      ? undefined
      : { body: svg, contentType: 'image/svg+xml; charset=utf-8', sandboxed: true },
    manifest: {
      body: JSON.stringify(manifest, null, 2),
      contentType: 'application/manifest+json; charset=utf-8',
      sandboxed: false,
    },
  }
}

/** 结束一个 304/405/403 之类的空响应。 */
function finish(res: ServerResponse, statusCode: number): void {
  res.statusCode = statusCode
  res.end()
}

/**
 * 服务一个品牌静态资源。
 *
 * 守卫与其它桌面同源路由一致（见 `desktop-update-route.ts`）：Chromium 的
 * 同源 GET 不带 `Origin`，因此只在带了 Origin 且不等于渲染源时拒绝。
 * @param req - 入站请求。
 * @param res - 出站响应。
 * @param expectedOrigin - 渲染层来源。
 * @param asset - 要服务的资源。
 */
export function handleBrandAssetRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  asset: BrandWebAsset,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') return finish(res, 405)
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    return finish(res, 403)
  }
  res.statusCode = 200
  res.setHeader('content-type', asset.contentType)
  res.setHeader('x-content-type-options', 'nosniff')
  // 品牌随渠道切换：任何缓存层都不得把上一个渠道的图标/manifest 带过来。
  res.setHeader('cache-control', 'no-store')
  if (asset.sandboxed) {
    // SVG 可能来自渠道包：即使内容检查漏了，也不允许它在我们源上取资源或导航。
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
  }
  if (req.method === 'HEAD') return finish(res, 200)
  res.end(asset.body)
}
