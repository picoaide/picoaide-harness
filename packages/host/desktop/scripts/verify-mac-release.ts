/** Verify the signed application sealed inside one macOS release DMG. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MACOS_ARM64_NATIVE_ENTRIES } from './mac-runtime.ts'

/** Injectable filesystem and command boundaries for release verification. */
export interface MacReleaseVerificationOptions {
  /** Directory containing exactly one release DMG. */
  readonly distDir: string
  /** Installed application name inside the mounted image. */
  readonly productName: string
  /** True (default) when the app is notarized and stapled — spctl/stapler
   * checks apply. Pre-release sign-only builds pass false so verification
   * checks codesign/deep/strict only (a signed-but-unnotarized app is
   * rejected by spctl and has no stapled ticket). */
  readonly notarized?: boolean
  /** Return regular DMG files in the distribution directory. */
  readonly listDmgs: (distDir: string) => readonly string[]
  /** Create a private empty mount point. */
  readonly makeMountPoint: () => string
  /** Execute one macOS verification command. */
  readonly run: (command: string, args: readonly string[]) => void
  /** Remove the detached empty mount point. */
  readonly removeMountPoint: (mountPoint: string) => void
}

function listDmgs(distDir: string): readonly string[] {
  return readdirSync(distDir)
    .filter(name => name.endsWith('.dmg'))
    .map(name => join(distDir, name))
    .filter(path => statSync(path).isFile())
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultOptions(): MacReleaseVerificationOptions {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  // 审计 2026-08-25 C-05:此前硬编码 'PicoAide Harness'——品牌改名即验证
  // 失效/误报。与 verify-mac-smoke.ts 对齐,从 package.json build.productName 读。
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    readonly build?: { readonly productName?: unknown }
  }
  const productName = manifest.build?.productName
  if (typeof productName !== 'string' || productName.length === 0) {
    throw new Error('package.json build.productName must be a non-empty string')
  }
  return {
    distDir: process.argv[2] === undefined
      ? join(packageRoot, 'dist', 'mac-release')
      : resolve(process.argv[2]),
    productName,
    notarized: !process.argv.includes('--unnotarized'),
    listDmgs,
    makeMountPoint: () => mkdtempSync(join(tmpdir(), 'dsh-desktop-dmg-')),
    run,
    removeMountPoint: mountPoint => rmdirSync(mountPoint),
  }
}

/**
 * Mount and verify the application contained in the unique release DMG.
 * @param options - Filesystem and command boundaries.
 * @returns The verified DMG and application paths.
 */
export function verifyMacRelease(
  options: MacReleaseVerificationOptions = defaultOptions(),
): { readonly appPath: string; readonly dmgPath: string } {
  const dmgs = options.listDmgs(options.distDir)
  if (dmgs.length !== 1) {
    throw new Error(
      `macOS release verification requires exactly one DMG in ${options.distDir}; found ${String(dmgs.length)}`,
    )
  }

  const dmgPath = dmgs[0]!
  const mountPoint = options.makeMountPoint()
  const appPath = join(mountPoint, `${options.productName}.app`)
  let mounted = false
  let failure: unknown

  try {
    options.run('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint, '-nobrowse', '-readonly'])
    mounted = true
    const executablePath = join(appPath, 'Contents', 'MacOS', options.productName)
    options.run('lipo', [executablePath, '-verify_arch', 'arm64'])
    const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar')
    const unpackedRoot = existsSync(asarPath)
      ? join(appPath, 'Contents', 'Resources', 'app.asar.unpacked')
      : join(appPath, 'Contents', 'Resources', 'app')
    for (const entry of MACOS_ARM64_NATIVE_ENTRIES) {
      options.run('lipo', [join(unpackedRoot, entry.path), '-verify_arch', entry.arch])
    }
    options.run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    // spctl/stapler 只对已公证+staple 的产物有意义;预发只签名不公证传
    // notarized: false 跳过(未公证 app 会被 spctl 拒绝,且无 stapled ticket)。
    if (options.notarized !== false) {
      options.run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
      options.run('xcrun', ['stapler', 'validate', appPath])
    }
  } catch (cause) {
    failure = cause
  }

  const cleanupFailures: unknown[] = []
  if (mounted) {
    try {
      options.run('hdiutil', ['detach', mountPoint])
    } catch (cause) {
      cleanupFailures.push(cause)
    }
  }
  try {
    options.removeMountPoint(mountPoint)
  } catch (cause) {
    cleanupFailures.push(cause)
  }

  if (failure !== undefined || cleanupFailures.length > 0) {
    const failures = failure === undefined ? cleanupFailures : [failure, ...cleanupFailures]
    throw new AggregateError(failures, `failed to verify macOS release DMG ${basename(dmgPath)}`)
  }
  return { appPath, dmgPath }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyMacRelease()
    console.log(`macOS release verification passed: ${verified.dmgPath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
