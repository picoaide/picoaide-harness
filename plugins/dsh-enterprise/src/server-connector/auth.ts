import { loadElectronModule } from './electron.ts'
import type { Session } from './config.ts'

export class AuthError extends Error {
  constructor(
    public kind: 'invalid_credentials' | 'auth_expired' | 'network' | 'server_error',
    message?: string,
  ) {
    super(message ?? kind)
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

export async function login(serverURL: string, username: string, password: string): Promise<Session> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await gatewayFetch(`${serverURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    })
    if (res.status === 401) throw new AuthError('invalid_credentials')
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
