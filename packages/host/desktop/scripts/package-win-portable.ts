/** Build an unsigned Windows x64 portable ZIP archive on a native Windows host. */

import { fileURLToPath } from 'node:url'
import {
  createWindowsPackageOptions,
  packageWindowsArtifact,
} from './package-win.ts'
import { prepareChannelPackaging } from './channel-prepare.ts'

const invokedPath = process.argv[1]
if (invokedPath !== undefined && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    // 渠道化准备(图标素材 + 随包 channel.json),必须在打包之前。
    await prepareChannelPackaging()
    packageWindowsArtifact(
      createWindowsPackageOptions('./verify-win-portable.ts'),
      'zip',
      'portable archive',
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
