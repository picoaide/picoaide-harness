/** Cordis Host surface for selecting the launcher-owned DSH profile. */

import type { Context } from '@deepseek-ai/cordis'
import type { DesktopProfileSummary } from './profile-manager.ts'
import type {} from './runtime.ts'

/** Narrow profile capability supplied by the Electron launcher before boot. */
export interface DesktopProfiles {
  /** Profile backing the current Cordis generation. */
  readonly currentProfileName: string
  /** Read the current set of profile manifests without changing them. */
  list(): readonly DesktopProfileSummary[]
  /** Persist a compatible profile as pending for the next generation. */
  select(name: string): void | Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned profile discovery and selection boundary. */
    desktopProfiles: DesktopProfiles
  }
}

/** Stable Cordis plugin name. */
export const name = 'desktop-profiles'

/** Native tray and launcher profile services required by this Host surface. */
export const inject = ['desktopRuntime', 'desktopProfiles']

/** Return whether a discovered profile can back the desktop Web surface. */
function selectable(profile: DesktopProfileSummary): boolean {
  return profile.webCapable && profile.problem === undefined
}

/** Render unavailable profiles without exposing manifest diagnostics in native menus. */
function profileLabel(profile: DesktopProfileSummary): string {
  return selectable(profile) ? profile.name : `${profile.name} (Unavailable for Desktop)`
}

/** Register the current profile and restart-safe switch commands in the native tray. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'profiles',
      order: 10,
      label: () => `Profile: ${ctx.desktopProfiles.currentProfileName}`,
      invoke: () => {},
      submenu: () => ctx.desktopProfiles.list().map(profile => ({
        label: () => profileLabel(profile),
        type: 'radio',
        checked: () => profile.name === ctx.desktopProfiles.currentProfileName,
        enabled: () => selectable(profile),
        invoke: async () => {
          if (profile.name === ctx.desktopProfiles.currentProfileName) return
          await ctx.desktopProfiles.select(profile.name)
          await ctx.desktopRuntime.requestRestart()
        },
      })),
    })
    return () => { registration.dispose() }
  }, 'dsh-plugin-desktop: native profile selector')
}
