/**
 * dsh-memory-evolve — 共享 HTTP 请求守卫（FIX-04，2026-09-12）。
 *
 * 为什么存在：P1-11 只把同源守卫装进 `lib/api.js` 的统一前置漏斗，而同一个
 * 插件里另有 8 个 `webServer.register` 注册点（bookmarks / prompts / coi api /
 * canvas / notify-web / coi broadcast / ui-settings / mermaid）**没有任何请求
 * 校验**：跨站页面发出的「简单请求」（`Origin: https://evil.example` +
 * `Content-Type: text/plain`，不触发 CORS 预检）能直接落库、发起 COI 本地
 * CLI 任务、打开本地文件。`lib/skills-manager.js` 另有一份手写副本。本模块
 * 是**唯一**的守卫实现：所有注册点的 handler 第一行调用
 * {@link applyRequestGuard}（skills-manager 用 {@link localTrustFence}，它的
 * 口径更宽：无 Origin 的本机脚本/CLI 要放行）。
 *
 * 分端口径——刻意**不是**"一刀切要求认证"（那会把设计上公开的端点打死，
 * 例如 GUI 匿名轮询的 badge / state 探测、mermaid vendor 静态资源）：
 *
 *   - GET/HEAD（只读，含设计上公开的端点）：放行。CSRF 侧只拒绝浏览器明确
 *     标注的跨站请求——`Sec-Fetch-Site: cross-site`。GET 可能没有 Origin
 *     （不能用 Origin 判定同源），而 `Sec-Fetch-Site` 是浏览器必然携带的
 *     Fetch Metadata 头；非浏览器客户端不发该头 ⇒ 放行（同机进程不在权限
 *     边界内）。
 *   - 其它方法（POST/PUT/PATCH/DELETE，全部是写操作）：Origin 必须存在且与
 *     Host 同源；有请求体时必须是 `application/json` 的 JSON 对象。跨站表单
 *     只能发 urlencoded/multipart/text-plain（被 content-type 判定拒绝），
 *     跨站 fetch 带 JSON 头会先触发预检而本服务无 CORS 许可。
 *
 * 失败响应沿用 `lib/api.js` 的既有契约：400 + `{ok:false, code:'bad-request'}`，
 * 浏览器标注的跨站 GET 用 403 + `{ok:false, code:'cross-site'}`。
 *
 * 零运行时依赖（node:url only）。
 *
 * @module dsh-memory-evolve/http-guard
 */

import { URL } from 'node:url'

/** 已解析的请求体缓存：统一前置守卫解析一次，路由侧 `readBody` 复用。 */
export const GUARDED_BODY = Symbol('memoryEvolveGuardedBody')

/**
 * 读取 JSON 请求体（带上限）。
 *
 * 若统一前置守卫已经解析过（`req[GUARDED_BODY]` 存在），直接返回缓存——
 * 流已被消费，再读会静默变成 `{}`（把「有体的写请求」变成空操作）。
 *
 * @param {object} req - node http 请求。
 * @param {number} [maxBytes] - 体积上限（默认 64 KiB）。
 * @returns {Promise<object>} 解析后的请求体（无体时 `{}`）。
 */
export async function readBody(req, maxBytes = 64 * 1024) {
  if (req[GUARDED_BODY] !== undefined) return req[GUARDED_BODY]
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
}

/**
 * 同源校验（保护本地写端点）：要求 Content-Type 精确为 JSON 媒体类型
 * （子串匹配会放过 text/plain;charset=json 之类，CodeX 复审 P1-5）；
 * 写操作强制要求 Origin 头存在且 host 与 Host 一致——跨站表单/脚本
 * 无法构造 JSON 体、且同源 fetch 必然携带 Origin。返回错误文案或 null。
 *
 * @param {object} req - node http 请求。
 * @param {object} body - 已解析的请求体（无体请求传 {}）。
 * @param {boolean} [bodyless] - 请求确实没有体（如浏览器发的 DELETE 不带
 *   Content-Type）时允许缺省 content-type；声明了就必须是 JSON。
 * @returns {string | null} 错误文案；null = 放行。
 */
function sameOriginGuard(req, body, bodyless = false) {
  const headers = req.headers ?? {}
  const contentType = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json' && !(bodyless && contentType === '')) {
    return '请求必须为 application/json'
  }
  const host = String(headers.host ?? '')
  const origin = String(headers.origin ?? '')
  if (origin === '') return '缺少 Origin 头，已拒绝（写操作必须由 Web UI 发起）'
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    return '跨站请求已拒绝'
  }
  if (originHost !== host) return '跨站请求已拒绝'
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return '请求体必须是 JSON 对象'
  }
  return null
}

/**
 * handler 的**统一前置守卫**（P1-11 + FIX-04）：在路由分发之前按方法分类
 * 处理，覆盖所有注册点，而不是只挂在某一个模块的某一个端点上。
 *
 * 语义见模块头注释：GET/HEAD 只拒绝 `Sec-Fetch-Site: cross-site`；其余方法
 * 必须 Origin 同源 + JSON 对象体。
 *
 * @param {object} req - node http 请求。
 * @param {number} [maxBytes] - 有体请求的解析上限（默认 64 KiB；调用方的
 *   路由若接受更大体积，必须传自己的上限，否则大体会在这里被 400）。
 * @returns {Promise<{status: number, body: object} | null>} null = 放行。
 */
