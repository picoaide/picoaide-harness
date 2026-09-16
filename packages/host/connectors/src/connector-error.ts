/**
 * 连接器错误的**稳定标识**（locale-independent connector error codes）。
 *
 * 为什么需要它（2026-09-16 i18n 耦合修复）
 * --------------------------------------
 * `src/client/friendly-error.ts` 过去靠**中文字串**（`退出码` / `未找到命令` /
 * `下载` / `授权` / `token` / `登录`）判断该把一条原始错误渲染成哪句友好文案；
 * Host 侧 `src/index.ts` 的 `startConnect` 也用同样的字串判断这一条该落
 * `unauthorized` 还是 `error`。一旦 Host 文案随语言走，这两处匹配在英文界面下
 * 全部失效：所有具体错误都会退化成通用兜底（"连接失败：…"），而字串匹配本身
 * 也把"文案"变成了上下游之间的隐式契约 —— 改一个字就静默坏掉。
 *
 * 现在的契约：
 *  - Host 给"它自己产生的、会跨到面板的错误"挂一个**语言无关的 code**
 *    （{@link ConnectorError} / 状态里的 `errorCode` 字段）；
 *  - 客户端只按 code（外加 OS 级、与语言无关的 `ENOENT`）做映射；
 *  - 两边都不再匹配任何自然语言子串。
 *
 * 该模块被 Host 半边与 client 半边共同引用，因此**不得**引入任何 node 依赖或
 * 运行时服务依赖（client bundle 会把它内联进去）。
 *
 * @module
 */

/**
 * Stable codes for connector errors that cross the host/client boundary.
 *
 * `auth-required` is the only code this package produces today (the 401
 * rewrite in `registerMcp` plus the OAuth/device flow failures). The other
 * three are reserved by the friendly-rendering contract for CLI/dependency
 * errors — the strings they used to be inferred from (a missing binary, an
 * exit code, a download failure) are natural-language text and therefore not a
 * contract the client may match on any more. A producer that has such an error
 * attaches the code; the client keeps `ENOENT` as a producer-independent
 * fallback.
 */
export const CONNECTOR_ERROR_CODES = ['auth-required', 'exit-code', 'command-missing', 'download'] as const

/** One stable, locale-independent connector error code. */
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number]

/** Whether a value is one of {@link CONNECTOR_ERROR_CODES}. */
export function isConnectorErrorCode(value: unknown): value is ConnectorErrorCode {
  return typeof value === 'string' && (CONNECTOR_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * An error that carries a stable code across every boundary that keeps the
 * object (in-process classification).
 *
 * Over HTTP the code travels as a sibling JSON field (`errorCode`) because the
 * body is a string; see {@link connectorErrorCodeOf}, which reads both shapes so
 * a re-thrown or re-hydrated error still classifies.
 */
export class ConnectorError extends Error {
  /** Stable, locale-independent classification of this failure. */
  readonly code: ConnectorErrorCode

  constructor(code: ConnectorErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConnectorError'
    this.code = code
  }
}

/**
 * Read the stable code off anything that carries one.
 *
 * Accepts a `ConnectorError`, a plain error/object with a `code` field (an
 * error from another module), the JSON body shape (`errorCode`) and a bare
 * code string, so callers never need to know which layer produced the value.
 * @param value - error, JSON body, or code string.
 * @returns the code, or undefined when the value carries none.
 */
export function connectorErrorCodeOf(value: unknown): ConnectorErrorCode | undefined {
  if (isConnectorErrorCode(value)) return value
  if (value === null || typeof value !== 'object') return undefined
  const record = value as { code?: unknown; errorCode?: unknown }
  if (isConnectorErrorCode(record.code)) return record.code
  if (isConnectorErrorCode(record.errorCode)) return record.errorCode
  return undefined
}

/**
 * Attach a stable code to an existing error **without** changing its message
 * (the client half uses this when a host response carried `errorCode`).
 * @param error - the error to classify.
 * @param code - the code to attach.
 * @returns the same error instance.
 */
export function withConnectorErrorCode<T extends Error>(error: T, code: ConnectorErrorCode | undefined): T {
  if (code !== undefined) (error as { code?: ConnectorErrorCode }).code = code
  return error
}
