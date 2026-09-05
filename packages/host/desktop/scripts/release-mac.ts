/** Build a signed and notarized macOS DMG from validated release credentials. */

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adaptMacReleaseEnvironment,
  assertMacReleaseReady,
  notarizationLabel,
  withoutMacReleaseSecrets,
} from './release-preflight.ts'
import { notarizeMacApp } from './notarize-mac.ts'
import { prepareInstalledMacUniversalRuntime } from './mac-universal.ts'

/** Injectable release boundary used by focused tests. */
export interface MacReleaseOptions {
  /** Environment containing the selected signing and notarization credentials. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the release. */
  readonly platform: NodeJS.Platform
  /** Desktop package root containing package.json. */
  readonly desktopRoot: string
  /** Dedicated signed-release output directory, isolated from historical artifacts. */
  readonly outputDir: string
  /** Product name shown by the packaged application (build.productName). */
  readonly productName: string
  /** Remove only the dedicated generated release output before packaging. */
  readonly resetOutput: () => void
  /** Read code-signing identities with a credential-free environment. */
  readonly listCodeSigningIdentities: (env: NodeJS.ProcessEnv) => string
  /** Execute one release command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Notarize and staple the signed application bundle. */
  readonly notarize: (appPath: string, env: NodeJS.ProcessEnv) => Promise<void>
  /** Report non-secret release progress. */
  readonly log: (message: string) => void
  /** Validate and prepare both architecture-specific runtime trees. */
  readonly prepareRuntime: () => void
}

function listCodeSigningIdentities(env: NodeJS.ProcessEnv): string {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    env,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`security find-identity exited with ${String(result.status)}`)
  }
  return result.stdout
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultReleaseOptions(): MacReleaseOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const outputDir = resolve(desktopRoot, 'dist', 'mac-release')
  // 审计 2026-08-25 C-05(verify-mac-release 同款做法):从 package.json 读
  // productName,避免品牌改名后硬编码失效。
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    readonly build?: { readonly productName?: unknown }
  }
  const productName = manifest.build?.productName
  if (typeof productName !== 'string' || productName.length === 0) {
    throw new Error('package.json build.productName must be a non-empty string')
  }
  return {
    env: process.env,
    platform: process.platform,
    desktopRoot,
    outputDir,
    productName,
    resetOutput: () => rmSync(outputDir, { recursive: true, force: true }),
    listCodeSigningIdentities,
    run,
    notarize: async (appPath, env) => {
      await notarizeMacApp({
        appPath,
        env,
        pollIntervalMs: 90_000,
        deadlineMs: 240 * 60_000,
        retries: 8,
        backoffMs: 10_000,
        run: (command, args, cwd) => {
          const result = spawnSync(command, args, { env, encoding: 'utf8', cwd })
          if (result.error !== undefined) throw result.error
          if (result.status !== 0) {
            const stderr = (result.stderr ?? result.stdout ?? '').toString().trim()
            throw new Error(
              `${command} exited with ${String(result.status)}${stderr.length > 0 ? `\n${stderr.slice(0, 2000)}` : ''}`,
            )
          }
          return String(result.stdout ?? '')
        },
        sleep: ms => new Promise(resolveTimer => setTimeout(resolveTimer, ms)),
        log: message => console.log(message),
      })
    },
    log: message => console.log(message),
    prepareRuntime: () => prepareInstalledMacUniversalRuntime(desktopRoot),
  }
}

/**
 * Build the macOS artifact while exposing release secrets only to Electron Builder.
 * @param options - Injectable process and command boundaries.
 */
export async function releaseMac(
  options: MacReleaseOptions = defaultReleaseOptions(),
): Promise<void> {
  const releaseEnvironment = adaptMacReleaseEnvironment(options.env)
  const buildEnvironment = withoutMacReleaseSecrets(releaseEnvironment)
  const result = assertMacReleaseReady({
    env: releaseEnvironment,
    platform: options.platform,
    listCodeSigningIdentities: () => options.listCodeSigningIdentities(buildEnvironment),
  })
  options.log(
    `macOS release preflight passed: identity ok; signing via ${result.signing}; notarization via ${notarizationLabel(result.notarization)}`,
  )

  // The workspace check includes the package build and repository-layout gate. Signing
  // material is withheld from every build, test, Loader smoke, and layout subprocess.
  options.run('yarn', ['run', 'check'], resolve(options.desktopRoot, '..', '..'), buildEnvironment)
  options.resetOutput()
  options.prepareRuntime()
  // Step 1: pack and sign the universal app bundle only (no DMG, no notarization).
  // The notarization is handled outside electron-builder (step 2) because its
  // inline `notarytool --wait` keeps one long-lived connection that GitHub-hosted
  // macOS runners drop mid-poll (NSURLError -1009/-1005), failing the whole build.
  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dir', '--universal',
    '--config.forceCodeSigning=true', '--config.mac.notarize=false',
    '--config.npmRebuild=false',
    `--config.directories.output=${options.outputDir}`,
  ], options.desktopRoot, releaseEnvironment)
  // Step 2: async submit + short-poll notarization with per-request retries,
  // then staple the ticket into the app bundle.
  const appPath = join(options.outputDir, 'mac-universal', `${options.productName}.app`)
  await options.notarize(appPath, releaseEnvironment)
  // Step 3: build the DMG from the already-notarized app (prepackaged keeps the
  // stapled app untouched; the DMG itself is signed with the same identity).
  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dmg', '--universal',
    '--prepackaged', appPath,
    '--config.forceCodeSigning=true', '--config.mac.notarize=false',
    '--config.npmRebuild=false',
    `--config.directories.output=${options.outputDir}`,
  ], options.desktopRoot, releaseEnvironment)
  options.run(
    process.execPath,
    ['scripts/verify-mac-release.ts', options.outputDir],
    options.desktopRoot,
    buildEnvironment,
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    // 打包前预构建依赖包(见 prebuild-workspace-deps.ts)
    const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
    prebuildWorkspaceDeps(dirname(dirname(resolve(invokedPath))))
    await releaseMac()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
