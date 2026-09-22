/** Build an unsigned unpacked application for the current host platform. */
// 打包前预构建 workspace 依赖包(lib/ 已从版本库移除,见 prebuild-workspace-deps.ts)。

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareChannelBuilderOverrides } from './channel-build.ts'
import { prepareChannelPackaging } from './channel-prepare.ts'
import { withStagedPackAppRoot } from './pack-app-root.mjs'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// 预构建依赖包(与 package-win/mac 一致),确保 app.asar 携带完整 lib。
const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
prebuildWorkspaceDeps(packageRoot)

// 渠道化准备（图标 + 随包 channel.json），见 channel-prepare.ts。
const channel = await prepareChannelPackaging()
const builderCli = require.resolve('electron-builder/cli.js')
const channelArgs = prepareChannelBuilderOverrides(channel)

// 打包输入必须走暂存白名单副本（见 pack-app-root.mjs 的说明）：electron-builder
// 26 不把 `build.files` 用在应用根目录内容上，直接打包会把 src/tests/scripts/
// temp/.e2e-* 与根级 *.map 一起收进 app.asar。
const staged = withStagedPackAppRoot(packageRoot, 'dist')
let result
try {
  result = spawnSync(process.execPath, [
    builderCli,
    '--dir',
    ...channelArgs,
    ...staged.args,
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
    stdio: 'inherit',
  })
} finally {
  staged.cleanup()
}

if (result.error !== undefined) throw result.error
if (result.status !== 0) {
  throw new Error(`electron-builder --dir exited with ${String(result.status)}`)
}
