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
 * Register the enterprise settings surfaces: the skill center page above the
 * General section and the account page (username + logout) at the bottom.
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
}
