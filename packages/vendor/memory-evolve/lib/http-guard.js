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
 *   - **读写共同的 Host 栅栏**（R24 B3，2026-09-26）：{@link hostTrustFence} 是
 *     全部 11 个注册点的**第一条**判据 —— Host 必须是本机可信托管名（loopback
 *     或 `webRuntime.trustedHosts` 中已声明的权威）。此前的写侧唯一判据是
 *     `Origin == Host`，而两端都可被攻击者填成同一个值：`Host: attacker.example`
 *     + `Origin: http://attacker.example` 的 DNS rebinding 页面（socket 落在
 *     127.0.0.1）可以读全部记忆、删除/归档条目、派发 COI 本地 CLI 任务。
 *     Host 是 rebinding **无法伪造**的头（浏览器按它以为的 URL 填写），所以这道
 *     栅栏必须罩住读与写，且只有一份实现。
 *   - GET/HEAD（只读，含设计上公开的端点）：过 Host 栅栏后放行。CSRF 侧只拒绝
 *     浏览器明确标注的跨站请求——`Sec-Fetch-Site: cross-site`。GET 可能没有
 *     Origin（不能用 Origin 判定同源），而 `Sec-Fetch-Site` 是浏览器必然携带的
 *     Fetch Metadata 头；非浏览器客户端不发该头 ⇒ 放行。
 *   - 其它方法（POST/PUT/PATCH/DELETE，全部是写操作）：过 Host 栅栏后，Origin
 *     必须存在且与 Host 同源；有请求体时必须是 `application/json` 的 JSON 对象。
 *     跨站表单只能发 urlencoded/multipart/text-plain（被 content-type 判定拒绝），
 *     跨站 fetch 带 JSON 头会先触发预检而本服务无 CORS 许可。
 *
 * 失败响应沿用 `lib/api.js` 的既有契约：400 + `{ok:false, code:'bad-request'}`，
 * 浏览器标注的跨站 GET 用 403 + `{ok:false, code:'cross-site'}`，Host 栅栏用
 * 403 + `{ok:false, code:'untrusted-host'}`。
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
 * 无法构造 JSON 体、且同源 fetch 必然携带 Origin。
 *
 * 返回 `{reason, error}`（reason 是机器可读的失败分类，供自有错误契约的
 * 模块做映射；`guardRequest` 对外仍然只吐 `{ok:false, code, error}`）。
 *
 * @param {object} req - node http 请求。
 * @param {object} body - 已解析的请求体（无体请求传 {}）。
 * @param {boolean} [bodyless] - 请求确实没有体（如浏览器发的 DELETE 不带
 *   Content-Type）时允许缺省 content-type；声明了就必须是 JSON。
 * @returns {{reason: string, error: string} | null} null = 放行。
 */
function sameOriginGuard(req, body, bodyless = false) {
  const headers = req.headers ?? {}
  const contentType = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json' && !(bodyless && contentType === '')) {
    return { reason: 'content-type', error: '请求必须为 application/json' }
  }
  const host = String(headers.host ?? '')
  const origin = String(headers.origin ?? '')
  if (origin === '') return { reason: 'origin-missing', error: '缺少 Origin 头，已拒绝（写操作必须由 Web UI 发起）' }
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    return { reason: 'origin-cross', error: '跨站请求已拒绝' }
  }
  if (originHost !== host) return { reason: 'origin-cross', error: '跨站请求已拒绝' }
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { reason: 'body-not-object', error: '请求体必须是 JSON 对象' }
  }
  return null
}

/** 守卫拒绝结果（公共响应体与既有契约逐字节一致；`reason` 供映射用）。 */
function guardDenial(status, reason, error) {
  return {
    status,
    reason,
    body: reason === 'cross-site'
      ? { ok: false, code: 'cross-site', error }
      : { ok: false, code: 'bad-request', error },
  }
}

