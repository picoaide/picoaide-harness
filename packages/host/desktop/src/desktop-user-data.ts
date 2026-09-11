/**
 * Electron 用户数据目录（`userData`）的**唯一口径**。
 *
 * 这里放的是"随渠道"的第二份数据根（第一份是 Harness home，见
 * desktop-home.ts）：日志、更新状态（`updates/state.json`）、插件管理状态、
 * 崩溃取证，以及 **Electron 的单实例锁**（锁文件落在 userData 里，两个渠道
 * 共用同一个目录就会互相"顶掉"启动）。
 *
 * 为什么需要单独一层：Electron 的缺省 userData 只用 `app.getName()`，而渠道
 * 构建里 `app.setName()` 用的是**产品名**——beta 渠道复用官方品牌，产品名与
 * official 逐字相同，两者就会共用一个目录。这里在"产品名与官方重名"时补上
 * 渠道 id，让目录名**由构造保证唯一**。
 *
 * 目录名规则（`desktopUserDataDirectoryName`）：
 *   - 官方渠道 → 产品名（改造前就是这样，逐字节不变）；
 *   - 品牌渠道（自己有自己的名字）→ 产品名；
 *   - 复用官方品牌的渠道（如 beta）→ `<产品名> (<渠道 id>)`。
 *
 * @module dsh-plugin-desktop/desktop-user-data
 */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { OFFICIAL_CHANNEL_ID } from './desktop-home.ts'
import { OFFICIAL_PRODUCT_NAME } from './desktop-channel.ts'

/**
 * userData 目录名（`appData` 下的那一段）。
 * @param productName - 本次构建声明的产品名（渠道包里来的）。
 * @param channelId - 渠道 id；官方（缺省）即官方行为。
 * @returns 目录名。
 */
export function desktopUserDataDirectoryName(
  productName: string,
  channelId: string = OFFICIAL_CHANNEL_ID,
): string {
  if (channelId === OFFICIAL_CHANNEL_ID) return productName
  // 只有"和官方重名"这一种情况需要消歧：其余渠道的产品名就是它自己的品牌，
  // 拿它当目录名又干净又能自查（`~/.config/Moka Harness`）。
  return productName === OFFICIAL_PRODUCT_NAME ? `${productName} (${channelId})` : productName
}

/**
 * Resolve the Electron user-data location without importing Electron.
 *
 * `main.ts` 走 Electron 自己的 `app.getPath('appData')` 再拼同一个目录名；
 * 这个函数是给**没有 Electron 的进程**（npm 启动器 `--export-diagnostics`、
 * 恢复工具）用的等价实现，两者必须给出同一个路径。
 * @param platform - 目标平台（测试可覆盖）。
 * @param environment - 取 `APPDATA` / `XDG_CONFIG_HOME` 的环境。
 * @param homeDirectory - OS home（macOS/Linux 回退）。
 * @param dataDirName - 目录名（见 {@link desktopUserDataDirectoryName}）。
 * @returns 绝对路径。
 */
export function defaultDesktopUserDataDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
  dataDirName: string = OFFICIAL_PRODUCT_NAME,
): string {
  const path = platform === 'win32' ? win32 : posix
  if (platform === 'win32') {
    const appData = environment.APPDATA
    if (appData === undefined || appData.length === 0) {
      throw new Error(`APPDATA is unavailable; cannot locate the ${dataDirName} user data directory`)
    }
    return path.join(appData, dataDirName)
  }
  if (platform === 'darwin') return path.join(homeDirectory, 'Library', 'Application Support', dataDirName)
  const config = environment.XDG_CONFIG_HOME
  return path.join(config === undefined || config.length === 0 ? path.join(homeDirectory, '.config') : config, dataDirName)
}
