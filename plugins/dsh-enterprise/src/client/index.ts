import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings slot contract (settings.section) and the
// slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: merges the layout-owned `sidebar` row into SlotMap (the sidebar
// contract types resolve through it).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: declares the sidebar brand slots (`sidebar.brand.mark` /
// `sidebar.brand.name`) and the foot action slot.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: declares the conversation hero brand-mark slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AccountSection } from './AccountSection.tsx'
import { BraceMark, BrandName } from './Brand.tsx'
import { SkillCenterTrigger } from './SkillCenterTrigger.tsx'
import { en, type EnterpriseKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Enterprise client surface copy. */
    enterprise: EnterpriseKey
  }
}

/** Stable Cordis plugin name for the enterprise client half. */
export const name = 'picoaide-enterprise-client'

/** Locale namespace owning the enterprise client copy. */
const LOCALE_NS = 'enterprise'

/** Services required: the slot registry for settings pages. */
export const inject = ['slots', 'locale']

/**
 * Enterprise brand chrome: layout-only overrides for surfaces the upstream
 * slots do not cover. The sidebar foot action container is a flex row, so it
 * is pinned to column to let stacked actions (skill center, cordis panel)
 * sit one per row above Settings instead of overflowing side by side; the
 * skill center trigger matches the Settings trigger hover. The hero headline
 * and preview badge stay upstream-owned text (`hero.headline` /
 * `hero.preview` in the `conversation` dictionary); the upstream locale
 * service registers each (namespace, locale) exactly once, so this client
 * cannot override them — give the upstream ui-conversation a configurable
 * headline and delete the two `headlineText`/`previewBadge` rules below.
 */
const BRAND_CSS = `
/* Sidebar foot actions stack vertically above Settings (upstream container is a row). */
[class$="_footerActions"] { flex-direction: column; align-items: stretch; }

/* Hero headline + preview badge text (upstream locale not overridable). */
[class$="_headlineText"] { font-size: 0; }
[class$="_headlineText"]::after { content: "PicoAide Harness"; font-size: 26px; line-height: 32px; font-weight: 500; }
[class$="_previewBadge"] { font-size: 0; }
[class$="_previewBadge"]::after { content: "企业版"; font-size: 12px; line-height: 18px; font-weight: 500; font-family: var(--ds-font-family-code); }

/* Skill center trigger hover feedback, matching the Settings trigger. */
.pico-skill-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
`

/**
 * Register the enterprise surfaces: the brace brand at the upstream brand
 * slots (sidebar mark/name, hero mark), the skill center foot action above
 * the sidebar Settings trigger, the account page (username + logout) at the
 * bottom of settings, the branded document title, and the layout-only brand
 * chrome above.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  // Enterprise client dictionaries (zh key source, en mirror).
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => { off() }
  }, 'enterprise: client dictionaries')

  // Upstream brand slots (single/root). The official occupant is suppressed
  // by the desktop patch on @deepseek-ai/dsh-client-ui-brand-official, so
  // these registrations are the only occupants and cannot collide.
  ctx.effect(
    () => ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
      name: 'sidebar.brand.mark',
    }, BraceMark)),
    'enterprise: sidebar brand mark',
  )
  ctx.effect(
    () => ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
      name: 'sidebar.brand.name',
    }, BrandName)),
    'enterprise: sidebar brand name',
  )
  ctx.effect(
    () => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
      name: 'conversation.hero.brand.mark',
    }, BraceMark)),
    'enterprise: hero brand mark',
  )

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
