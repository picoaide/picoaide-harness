/**
 * 本插件自己渲染的宿主页面（可读中文/英文错误页）。
 *
 * 两条约束：
 *  1. **按调用渲染**（`(locale) => string`），禁止模块级冻结：语言可以在应用
 *     运行中改变，而这些页面是"请求时才知道要什么语言"的那一类（本仓已记录
 *     两次同根因 bug，见 `packages/host/connectors/src/client/status-label.ts`）。
 *  2. 一切插值都要转义（`hint`/`message` 可能来自服务端信封或畸形 URL）。
 *
 * 页面**不需要脚本**：即使渲染器给自定义协议响应套上 `default-src 'none'`，
 * 文字也照常可读（样式会退化，可读性不退化）。
 *
 * @module @picoaide/dsh-wasm-apps-host/pages
 */

import { hostCopy, type HostLocale } from './locale.ts'

/** 转义进 HTML 文本/属性（唯一实现）。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/** 一个页面要展示的结构化内容。 */
export interface HostPageContent {
  /** 大标题。 */
  title: string
  /** 一句话说明。 */
  message: string
  /** 可照做的建议（逐条）。 */
  hints?: readonly string[]
  /** 诊断细节（状态码/错误码/原因），以小字展示。 */
  detail?: string
}

/** 页面外壳（纯函数，便于单测直接断言文案）。 */
function page(locale: HostLocale, content: HostPageContent): string {
  const hintItems = (content.hints ?? [])
    .map(hint => `<li>${escapeHtml(hint)}</li>`)
    .join('')
  const hints = hintItems === '' ? '' : `<ul>${hintItems}</ul>`
  const detail = content.detail === undefined || content.detail === ''
    ? ''
    : `<p class="detail">${escapeHtml(content.detail)}</p>`
  return `<!doctype html>
<html lang="${locale === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(content.title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 40px 24px; font: 15px/1.7 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; display: flex; justify-content: center; }
main { max-width: 560px; }
h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
p { margin: 0 0 12px; }
ul { margin: 0 0 12px; padding-left: 20px; }
li { margin: 4px 0; }
.detail { margin-top: 20px; font-size: 12px; opacity: .6; word-break: break-all; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(content.title)}</h1>
<p>${escapeHtml(content.message)}</p>
${hints}
${detail}
</main>
</body>
</html>
`
}

/**
 * 未登录 / 无会话页（契约 §2：一律要求登录，没有匿名面）。
 * @param locale - 宿主语言。
 * @returns 完整的 HTML 文档。
 */
export function signInRequiredPage(locale: HostLocale): string {
  return page(locale, {
    title: hostCopy(locale, '请先登录', 'Sign in required'),
    message: hostCopy(
      locale,
      '请在客户端登录后再打开应用。',
      'Please sign in to the client before opening apps.',
    ),
    hints: hostCopy(
      locale,
      ['应用只在客户端内可用，浏览器无法直接访问。', '登录后重新打开这个应用即可。'],
      ['Apps only run inside the client; a browser cannot open them directly.', 'Sign in, then open the app again.'],
    ),
  })
}

/**
 * 会话过期页（平台返回 401：本机会话已被清掉）。
 * @param locale - 宿主语言。
 * @returns 完整的 HTML 文档。
 */
export function sessionExpiredPage(locale: HostLocale): string {
  return page(locale, {
    title: hostCopy(locale, '登录已过期', 'Session expired'),
    message: hostCopy(locale, '请重新登录后再打开应用。', 'Please sign in again before opening apps.'),
  })
}

/**
 * 畸形地址 / 体积超限等**本地**拒绝的页面。
 * @param locale - 宿主语言。
 * @param detail - 诊断细节（状态或原因）。
 * @returns 完整的 HTML 文档。
 */
export function invalidRequestPage(locale: HostLocale, detail: string): string {
  return page(locale, {
    title: hostCopy(locale, '无法打开这个应用', 'This app cannot be opened'),
    message: hostCopy(locale, '应用地址不合法或请求超出了允许的大小。', 'The app address is invalid or the request exceeded the allowed size.'),
    detail,
  })
}

/**
 * 平台/网络错误页（未知 app_id、无权限、服务端不可达都落在这里）。
 *
 * `message`/`hints` 直接来自平台信封（§8：`details`/`hints` 原样送达第一消费者），
 * 本函数只负责转义与排版。
 * @param locale - 宿主语言。
 * @param content - 标题/说明/建议/细节。
 * @returns 完整的 HTML 文档。
 */
export function appErrorPage(locale: HostLocale, content: HostPageContent): string {
  return page(locale, content)
}

/**
 * 平台错误信封里能读出来的部分（尽量把服务端的原话带给用户）。
 * @param value - `JSON.parse` 之后的响应体。
 * @returns 结构化错误，或 null。
 */
export function readPlatformError(value: unknown): { code: string, message: string, hints?: string[], reason?: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = (value as { error?: unknown }).error
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null
  const hints = Array.isArray(record.hints)
    ? record.hints.filter((hint): hint is string => typeof hint === 'string')
    : []
  return {
    code: record.code,
    message: record.message,
    ...(hints.length === 0 ? {} : { hints }),
    // §19 Q3/R2I-20：冻结的机器可读原因（`reason=app_frozen`）—— 客户端按它选**可辨**的
    // 三档文案，而不是把"被管理员停用"渲染成"应用不存在"。
    ...(typeof record.reason === 'string' && record.reason !== '' ? { reason: record.reason } : {}),
  }
}
