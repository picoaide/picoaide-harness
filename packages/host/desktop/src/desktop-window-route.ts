/**
 * 标题栏双击路由：把 renderer 的 `dblclick` 交给宿主执行 macOS 的窗口动作。
 *
 * 为什么不让 renderer 自己算：缩放/最小化只能由主进程做，而"用户把双击设成了缩放还是
 * 最小化、还是什么都不做"来自系统偏好（`AppleActionOnDoubleClick`）—— 见
 * `electron-runtime.ts` 的 `performTitleBarDoubleClick()`。
 *
 * 写面守卫与 `directory-picker-route.ts` 同形：方法 → Origin → BrowserAuth 持有性证明
 * （证明未接线 ⇒ fail-closed）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { acceptWriteProof, type WriteProofDeps } from './write-proof.ts'

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/**
 * 处理一次 renderer 发起的标题栏双击。
 * @param req - 进入的请求。
 * @param res - 响应。
 * @param expectedOrigin - 本安装的回环源（Origin 校验基准）。
 * @param perform - 宿主侧执行窗口动作（非 macOS / 无窗口时自行 no-op）。
 * @param proof - 写面持有性证明依赖。
 */
export async function handleDesktopTitleBarDoubleClickRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  perform: () => void,
  proof: WriteProofDeps | undefined,
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' })
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  if (!acceptWriteProof(req, res, proof)) return
  perform()
  finishJson(res, 202, { accepted: true })
}
