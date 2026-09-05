/** Shared preparation and verification inventory for arm64 macOS packages. */

import { chmodSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type MacArch = 'arm64'

/** Thin native files that must be present inside app.asar.unpacked. */
export const MACOS_ARM64_NATIVE_ENTRIES = [
  {
    arch: 'arm64',
    path: 'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node',
  },
  {
    arch: 'arm64',
    path: 'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib',
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
] as const satisfies readonly { readonly arch: MacArch; readonly path: string }[]

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
    .map(entry => join(root, entry.path))
    .filter(path => !options.exists(path))
  if (missing.length > 0) {
    throw new Error(
      `arm64 macOS runtime is missing ${String(missing.length)} native file(s): ${missing.join(', ')}`,
    )
  }

  for (const entry of MACOS_ARM64_NATIVE_ENTRIES) {
    if (entry.path.endsWith('/spawn-helper')) {
      options.chmod(join(root, entry.path), 0o755)
    }
  }
}

/** Prepare the installed workspace dependency tree for arm64 packaging. */
export function prepareInstalledMacArm64Runtime(desktopRoot: string): void {
  prepareMacArm64Runtime({ desktopRoot, exists: existsSync, chmod: chmodSync })
}
