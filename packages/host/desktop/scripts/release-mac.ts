/** Build a signed and notarized macOS DMG from validated release credentials. */

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareChannelBuilderOverrides, resolveChannelBuildContext } from './channel-build.ts'
import { prepareChannelPackaging } from './channel-prepare.ts'
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
  /** Product name shown by the packaged application（官方=package.json，渠道=渠道包）。 */
  readonly productName: string
  /**
   * 渠道化的 electron-builder `--config.*` 覆盖参数（见 channel-build.ts）。
   * 官方渠道为空数组 —— 不做覆盖，产物与改造前一致。
   */
  readonly channelConfigArgs: readonly string[]
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
  const fromManifest = manifest.build?.productName
  if (typeof fromManifest !== 'string' || fromManifest.length === 0) {
    throw new Error('package.json build.productName must be a non-empty string')
  }
  // 渠道构建用渠道包里的产品名（app 路径 `<productName>.app` 必须与打包结果一致）；
  // 官方渠道沿用 package.json —— 见 tests/channel-build.spec.ts 的漂移断言。
  const channel = resolveChannelBuildContext()
  const productName = channel.official ? fromManifest : channel.productName
  return {
    env: process.env,
    platform: process.platform,
    desktopRoot,
    outputDir,
    productName,
    channelConfigArgs: prepareChannelBuilderOverrides(channel),
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

/** Optional switches for CI reuse (gates/build already run by the CI gate job). */
export interface MacReleaseSwitches {
  /** Skip the root `yarn run check` gate inside packMacApp (CI runs it as the gate job). */
  readonly skipGates?: boolean
  /** Sign only, without notarization credentials (pre-release tag): the
   * preflight then reports notarization 'none' instead of failing. */
  readonly signOnly?: boolean
}

/**
 * Validate credentials and build the signed arm64 app bundle only
 * (no DMG, no notarization). Used both by the full release and by the
 * CI-split "pack" step so a later notarization step can reuse this output.
 * @param options - Injectable process and command boundaries.
 * @param switches - Optional CI reuse switches.
 * @returns absolute path of the signed application bundle.
 */
export async function packMacApp(
  options: MacReleaseOptions,
  switches: MacReleaseSwitches = {},
): Promise<string> {
  const releaseEnvironment = adaptMacReleaseEnvironment(options.env)
  const buildEnvironment = withoutMacReleaseSecrets(releaseEnvironment)
  const result = assertMacReleaseReady({
    env: releaseEnvironment,
    platform: options.platform,
    listCodeSigningIdentities: () => options.listCodeSigningIdentities(buildEnvironment),
    notarizationOptional: switches.signOnly === true,
  })
  options.log(
    `macOS release preflight passed: identity ok; signing via ${result.signing}; notarization via ${notarizationLabel(result.notarization)}`,
  )

  // The workspace check includes the package build and repository-layout gate. Signing
  // material is withheld from every build, test, Loader smoke, and layout subprocess.
  if (!switches.skipGates) {
    // 2026-09-08:仓库根在 desktopRoot 上溯 3 级(packages/host/desktop → 仓库根);
    // 此前只上溯 2 级到 packages/,靠 Yarn 向上找 workspace 根侥幸可用。
    options.run('yarn', ['run', 'check'], resolve(options.desktopRoot, '..', '..', '..'), buildEnvironment)
  }
  options.resetOutput()
  options.prepareRuntime()
  // Pack and sign the arm64 app bundle only (no DMG, no notarization).
  // The notarization runs outside electron-builder because its inline
  // `notarytool submit --wait` keeps one long-lived connection that
  // GitHub-hosted macOS runners drop mid-poll (NSURLError -1009/-1005),
  // failing the whole build. `--publish never` also disables the implicit
  // publish electron-builder triggers on git tags (v27 前行为,曾因缺
  // GH_TOKEN 打挂 tag 运行)——发布由 CI Release job 统一负责。注意必须是
  // 顶层 --publish 选项:`--config.publish=never` 会被当成发布插件名
  // "never" 加载失败(2026-09-05 rc.3 公证成功后死于 DMG 步骤的元凶)。
  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dir', '--arm64',
    '--publish', 'never',
    '--config.forceCodeSigning=true', '--config.mac.notarize=false',
    '--config.npmRebuild=false',
    ...options.channelConfigArgs,
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
 * Build the DMG from an already signed app bundle **without notarization**
 * (pre-release sign-only path), then run the release verification with the
 * notarized-specific checks disabled. The app bundle itself is untouched
 * (`--prepackaged`); no notarization state file is involved.
 * @param options - Injectable process and command boundaries.
 * @param appPath - absolute path produced by {@link packMacApp}.
 */
export async function buildMacDmgWithoutNotarization(
  options: MacReleaseOptions,
  appPath: string,
): Promise<void> {
  const releaseEnvironment = adaptMacReleaseEnvironment(options.env)
  const buildEnvironment = withoutMacReleaseSecrets(releaseEnvironment)
  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dmg', '--arm64',
    '--prepackaged', appPath,
    '--publish', 'never',
    '--config.forceCodeSigning=true', '--config.mac.notarize=false',
    '--config.npmRebuild=false',
    ...options.channelConfigArgs,
    `--config.directories.output=${options.outputDir}`,
  ], options.desktopRoot, releaseEnvironment)
  options.run(
    process.execPath,
    ['scripts/verify-mac-release.ts', options.outputDir, '--unnotarized'],
    options.desktopRoot,
    buildEnvironment,
  )
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
    '--publish', 'never',
    '--config.forceCodeSigning=true', '--config.mac.notarize=false',
    '--config.npmRebuild=false',
    ...options.channelConfigArgs,
    `--config.directories.output=${options.outputDir}`,
  ], options.desktopRoot, releaseEnvironment)
  options.run(
    process.execPath,
    ['scripts/verify-mac-release.ts', options.outputDir],
    options.desktopRoot,
    buildEnvironment,
  )
  // 整条发布链路(公证+staple+DMG+验证)成功后才清除状态文件:之前提前删除
  // 导致"公证已 Accepted 但 DMG 失败"时重试重新提交同一构建(2026-09-05 rc.3)。
  try {
    rmSync(stateFile, { force: true })
  } catch { /* 非致命:状态文件已缺失 */ }
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
    const noPrebuild = process.argv.includes('--no-prebuild')
    const noGates = process.argv.includes('--no-gates')
    if (!noPrebuild) {
      // 打包前预构建依赖包(见 prebuild-workspace-deps.ts)
      const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
      prebuildWorkspaceDeps(dirname(dirname(resolve(invokedPath))))
    }
    // 拆分模式:--pack 只打包+签名;--notarize 只公证+DMG+验证(可对同一产物
    // 重试,公证 submission id 经状态文件续等);--dmg 对已签名 app 直接出
    // 未公证 DMG(预发签名单路径)。无参数 = 完整发布。
    const phase = process.argv[2]
    const options = defaultReleaseOptions()
    const switches = { skipGates: noGates, signOnly: process.argv.includes('--sign-only') }
    // 打包分支才需要渠道化准备(图标素材 + 随包 channel.json):--notarize/--dmg
    // 面对的是**已经打好**的 app,重新派生素材只会白跑一遍 sharp(见
    // channel-prepare.ts)。CI 走 --no-prebuild,这一步不能被 prebuild 代替。
    if (phase === '--pack' || phase === undefined) {
      await prepareChannelPackaging()
    }
    if (phase === '--pack') {
      await packMacApp(options, switches)
    } else if (phase === '--notarize') {
      const appPath = join(options.outputDir, 'mac-arm64', `${options.productName}.app`)
      await notarizeAndPackageMacDmg(options, appPath)
    } else if (phase === '--dmg') {
      const appPath = join(options.outputDir, 'mac-arm64', `${options.productName}.app`)
      await buildMacDmgWithoutNotarization(options, appPath)
    } else if (phase === undefined) {
      await releaseMac(options)
    } else {
      throw new Error(
        `unknown release phase: ${phase} (expected --pack, --notarize, --dmg, or no argument)`,
      )
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
