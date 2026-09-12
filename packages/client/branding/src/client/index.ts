import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the layout-owned `sidebar` row and the brand slot
// contracts into SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: declares the conversation hero brand-mark slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: declares the settings-page `settings.section` slot contract
// (the About section occupant).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BraceMark, BrandName } from './Brand.tsx'
import { AboutSection, OverlayBadge, applyBrandTheme, injectBrandShellStyles } from './brand-shell.tsx'

/** Stable Cordis plugin name for the branding client half. */
export const name = 'picoaide-branding-client'

/** Services required: the slot registry for the brand holes, plus the theme runtime. */
export const inject = ['slots', 'theme']

/**
 * Browser favicon artwork: the exact brand mark
 * (`brands/official/logo.svg` — black rounded square, white
 * brace mark, uniformly enlarged 1.25×), inlined as a data URI so no server
 * static override is needed — the upstream `/favicon.svg` (DeepSeek fish) is
 * served by dsh-web-frontend and cannot be patched from this profile layer.
 */
const FAVICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">
  <rect x="0" y="0" width="1254" height="1254" rx="180" fill="#000000"/>
  <g transform="translate(627 627) scale(1.25) translate(-627 -627)">
    <path d="M 334 409 C 300 409 273 431 273 466 V 548 C 273 582 254 607 220 620 C 254 633 273 658 273 692 V 775 C 273 810 300 843 334 843" fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M 920 409 C 954 409 981 431 981 466 V 548 C 981 582 1000 607 1034 620 C 1000 633 981 658 981 692 V 775 C 981 810 954 843 920 843" fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="435" y1="627" x2="817" y2="627" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round"/>
    <circle cx="435" cy="627" r="65" fill="#FFFFFF"/>
    <circle cx="817" cy="627" r="65" fill="#FFFFFF"/>
  </g>
</svg>`

/**
 * Replace every `<link rel=icon>` href with the brace mark.
 *
 * 2026-09-12：原先那段"改 manifest 的 icons[].src"是**死代码**（改的是
 * `fetch()` 解析出来的副本，浏览器读的是它自己那次请求；改完既不写回也没人消费），
 * 已删除。桌面端的 `/favicon.svg` 与 `/manifest.webmanifest` 现在由 host 的 exact
 * 路由覆盖（`packages/host/desktop/src/brand-web-route.ts`）；纯 web 形态
 * （`dsh web`，非交付形态）仍会拿到上游 dist 的 manifest —— 那是上游前端包的分发
 * 内容，本包无权覆盖，这里也不假装能覆盖。
 */
function installFavicon(): void {
  const href = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    link.href = href
  }
}

/**
 * Register the PicoAide brand surfaces for the web UI: the brace mark at the
 * upstream brand slots (sidebar mark/name, hero mark) and the browser
 * favicon. These slots are single/root and unoccupied in the web
 * composition (the official brand package is not present), so these
 * registrations are the only occupants.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
      name: 'sidebar.brand.mark',
    }, BraceMark)),
    'picoaide-branding: sidebar brand mark',
  )
  ctx.effect(
    () => ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
      name: 'sidebar.brand.name',
    }, BrandName)),
    'picoaide-branding: sidebar brand name',
  )
  ctx.effect(
    () => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
      name: 'conversation.hero.brand.mark',
    }, BraceMark)),
    'picoaide-branding: hero brand mark',
  )

  ctx.effect(() => {
    installFavicon()
    return () => { /* favicon reverts on the next navigation */ }
  }, 'picoaide-branding: favicon')

  // --- Brand shell surfaces (merged from the retired @picoaide/dsh-shell) ---

  ctx.effect(() => {
    injectBrandShellStyles()
    // The theme layer disposer teardowns the token override on disposal.
    return applyBrandTheme(ctx) ?? (() => {})
  }, 'picoaide-branding: shell styles + theme tokens')

  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'picoaide-badge',
    }, OverlayBadge)),
    'picoaide-branding: overlay badge',
  )

  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'picoaide-about',
      order: 900,
      label: 'About PicoAide',
    }, AboutSection)),
    'picoaide-branding: about section',
  )
}
