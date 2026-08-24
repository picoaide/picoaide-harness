/**
 * Rewrite `child_process.spawn`/`spawnSync` program paths that point inside
 * `app.asar` to the physical `app.asar.unpacked` counterpart.
 *
 * Electron patches `execFile`/`execFileSync` (through `archive.copyFileOut`)
 * so they can launch a binary stored in an asar archive, but deliberately
 * does NOT patch `spawn`/`spawnSync` — `spawn` accepts a program path and a
 * shell may or may not be involved, so a rewrite cannot be proven safe in
 * general (`docs/tutorial/asar-archives.md`). The DeepSeek Harness process
 * seam (`dsh-subprocess-local`) launches every command through `spawn`, and
 * the sandbox runner probe (`dsh-sandbox-local`) uses `spawnSync`, so under
 * Electron packaging a binary that ships unpacked next to the archive still
 * resolves to a virtual `app.asar/...` path and spawn rejects with
 * `ENOTDIR` — the failure a packaged `rg` or the `landlock-run` launcher
 * hits despite an existing `app.asar.unpacked` twin.
 *
 * This module mirrors Electron's own `copyFileOut` semantics narrowly: only
 * when the spawn's program argument is an absolute path whose asar segment
 * has a physically existing `app.asar.unpacked` twin is the spawn redirected
 * to the twin. Everything else — bare PATH names, relative paths, URLs,
 * shell command strings (`spawn('cmd arg', { shell: true })`, whose first
 * argument is never a plain program path), and paths without a twin — passes
 * through unchanged, and a genuinely missing binary still fails at the OS
 * layer exactly as before.
 *
 * The patch is installed once in the Electron main process before the
 * Loader imports any harness plugin module. Node serves the builtin
 * `node:child_process` through one shared CJS module instance, and ESM named
 * imports are live bindings over it, so a plugin's `import { spawn } from
 * 'node:child_process'` observes the patched function (verified against
 * Electron 43 and Node 24).
 * @module dsh-plugin-desktop/asar-spawn
 */

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createRequire } from 'node:module'

/** The shared builtin instance every `import ... from 'node:child_process'` live-binds to. */
const childProcessModule = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')

/**
 * Match the virtual in-archive segment of a path: `.asar` immediately
 * followed by a path separator. The lookahead keeps `app.asar.unpacked/...`
 * (already physical) out of the rewrite and also matches the
 * `node_modules.asar/...` multi-package spelling Electron supports.
 */
const IN_ARCHIVE = /\.asar(?=[\\/])/u

/**
 * Map a virtual asar executable path to its physical `app.asar.unpacked`
 * twin when the twin exists; return the input otherwise.
 * @param path - the exact executable path a spawn is about to use.
 * @param exists - physical existence probe (defaults to `fs.existsSync`);
 *   the probe always receives the physical twin path, which Electron's asar
 *   fs patch leaves to the real filesystem (verified on Electron 43: an
 *   `.asar.unpacked` segment is not treated as an archive path).
 * @returns the physical twin when present, else the input unchanged.
 */
export function mapExecutableToUnpacked(
  path: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (!isAbsolute(path) || !IN_ARCHIVE.test(path)) return path
  const twin = path.replace(IN_ARCHIVE, '.asar.unpacked')
  return exists(twin) ? twin : path
}

/**
 * Whether a spawn call runs its first argument through a shell, in which
 * case it is a command string and never a single program path. Node's
 * `shell` option accepts `true` (the default platform shell) or a string
 * (a specific shell path); any value other than `false`/`undefined` puts
 * the first argument through a shell. Handles both call shapes:
 * `spawn(command, options)` and `spawnSync(command, args, options)`.
 * @param args - the `spawn`/`spawnSync` arguments.
 */
function isShellCommand(args: readonly unknown[]): boolean {
  for (const position of [1, 2]) {
    const options = args[position]
    if (typeof options === 'object' && options !== null && (options as { shell?: unknown }).shell !== undefined
      && (options as { shell?: unknown }).shell !== false) {
      return true
    }
  }
  return false
}

/**
 * Wrap one spawn function with the asar executable rewrite. The parameter
 * list stays opaque via a cast because `spawn` is overloaded while its first
 * argument is always the program (or a shell command when `shell: true`).
 */
function wrapSpawnAsarRewrite<F extends (this: unknown, ...args: any[]) => any>(fn: F): F {
  return function patchedSpawn(this: unknown, ...args: unknown[]) {
    if (typeof args[0] === 'string' && !isShellCommand(args)) {
      args[0] = mapExecutableToUnpacked(args[0])
    }
    return (fn as (this: unknown, ...callArgs: unknown[]) => unknown).apply(this, args)
  } as F
}

/**
 * Patch the shared `node:child_process` instance's `spawn` and `spawnSync`
 * with the asar executable rewrite and return a disposer restoring both.
 * @returns a disposer removing the patches this call installed.
 */
export function installAsarSpawnRewrite(): () => void {
  if (childProcessModule.spawn === undefined || childProcessModule.spawnSync === undefined) {
    return () => {}
  }
  const originalSpawn = childProcessModule.spawn
  const originalSpawnSync = childProcessModule.spawnSync
  const patchedSpawn = wrapSpawnAsarRewrite(originalSpawn)
  const patchedSpawnSync = wrapSpawnAsarRewrite(originalSpawnSync)
  if (childProcessModule.spawn !== patchedSpawn) childProcessModule.spawn = patchedSpawn
  if (childProcessModule.spawnSync !== patchedSpawnSync) childProcessModule.spawnSync = patchedSpawnSync
  return () => {
    // Restore only what this call owns, so a peer installer's newer patch
    // survives this disposer.
    if (childProcessModule.spawn === patchedSpawn) childProcessModule.spawn = originalSpawn
    if (childProcessModule.spawnSync === patchedSpawnSync) childProcessModule.spawnSync = originalSpawnSync
  }
}
