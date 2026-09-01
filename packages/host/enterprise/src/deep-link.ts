import type { Context } from '@deepseek-ai/cordis'
import { assertServerURLAllowed, AuthError, fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'

// 声明桌面壳转发的深链事件(desktop shell 的 ctx.emit)。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/deep-link'(url: string): void
  }
}

/**
 * picoaide:// deep link handler — completes OIDC/OpenID browser login.
 *
 * The server OIDC callback redirects the system browser to
 * `picoaide://auth?token=<t>[&server=<url>&user=<name>]`; the desktop shell
 * forwards it here as the 'pico/deep-link' event. We parse it, validate the
 * server URL (https or loopback http), and store the session — the login
 * page's `/api/pico/auth/state` poll then flips to loggedIn and reloads.
 *
 * Security: a deep link is a local OS event, so it is treated like a login
 * form POST: the token is only accepted when the server URL is allowed and
 * the token verifies against that server (verified on next bootstrap fetch;
 * an attacker-crafted link just fails the fetch).
 */
export function parseAuthDeepLink(url: string): Session | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'picoaide:') return null
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

/** Install the deep-link listener; used by SessionService on construction. */
export function installDeepLinkListener(ctx: Context, applySession: (session: Session) => void): () => void {
  return ctx.on('pico/deep-link', (url: unknown) => {
    if (typeof url !== 'string') return
    const session = parseAuthDeepLink(url)
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
      ctx.logger?.info(`pico-deep-link: logged in as ${JSON.stringify(session.username)}`)
      applySession(session)
    })()
  })
}
