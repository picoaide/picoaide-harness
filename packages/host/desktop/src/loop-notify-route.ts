/**
 * Same-origin route serving the loop-notification click-to-jump request:
 * the Host plugin records the session id when it raises a loop notification,
 * the renderer polls this endpoint and opens the session.
 *
 * The GET CONSUMES the pending request (read-then-clear, P2-24): a request
 * that is never cleared would be re-delivered on every poll and on every
 * renderer reload, re-opening a session the user already visited.
 *
 * FIX-36（第二十七轮）：**消费就是写**，所以本路由不看方法地要一份 BrowserAuth
 * 持有性证明。`write-proof.ts` 的 GET 豁免只覆盖**只读** GET，本 GET 落在它的
 * 定义域之外；而 exact 路由优先于 `/api` prefix（上游 webserver 先查 exact 表），
 * `connection` 的 Host/Origin + cookie 围栏又只装在 prefix 通道上 ⇒ 少了这一步，
 * 本机任意进程一个裸 GET 就能把待跳转会话**取走并清空**：持证明的渲染层轮询再也
 * 拿不到（用户点系统通知"没反应"），并顺带泄露会话 id。
 *
 * 正常路径不受影响：轮询是渲染层的**同源** GET，Chromium 为同源请求自动带上
 * `dsh-auth-*` cookie（与 `/_dsh/desktop/renderer-boot`、`/update/check` 的
 * POST 同一形态，且同源 GET 不带 Origin —— 围栏明确接受缺席的 Origin）。
 * @module dsh-plugin-desktop/loop-notify-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DesktopLoopNotifySessionResponse } from './loop-notify-contract.ts'
import { acceptWriteProof, type WriteProofDeps } from './write-proof.ts'

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/**
 * 消费型证明闸：`acceptWriteProof` 的契约是"GET 读面豁免（由各写路由自己的方法闸
 * 处理）"，而本路由的 GET **消费**待跳转会话。闸门只读 `method` 与 `headers`，因此
 * 用一份非 GET 的方法视图复用同一份实现 —— 状态码（403/503）、错误信封、hint 与
 * fail-closed 行为都只有一处定义，不在这里复制一遍。
 *
 * 视图与真实非 GET 请求的等价性由 `tests/audit-r27-loopnotify-consuming-get.spec.ts`
 * 的等价腿钉住（同一组 headers 分别过本闸与 `acceptWriteProof` 的 POST 路径，结论
 * 逐字相同）；若哪天闸门开始读 `method`/`headers` 之外的字段，那条判据会红。
 * @param req - 进入闸门的请求（只读 headers）。
 * @param res - 拒绝时写出的响应。
 * @param proof - 证明依赖；未接线 ⇒ fail-closed 503。
 * @returns 请求持有证明、可以继续时为 true。
 */
function acceptConsumingProof(
  req: IncomingMessage,
  res: ServerResponse,
  proof: WriteProofDeps | undefined,
): boolean {
  const nonGetView = { method: 'POST', headers: req.headers }
  return acceptWriteProof(nonGetView as unknown as IncomingMessage, res, proof)
}

/**
 * Serve (and consume) the pending click-to-jump session request.
 *
 * 顺序：方法（405）→ Origin（403）→ **持有性证明**（403/503）→ 消费。证明在消费
 * 之前：拿不到证明的请求必须既不返回也不清空待跳转项。
 * @param req - 进入证明闸的请求。
 * @param res - 响应。
 * @param expectedOrigin - 渲染层 origin（缺失 Origin 的同源 GET 视为合法）。
 * @param consume - read-then-clear 的消费回调（只在证明通过后调用）。
 * @param proof - BrowserAuth 持有性证明依赖；未接线 ⇒ fail-closed 503。
 */
export async function handleDesktopLoopNotifySessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  consume: () => DesktopLoopNotifySessionResponse,
  proof: WriteProofDeps | undefined,
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, { error: 'method not allowed' })
  // Same-origin GET in Chromium carries no Origin header; strict equality
  // would reject the renderer's request (see desktop-update-route.ts).
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  if (!acceptConsumingProof(req, res, proof)) return
  finishJson(res, 200, consume())
}
