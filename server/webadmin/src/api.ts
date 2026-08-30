export class ApiError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

// 管理页挂载基路径(与服务端路由与 BrowserRouter basename 一致;
// 审计2026-W7:不得在请求层硬编码 /admin/)
export const ADMIN_BASE = '/admin'

import { ADMIN_API, CLIENT_API } from './lib/api-paths'

// 页面/组件统一从集中常量取前缀,避免散落硬编码旧前缀(/api/admin 等)。
export { ADMIN_API, CLIENT_API }

let csrfToken = ''

// 全局 401 回调(审计 A5-M3):会话过期时由 App 原地切换登录态,取代
// window.location.assign 整页刷新(会丢当前页未保存状态;并行 401 重复跳转)。
let unauthorizedHandler: (() => void) | null = null

export function setCsrf(token: string) {
  csrfToken = token
}

export function setOnUnauthorized(fn: (() => void) | null) {
  unauthorizedHandler = fn
}

// 非 JSON 错误体的中文兜底(审计 A5-L6):反代 502/HTML 错误页时
// statusText(英文)对管理用户无意义。
function fallbackMessage(status: number): string {
  if (status >= 500) return '服务暂时不可用,请稍后再试'
  if (status === 403) return '没有权限执行该操作'
  if (status === 404) return '请求的资源不存在'
  return `请求失败(${status})`
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
    let message = fallbackMessage(res.status)
    try {
      const body = await res.json()
      code = body?.error?.code ?? code
      message = body?.error?.message ?? message
    } catch {
      /* keep the Chinese fallback */
    }
    if (res.status === 401) {
      // 审计 A5-L5: 任何页面(含 /admin/)收到 401 都走同一回调回登录态,
      // 不再区分 pathname —— 行为一致,由 App 决定如何呈现
      unauthorizedHandler?.()
    }
    throw new ApiError(res.status, code, message)
  }
  return res.json() as Promise<T>
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch(`${ADMIN_API}/login`, {
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
  await request(`${ADMIN_API}/logout`, { method: 'POST' })
}

export async function me(): Promise<any> {
  const body = await request(`${ADMIN_API}/me`)
  if (body?.csrf_token) setCsrf(body.csrf_token)
  return body
}
