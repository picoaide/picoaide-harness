import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings slot contract (settings.section) and the
// slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AccountSection } from './AccountSection.tsx'
import { SkillCenterSection } from './SkillCenterSection.tsx'

/** Stable Cordis plugin name for the enterprise client half. */
export const name = 'picoaide-enterprise-client'

/** Services required: the slot registry for settings pages. */
export const inject = ['slots']

/**
 * Enterprise brand CSS: swap the upstream DeepSeek marks for the product name
 * in place, keeping the upstream layout geometry (headline grid, sizes, ink).
 * CSS-module classes match by suffix; `:has()` scopes the headline grid fix to
 * the hero headline (the only one containing a headlineText child).
 */
const BRAND_CSS = `
[class$="_headlineText"] { font-size: 0; }
[class$="_headlineText"]::after { content: "PicoAide Harness"; font-size: 26px; line-height: 32px; font-weight: 500; }
[class$="_previewBadge"] { display: none; }
[class$="_fishHitbox"] { display: none; }
[class$="_headline"]:has([class$="_headlineText"]) { grid-template-columns: auto; }
[class*="_brand"] { font-size: 0; }
[class*="_brand"] svg { display: none; }
[class*="_brand"]::before { content: "PicoAide"; font-size: 20px; font-weight: 700; letter-spacing: 0.3px; }
[class$="_railFish"] { display: none; }
`

/**
 * Register the enterprise settings surfaces: the skill center page above the
 * General section and the account page (username + logout) at the bottom, plus
 * the branded document title and in-place brand CSS.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.register({
      name: 'settings.section',
      id: 'skill-center',
      order: -1,
      label: '技能中心',
    }, SkillCenterSection),
    'enterprise: skill center section',
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
