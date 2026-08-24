/**
 * Desktop guidance section for packaged in-box files.
 *
 * The desktop ships read-only harness packages inside the application archive
 * (`resources/app.asar`). A model inspecting them through the fallback links
 * under `$DSH_HOME/profiles/node_modules` reaches paths Electron cannot follow
 * into the archive; the asar-repairing filesystem backend (`asar-file-system`)
 * makes those reads work, but the model-facing guidance here states the direct
 * spelling so an agent stops at the virtual path instead of reaching for
 * byte-level archive parsing.
 *
 * @module dsh-plugin-desktop/asar-guidance
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Stable Cordis plugin name. */
export const name = 'desktop-asar-guidance'

/** The system prompt service this plugin contributes a section to. */
export const inject = ['systemPrompt']

/** No configuration. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

/** Register the packaged in-box file reading guidance. */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'desktop:inbox-packages',
      order: 90,
      text: [
        'Read-only packaged files (presets, shipped configs) live inside the application archive.',
        'Read them directly through their in-archive path, e.g. `<install>\\resources\\app.asar\\node_modules\\<pkg>\\<file>`.',
        'The `$DSH_HOME\\profiles\\node_modules` fallback links also work for reading; prefer the in-archive path when you see it.',
      ].join('\n'),
    }),
    'desktop-asar-guidance: inbox package path',
  )
}
