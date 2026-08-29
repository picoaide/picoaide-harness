import type { Context } from '@deepseek-ai/cordis'
import { assertServerURLAllowed, AuthError } from './server-connector/auth.ts'
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
  return {
    serverURL: parsed.searchParams.get('server') ?? '',
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
    ctx.logger?.info(`pico-deep-link: logged in as ${session.username}`)
    applySession(session)
  })
}
