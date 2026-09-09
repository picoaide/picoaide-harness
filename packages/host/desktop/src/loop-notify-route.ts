/**
 * Same-origin route serving the loop-notification click-to-jump request:
 * the Host plugin records the session id when it raises a loop notification,
 * the renderer polls this endpoint and opens the session.
 *
 * The GET CONSUMES the pending request (read-then-clear, P2-24): a request
 * that is never cleared would be re-delivered on every poll and on every
 * renderer reload, re-opening a session the user already visited.
 * @module dsh-plugin-desktop/loop-notify-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DesktopLoopNotifySessionResponse } from './loop-notify-contract.ts'

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/** Serve (and consume) the pending click-to-jump session request. */
export async function handleDesktopLoopNotifySessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  consume: () => DesktopLoopNotifySessionResponse,
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, { error: 'method not allowed' })
  // Same-origin GET in Chromium carries no Origin header; strict equality
  // would reject the renderer's request (see desktop-update-route.ts).
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  finishJson(res, 200, consume())
}
