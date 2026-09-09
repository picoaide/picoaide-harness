/** Shared preparation and verification inventory for arm64 macOS packages. */

import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type MacArch = 'arm64'

/** One required native file; `match` handles dependency-version drift. */
export interface MacNativeEntry {
  readonly arch: MacArch
  readonly path: string
  /** Optional filename pattern. `@img/sharp-*` embeds the dependency version in
   * the file name (`sharp-darwin-arm64-0.35.3.node`, `libvips-cpp.8.18.3.dylib`),
   * so a patch upgrade changes it; the resolver picks the installed file
   * instead of hardcoding the version (audit P2-24). */
  readonly match?: RegExp
}

/** Thin native files that must be present inside app.asar.unpacked. */
export const MACOS_ARM64_NATIVE_ENTRIES: readonly MacNativeEntry[] = [
  {
    arch: 'arm64',
    path: 'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node',
    match: /^sharp-darwin-arm64-.*\.node$/u,
  },
  {
    arch: 'arm64',
    path: 'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.*.dylib',
    match: /^libvips-cpp\..*\.dylib$/u,
  },
  {
    arch: 'arm64',
    path: 'node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
  },
  {
    arch: 'arm64',
    path: 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
  },
  {
    arch: 'arm64',
    path: 'node_modules/node-addon-require-builtin-darwin-arm64/prebuilt/darwin-arm64-napi-v9.node',
  },
  {
    arch: 'arm64',
    path: 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  },
  {
    arch: 'arm64',
    path: 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  },
]

/**
 * Resolve the concrete file for one entry. Version-free entries return their
 * literal path; entries with `match` scan the containing directory and pick the
 * installed file, so a sharp/libvips patch upgrade does not break packaging
 * (P2-24). When the directory is absent (Linux CI) the literal path is kept, so
 * the caller's existing missing-file diagnostics are unchanged.
 * @param root - unpacked runtime root.
 * @param entry - required native entry.
 * @param readdir - injectable directory listing (tests).
 */
export function resolveNativeEntry(
  root: string,
  entry: MacNativeEntry,
  readdir: (dir: string) => readonly string[] = dir => readdirSync(dir),
): string {
  const literal = join(root, entry.path)
  if (entry.match === undefined) return literal
  const dir = dirname(literal)
  try {
    const found = readdir(dir).find(name => entry.match?.test(name) === true)
    if (found !== undefined) return join(dir, found)
  } catch {
    // Directory absent (non-macOS host): keep the literal path.
  }
  return literal
}

/** Generated host-architecture files that must never shadow the prebuilt. */
export const FORBIDDEN_MACOS_NATIVE_ENTRIES = [
  'node_modules/node-pty/build/Release/pty.node',
  'node_modules/node-pty/build/Release/spawn-helper',
] as const

/** Injectable filesystem seam for source-runtime preparation. */
export interface MacArm64PreparationOptions {
  readonly desktopRoot: string
  readonly exists: (path: string) => boolean
  readonly chmod: (path: string, mode: number) => void
}

/**
 * Validate the arm64 runtime tree and restore the node-pty helper execute bit.
 * Yarn intentionally disables lifecycle scripts, so the package step owns this
 * deterministic permission repair.
 * @param options - Desktop root and injectable filesystem operations.
 */
export function prepareMacArm64Runtime(
  options: MacArm64PreparationOptions,
): void {
  const root = resolve(options.desktopRoot)
  const missing = MACOS_ARM64_NATIVE_ENTRIES
    .map(entry => resolveNativeEntry(root, entry))
    .filter(path => !options.exists(path))
  if (missing.length > 0) {
    throw new Error(
      `arm64 macOS runtime is missing ${String(missing.length)} native file(s): ${missing.join(', ')}`,
    )
  }

  for (const entry of MACOS_ARM64_NATIVE_ENTRIES) {
    if (entry.path.endsWith('/spawn-helper')) {
      options.chmod(resolveNativeEntry(root, entry), 0o755)
    }
  }
}

/** Prepare the installed workspace dependency tree for arm64 packaging. */
export function prepareInstalledMacArm64Runtime(desktopRoot: string): void {
  prepareMacArm64Runtime({ desktopRoot, exists: existsSync, chmod: chmodSync })
}
