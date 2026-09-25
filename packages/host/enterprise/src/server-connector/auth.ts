import { loadElectronModule } from './electron.ts'
import type { Session } from './config.ts'
import { DEFAULT_HOST_LOCALE, hostCopy, type HostLocale } from 'dsh-plugin-desktop/host-locale'

export type AuthErrorKind = 'invalid_credentials' | 'auth_expired' | 'network' | 'server_error'

/**
 * 服务端"先改密"守卫的稳定错误码（`serverauth/handler.go` 对
 * `password_must_change` 用户白名单外的一切接口回 `403 {error:{code}}`）。
 *
 * 它**必须**在客户端被当成契约而不是一句文案：`fetchJSON` 会把它放进
 * `ApiError.code`，auth-gate 的代理层按码回 403 + 可操作路径（此前被压成
 * `502 {"error":"gateway error: …"}` ⇒ 码丢了、面板只剩一句被包了一层的文本，
 * 任何"把用户送回改密页"的分支都无从下手）。R15B-02，2026-09-25。
 */
export const PASSWORD_CHANGE_REQUIRED_CODE = 'PASSWORD_CHANGE_REQUIRED'

/**
 * 该错误是不是"服务端要求先改密"。
 *
 * 判据只看码（不看 message）：服务端文案是中文散文、可随时改，而码是稳定契约
 * —— 与 `AccountSection` 从"嗅探中文原文"改为"读稳定码"是同一口径。
 * @param cause - 任意被捕获的值。
 * @returns true 表示必须先改密再重试。
 */
export function isPasswordChangeRequired(cause: unknown): boolean {
  return cause instanceof ApiError && cause.code === PASSWORD_CHANGE_REQUIRED_CODE
}

/**
 * 「先改密」应答里给界面的动作名（R15B-02）。
 *
 * 与 `code` 一样是**跨端契约**：面板/账号页据此把用户送到改密页，而不是各写各的
 * 文案匹配。客户端已有的那条路径是 `/change-password`（auth-gate 的精确路由，
 * 也是索引渲染在 `mustChangePassword` 时给出的页面）。
 */
export const PASSWORD_CHANGE_REQUIRED_ACTION = 'change-password'

/**
 * User-facing message per auth failure kind (shown by the login page).
 *
 * 这些消息**用户可见**: 登录页把 `AuthError.message` 原样渲染出来, 所以按宿主
 * 语言取文案。语言由调用方**按请求**解析后传入(见 auth-gate.ts 的 hostLocale);
 * 缺省中文 = 历史行为(account-card 等不发语言的调用方行为不变)。
 * @param kind - 认证失败类别。
 * @param locale - 宿主语言。
 * @returns 该语言的用户可见文案。
 */
export function authErrorMessage(kind: AuthErrorKind, locale: HostLocale = DEFAULT_HOST_LOCALE): string {
  switch (kind) {
    case 'invalid_credentials':
      return hostCopy(locale, '账号或密码错误', 'Incorrect username or password')
    case 'auth_expired':
      return hostCopy(locale, '登录已过期，请重新登录', 'Your session has expired. Please sign in again.')
    case 'network':
      return hostCopy(locale, '网络错误，请检查网络连接', 'Network error — check your connection')
    case 'server_error':
      return hostCopy(locale, '服务端错误，请稍后重试', 'Server error — please try again later')
  }
}

