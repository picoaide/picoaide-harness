/** Build an unsigned unpacked application for the current host platform. */
// 打包前预构建 workspace 依赖包(lib/ 已从版本库移除,见 prebuild-workspace-deps.ts)。

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareChannelBuilderOverrides, resolveChannelBuildContext } from './channel-build.ts'
import { prepareChannelPackaging } from './channel-prepare.ts'
import { withStagedPackAppRoot } from './pack-app-root.mjs'

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
 * 默认选项（生产路径）。渠道上下文在这里**同步**解析（与 `channel-build.ts` 的
 * `resolveChannelBuildContext()` 同源）；`prepareChannelPackaging()`（异步、会派生
 * 图标与随包 `channel.json`）留在直接执行分支里，必须在打包之前跑完。
 * @returns 打包一条 unpacked 产物所需的全部注入缝。
 */
function defaultOptions() {
  const require = createRequire(import.meta.url)
  return {
    desktopRoot: packageRoot,
    builderCli: require.resolve('electron-builder/cli.js'),
    channelConfigArgs: prepareChannelBuilderOverrides(resolveChannelBuildContext()),
    run,
  }
}

/**
 * 打一条 unpacked 产物：应用根走暂存白名单副本（见 `pack-app-root.mjs`），
 * 打完立刻清掉暂存目录。
 *
 * 为什么可注入：这条路径的**生产默认值**正是判据的对象（"接线有没有真的接上"），
 * 而真实实现要求真实的包根（会复制 lib/build/node_modules）。测试因此注入一个
 * **真实存在**的假包根 + 记录 argv 的 `run`，并且**不注入** `stagePackAppRoot`
 * —— 走的就是生产默认的暂存实现（`tests/pack-app-root.spec.ts` 的能力级接线判据）。
 * @param options - 注入缝；缺省 = 生产路径。
 */
export function packageDir(options = defaultOptions()) {
  const staged = (options.stagePackAppRoot ?? withStagedPackAppRoot)(options.desktopRoot, 'dist')
  try {
    options.run(process.execPath, [
      options.builderCli,
      '--dir',
      ...options.channelConfigArgs,
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

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
  prebuildWorkspaceDeps(packageRoot)
  // 渠道化准备（图标 + 随包 channel.json），见 channel-prepare.ts。
  await prepareChannelPackaging()
  packageDir()
}