/**
 * handler 的**统一前置守卫**（P1-11 + FIX-04）：在路由分发之前按方法分类
 * 处理，覆盖所有注册点，而不是只挂在某一个模块的某一个端点上。
 *
 * 语义见模块头注释：先过 {@link hostTrustFence}；GET/HEAD 只拒绝
 * `Sec-Fetch-Site: cross-site`；其余方法必须 Origin 同源 + JSON 对象体。
 *
 * @param {object} req - node http 请求。
 * @param {number} [maxBytes] - 有体请求的解析上限（默认 64 KiB；调用方的
 *   路由若接受更大体积，必须传自己的上限，否则大体会在这里被 400）。
 * @param {object} [webCtx] - 注册时的 web 侧 ctx（读 `webRuntime.trustedHosts`；
 *   见 {@link hostTrustFence}）。缺省时 `trustedHosts` 按空表处理——只放行
 *   loopback，绝不放宽到任意主机。
 * @returns {Promise<{status: number, body: object} | null>} null = 放行。
 */
export async function guardRequest(req, maxBytes = 64 * 1024, webCtx = undefined) {
  const denied = await guardRequestReasoned(req, maxBytes, webCtx)
  if (denied === null) return null
  return { status: denied.status, body: denied.body }
}

/**
 * 带**失败分类**的守卫（FIX-27 / me-3，2026-09-13）。
 *
 * 语义与 {@link guardRequest} **完全同一份实现**，只是拒绝时多返回一个机器
 * 可读的 `reason`：`host-untrusted` / `cross-site` / `content-type` /
 * `origin-missing` / `origin-cross` / `body-too-large` / `bad-json` /
 * `body-not-object`。
 *
 * 为什么需要它：`lib/advisor/api.js` 有自己的错误契约（按失败原因分
 * 400/403/413/415，MAJOR-8 复审口径）。此前它靠**本地第 10 份手写副本**维持
 * 那套契约，于是共享守卫的读侧策略（跨站 GET → 403）与无体 content-type
 * 规则都传不到它 —— 同一份策略两处漂移，下一轮加固必然漏改。现在策略只此
 * 一份，自有契约的模块按 reason 做映射即可。
 *
 * @param {object} req - node http 请求。
 * @param {number} [maxBytes] - 有体请求的解析上限（默认 64 KiB）。
 * @param {object} [webCtx] - 注册时的 web 侧 ctx（见 {@link hostTrustFence}）。
 * @returns {Promise<{status: number, reason: string, body: object} | null>}
 *   null = 放行。
 */
