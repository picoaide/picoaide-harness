/** Build unsigned Linux AppImage and deb artifacts on a native Linux host. */
// 打包前预构建 workspace 依赖包(lib/ 已从版本库移除,见 prebuild-workspace-deps.ts);
// CI 门禁 job 已构建并下发产物时传 --no-prebuild 跳过(与 package-win/mac 同构)。
//
// 渠道化:DSH_BUILD_CHANNEL=<id> 时用该渠道的产品名/appId/安装包名(见
// scripts/channel-build.ts);未设 = 官方,不做任何覆盖,产物与改造前一致。

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareChannelBuilderOverrides, resolveChannelBuildContext } from './channel-build.ts'
import { prepareChannelPackaging } from './channel-prepare.ts'
import { withStagedPackAppRoot } from './pack-app-root.mjs'
import { isDirectInvocation } from './direct-invocation.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** 执行一条打包命令（生产实现；测试注入替身以只观察 argv）。 */
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/**
 * 默认选项（生产路径）。渠道上下文在这里**同步**解析；真正会派生图标与随包
 * `channel.json` 的 `prepareChannelPackaging()` 留在直接执行分支里（必须在打包之前
 * 跑完，否则渠道包会带官方图标出厂）。
 *
 * `channelConfigArgs` 是**函数**而不是数组：生成的 electron-builder 配置必须在应用根
 * **暂存之后**才写（缺省参数在函数进入时就求值，写成数组就等于"暂存之前生成"，
 * 那正是 2026-09-23 复审 N-1 的机制）。渠道 id 非法仍在这里 fail-loud（早于暂存）。
 * @returns 打包 AppImage/deb 所需的全部注入缝。
 */
function defaultOptions() {
  const require = createRequire(import.meta.url)
  const channel = resolveChannelBuildContext()
  return {
    desktopRoot: packageRoot,
    builderCli: require.resolve('electron-builder/cli.js'),
    channelConfigArgs: () => prepareChannelBuilderOverrides(channel),
    channelId: channel.channelId,
    run,
    log: message => console.log(message),
  }
}

/**
 * 打 AppImage + deb：应用根走暂存白名单副本（见 `pack-app-root.mjs`），打完立刻
 * 清掉暂存目录。
 *
 * 为什么可注入：这条路径的**生产默认值**正是判据的对象（"接线有没有真的接上"），
 * 而真实实现要求真实的包根。测试注入一个**真实存在**的假包根 + 记录 argv 的 `run`，
 * 并且**不注入** `stagePackAppRoot` —— 走的就是生产默认的暂存实现
 * （`tests/pack-app-root.spec.ts` 的能力级接线判据）。
 * @param options - 注入缝；缺省 = 生产路径。
 */
export function packageLinux(options = defaultOptions()) {
  // 打包输入走暂存白名单副本（见 pack-app-root.mjs）：否则 src/tests/scripts/temp
  // 与根级 sourcemap 会随包出厂。
  const staged = (options.stagePackAppRoot ?? withStagedPackAppRoot)(options.desktopRoot, 'dist')
  try {
    options.run(process.execPath, [
      options.builderCli,
      '--linux',
      'AppImage',
      'deb',
      '--x64',
      '--publish',
      'never',
      '--config.npmRebuild=false',
      // 惰性求值：到这里应用根已经暂存完（见 defaultOptions 的说明）。
      ...options.channelConfigArgs(),
      ...staged.args,
    ], options.desktopRoot, {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    })
  } finally {
    // 暂存目录必须就地清掉：留在 dist/ 里会被下一次打包当输入收编。
    staged.cleanup()
  }
}

if (isDirectInvocation(import.meta)) {
  // 预构建依赖包(与 package-win/mac 一致),确保 AppImage/deb 携带完整 lib。
  if (!process.argv.includes('--no-prebuild')) {
    const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
    prebuildWorkspaceDeps(packageRoot)
  }
  // 渠道化准备（按渠道派生图标素材 + 就位随包 channel.json）：**必须在
  // electron-builder 之前**。CI 打包一律 `--no-prebuild`（构建产物来自 gate job），
  // brand-prepare 不会经 prebuild 被触发 —— 少了这一步，渠道包会带官方图标出厂。
  const channel = await prepareChannelPackaging()
  console.log(`package-linux: 渠道 ${channel.channelId}`)
  packageLinux()
}
