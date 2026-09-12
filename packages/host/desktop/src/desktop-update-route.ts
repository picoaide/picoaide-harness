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

/**
 * 同源写入口的统一守卫。
 *
 * POST 由 renderer 页面发起时 Chromium 会带 Origin; 无 Origin 的场景(如本地
 * 脚本)也放行, 跨站请求无法隐藏 Origin。
 * @returns 请求可以继续时为 true;已写出错误响应时为 false。
 */
function acceptRendererPost(req: IncomingMessage, res: ServerResponse, expectedOrigin: string): boolean {
  if (req.method !== 'POST') {
    finishJson(res, 405, { error: 'method not allowed' })
    return false
  }
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    finishJson(res, 403, { error: 'forbidden' })
    return false
  }
  return true
}

/** Serve a renderer-triggered manual update check (same flow as the tray command). */
export async function handleDesktopUpdateCheckRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  checkNow: () => void,
): Promise<void> {
  if (!acceptRendererPost(req, res, expectedOrigin)) return
  checkNow()
  finishJson(res, 202, { accepted: true })
}

/**
 * Serve a renderer-triggered installation of an already-downloaded installer.
 *
 * 与检查分成两条路由:检查会联网,安装只在本地动手(可能重启应用),对 UI 是
 * 两个不同动作,共用一个"再检查一次"的入口会让安装点不动。
 */
export async function handleDesktopUpdateInstallRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  installNow: () => void,
): Promise<void> {
  if (!acceptRendererPost(req, res, expectedOrigin)) return
  installNow()
  finishJson(res, 202, { accepted: true })
}
