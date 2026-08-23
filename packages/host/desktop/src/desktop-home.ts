/**
 * Product home resolution for DSH Desktop.
 *
 * The product owns its data directory: the default Harness home under the
 * OS home is `~/.picoaide-harness` instead of the upstream `~/.dsh`.
 *
 * The resolution contract mirrors the official `@deepseek-ai/dsh-home-paths`
 * (packages/util/home-paths): precedence, highest first — an explicit
 * configured path, `$DSH_HOME`, then the product default. An empty or
 * whitespace-only `$DSH_HOME` is treated as unset. Every official package
 * (settings-file, credentials-local, app-boot, …) resolves the home through
 * that one shared package; this module is the product's equivalent single
 * source of truth, and sibling plugins re-export it instead of copying the
 * default-directory constant.
 *
 * The desktop launcher also writes the resolved home back into `DSH_HOME`
 * at startup (main.ts), so every downstream consumer that reads the
 * environment agrees on one location.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that overrides the product home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name of the product default Harness home under the OS home. */
export const PRODUCT_DSH_HOME_DIR = '.picoaide-harness'

/** Stable user-facing display form for the default product home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${PRODUCT_DSH_HOME_DIR}`

/** Expand a leading ~ (or ~user) in a path, platform-style. */
export function expandHomePath(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/**
 * Resolve the single-root product Harness home.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
 * `~/.picoaide-harness`. The product keeps all user data under one root. An
 * empty or whitespace-only `$DSH_HOME` is treated as unset.
 * @param configured - explicit harness-home override, highest precedence.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @param home - platform home directory fallback (test seam).
 * @returns the normalized absolute product home path.
 */
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(home, PRODUCT_DSH_HOME_DIR))
  return resolve(expandHomePath(selected, home))
}

/**
 * Join path segments onto the resolved product Harness home.
 * @param segments - path segments appended to the home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/** Resolve the product home from the live environment. */
export function dshHome(): string {
  return resolveDshHome()
}
