/**
 * Single source of truth for the upstream platform module table.
 *
 * Mirrors `PLATFORM_MODULES` / `PRELOADED_CLIENT_EXTERNALS` from the pinned
 * upstream checkout (`deepseek-harness/packages/client/web/src/platform.ts`).
 * Every desktop-owned client bundle keeps these specifiers external (the
 * shell's frozen module table resolves them at runtime), so the table must
 * never drift from upstream: `scripts/upgrade-upstream.mjs` re-extracts this
 * file from the new pin on every upgrade and fails the gate if it differs.
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
  '@deepseek-ai/dsh-client-runtime/client',
]
