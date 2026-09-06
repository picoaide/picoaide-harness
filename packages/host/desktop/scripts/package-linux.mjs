/** Build unsigned Linux AppImage and deb artifacts on a native Linux host. */
// 打包前预构建 workspace 依赖包(lib/ 已从版本库移除,见 prebuild-workspace-deps.ts);
// CI 门禁 job 已构建并下发产物时传 --no-prebuild 跳过(与 package-win/mac 同构)。

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// 预构建依赖包(与 package-win/mac 一致),确保 AppImage/deb 携带完整 lib。
if (!process.argv.includes('--no-prebuild')) {
  const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
  prebuildWorkspaceDeps(packageRoot)
}

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
