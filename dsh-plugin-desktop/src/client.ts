/** Browser half of DSH Desktop: marks the renderer generation for desktop contributors. */

import type { Context } from '@deepseek-ai/cordis'
import type { DesktopPlatform } from './runtime.ts'

const PLATFORMS = new Set<DesktopPlatform>(['darwin', 'win32', 'linux'])

/**
 * Parse the launcher-authored platform marker from a renderer URL.
 * @param href - current renderer URL.
 * @returns the supported platform, or undefined for a non-desktop page.
 */
export function desktopPlatformFromUrl(href: string): DesktopPlatform | undefined {
  const value = new URL(href).searchParams.get('dsh-desktop-platform')
  return value !== null && PLATFORMS.has(value as DesktopPlatform)
    ? value as DesktopPlatform
    : undefined
}

/**
 * Mark the document while this client fiber is active.
 * @param ctx - renderer Cordis context.
 */
export function apply(ctx: Context): void {
  if (typeof document === 'undefined' || typeof location === 'undefined') return
  const platform = desktopPlatformFromUrl(location.href)
  if (platform === undefined) return
  ctx.effect(() => {
    const root = document.documentElement
    const previousDesktop = root.dataset.dshDesktop
    const previousPlatform = root.dataset.dshDesktopPlatform
    root.dataset.dshDesktop = 'true'
    root.dataset.dshDesktopPlatform = platform
    return () => {
      if (previousDesktop === undefined) delete root.dataset.dshDesktop
      else root.dataset.dshDesktop = previousDesktop
      if (previousPlatform === undefined) delete root.dataset.dshDesktopPlatform
      else root.dataset.dshDesktopPlatform = previousPlatform
    }
  }, 'dsh-plugin-desktop: renderer marker')
}