export async function guardRequest(req, maxBytes = 64 * 1024) {
  // 守卫现在挂在每个注册点上，而 handler 可能由测试桩/非标准载体调用；
  // 缺 headers 时按"全部缺省"处理（写请求会因缺少 Origin 被拒，GET 放行），
  // 而不是抛 TypeError 变成 500。
  const headers = req.headers ?? {}
  const method = String(req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    const site = String(headers['sec-fetch-site'] ?? '').trim().toLowerCase()
    if (site === 'cross-site') {
      return { status: 403, body: { ok: false, code: 'cross-site', error: '跨站请求已拒绝' } }
    }
    return null
  }
  // 有体判定：Content-Length > 0 或 chunked（transfer-encoding）。无体请求
  // （浏览器 DELETE 不带 Content-Type/体）跳过 JSON 体校验但**仍要求
  // Origin**——浏览器对所有非 GET/HEAD 请求都附带 Origin，跨站的无体
  // POST/DELETE 因此同样被挡下。
  const declared = Number(headers['content-length'] ?? 0)
  const hasBody = (Number.isFinite(declared) && declared > 0) || headers['transfer-encoding'] !== undefined
  let body = {}
  if (hasBody) {
    try {
      body = await readBody(req, maxBytes)
    } catch (error) {
      const detail = error instanceof Error && error.message === 'body too large' ? '请求体过大' : '请求体不是合法 JSON'
      return { status: 400, body: { ok: false, code: 'bad-request', error: detail } }
    }
  }
  const message = sameOriginGuard(req, body, !hasBody)
  if (message !== null) return { status: 400, body: { ok: false, code: 'bad-request', error: message } }
  if (hasBody) req[GUARDED_BODY] = body
  return null
}

/** 写出守卫的拒绝响应（与 `sendJson` 同形，避免各模块再传自己的 helper）。 */
export function sendGuardDenial(res, denied) {
  const text = JSON.stringify(denied.body)
  res.writeHead(denied.status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/**
 * 一行式入口：handler 第一行调用。
 *
 * ```js
 * handler: async (req, res) => {
 *   if (await applyRequestGuard(req, res)) return
 *   ...
 * }
 * ```
 *
 * @param {object} req - node http 请求。
 * @param {object} res - node http 响应。
 * @param {number} [maxBytes] - 有体请求的解析上限（见 {@link guardRequest}）。
 * @returns {Promise<boolean>} true = 已拒绝并写完响应，调用方必须立刻 return。
 */
export async function applyRequestGuard(req, res, maxBytes = 64 * 1024) {
  const denied = await guardRequest(req, maxBytes)
  if (denied === null) return false
  sendGuardDenial(res, denied)
  return true
}

/**
 * skills-manager 的本地信任栅栏（F6 审计 2026-09-11 口径，FIX-04 收敛到本
 * 模块，消除第 9 份手写副本）。与 {@link guardRequest} 的差别是**刻意的**：
 * 技能管理面混有 GET 读与文本写，且要放行无 Origin 的本机脚本/CLI，所以
 * 它不要求 JSON content-type、也不强制 Origin 存在；它挡的是
 *  1) Host 自称 loopback 时 socket 必须也是 loopback（伪造 Host 拒绝）；
 *  2) Host 非 loopback 时必须是 `webRuntime.trustedHosts` 中已声明的权威
 *     （局域网 `dsh web --host 0.0.0.0` 的正常访问）；
 *  3) `Sec-Fetch-Site: cross-site` 拒绝；
 *  4) 带 Origin 时必须与 Host 同源（无 Origin 的本机脚本放行）。
 *
 * @param {object} req - node http 请求。
 * @param {object} webCtx - 注册时拿到的 web 侧 ctx（用于读 `webRuntime`）。
 * @returns {{status: number, body: object} | null} null = 放行。
 */
export function localTrustFence(req, webCtx) {
  const remote = String(req.socket?.remoteAddress ?? '')
  const loopbackRemote = remote === '::1' || remote === '::ffff:127.0.0.1' || /^127\./.test(remote)
  const hostHeader = req.headers?.host
  const hostIsLoopback = typeof hostHeader === 'string' &&
    /^(127(\.\d{1,3}){3}|localhost|\[::1\])(:|$)/.test(hostHeader)
  let trustedHosts = []
  try {
    const runtime = webCtx.get?.('webRuntime')
    if (runtime && Array.isArray(runtime.trustedHosts)) trustedHosts = runtime.trustedHosts
  } catch { /* 非 web 载体没有 webRuntime 服务 */ }
  const hostTrusted = typeof hostHeader === 'string' && trustedHosts.some((entry) => {
    const value = String(entry)
    return value === hostHeader || value === hostHeader.replace(/:\d+$/, '')
  })
  if (!hostIsLoopback && !hostTrusted) return { status: 403, body: { error: 'forbidden' } }
  if (hostIsLoopback && !loopbackRemote) return { status: 403, body: { error: 'forbidden' } }
  if (String(req.headers?.['sec-fetch-site'] ?? '') === 'cross-site') {
    return { status: 403, body: { error: 'forbidden' } }
  }
  const originHeader = req.headers?.origin
  if (typeof originHeader === 'string') {
    let originHost = ''
    try { originHost = new URL(originHeader).host } catch { originHost = '' }
    if (originHost !== hostHeader) return { status: 403, body: { error: 'forbidden' } }
  }
  return null
}
