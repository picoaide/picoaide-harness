import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings slot contract (settings.section) and the
// slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: merges the layout-owned `sidebar` row into SlotMap (the sidebar
// contract types resolve through it).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: declares the sidebar foot action slot (`sidebar.footer.action`).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AccountSection } from './AccountSection.tsx'
import { SkillCenterTrigger } from './SkillCenterTrigger.tsx'

/** Stable Cordis plugin name for the enterprise client half. */
export const name = 'picoaide-enterprise-client'

/** Services required: the slot registry for settings pages. */
export const inject = ['slots']

/**
 * White brace mark (matches the app/tray icon): transparent-background SVG
 * data URI of the two braces, connector and nodes, rendered via background
 * image at the upstream mark slots (hero, sidebar wordmark, collapsed rail).
 */
/**
 * Brace mark (matches the app/tray icon) in both theme variants:
 * white braces for the light theme's black tile, black braces for the dark
 * theme's white tile. Transparent-background SVG data URIs rendered via
 * background image at the upstream mark slots (hero, sidebar wordmark,
 * collapsed rail); the tile color flips on `body[data-ds-dark-theme]`.
 */
const BRACE_WHITE_URI = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="83 320 1087 617"><path d="M334 409 C300 409 273 431 273 466 V548 C273 582 254 607 220 620 C254 633 273 658 273 692 V775 C273 810 300 843 334 843" fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/><path d="M920 409 C954 409 981 431 981 466 V548 C981 582 1000 607 1034 620 C1000 633 981 658 981 692 V775 C981 810 954 843 920 843" fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/><line x1="435" y1="627" x2="817" y2="627" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round"/><circle cx="435" cy="627" r="65" fill="#FFFFFF"/><circle cx="817" cy="627" r="65" fill="#FFFFFF"/></svg>`)
const BRACE_BLACK_URI = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="83 320 1087 617"><path d="M334 409 C300 409 273 431 273 466 V548 C273 582 254 607 220 620 C254 633 273 658 273 692 V775 C273 810 300 843 334 843" fill="none" stroke="#000000" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/><path d="M920 409 C954 409 981 431 981 466 V548 C981 582 1000 607 1034 620 C1000 633 981 658 981 692 V775 C981 810 954 843 920 843" fill="none" stroke="#000000" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/><line x1="435" y1="627" x2="817" y2="627" stroke="#000000" stroke-width="20" stroke-linecap="round"/><circle cx="435" cy="627" r="65" fill="#000000"/><circle cx="817" cy="627" r="65" fill="#000000"/></svg>`)

/**
 * Enterprise brand CSS: swap the upstream DeepSeek marks for the PicoAide
 * brand in place, keeping the upstream layout geometry (headline grid, sizes,
 * ink). CSS-module classes match by suffix; `:has()` scopes the headline grid
 * fix to the hero headline (the only one containing a headlineText child).
 * The sidebar foot action container is a flex row, so it is pinned to column
 * to let stacked actions (skill center, cordis panel) sit one per row above
 * Settings instead of overflowing side by side.
 */
const BRAND_CSS = `
/* Sidebar foot actions stack vertically above Settings (upstream container is a row). */
[class$="_footerActions"] { flex-direction: column; align-items: stretch; }

/* Hero: brace mark (black tile, white braces) replaces the whale, headline
   text is replaced in place, and the preview pill becomes the enterprise
   badge. Dark theme flips the tile to white with black braces. */
[class$="_fishHitbox"] svg { display: none; }
[class$="_fishHitbox"]::before {
  content: "";
  display: inline-block;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background-color: #000000;
  background-image: url("${BRACE_WHITE_URI}");
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center;
}
body[data-ds-dark-theme] [class$="_fishHitbox"]::before {
  background-color: #ffffff;
  background-image: url("${BRACE_BLACK_URI}");
}
[class$="_headlineText"] { font-size: 0; }
[class$="_headlineText"]::after { content: "PicoAide Harness"; font-size: 26px; line-height: 32px; font-weight: 500; }
[class$="_previewBadge"] { font-size: 0; }
[class$="_previewBadge"]::after { content: "企业版"; font-size: 12px; line-height: 18px; font-weight: 500; font-family: var(--ds-font-family-code); }

/* Sidebar brand: brace mark + product name replace the DeepSeek wordmark. */
[class*="_brand"] { font-size: 0; gap: 8px; }
[class*="_brand"] svg { display: none; }
[class*="_brand"]::before {
  content: "";
  display: inline-block;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background-color: #000000;
  background-image: url("${BRACE_WHITE_URI}");
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center;
}
body[data-ds-dark-theme] [class*="_brand"]::before {
  background-color: #ffffff;
  background-image: url("${BRACE_BLACK_URI}");
}
[class*="_brand"]::after { content: "PicoAide"; font-size: 20px; font-weight: 700; letter-spacing: 0.3px; }

/* Collapsed rail: the brace mark replaces the whale (hover yields to the panel icon). */
[class$="_railFish"] { display: none; }
[class*="_collapsed"] [class$="_toggle"]::before {
  content: "";
  display: inline-block;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background-color: #000000;
  background-image: url("${BRACE_WHITE_URI}");
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center;
}
body[data-ds-dark-theme] [class*="_collapsed"] [class$="_toggle"]::before {
  background-color: #ffffff;
  background-image: url("${BRACE_BLACK_URI}");
}
[class*="_collapsed"] [class$="_toggle"]:hover::before { display: none; }

/* Skill center trigger hover feedback, matching the Settings trigger. */
.pico-skill-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
`

/**
 * Register the enterprise surfaces: the skill center foot action above the
 * sidebar Settings trigger, the account page (username + logout) at the
 * bottom of settings, and the branded document title and in-place brand CSS.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'skill-center',
      order: -1,
    }, SkillCenterTrigger)),
    'enterprise: skill center foot action',
  )

  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'account',
      order: 999,
      label: '账号',
    }, AccountSection)),
    'enterprise: account section',
  )

  ctx.effect(() => {
    document.title = 'PicoAide Harness'
    return () => { /* document title resets with the next navigation */ }
  }, 'enterprise: document brand title')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = BRAND_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'enterprise: brand styles')
}
