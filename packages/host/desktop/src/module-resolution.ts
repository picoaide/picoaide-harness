/** Profile-relative package resolution for Electron's restricted Node runtime. */

import { registerHooks } from 'node:module'

const LOADER_ENTRY_URL = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
const DESKTOP_ENTRY_URL = new URL('../lib/index.js', import.meta.url).href
const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'

/** Return whether a Loader request needs Node package resolution. */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !URL.canParse(specifier)
}

/**
 * Resolve Cordis Loader bare imports from the selected persistent profile,
 * falling back to the desktop application tree (physical in dev, inside
 * app.asar when packaged — Electron's resolver understands asar paths).
 *
 * Profile-local packages resolve through Node's own parent-walk from the
 * profile directory (the profile's node_modules). When that fails (an
 * in-box package present only in the application tree), the desktop anchor
 * is tried via `import.meta.resolve`, which is asar-aware inside Electron.
 * @param profileBaseUrl - file URL inside the profile that owns plugin dependencies.
 * @returns an idempotent hook disposer.
 */
export function installProfilePackageResolver(profileBaseUrl: string): () => void {
  const desktopAnchor = new URL('../', import.meta.url).href
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromLoader = context.parentURL === LOADER_ENTRY_URL
      if (fromLoader && specifier === DESKTOP_PACKAGE_NAME) {
        return { shortCircuit: true, url: DESKTOP_ENTRY_URL }
      }
      if (!fromLoader || !isBareSpecifier(specifier)) {
        return nextResolve(specifier, context)
      }
      // 1. Profile-local packages: Node walks from the profile directory.
      try {
        const fromProfile = nextResolve(specifier, { ...context, parentURL: profileBaseUrl })
        if (fromProfile !== undefined) {
          return fromProfile
        }
      } catch {
        // fall through to the desktop tree
      }
      // 2. Desktop application tree (physical or asar virtual path).
      try {
        const fromDesktop = import.meta.resolve(specifier, desktopAnchor)
        if (fromDesktop !== undefined) {
          return { shortCircuit: true, url: fromDesktop }
        }
      } catch {
        // preserve the original resolution error below
      }
      return nextResolve(specifier, context)
    },
  })
  let active = true
  return () => {
    if (!active) return
    active = false
    hooks.deregister()
  }
}
