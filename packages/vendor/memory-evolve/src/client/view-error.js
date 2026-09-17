/**
 * 宿主错误信封 → 视图错误对象（ME-8，2026-09-17 二审）。
 *
 * 宿主（lib/api.js）刻意用 `{ ok: false, code, error }` 分级表达失败：
 *   - 422 `{ code: 'unsupported', error: '版本检测模块未装配' }`
 *   - 503 `{ code: 'error', error: '版本检测服务内部错误' }`
 * 客户端只看 HTTP 状态码时这些原因被整块丢弃，用户看到的是
 * 「网络请求失败：HTTP 503」这类误导文案（同一组件对 POST /api/update 的
 * 失败路径却会读 outcome.code/outcome.error，两条路径口径不一致）。
 *
 * 逻辑放在无框架的纯 JS 模块里：只有它能用假响应做行为断言（.tsx 里的
 * fetch 包装在 node --test 下跑不了）。
 */

/**
 * 把非 2xx 响应的宿主信封转成带 code 的 Error（沿用视图既有的 catch 路径）。
 * @param {number} status HTTP 状态码。
 * @param {unknown} body 已解析的响应体（解析失败传 null）。
 * @returns {Error & { code: string }}
 */
export function hostErrorFromResponse(status, body) {
  const record = body !== null && typeof body === 'object' ? body : {}
  const code = typeof record.code === 'string' && record.code !== '' ? record.code : 'network'
  const message = typeof record.error === 'string' && record.error !== ''
    ? record.error
    : typeof record.message === 'string' && record.message !== ''
      ? record.message
      : `HTTP ${status}`
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 任意异常 → ViewError（{ code, message }）：带 code 的宿主错误原样透传，
 * 其余（网络层 TypeError 等）归一到 network + 原始 message。
 * @param {unknown} err
 * @returns {{ code: string, message: string }}
 */
export function viewErrorOf(err) {
  const message = err instanceof Error
    ? err.message
    : typeof err === 'string' && err !== '' ? err : 'network error'
  const code = err !== null && typeof err === 'object' && typeof err.code === 'string' && err.code !== ''
    ? err.code
    : 'network'
  return { code, message }
}
