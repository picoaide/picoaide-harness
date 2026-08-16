export class ApiError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

let csrfToken = ''

export function setCsrf(token: string) {
  csrfToken = token
}

export async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (!(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  if (csrfToken && (init.method === undefined || !['GET', 'HEAD'].includes(init.method))) {
    headers['X-CSRF-Token'] = csrfToken
  }
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let code = 'INTERNAL'
    let message = res.statusText
    try {
      const body = await res.json()
      code = body?.error?.code ?? code
      message = body?.error?.message ?? message
    } catch {
      /* keep defaults */
    }
    if (res.status === 401 && window.location.pathname !== '/admin/') {
      // 会话过期/失效:任何页面请求收到 401 都回到登录页(App 挂载时
      // 的 me() 检查会渲染 Login),而不是停留在已失效的界面
      window.location.assign('/admin/')
    }
    throw new ApiError(res.status, code, message)
  }
  return res.json() as Promise<T>
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    let msg = '登录失败'
    try {
      msg = (await res.json())?.error?.message ?? msg
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  const body = await res.json()
  setCsrf(body.csrf_token)
}

export async function logout(): Promise<void> {
  await request('/api/admin/logout', { method: 'POST' })
}

export async function me(): Promise<any> {
  const body = await request('/api/admin/me')
  if (body?.csrf_token) setCsrf(body.csrf_token)
  return body
}