export class AuthError extends Error {
  constructor(
    public kind: AuthErrorKind,
    message?: string,
    locale: HostLocale = DEFAULT_HOST_LOCALE,
  ) {
    super(message ?? authErrorMessage(kind, locale))
    this.name = 'AuthError'
  }
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    /** 服务端原始 HTTP 状态码(2026-09-02 归属权:上传错误转发须透传,
     *  否则 VERSION_EXISTS=409 / APP_LOCKED=403 / NOT_FOUND=404 被压平成 422)。 */
    public status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Normalize a user-entered server URL: trim whitespace and strip one or more
 * trailing slashes so `https://host/` and `https://host` behave identically.
 * The login page brands/methods probes and every gateway request go through
 * here — a trailing slash must never produce `//api/...` path segments.
 */
export function normalizeServerURL(input: string): string {
  let s = input.trim()
  // Strip trailing slashes (multiple, per user requests). Done with a plain
  // loop rather than regex so no backslash escapes are involved.
  while (s.length > 0 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

async function electronSessionFetch(): Promise<typeof fetch | null> {
  const mod = await loadElectronModule()
  const f = mod?.session?.defaultSession?.fetch
  return typeof f === 'function' ? (f as typeof fetch) : null
}

export async function gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const sessionFetch = await electronSessionFetch()
  const url = typeof input === 'string' ? input : input.toString()
  if (sessionFetch) return sessionFetch(url, init)
  return fetch(input, init)
}

/**
 * Re-check that a server URL is allowed on every use (not only at login):
 * https, or http restricted to loopback hosts. Prevents a persisted session
 * from steering credentials or tokens at an arbitrary http:// target later.
 */
export function assertServerURLAllowed(serverURL: string): void {
  let parsed: URL
  try {
    parsed = new URL(serverURL)
  } catch {
    throw new AuthError('server_error', 'invalid server url')
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new AuthError('server_error', 'server must use https (http only for localhost)')
  }
}

/**
 * 登录网关。`locale` 只影响**本地生成**的用户可见文案(账号或密码错误等);
 * 服务端下发的消息原样透出(服务端文案不在 i18n 范围内)。
 * @param serverURL - 服务端地址(尾部斜杠会被归一)。
 * @param username - 账号。
 * @param password - 密码。
 * @param locale - 宿主语言(调用方按请求解析)。
 * @returns 已建立的会话。
 */
export async function login(
  serverURL: string, username: string, password: string, locale: HostLocale = DEFAULT_HOST_LOCALE,
): Promise<Session> {
  const server = normalizeServerURL(serverURL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    assertServerURLAllowed(server)
    const res = await gatewayFetch(`${server}/api/client/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    })
    if (res.status === 401) {
      // v3b: 审计账号拒绝登录客户端(AUDITOR_NOT_ALLOWED)——给出明确提示。
      const body = await res.json().catch(() => null) as { error?: { code?: string } } | null
      if (body?.error?.code === 'AUDITOR_NOT_ALLOWED') {
        throw new AuthError('server_error', hostCopy(
          locale,
          '审计账号不可登录客户端,请使用管理后台',
          'Audit accounts cannot sign in to the desktop client. Please use the admin console.',
        ))
      }
      throw new AuthError('invalid_credentials', undefined, locale)
    }
    if (!res.ok) throw new AuthError('server_error', `HTTP ${res.status}`)
    const data = (await res.json()) as {
      token?: string
      user?: { role?: string; source?: string; password_changeable?: boolean }
      must_change_password?: boolean
    }
    if (!data.token) throw new AuthError('server_error', 'missing token in response')
    const sess: Session = { serverURL: server, username, token: data.token }
    if (data.user?.role) sess.role = data.user.role
    // 0057: 来源/可改密标志(客户端判断改密入口); 强制改密标记驱动登录后拦截。
    // exactOptionalPropertyTypes: 仅在值存在时赋值, 不写 undefined。
    if (data.user?.source !== undefined) sess.source = data.user.source
    if (data.user?.password_changeable !== undefined) sess.passwordChangeable = data.user.password_changeable
    if (data.must_change_password === true) sess.mustChangePassword = true
    return sess
  } catch (e) {
    if (e instanceof AuthError) throw e
    if (controller.signal.aborted) throw new AuthError('network', 'timeout')
    throw new AuthError('network', e instanceof Error ? e.message : 'network error')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 0057 员工自助改密(本地认证用户): 成功后服务端吊销该用户全部令牌(含当前),
 * 调用方必须清除本地会话并让用户重新登录。
 * 失败时抛出携带服务端中文消息的错误(原密码错误/外部用户/长度不足等)。
 */
export async function changePassword(
  serverURL: string,
  token: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const server = normalizeServerURL(serverURL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    assertServerURLAllowed(server)
    const res = await gatewayFetch(`${server}/api/client/v2/auth/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      signal: controller.signal,
    })
    if (res.ok) return
    const data = await res.json().catch(() => null) as { error?: { message?: string } } | null
    const message = data?.error?.message ?? `HTTP ${res.status}`
    if (res.status === 401 || res.status === 403) throw new AuthError('invalid_credentials', message)
    throw new ApiError(`HTTP_${res.status}`, message)
  } catch (e) {
    if (e instanceof AuthError || e instanceof ApiError) throw e
    if (controller.signal.aborted) throw new AuthError('network', 'timeout')
    throw new AuthError('network', e instanceof Error ? e.message : 'network error')
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJSON(
  serverURL: string,
  path: string,
  opts: { token?: string; method?: string; body?: unknown; timeoutMs?: number; locale?: HostLocale } = {},
): Promise<any> {
  const server = normalizeServerURL(serverURL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000)
  let res: Response
  try {
    assertServerURLAllowed(server)
    res = await gatewayFetch(`${server}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    })
  } catch (e) {
    if (e instanceof AuthError) throw e
    if (controller.signal.aborted) throw new AuthError('network', 'timeout')
    throw new AuthError('network', e instanceof Error ? e.message : 'network error')
  } finally {
    clearTimeout(timer)
  }

  let data: any = null
  let parseFailed = false
  try {
    data = await res.json()
  } catch {
    parseFailed = true
  }

  if (!res.ok) {
    const env = data?.error
    const code = (env?.code as string) ?? `HTTP_${res.status}`
    const message = (env?.message as string) ?? `HTTP ${res.status}`
    if (res.status === 401 || code === 'AUTH_REQUIRED' || code === 'AUTH_FAILED') {
      throw new AuthError('auth_expired', message)
    }
    throw new ApiError(code, message, res.status)
  }
  // 防御: 期望 JSON 的 API 却返回了 HTML(如误指向门户首页/SPA 或代理劫持)。
  // 早失败给出明确提示,而不是把 HTML 当 JSON 解析失败成含糊的 UPSTREAM。
  // 这两条**用户可见**(经 auth-gate 的 { error } 回到能力中心面板),故按宿主语言取;
  // `opts.locale` 由调用方按请求解析后传入,缺省中文 = 历史行为。
  if (parseFailed && res.status !== 204) {
    const ct = res.headers.get('content-type') ?? ''
    const locale = opts.locale ?? DEFAULT_HOST_LOCALE
    if (ct.includes('text/html')) {
      throw new ApiError('NOT_JSON', hostCopy(
        locale,
        '服务端返回了 HTML 页面而非 JSON,请确认地址指向 API 服务根,而非门户/SPA 页面',
        'The server returned an HTML page instead of JSON; make sure the address points at the API root, not a portal/SPA page',
      ))
    }
    throw new ApiError('UPSTREAM', hostCopy(locale, '网关响应不是合法 JSON', 'The gateway response is not valid JSON'))
  }
  return data
}
