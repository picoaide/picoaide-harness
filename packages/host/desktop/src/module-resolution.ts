/** Profile-relative package resolution for Electron's restricted Node runtime. */

import Module from 'node:module'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const LOADER_ENTRY_URL = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
const DESKTOP_ENTRY_URL = new URL('../lib/index.js', import.meta.url).href
const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'
const DESKTOP_PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))

/** Return whether a specifier is a bare package request (needs node_modules resolution). */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !URL.canParse(specifier)
}

/** Node internal CJS resolver signature patched below; private API, kept narrow. */
type ResolveFilename = (
  request: string,
  parent: { filename?: string; paths?: string[] } | undefined,
  isMain: boolean,
  options?: { paths?: string[] },
) => string

/** The live internal CJS resolver; absent on an exotic Node release means no patch. */
const RESOLVE_FILENAME = '_resolveFilename'
const resolveFilename = (Module as unknown as Record<string, unknown>)[RESOLVE_FILENAME] as ResolveFilename | undefined

/**
 * Resolve bare package specifiers from the selected persistent profile,
 * falling back to the desktop application tree (physical in dev, inside
 * app.asar when packaged — Electron's resolver understands asar paths).
 *
 * Two resolution worlds must be covered:
 * - ESM: the Cordis Loader resolves plugin packages bare; the `registerHooks`
 *   `resolve` hook below intercepts those and retries from the profile, then
 *   from the desktop tree.
 * - CJS `require.resolve`: host services such as dsh-client-modules scan
 *   plugin manifests with `createRequire(ctx.baseUrl).resolve('<pkg>/package.json')`.
 *   In the packaged asar layout the profile's flat fallback
 *   (`$DSH_HOME/profiles/node_modules`) holds one symlink per in-box package,
 *   each pointing INTO `app.asar` (see `healProfilesModuleFallback`). Electron's
 *   asar patch matches the literal `.asar` path segment, but a symlink target
 *   is seen by the CJS resolver as an ordinary file (`app.asar`), not a
 *   directory, so the walk fails with MODULE_NOT_FOUND — while the equivalent
 *   `.asar`-segment path resolves fine. Verified in real Electron: direct
 *   `.asar` path resolves, symlink-into-asar does not.
 *
 * The CJS patch mirrors the ESM fallback: on MODULE_NOT_FOUND retry through a
 * `createRequire` anchored at the desktop package.json, whose parent walk hits
 * `app.asar/node_modules` directly. The retry is guarded against re-entrancy
 * (a second failure inside the retry must not recurse).
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
  let original: ResolveFilename | undefined
  if (resolveFilename !== undefined) {
    original = resolveFilename
    const cjsRequire = createRequire(DESKTOP_PACKAGE_JSON)
    let inFallback = false
    const fallback = function desktopCjsResolve(
      this: unknown,
      request: string,
      parent: { filename?: string; paths?: string[] } | undefined,
      isMain: boolean,
      options?: { paths?: string[] },
    ): string {
      try {
        return original!.call(this, request, parent, isMain, options)
      } catch (error) {
        if (inFallback || (error as NodeJS.ErrnoException | null)?.code !== 'MODULE_NOT_FOUND' || !isBareSpecifier(request)) {
          throw error
        }
        inFallback = true
        try {
          return cjsRequire.resolve(request)
        } catch {
          throw error
        } finally {
          inFallback = false
        }
      }
    }
    ;(Module as unknown as Record<string, unknown>)[RESOLVE_FILENAME] = fallback
  }
  return () => {
    if (!active) return
    active = false
    hooks.deregister()
    if (original !== undefined) {
      ;(Module as unknown as Record<string, unknown>)[RESOLVE_FILENAME] = original
    }
  }
}
