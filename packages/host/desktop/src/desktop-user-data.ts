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
 * official 逐字相同，两者就会共用一个目录。这里在**非官方渠道**一律补上渠道 id，
 * 让目录名**由构造保证唯一**。
 *
 * 目录名规则（`desktopUserDataDirectoryName`）：
 *   - 官方渠道 → 产品名（改造前就是这样，逐字节不变）；
 *   - 非官方渠道 → `<产品名> (<渠道 id>)`（beta 与所有品牌渠道）。
 *
 * 为什么是"一律带后缀"而不是"只在与官方重名时带"（2026-09-12 审计 P1-13）：
 * 后者只挡住了与 **official** 的碰撞，而两个**不同的**品牌渠道只要取同一个产品名
 * （`acme` / `acme-staging` 写同一个 `desktop.product_name`）仍会共用一个目录 ——
 * 单实例锁互顶（后启动的直接退出）+ 日志/更新状态/插件管理状态/已下载安装包共享。
 * 渠道 id 形状固定（小写字母/数字/连字符，无括号），所以末尾的 ` (<id>)` 唯一可
 * 解码，`(产品名, 渠道 id)` → 目录名 是单射。
 *
 * **升级影响（认账）**：品牌渠道（产品名 ≠ 官方名）的 userData 目录名会变一次
 * （如 `~/.config/Acme Harness` → `~/.config/Acme Harness (acme)`）。userData 里
 * 是日志、更新状态、插件管理状态、崩溃取证与单实例锁 —— **不是**会话/登录态
 * （那些在 Harness home，见 desktop-home.ts），所以"看不到历史会话"这类事故不会
 * 因此发生；但已下载的安装包与插件管理状态会在新目录里重新开始。官方与 beta
 * 的目录名逐字节不变（官方 = 产品名；beta 本来就是 `<产品名> (beta)`），
 * 公共渠道用户不受影响。已交付过的品牌渠道需要一次性搬运（口径见
 * docs/decisions/2026-09-11-channel-scoped-data-roots.md §7）。
 *
 * @module dsh-plugin-desktop/desktop-user-data
 */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { OFFICIAL_CHANNEL_ID } from './desktop-home.ts'
import { OFFICIAL_PRODUCT_NAME } from './desktop-channel.ts'

/**
 * userData 目录名（`appData` 下的那一段）。
 *
 * 形状由调用方保证（`desktop-channel.ts` 的 `product_name` 形状校验 + 渠道 id
 * 的 `CHANNEL_ID_PATTERN`）：产品名不含分隔符/控制字符/首尾点，渠道 id 不含括号，
 * 于是拼出来永远是 `appData` 下的**单段**目录名。
 * @param productName - 本次构建声明的产品名（渠道包里来的）。
 * @param channelId - 渠道 id；官方（缺省）即官方行为。
 * @returns 目录名。
 */
export function desktopUserDataDirectoryName(
  productName: string,
  channelId: string = OFFICIAL_CHANNEL_ID,
): string {
  if (channelId === OFFICIAL_CHANNEL_ID) return productName
  // **每个**非官方渠道都带后缀（含 beta）：唯一性必须由构造保证，而不是"靠渠道包
  // 作者不重名"——两个客户环境（acme / acme-staging）写同一个产品名就会共用一个
  // userData，且这种事在客户机器上才发现（单实例锁互顶 = 应用打不开）。
  return `${productName} (${channelId})`
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
