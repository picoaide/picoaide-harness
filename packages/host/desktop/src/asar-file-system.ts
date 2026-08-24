/**
 * Desktop filesystem backend that repairs asar-linked package paths for the
 * model-facing file tools.
 *
 * The desktop profile installs package fallback links at
 * `$DSH_HOME/profiles/node_modules/<pkg>` pointing into the packaged
 * `resources/app.asar/node_modules/...` tree (see `healProfilesModuleFallback`
 * in `@deepseek-ai/dsh-app-boot`). Electron's fs patch understands literal
 * `.asar` path segments but does NOT follow a symlink into an archive
 * (verified on Electron 43: `realpath`/`readFile` through such a link reject
 * with `ENOTDIR`), so a model reading an in-box preset through the link gets
 * `not found` and reaches for byte-level asar parsing instead of the direct
 * virtual path.
 *
 * This backend extends the upstream `SandboxedFileSystem` and repairs only
 * the path-resolution surface: when a model-supplied path passes through a
 * symlink whose target points into an asar archive, it rewrites the path to
 * the direct in-archive spelling before delegating to the local backend,
 * whose realpath then succeeds and yields a stable in-archive target key.
 * Mutations are never rewritten — the archive is read-only by construction,
 * and the inherited sandbox fence keeps enforcing the write policy.
 *
 * @module dsh-plugin-desktop/asar-file-system
 */

import { lstatSync, readlinkSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { Config as SandboxConfig } from '@deepseek-ai/dsh-fs-sandbox'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

/** The in-archive segment a repair path must contain. */
const IN_ARCHIVE = /\.asar(?=[\\/])/u

/** Symlink metadata probe shape (injectable for tests). */
interface LinkProbe {
  isSymbolicLink(): boolean
}

/**
 * Rewrite one absolute path by unwinding symlink components whose targets
 * point into an asar archive.
 *
 * The walk starts at the deepest component and rises. A component whose
 * `lstat` fails still rises — through an archive-pointing symlink the failed
 * low-level resolve is exactly the failure being repaired (Electron's fs
 * patch does not follow a link into an archive, so any access beneath it
 * reports `ENOTDIR`/`ENOENT`). When the walk reaches a *successfully*
 * lstat-able component:
 * - it is a symlink whose target contains an `.asar` segment → rewrite the
 *   link component to its target and append the suffix preserved below it;
 * - anything else (symlink to a non-archive path, or a real file/directory)
 *   → the path is not an asar repair case, return the input unchanged.
 *
 * A path whose walk reaches the filesystem root without success is returned
 * unchanged, so a genuinely missing file keeps the local backend's normal
 * `not found` taxonomy.
 *
 * @param path - absolute path the model supplied.
 * @param lstat - symlink metadata probe (defaults to `lstatSync`).
 * @param readlink - link-target reader (defaults to `readlinkSync`).
 * @returns the direct asar path when a link was repaired, else the input.
 */
export function repairAsarLinkPath(
  path: string,
  lstat: (path: string) => LinkProbe = lstatSync,
  readlink: (path: string) => string = readlinkSync,
): string {
  let current = path
  let suffix = ''
  for (let depth = 0; depth < 128; depth += 1) {
    let info: LinkProbe | undefined
    try {
      info = lstat(current)
    } catch {
      info = undefined
    }
    if (info !== undefined) {
      if (!info.isSymbolicLink()) return path
      const target = readlink(current)
      if (!IN_ARCHIVE.test(target)) return path
      const resolvedTarget = targetAbsolute(target) ? target : resolveRelativeTarget(parentOf(current), target)
      return suffix.length === 0 ? resolvedTarget : joinResolved(resolvedTarget, suffix)
    }
    const parent = parentOf(current)
    if (parent === current) return path
    const base = lastComponent(current)
    suffix = base.length === 0 ? suffix : base + (suffix.length === 0 ? '' : `${sepOf(current)}${suffix}`)
    current = parent
  }
  return path
}

/** Whether a link target is absolute in EITHER native or Windows terms. */
function targetAbsolute(target: string): boolean {
  return isAbsolute(target) || win32.isAbsolute(target)
}

/** Resolve a relative target against a link's directory (matching separator flavor). */
function resolveRelativeTarget(linkDir: string, target: string): string {
  const parentIsWin = linkDir.includes('\\') && !linkDir.includes('/')
  return parentIsWin ? win32.resolve(linkDir, target) : resolvePath(linkDir, target)
}

/** Join a resolved absolute target with its remaining suffix. */
function joinResolved(target: string, suffix: string): string {
  const sepChar = sepOf(target)
  return target.endsWith(sepChar) ? `${target}${suffix}` : `${target}${sepChar}${suffix}`
}

/** The separator of a path (POSIX or Windows). */
function sepOf(input: string): string {
  return input.includes('\\') ? '\\' : '/'
}

/** The last path component (either separator flavor). */
function lastComponent(input: string): string {
  const parts = input.split(/[\\/]/u)
  return parts[parts.length - 1] ?? ''
}

/** The parent directory of a path (POSIX or Windows separator). */
function parentOf(input: string): string {
  const lastSlash = input.lastIndexOf('/')
  const lastBackslash = input.lastIndexOf('\\')
  const idx = Math.max(lastSlash, lastBackslash)
  return idx <= 0 ? input : input.slice(0, idx)
}

/**
 * The Desktop asar-repairing filesystem backend. Registers as `ctx.fs` in the
 * desktop profile instead of upstream `dsh-fs-sandbox`; reads pass through
 * the inherited sandbox (every mode permits reading) after path repair.
 */
export class DesktopAsarFileSystem extends SandboxedFileSystem {
  /** Test knobs for the link walk. */
  links = {
    lstat: lstatSync,
    readlink: readlinkSync,
  }

  constructor(ctx: Context, config: SandboxConfig) {
    super(ctx, config)
  }

  private repair(path: string): string {
    return repairAsarLinkPath(path, this.links.lstat, this.links.readlink)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return super.resolve(this.repair(path), opts)
  }
}

export default DesktopAsarFileSystem
