import { loadElectronModule } from './electron.ts'
import type { Session } from './config.ts'

export type AuthErrorKind = 'invalid_credentials' | 'auth_expired' | 'network' | 'server_error'

/** User-facing message per auth failure kind (shown by the login page). */
export function authErrorMessage(kind: AuthErrorKind): string {
  switch (kind) {
    case 'invalid_credentials': return '账号或密码错误'
    case 'auth_expired': return '登录已过期，请重新登录'
    case 'network': return '网络错误，请检查网络连接'
    case 'server_error': return '服务端错误，请稍后重试'
  }
}

export class AuthError extends Error {
  constructor(
    public kind: AuthErrorKind,
    message?: string,
  ) {
    super(message ?? authErrorMessage(kind))
    this.name = 'AuthError'
  }
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
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

export async function login(serverURL: string, username: string, password: string): Promise<Session> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    assertServerURLAllowed(serverURL)
    const res = await gatewayFetch(`${serverURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    })
    if (res.status === 401) {
      // v3b: 审计账号拒绝登录客户端(AUDITOR_NOT_ALLOWED)——给出明确提示。
      const body = await res.json().catch(() => null) as { error?: { code?: string } } | null
      if (body?.error?.code === 'AUDITOR_NOT_ALLOWED') {
        throw new AuthError('server_error', '审计账号不可登录客户端,请使用管理后台')
      }
      throw new AuthError('invalid_credentials')
    }
    if (!res.ok) throw new AuthError('server_error', `HTTP ${res.status}`)
    const data = (await res.json()) as { token?: string }
    if (!data.token) throw new AuthError('server_error', 'missing token in response')
    return { serverURL, username, token: data.token }
  } catch (e) {
    if (e instanceof AuthError) throw e
    if (controller.signal.aborted) throw new AuthError('network', 'timeout')
    throw new AuthError('network', e instanceof Error ? e.message : 'network error')
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJSON(
  serverURL: string,
  path: string,
  opts: { token?: string; method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000)
  let res: Response
  try {
    assertServerURLAllowed(serverURL)
    res = await gatewayFetch(`${serverURL}${path}`, {
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
    throw new ApiError(code, message)
  }
  if (parseFailed && res.status !== 204) throw new ApiError('UPSTREAM', '网关响应不是合法 JSON')
  return data
}
