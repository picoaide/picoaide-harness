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
  if (req.headers.origin !== expectedOrigin) return finishJson(res, 403, { error: 'forbidden' })
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
  if (req.headers.origin !== expectedOrigin) return finishJson(res, 403, { error: 'forbidden' })
  checkNow()
  finishJson(res, 202, { accepted: true })
}
