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
  /** Network-resilient notarization and stapling of the signed app bundle.
   * @param appPath - signed application bundle.
   * @param env - release environment carrying the notarization credentials.
   * @param resumeFilePath - optional file persisting the in-flight submission id
   * so a retried run resumes the same Apple submission.
   */
  readonly notarize: (appPath: string, env: NodeJS.ProcessEnv, resumeFilePath?: string) => Promise<void>
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
    notarize: async (appPath, env, resumeFilePath) => {
      await notarizeMacApp({
        appPath,
        env,
        waitTimeoutMs: 15 * 60_000,
        pollIntervalMs: 15_000,
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
        ...(resumeFilePath === undefined ? {} : { resumeFilePath }),
      })
    },
    log: message => console.log(message),
    prepareRuntime: () => prepareInstalledMacArm64Runtime(desktopRoot),
  }
}

const SUBMISSION_STATE_FILENAME = '.notary-submission.json'

/**
 * Validate credentials and build the signed arm64 app bundle only
 * (no DMG, no notarization). Used both by the full release and by the
 * CI-split "pack" step so a later notarization step can reuse this output.
 * @param options - Injectable process and command boundaries.
 * @returns absolute path of the signed application bundle.
 */
export async function packMacApp(options: MacReleaseOptions): Promise<string> {
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
  // Pack and sign the arm64 app bundle only (no DMG, no notarization).
  // The notarization runs outside electron-builder because its inline
  // `notarytool submit --wait` keeps one long-lived connection that
  // GitHub-hosted macOS runners drop mid-poll (NSURLError -1009/-1005),
  // failing the whole build. `--config.publish=never` also disables the
  // implicit publish electron-builder triggers on git tags (v27 前行为,
  // 曾因缺 GH_TOKEN 打挂 tag 运行)——发布由 CI Release job 统一负责。
  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dir', '--arm64',
    '--config.publish=never',
    '--config.forceCodeSigning=true', '--config.mac.notarize=false',
    '--config.npmRebuild=false',
    `--config.directories.output=${options.outputDir}`,
  ], options.desktopRoot, releaseEnvironment)
  // A fresh build invalidates any previous submission: the notarization state
  // file (if present) belongs to an older app bundle and must not be resumed.
  try {
    rmSync(join(options.outputDir, SUBMISSION_STATE_FILENAME), { force: true })
  } catch { /* non-fatal: no state file yet */ }
  return join(options.outputDir, 'mac-arm64', `${options.productName}.app`)
}

/**
 * Notarize a previously packed app (resuming its persisted submission when
 * present), build the DMG from the stapled bundle, and run the release
 * verification. The CI-split "notarize" step can be retried alone: transient
 * network failures only cost the bounded wait calls, never the gate/build.
 * @param options - Injectable process and command boundaries.
 * @param appPath - absolute path produced by {@link packMacApp}.
 */
export async function notarizeAndPackageMacDmg(
  options: MacReleaseOptions,
  appPath: string,
): Promise<void> {
  const releaseEnvironment = adaptMacReleaseEnvironment(options.env)
  const buildEnvironment = withoutMacReleaseSecrets(releaseEnvironment)
  const stateFile = join(options.outputDir, SUBMISSION_STATE_FILENAME)
  await options.notarize(appPath, releaseEnvironment, stateFile)
  // Build the DMG from the already-notarized app (prepackaged keeps the
  // stapled app untouched; the DMG itself is signed with the same identity).
  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dmg', '--arm64',
    '--prepackaged', appPath,
    '--config.publish=never',
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

/**
 * Build a signed and notarized macOS DMG from validated release credentials.
 * @param options - Injectable process and command boundaries.
 */
export async function releaseMac(
  options: MacReleaseOptions = defaultReleaseOptions(),
): Promise<void> {
  const appPath = await packMacApp(options)
  await notarizeAndPackageMacDmg(options, appPath)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    // 打包前预构建依赖包(见 prebuild-workspace-deps.ts)
    const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
    prebuildWorkspaceDeps(dirname(dirname(resolve(invokedPath))))
    // 拆分模式:--pack 只打包+签名;--notarize 只公证+DMG+验证(可对同一产物
    // 重试,公证 submission id 经状态文件续等)。无参数 = 完整发布。
    const phase = process.argv[2]
    const options = defaultReleaseOptions()
    if (phase === '--pack') {
      await packMacApp(options)
    } else if (phase === '--notarize') {
      const appPath = join(options.outputDir, 'mac-arm64', `${options.productName}.app`)
      await notarizeAndPackageMacDmg(options, appPath)
    } else if (phase === undefined) {
      await releaseMac(options)
    } else {
      throw new Error(`unknown release phase: ${phase} (expected --pack, --notarize, or no argument)`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
