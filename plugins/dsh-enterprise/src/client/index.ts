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

/* Hero: brand mark replaces the whale, headline text is replaced in place,
   and the preview pill becomes the enterprise badge. */
[class$="_fishHitbox"] svg { display: none; }
[class$="_fishHitbox"]::before {
  content: "P";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: #4D6BFE;
  color: #fff;
  font-size: 17px;
  font-weight: 700;
  line-height: 1;
}
[class$="_headlineText"] { font-size: 0; }
[class$="_headlineText"]::after { content: "PicoAide Harness"; font-size: 26px; line-height: 32px; font-weight: 500; }
[class$="_previewBadge"] { font-size: 0; }
[class$="_previewBadge"]::after { content: "企业版"; font-size: 12px; line-height: 18px; font-weight: 500; font-family: var(--ds-font-family-code); }

/* Sidebar brand: P mark + product name replace the DeepSeek wordmark. */
[class*="_brand"] { font-size: 0; gap: 8px; }
[class*="_brand"] svg { display: none; }
[class*="_brand"]::before {
  content: "P";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: #4D6BFE;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}
[class*="_brand"]::after { content: "PicoAide"; font-size: 20px; font-weight: 700; letter-spacing: 0.3px; }

/* Collapsed rail: the P mark replaces the whale (hover yields to the panel icon). */
[class$="_railFish"] { display: none; }
[class*="_collapsed"] [class$="_toggle"]::before {
  content: "P";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: #4D6BFE;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
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
    () => ctx.slots.register({
      name: 'settings.section',
      id: 'account',
      order: 999,
      label: '账号',
    }, AccountSection),
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