export async function guardRequestReasoned(req, maxBytes = 64 * 1024, webCtx = undefined) {
  // 守卫现在挂在每个注册点上，而 handler 可能由测试桩/非标准载体调用；
  // 缺 headers 时按"全部缺省"处理（Host 栅栏会拒绝，GET 也不例外——Host 是
  // 唯一无法伪造的身份头，缺失即无可信证据），而不是抛 TypeError 变成 500。
  const headers = req.headers ?? {}
  const hostDenied = hostTrustFence(req, webCtx)
  if (hostDenied !== null) {
    return {
      status: hostDenied.status,
      reason: hostDenied.reason,
      body: { ok: false, code: 'untrusted-host', error: hostDenied.error },
    }
  }
  const method = String(req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    const site = String(headers['sec-fetch-site'] ?? '').trim().toLowerCase()
    if (site === 'cross-site') {
      return guardDenial(403, 'cross-site', '跨站请求已拒绝')
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
      const tooLarge = error instanceof Error && error.message === 'body too large'
      return tooLarge
        ? guardDenial(400, 'body-too-large', '请求体过大')
        : guardDenial(400, 'bad-json', '请求体不是合法 JSON')
    }
  }
  const denied = sameOriginGuard(req, body, !hasBody)
  if (denied !== null) return guardDenial(400, denied.reason, denied.error)
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
 *   if (await applyRequestGuard(req, res, 256 * 1024, webCtx)) return
 *   ...
 * }
 * ```
 *
 * @param {object} req - node http 请求。
 * @param {object} res - node http 响应。
 * @param {number} [maxBytes] - 有体请求的解析上限（见 {@link guardRequest}）。
 * @param {object} [webCtx] - 注册时的 web 侧 ctx（见 {@link hostTrustFence}）。
 * @returns {Promise<boolean>} true = 已拒绝并写完响应，调用方必须立刻 return。
 */
export async function applyRequestGuard(req, res, maxBytes = 64 * 1024, webCtx = undefined) {
  const denied = await guardRequest(req, maxBytes, webCtx)
  if (denied === null) return false
  sendGuardDenial(res, denied)
  return true
}

/**
 * **Host 信任栅栏**（R24 B3，2026-09-26）——全部注册点（读+写）的共同前置，
 * 唯一实现。
 *
 * 判据（三条，任一不成立即拒）：
 *  1) Host 必须是 loopback 名（`127.0.0.0/8` / `localhost` / `[::1]`）或
 *     `webRuntime.trustedHosts` 中已声明的权威。缺 Host 一律拒（真实 HTTP/1.1
 *     请求必然带 Host，缺失只出现在非标准载体上，没有可判证据 ⇒ fail-closed）。
 *  2) Host 自称 loopback 时，socket 也必须来自 loopback —— 服务绑在
 *     `0.0.0.0` 时，局域网机器伪造 `Host: 127.0.0.1` 会被这条挡下。
 *     载体**完全没有 socket** 时（测试桩 / 非 HTTP 调用）没有可判的远端地址，
 *     只保留第 1 条；真实 node:http 请求一律有 socket，判定不变。
 *  3) `trustedHosts` 的来源是上游 web-app 提供的 `webRuntime` 服务，缺省
 *     `[]`（`packages/bundle/web-app/src/index.ts` 的 `resolveLanTrust`：只有
 *     绑 `0.0.0.0` 时派生本机局域网字面量，外加命令行 `--trusted-host`）。
 *     本模块**不**自行放宽：ctx 缺失或服务未提供时按空表处理。
 *
 * 为什么 Host 而不是 Origin：DNS rebinding 下浏览器把 `Host` 填成攻击者域名
 * （它以为在跟那个域名说话），而 `Origin` 由页面自己决定 —— 攻击者页面完全
 * 可以把两者写成同一个值。所以 `Origin == Host` 对 rebinding 是零判据。
 *
 * @param {object} req - node http 请求。
 * @param {object} [webCtx] - 注册时的 web 侧 ctx（用于读 `webRuntime`）。
 * @returns {{status: number, reason: string, error: string} | null} null = 放行。
 */
function hostTrustFence(req, webCtx) {
  const remote = String(req.socket?.remoteAddress ?? '')
  const loopbackRemote = remote === '::1' || remote === '::ffff:127.0.0.1' || /^127\./.test(remote)
  const hostHeader = req.headers?.host
  const hostIsLoopback = typeof hostHeader === 'string' &&
    /^(127(\.\d{1,3}){3}|localhost|\[::1\])(:|$)/.test(hostHeader)
  let trustedHosts = []
  try {
    const runtime = webCtx?.get?.('webRuntime')
    if (runtime && Array.isArray(runtime.trustedHosts)) trustedHosts = runtime.trustedHosts
  } catch { /* 非 web 载体没有 webRuntime 服务 */ }
  const hostTrusted = typeof hostHeader === 'string' && trustedHosts.some((entry) => {
    const value = String(entry)
    return value === hostHeader || value === hostHeader.replace(/:\d+$/, '')
  })
  if (!hostIsLoopback && !hostTrusted) {
    return { status: 403, reason: 'host-untrusted', error: 'Host 不是本机可信托管名，已拒绝' }
  }
  if (hostIsLoopback && req.socket !== undefined && !loopbackRemote) {
    return { status: 403, reason: 'host-untrusted', error: 'Host 自称 loopback 但连接不来自 loopback，已拒绝' }
  }
  return null
}

/**
 * skills-manager 的本地信任栅栏（F6 审计 2026-09-11 口径，FIX-04 收敛到本
 * 模块，消除第 9 份手写副本；R24 B3 起 Host 判据与 {@link guardRequestReasoned}
 * 共用 {@link hostTrustFence}）。与 {@link guardRequest} 的差别是**刻意的**：
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
  const hostDenied = hostTrustFence(req, webCtx)
  if (hostDenied !== null) return { status: hostDenied.status, body: { error: 'forbidden' } }
  if (String(req.headers?.['sec-fetch-site'] ?? '') === 'cross-site') {
    return { status: 403, body: { error: 'forbidden' } }
  }
  const originHeader = req.headers?.origin
  if (typeof originHeader === 'string') {
    let originHost = ''
    try { originHost = new URL(originHeader).host } catch { originHost = '' }
    if (originHost !== req.headers?.host) return { status: 403, body: { error: 'forbidden' } }
  }
  return null
}
