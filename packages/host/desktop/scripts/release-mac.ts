/** Build a signed and notarized macOS DMG from validated release credentials. */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adaptMacReleaseEnvironment,
  assertMacReleaseReady,
  notarizationLabel,
  withoutMacReleaseSecrets,
} from './release-preflight.ts'
import { prepareInstalledMacArm64Runtime } from './mac-runtime.ts'

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
  /** Report non-secret release progress. */
  readonly log: (message: string) => void
  /** Validate and prepare the arm64 native runtime tree. */
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
  return {
    env: process.env,
    platform: process.platform,
    desktopRoot,
    outputDir,
    resetOutput: () => rmSync(outputDir, { recursive: true, force: true }),
    listCodeSigningIdentities,
    run,
    log: message => console.log(message),
    prepareRuntime: () => prepareInstalledMacArm64Runtime(desktopRoot),
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
  // One standard electron-builder invocation: pack + sign + notarize (its inline
  // @electron/notarize zips the app, runs `notarytool submit --wait`, staples the
  // ticket) + DMG. The long-lived --wait connection was flaky on macos-latest
  // (arm64) runners; the release job pins macos-15 (Intel, community-verified
  // stable per electron/notarize#219) and the workflow retries the whole step.
  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dmg', '--arm64',
    '--config.forceCodeSigning=true', '--config.mac.notarize=true',
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
