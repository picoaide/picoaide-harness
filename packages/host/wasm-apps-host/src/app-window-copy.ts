/**
 * 应用窗口 chrome 的文案真源（接缝 **J12**，主控 2026-09-19 裁定）。
 *
 * 裁定口径：**不共享模块，各持一份，设计总纲为唯一真源** —— 客户端 UI（应用中心/分享/空态）
 * 的文案由 `packages/client/wasm-apps` 持有；**应用窗口**的 chrome 文案（外链提示条、
 * 下载反馈、骨架屏、冻结/下架/删除三档）由本包持有，用与宿主可读页同一套 zh/en 机制
 * （`hostCopy(locale, zh, en)`，**按调用解析**，禁止模块级冻结）。
 *
 * 逐字断言在 `src/app-window-copy.spec.ts`：这些串是 §7.2/§19 Q3/Q9 冻结文案的落地形态，
 * 任一侧（本包或客户端包）被改写都必须各红一次。
 *
 * @module @picoaide/dsh-wasm-apps-host/app-window-copy
 */

import { hostCopy, type HostLocale } from './locale.ts'

/** 外链提示条（§19 Q9：外链改走内置浏览器新标签 + 应用窗口提示条）。 */
export function externalLinkNotice(locale: HostLocale, host: string): string {
  return hostCopy(
    locale,
    `已在浏览器窗口中打开 ${host}`,
    `Opened ${host} in the browser window`,
  )
}

/** 下载反馈（§19 Q9：最小反馈"已开始下载，进度见浏览器窗口"）。 */
export function downloadStartedNotice(locale: HostLocale): string {
  return hostCopy(
    locale,
    '已开始下载，进度见浏览器窗口',
    'Download started — see the browser window for progress',
  )
}

/** 骨架屏（§19 Q12：先开窗骨架屏 → 校验回来再加载）。 */
export function loadingSkeletonTitle(locale: HostLocale, appLabel: string): string {
  return hostCopy(locale, `正在打开 ${appLabel}…`, `Opening ${appLabel}…`)
}

/** 冻结（§19 Q3：目录不列；直接打开给可辨文案「已被管理员停用」）。 */
export function frozenAppTitle(locale: HostLocale): string {
  return hostCopy(locale, '应用已被管理员停用', 'This app has been disabled by an administrator')
}

/** 冻结的解释与出路（不说"应用不存在" —— 那是另一个语义）。 */
export function frozenAppHint(locale: HostLocale): string {
  return hostCopy(
    locale,
    '如需继续使用，请联系应用负责人或管理员。',
    'Contact the app owner or an administrator if you need it re-enabled.',
  )
}

/** 已下架（§5.1：内层 410，`code` 复用 `NOT_FOUND`）。 */
export function retiredAppTitle(locale: HostLocale): string {
  return hostCopy(locale, '应用已下架', 'This app is no longer available')
}

/** 不存在（与"停用/下架"必须可区分）。 */
export function missingAppTitle(locale: HostLocale): string {
  return hostCopy(locale, '应用不存在', 'This app does not exist')
}

/**
 * 软闸门横幅（§5.1b：聚焦已开窗口时"无法确认最新版本"+ 重试，**不**把正常应用打成错误页）。
 */
export function versionUnverifiedBanner(locale: HostLocale): string {
  return hostCopy(
    locale,
    '无法确认最新版本，当前显示的内容可能不是最新的。',
    'The latest version could not be confirmed; what you see may be out of date.',
  )
}

/** 重试（软闸门横幅上的动作，§5.1b）。 */
export function retryAction(locale: HostLocale): string {
  return hostCopy(locale, '重试', 'Retry')
}

/** 会话过期页的动作（§7.6：保留当前路径，登录后回到该路径）。 */
export function signInAgainAction(locale: HostLocale): string {
  return hostCopy(locale, '重新登录', 'Sign in again')
}

/**
 * 一次性引导卡（§19 Q15：应用是什么 / 怎么让 AI 做一个 / 怎么分享）。
 *
 * 三条一起给：引导卡是一个整体，拆开渲染会让"少一条"变成静默缺陷。
 * @param locale - 宿主语言（按调用解析）。
 * @returns 三条文案（标题 + 说明）。
 */
export function onboardingCard(locale: HostLocale): Array<{ title: string, body: string }> {
  return [
    {
      title: hostCopy(locale, '什么是应用', 'What an app is'),
      body: hostCopy(
        locale,
        '应用是同事用 AI 做出来的小工具，在客户端里打开，数据留在公司服务器上。',
        'Apps are small tools your colleagues built with AI. They open inside the client and keep their data on your company server.',
      ),
    },
    {
      title: hostCopy(locale, '怎么让 AI 做一个', 'How to have one built'),
      body: hostCopy(
        locale,
        '在对话里描述你要解决的问题，AI 会帮你生成并提交应用。',
        'Describe the problem you want solved in a chat; the AI will build and submit the app for you.',
      ),
    },
    {
      title: hostCopy(locale, '怎么分享', 'How to share it'),
      body: hostCopy(
        locale,
        '在应用中心点「复制链接」，把链接发给同事即可。',
        'Use “Copy link” in the app center and send it to a colleague.',
      ),
    },
  ]
}

/**
 * 崩溃 / 加载失败页的三段文案（R16B-19）。
 *
 * 与 shell 窗口的失败页逐字对标（`desktop/src/tray-locale.ts` 的
 * `desktopCrashPageCopy`）：那条路径早已有"失败页 + 手动重试"，而应用窗口此前
 * **一个都没有** —— 渲染进程崩了就是永久空白窗口，用户与 AI 都看不到它坏了。
 */
export interface AppWindowFailureCopy {
  /** 大标题。 */
  heading: string
  /** 一句话说明（说清楚"可以重试"，不要只说"出错了"）。 */
  body: string
  /** 重试按钮的文字。 */
  retry: string
}

/**
 * 失败页文案（**按调用**求值：`data:text/html` 是独立文档，拿不到客户端字典，
 * 所以宿主每次渲染时按当时的语言解析）。
 * @param locale - 宿主语言。
 * @returns 三段文案。
 */
export function appWindowFailureCopy(locale: HostLocale): AppWindowFailureCopy {
  return {
    heading: hostCopy(locale, '应用已停止运行', 'The app stopped running'),
    body: hostCopy(
      locale,
      '这个应用窗口遇到了问题，可以重新加载。',
      'This app window ran into a problem. You can reload it.',
    ),
    retry: retryAction(locale),
  }
}
