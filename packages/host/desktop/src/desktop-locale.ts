/**
 * 上游 locale id → 桌面支持的语言（唯一实现，2026-09-16）。
 *
 * 为什么必须有这个模块：语言这件事在本产品里有**两个**入口，此前各自判定：
 *
 *  - **客户端界面**用上游 `@deepseek-ai/dsh-client-locale`：它的
 *    `LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/` 允许
 *    `zh-CN` 这种带地区的 id，`register()` 就按这个 id 注册，`document` 上写的
 *    也是 `zh-CN`；
 *  - **桌面原生面**（托盘菜单 / 通知 / 隐私确认框）走本模块的调用方：它读
 *    上游 settings 里的 `locale.preference`，此前只认**裸 `zh` / `en`**，
 *    于是用户显式选了 `zh-CN`（或上游默认写入 `zh-CN`）时判定为 `undefined`
 *    ⇒ 回落系统语言：中文界面 + 英文托盘的混搭，且**没有任何报错**。
 *
 * 口径：语言子标签前缀匹配（`zh` / `zh-CN` / `zh_CN` / `zh-Hans` / `ZH-hant`
 * → `zh`；`en` / `en-US` / `en_GB` → `en`）；不认识的 id 返回 `undefined`
 * （调用方据此回落系统语言或默认值，而不是硬塞一个错的语言）。
 *
 * 与 `desktopTrayLabel` 的语言标签解析（Electron `app.getLocale()` 的
 * `zh-CN` / `zh_CN`）共用同一份前缀规则，避免两处再次漂移。
 */

import type { DesktopLocale } from './runtime.ts'

/**
 * Map one locale id to a shipped desktop locale.
 * @param localeId - upstream locale id or a platform language tag.
 * @returns the desktop locale, or `undefined` when the id is not one we ship.
 */
export function localeIdToDesktopLocale(localeId: string): DesktopLocale | undefined {
  const value = typeof localeId === 'string' ? localeId.trim() : ''
  if (value === '') return undefined
  const primary = value.split(/[-_]/u)[0]?.toLowerCase() ?? ''
  if (primary === 'zh') return 'zh'
  if (primary === 'en') return 'en'
  return undefined
}

/**
 * Resolve the desktop locale from the upstream `locale.preference` setting.
 *
 * `preference` 取值有三种形态，语义各不相同：
 *  - `undefined`（用户从未设置）→ `undefined`：交给系统语言与上层默认值；
 *  - `'auto'`（显式选择"跟随系统"）→ `undefined`：同样交给系统语言；
 *  - 具体 id（`'zh'` / `'zh-CN'` / `'en-US'` …）→ 归一化后的桌面语言；
 *    上游允许地区子标签，**必须**按前缀识别，否则中文用户被静默判成"未设置"。
 * @param preference - raw `locale.preference` value.
 * @returns the desktop locale, or `undefined` when the preference defers to the system.
 */
export function desktopLocaleFromPreference(preference: string | undefined): DesktopLocale | undefined {
  if (preference === undefined) return undefined
  if (preference.trim().toLowerCase() === 'auto') return undefined
  return localeIdToDesktopLocale(preference)
}
