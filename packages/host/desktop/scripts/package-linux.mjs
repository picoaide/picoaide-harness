/** Build unsigned Linux AppImage and deb artifacts on a native Linux host. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
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
