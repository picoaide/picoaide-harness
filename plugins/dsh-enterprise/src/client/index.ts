import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings slot contract (settings.section) and the
// slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: declares the root frame's `shell.overlay` list slot so the
// enterprise hero brand overlay can register into it.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AccountSection } from './AccountSection.tsx'
import { HeroBrandOverlay } from './HeroBrandOverlay.tsx'
import { SkillCenterSection } from './SkillCenterSection.tsx'

/** Stable Cordis plugin name for the enterprise client half. */
export const name = 'picoaide-enterprise-client'

/** Services required: the slot registry for settings pages. */
export const inject = ['slots']

/** Hide the upstream empty-state headline and preview badge behind the brand. */
const HERO_BRAND_CSS = `
[class$="_headlineText"], [class$="_previewBadge"] { display: none; }
`

/**
 * Register the enterprise settings surfaces: the skill center page above the
 * General section and the account page (username + logout) at the bottom, plus
 * the branded empty-conversation hero overlay.
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
    style.textContent = HERO_BRAND_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'enterprise: hero brand styles')

  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'picoaide-hero-brand',
      order: -1,
    }, HeroBrandOverlay)),
    'enterprise: hero brand overlay',
  )
}
