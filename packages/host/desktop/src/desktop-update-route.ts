import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DesktopUpdateStateResponse } from './desktop-update-contract.ts'

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/** Serve the live desktop update badge snapshot to the renderer. */
export async function handleDesktopUpdateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  readState: () => DesktopUpdateStateResponse,
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, { error: 'method not allowed' })
  // 同源 GET 请求在 Chromium 中不带 Origin header(仅跨源/非简单请求携带),
  // 严格 equality 会把 renderer 的合法请求判为 forbidden(2026-08-31 实测)。
  // 安全边界: 恶意跨站页面无法隐藏 Origin(浏览器强制), 无 Origin 的请求
  // 只可能来自同源 renderer 或非浏览器客户端, 二者均不构成跨站 CSRF。
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  finishJson(res, 200, readState())
}

/** Serve a renderer-triggered manual update check (same flow as the tray command). */
export async function handleDesktopUpdateCheckRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  checkNow: () => void,
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' })
  // 同上: POST 由 renderer 页面发起时 Chromium 会带 Origin; 无 Origin 的
  // 场景(如本地脚本)也放行, 跨站请求无法隐藏 Origin。
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  checkNow()
  finishJson(res, 202, { accepted: true })
}
