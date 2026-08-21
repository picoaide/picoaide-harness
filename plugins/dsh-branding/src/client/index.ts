import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the layout-owned `sidebar` row and the brand slot
// contracts into SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: declares the conversation hero brand-mark slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BraceMark, BrandName } from './Brand.tsx'

/** Stable Cordis plugin name for the branding client half. */
export const name = 'picoaide-branding-client'

/** Services required: the slot registry for the brand holes. */
export const inject = ['slots']

/**
 * Browser favicon artwork: the exact tray/app icon SVG
 * (`dsh-plugin-desktop/build/tray-icon.svg` — black rounded square, white
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

/** Replace the upstream fish favicon with the brace mark. */
function installFavicon(): void {
  const href = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    link.href = href
  }
  // Some shells read the manifest icon; keep the touch-icon path simple.
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (manifest !== null) {
    fetch(manifest.href)
      .then(res => res.json())
      .then((data: { icons?: { src?: string }[] }) => {
        if (Array.isArray(data.icons)) data.icons.forEach(icon => { icon.src = href })
      })
      .catch(() => { /* favicon replacement is best-effort */ })
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
}
