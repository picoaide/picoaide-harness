import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_DEEP_LINK_SCHEME } from 'dsh-plugin-desktop/desktop-channel'
import { assertServerURLAllowed, AuthError, fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'

// 声明桌面壳转发的深链事件(desktop shell 的 ctx.emit)。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/deep-link'(url: string): void
  }
}

/**
 * Deep link handler — completes OIDC/OpenID browser login.
 *
 * The server OIDC callback redirects the system browser to
 * `<scheme>://auth?token=<t>[&server=<url>&user=<name>]`; the desktop shell
 * forwards it here as the 'pico/deep-link' event. scheme 随渠道包（安装包级），由
 * 桌面壳在组装期注入本插件（见 `installDeepLinkListener` 的说明）：渠道构建用它
 * 自己的 scheme，浏览器确认框里不出现厂商名。We parse it, validate the
 * server URL (https or loopback http), and store the session — the login
 * page's `/api/pico/auth/state` poll then flips to loggedIn and reloads.
 *
 * Security: a deep link is a local OS event, so it is treated like a login
 * form POST: the token is only accepted when the server URL is allowed and
 * the token verifies against that server (verified on next bootstrap fetch;
 * an attacker-crafted link just fails the fetch).
 */
export function parseAuthDeepLink(
  url: string,
  scheme: string = DEFAULT_DEEP_LINK_SCHEME,
): Session | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${scheme}:`) return null
  if (parsed.hostname !== 'auth') return null
  const token = parsed.searchParams.get('token')
  if (!token) return null
  let serverURL = parsed.searchParams.get('server') ?? ''
  // 与登录表单一致地归一尾斜杠:fetchJSON 内部会 normalize,但本机
  // 模板拼接路径处(如 auth-gate 的 archive 下载)不会——深链会话带尾
  // 斜杠会在这些路径产生 `//api/...` 双斜杠 404(2026-09-01 审计)。
  while (serverURL.endsWith('/')) serverURL = serverURL.slice(0, -1)
  return {
    serverURL,
    username: parsed.searchParams.get('user') ?? '',
    token,
  }
}

/**
 * Install the deep-link listener; used by SessionService on construction.
 *
 * scheme 由**桌面壳注入**（`picoaide-session` 行 config 的 `deepLinkScheme`，
 * 见 desktop/src/profile.ts 的 `channelProfilePatches`），不在这里自己读随包
 * `channel.json`：本文件会被 tsdown **内联**进 enterprise 的 lib，而
 * `desktop-channel.ts` 里的路径是相对**它自己**的模块位置算的，于是
 * `../build/channel.json` 会指向 `@picoaide/dsh-enterprise/build/channel.json`
 * —— 那个文件在打包产物里不存在（asar 里只有应用根的 `/build/channel.json`），
 * 结果永远回落官方 scheme，渠道客户端的浏览器 SSO 回调被当成畸形链接丢掉
 * （2026-09-11 真机复现）。
 * @param ctx - Host context (carries the `pico/deep-link` event).
 * @param applySession - store a verified session.
 * @param getCurrent - current session (cross-server switch guard).
 * @param scheme - 本安装的深链 scheme（缺省官方值）。
 */
export function installDeepLinkListener(
  ctx: Context,
  applySession: (session: Session) => void,
  getCurrent?: () => Session | null,
  scheme: string = DEFAULT_DEEP_LINK_SCHEME,
): () => void {
  return ctx.on('pico/deep-link', (url: unknown) => {
    if (typeof url !== 'string') return
    const session = parseAuthDeepLink(url, scheme)
    if (session === null) {
      ctx.logger?.warn('pico-deep-link: ignored malformed deep link')
      return
    }
    // The link may omit server/user (older server or manual invocation):
    // without a server the token cannot be attached to any gateway.
    if (session.serverURL === '' || session.username === '') {
      ctx.logger?.warn('pico-deep-link: ignored link without server/user')
      return
    }
    try {
      assertServerURLAllowed(session.serverURL)
    } catch (error) {
      ctx.logger?.warn(`pico-deep-link: rejected unsafe server: ${error instanceof AuthError ? error.message : String(error)}`)
      return
    }
    // 安全:深链 token 先对目标网关预验证(/auth/me 带 token 探通),避免
    // 攻击者可控网关返回合法 bootstrap 把活动 session 劫持到任意 server——
    // 验证失败即拒绝,成功才 applySession(fire-and-forget,失败静默降级)。
    void (async (): Promise<void> => {
      try {
        await fetchJSON(session.serverURL, '/api/client/v2/auth/me', { token: session.token })
      } catch (error) {
        // 日志消毒:serverURL/username 来自链接参数(攻击者可控),
        // JSON.stringify 剥离换行/控制符,防日志注入(2026-09-01 审计)。
        ctx.logger?.warn(`pico-deep-link: token rejected by ${JSON.stringify(session.serverURL)}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      // F12(审计 2026-09-11):已登录时拒绝把活动会话静默切换到**另一台
      // 服务端** —— 任意本机进程都能触发该 scheme,配合攻击者服务器与
      // 自签 token 可完成会话劫持(此前仅预验证目标可达,无法证明可信)。
      // 单服务端产品语义下,切换服务器必须先显式登出。
      const existing = getCurrent?.() ?? null
      if (existing !== null && existing.serverURL !== session.serverURL) {
        ctx.logger?.warn(`pico-deep-link: refused server switch while signed in; sign out first (${JSON.stringify(session.serverURL)})`)
        return
      }
      ctx.logger?.info(`pico-deep-link: logged in as ${JSON.stringify(session.username)}`)
      applySession(session)
    })()
  })
}
