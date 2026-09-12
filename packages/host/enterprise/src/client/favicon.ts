/**
 * Desktop favicon replacement: the exact brand mark (`brands/official/logo.svg` —
 * black rounded square, white brace mark, uniformly enlarged 1.25×; single
 * brand authority), inlined as a data URI for the `<link rel=icon>` element.
 *
 * 2026-09-12 起 manifest **不再在这里改**：从前那段 `fetch(manifest.href)` 之后
 * 改 `icons[].src` 的代码是**死代码**（改的是 `fetch()` 解析出来的副本，浏览器
 * 读的是自己那次请求，改完既不写回也没人消费）。现在 `/favicon.svg` 与
 * `/manifest.webmanifest` 由桌面 host 的 exact 路由覆盖（`brand-web-route.ts`，
 * 上游前端挂在 fallback 席位、具名路由优先），manifest 的 name/short_name/icons
 * 才是真正对外的那个。这里只保留 DOM 内的 `<link rel=icon>` 覆盖：它对
 * **已经加载完的页面**仍然必要（登录页/恢复页在客户端插件装载前就会取一次图标）。
 *
 * The desktop assembly does not include `@picoaide/dsh-branding` (web-only),
 * so this module carries the favicon surface for the desktop client.
 */

import { brandTileSvg } from '../channel-geometry.ts'

const FAVICON_SVG = brandTileSvg()

/** Replace every `<link rel=icon>` href with the brace mark. */
export function installFavicon(): void {
  const href = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    link.href = href
  }
}
