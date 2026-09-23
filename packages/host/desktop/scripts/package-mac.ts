/** Build an unsigned macOS DMG smoke artifact on a native macOS host. */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareChannelBuilderOverrides, resolveChannelBuildContext } from './channel-build.ts'
import { withStagedPackAppRoot } from './pack-app-root.mjs'
import { prepareChannelPackaging } from './channel-prepare.ts'
import { withoutMacReleaseSecrets } from './release-preflight.ts'
import { prepareInstalledMacArm64Runtime } from './mac-runtime.ts'
import { isDirectInvocation } from './direct-invocation.mjs'

/** Injectable native macOS packaging boundary used by focused tests. */
export interface MacSmokePackageOptions {
  /** Environment inherited by the packaging command. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the package build. */
  readonly platform: NodeJS.Platform
  /** Node architecture executing the package build. */
  readonly arch: string
  /** Node version executing the package build. */
  readonly nodeVersion: string
  /** Repository root containing the Yarn workspace. */
  readonly workspaceRoot: string
  /** Desktop package root containing electron-builder configuration. */
  readonly desktopRoot: string
  /** Dedicated smoke output directory, isolated from signed release artifacts. */
  readonly outputDir: string
  /** Remove only the dedicated generated smoke output before packaging. */
  readonly resetOutput: () => void
  /** Validate and prepare both architecture-specific runtime trees. */
  readonly prepareRuntime: () => void
  /** Absolute electron-builder CLI module. */
  readonly builderCli: string
  /** Absolute packaged-DMG verification script. */
  readonly verifier: string
  /** Node executable used to run package-local scripts. */
  readonly nodeExecutable: string
  /**
   * 渠道化的 electron-builder `--config.*` 覆盖参数（见 channel-build.ts）。
   * 官方渠道为空数组 —— 不做覆盖，产物与改造前一致。
   *
   * **是函数而不是数组**：生成配置文件这件事必须发生在**应用根暂存之后**，而参数
   * 对象的构造发生在暂存之前（缺省参数在函数进入时就求值）。2026-09-23 复审 N-1
   * 的机制正是"暂存之前把渠道配置写进 `build/`，暂存整目录复制把它带进 asar"。
   */
  readonly channelConfigArgs: () => readonly string[]
  /**
   * 打包输入暂存（见 pack-app-root.mjs）：把应用根复制成**只含运行期条目**的副本，
   * 让 electron-builder 以它为 `directories.app`。
   *
   * 测试注入替身：真实实现要求在真实的包根上执行（会复制 lib/build/node_modules），
   * 而这些用例用假路径（`/repo/...`、`C:\repo\...`）驱动命令边界，因此必须可注入。
   * 生产调用一律用缺省值（真实现），afterPack 门禁兜住真实产物。
   */
  readonly stagePackAppRoot?: typeof withStagedPackAppRoot
  /** Execute one packaging command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret packaging progress. */
  readonly log: (message: string) => void
}

/** Optional switches for CI reuse (gates/build already run by the CI gate job). */
export interface MacSmokeSwitches {
  /** Skip the in-package root `check` gate (CI runs it as the gate job). */
  readonly skipGates?: boolean
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultOptions(): MacSmokePackageOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..', '..')
  const require = createRequire(import.meta.url)
  const outputDir = resolve(desktopRoot, 'dist', 'mac-smoke')
  // 渠道在解析选项时定下来：验证脚本也要用它推导 DMG 名。
  const channel = resolveChannelBuildContext()
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    workspaceRoot,
    desktopRoot,
    outputDir,
    resetOutput: () => rmSync(outputDir, { recursive: true, force: true }),
    prepareRuntime: () => prepareInstalledMacArm64Runtime(desktopRoot),
    builderCli: require.resolve('electron-builder/cli.js'),
    verifier: fileURLToPath(new URL('./verify-mac-smoke.ts', import.meta.url)),
    nodeExecutable: process.execPath,
    // 惰性求值：配置在**应用根暂存之后**才生成（见 channelConfigArgs 的说明）。
    channelConfigArgs: () => prepareChannelBuilderOverrides(channel),
    run,
    log: message => console.log(message),
  }
}

/**
 * Run the headless release gates and package one unsigned macOS DMG smoke.
 *
 * The signed and notarized release stays a manual step on a credentialed
 * machine; this smoke exists so macOS packaging regressions fail in CI before
 * a manual release. The target builds the arm64-only artifact for Apple
 * Silicon Macs.
 * @param options - Injectable process and command boundaries.
 */
export function packageMacSmoke(
  options: MacSmokePackageOptions = defaultOptions(),
  switches: MacSmokeSwitches = {},
): void {
  if (options.platform !== 'darwin') {
    throw new Error('macOS DMG smoke must be built on a native macOS host')
  }
  if (options.arch !== 'x64' && options.arch !== 'arm64') {
    throw new Error(`macOS DMG smoke requires x64 or arm64 Node; received ${options.arch}`)
  }
  const versionMatch = /^(\d+)\.(\d+)\./u.exec(options.nodeVersion)
  const major = Number(versionMatch?.[1])
  const minor = Number(versionMatch?.[2])
  if (!((major === 22 && minor >= 19) || major === 24)) {
    throw new Error(
      `macOS DMG smoke requires Node 22.19+ or Node 24.x with bundled Corepack; received ${options.nodeVersion}`,
    )
  }

  const cleanEnvironment = withoutMacReleaseSecrets(options.env)
  options.log('Building an unsigned macOS DMG smoke; signing and notarization are release-only steps.')
  if (!switches.skipGates) {
    options.run(
      'corepack',
      ['yarn', 'workspace', 'dsh-plugin-desktop', 'check:mac-package'],
      options.workspaceRoot,
      cleanEnvironment,
    )
  }
  options.resetOutput()
  options.prepareRuntime()
  // 打包输入走暂存白名单副本（见 pack-app-root.mjs）：electron-builder 26 不把
  // `build.files` 用在应用根目录内容上，直接打包会把 src/tests/scripts/temp/
  // .e2e-* 与根级 sourcemap 一起收进 app.asar。
  const staged = (options.stagePackAppRoot ?? withStagedPackAppRoot)(options.desktopRoot, 'dist')
  try {
  options.run(
    options.nodeExecutable,
    [
      options.builderCli,
      '--mac',
      'dmg',
      '--arm64',
      '--publish',
      'never',
      '--config.mac.notarize=false',
      '--config.npmRebuild=false',
      `--config.directories.output=${options.outputDir}`,
      // 惰性求值：到这里应用根已经暂存完（见 channelConfigArgs 的说明）。
      ...options.channelConfigArgs(),
      ...staged.args,
    ],
    options.desktopRoot,
    {
      ...cleanEnvironment,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  )
  } finally {
    // 暂存目录必须就地清掉：留在 dist/ 里会被下一次打包当输入收编。
    staged.cleanup()
  }
  options.run(
    options.nodeExecutable,
    [options.verifier, options.outputDir],
    options.desktopRoot,
    cleanEnvironment,
  )
}

if (isDirectInvocation(import.meta)) {
  try {
    if (!process.argv.includes('--no-prebuild')) {
      // 打包前预构建依赖包(见 prebuild-workspace-deps.ts)
      const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
      prebuildWorkspaceDeps(dirname(dirname(fileURLToPath(import.meta.url))))
    }
    // 渠道化准备(按渠道派生图标素材 + 就位随包 channel.json),必须在打包之前。
    await prepareChannelPackaging()
    packageMacSmoke(undefined, { skipGates: process.argv.includes('--no-gates') })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
