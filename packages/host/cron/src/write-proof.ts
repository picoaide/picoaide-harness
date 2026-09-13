/**
 * R4-RV3a（第四轮收尾）：cron 写面的 BrowserAuth 持有性证明。
 *
 * `loopback.ts` 的 `guard()` 自述边界就是"伪造 Origin 的 curl 也能过"：本机任意
 * 进程伪造 `Origin`/`Host`/`Sec-Fetch-Site` 即可 `POST /api/cron/action` 创建并
 * 立即执行定时任务（落盘 `cron/ledger.json`，跨重启生效）或抹掉用户已有任务。
 *
 * 证明 = 上游 `connection` 服务的 BrowserAuth cookie（`dsh-auth-<authority>`：
 * HttpOnly + SameSite=Strict + HMAC，只能由本进程服务、经 launch token 换票的
 * 页面持有），直接复用 `connection.requestRejection()`。本文件与
 * `packages/host/browser/src/index.ts`、`packages/host/connectors/src/index.ts`
 * 第三轮的 `proofOfPossession` / `requireWriteProof` 同一形状：
 * fence 缺席 ⇒ fail-closed 503；GET 读面豁免（由各写路由自己的方法闸处理）。
 * @module dsh-cron/write-proof
 */
import type { IncomingMessage } from 'node:http'

/**
 * 与 enterprise/browser/connectors 的 `ConnectionTrustFence` 同形：只用到
 * `requestRejection`（Host/Origin 围栏 + `dsh-auth-*` cookie 验签），结构类型 +
 * 运行时存在性判断已足够，服务缺席时明确 fail-closed。
 */
export interface ConnectionTrustFence {
  /**
   * Connection 的 Host/Origin 围栏 + BrowserAuth cookie 校验。
   * @param request - 只用到 headers(Host / Cookie)。
   * @returns 401/403 表示拒绝；undefined 表示通过。
   */
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** 写面证明的依赖：fence 来源 + 诊断前缀。 */
export interface WriteProofDeps {
  /** 证明来源（`ctx.get('connection')`）；每请求求值，服务可能晚于路由注册出现。 */
  fence: () => ConnectionTrustFence | undefined
  /** 诊断前缀（插件名），用于日志。 */
  label: string
  /** 拒绝原因写入插件日志；缺省丢弃。 */
  warn?: (message: string) => void
}

/** 证明闸结论：`ok` 为 false 时给出拒绝状态码与机器可读错误码。 */
export type WriteProofOutcome =
  | { ok: true }
  | {
    ok: false
    status: 403 | 503
    error: 'browser session proof required' | 'browser session proof unavailable'
  }

/** 拒绝响应的提示文案（与 browser/connectors 逐字一致）。 */
export const WRITE_PROOF_HINT = 'reopen the application window from its launch URL'

/**
 * 写面持有性证明闸：GET 读面豁免，其余方法必须持本进程签发的 BrowserAuth cookie。
 * @param req - 进入证明闸的请求（只读 method 与 headers）。
 * @param deps - fence 来源与诊断前缀。
 * @returns 通过，或 403（证明不足）/ 503（证明机制缺席）的拒绝结论。
 */
export function requireWriteProof(req: IncomingMessage, deps: WriteProofDeps): WriteProofOutcome {
  if (req.method === 'GET') return { ok: true }
  const warn = deps.warn ?? ((): void => {})
  const fence = deps.fence()
  if (fence === undefined || typeof fence.requestRejection !== 'function') {
    warn(`${deps.label}: connection service unavailable; refusing a local write (fail-closed)`)
    return { ok: false, status: 503, error: 'browser session proof unavailable' }
  }
  let rejection: 401 | 403 | undefined
  try {
    rejection = fence.requestRejection({ headers: req.headers })
  } catch (error) {
    // 校验器自身抛错 = 无法证明 ⇒ 按拒绝处理（不把异常泄漏成 500）。
    warn(`${deps.label}: browser proof check failed (${error instanceof Error ? error.message : String(error)})`)
    rejection = 403
  }
  if (rejection === undefined) return { ok: true }
  warn(`${deps.label}: refused a local write without browser proof (${String(rejection)})`)
  return { ok: false, status: 403, error: 'browser session proof required' }
}
