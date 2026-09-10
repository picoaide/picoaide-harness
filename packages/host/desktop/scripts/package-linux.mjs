/** Build unsigned Linux AppImage and deb artifacts on a native Linux host. */
// 打包前预构建 workspace 依赖包(lib/ 已从版本库移除,见 prebuild-workspace-deps.ts);
// CI 门禁 job 已构建并下发产物时传 --no-prebuild 跳过(与 package-win/mac 同构)。
//
// 渠道化:DSH_BUILD_CHANNEL=<id> 时用该渠道的产品名/appId/安装包名(见
// scripts/channel-build.ts);未设 = 官方,不做任何覆盖,产物与改造前一致。

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareChannelBuilderOverrides } from './channel-build.ts'
import { prepareChannelPackaging } from './channel-prepare.ts'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

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

const builderCli = require.resolve('electron-builder/cli.js')
const result = spawnSync(process.execPath, [
  builderCli,
  '--linux',
  'AppImage',
  'deb',
  '--x64',
  '--publish',
  'never',
  '--config.npmRebuild=false',
  ...prepareChannelBuilderOverrides(channel),
], {
  cwd: packageRoot,
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  },
  stdio: 'inherit',
})

if (result.error !== undefined) throw result.error
if (result.status !== 0) {
  throw new Error(`electron-builder --linux AppImage deb exited with ${String(result.status)}`)
}
