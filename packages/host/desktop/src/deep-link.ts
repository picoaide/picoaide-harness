/**
 * Strict deep-link parsing (P2-62).
 *
 * The shell used to forward any argv/open-url string that merely STARTED with
 * the scheme — `<scheme>://anything?...` reached every Host consumer of the
 * `pico/deep-link` event (the enterprise auth callback included). Parsing is
 * now strict: the URL must parse, use the **expected scheme**, and name an
 * allow-listed action. Unknown or malformed links are dropped with a log line.
 *
 * scheme 由渠道包决定(见 desktop-channel.ts):渠道构建用它自己的 scheme,
 * 浏览器跳回客户端时的确认框因此不出现厂商名。
 * @module dsh-plugin-desktop/deep-link
 */

import { DEFAULT_DEEP_LINK_SCHEME } from './desktop-channel.ts'

/** Deep-link actions the desktop shell accepts. */
export const DESKTOP_DEEP_LINK_ACTIONS = ['auth'] as const

/** One allow-listed deep-link action. */
export type DesktopDeepLinkAction = (typeof DESKTOP_DEEP_LINK_ACTIONS)[number]

/** A validated deep link. */
export interface DesktopDeepLink {
  /** Allow-listed action (URL host or first path segment). */
  readonly action: DesktopDeepLinkAction
  /** Canonical URL handed to Host consumers. */
  readonly url: string
}

/** Upper bound on an accepted deep link (a link is a callback, not a payload). */
const MAX_DEEP_LINK_LENGTH = 4_096

/**
 * Parse and validate one deep link.
 * @param raw - candidate string from argv / `open-url`.
 * @param scheme - 本安装期望的 scheme（渠道包决定；缺省官方）。
 * @returns the validated link, or null when it is malformed or not allow-listed.
 */
export function parseDesktopDeepLink(
  raw: unknown,
  scheme: string = DEFAULT_DEEP_LINK_SCHEME,
): DesktopDeepLink | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_DEEP_LINK_LENGTH) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== `${scheme}:`) return null
  // `<scheme>://auth?...` → host; `<scheme>:/auth?...`/`<scheme>:///auth?...` → path.
  const action = (parsed.hostname !== '' ? parsed.hostname : parsed.pathname.replace(/^\/+/u, '').split('/')[0] ?? '').toLowerCase()
  if (!(DESKTOP_DEEP_LINK_ACTIONS as readonly string[]).includes(action)) return null
  return { action: action as DesktopDeepLinkAction, url: parsed.toString() }
}
