/** Mock gateway used by the client E2E tool (fixed port 34567).
 *  职责:模拟企业网关 /api/client/v2/* 供登录与各面板取数;同时 e2e 把桌面
 *  app 整体指向本 fixture,enterprise host 的本地代理(如 /api/pico/*)与
 *  DSH host 路由(如 /api/workspaces)打到此处时也返回空/固定模拟。
 *  注意:网关路由必须与 server/internal/router/router.go 的 registerClientV2
 *  一致(2026-09-01 已删除 /api/client/v2/models、/config/models、
 *  /auth/session 三个服务端无声明的死路由);保留的其它路径是 host 模拟。
 *
 *  2026-09-16 (P0-5) 新增两个**非**企业网关契约的 E2E 专用端点:
 *   · `/api/<project>/store/` + `/api/<project>/envelope/` —— Sentry 兼容摄取
 *     端点,只为本 fixture 自报的本地 mock DSN 服务,用来证明「客户端 → 错误
 *     监控后端」这条链路真的通(见 bootstrap 里的 web 段)。
 *   · `GET /__e2e/sentry-events` —— 摄取账本查询面,供 e2e-client.mjs 断言。 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

/** 本 fixture 的监听端口。bootstrap 自报的 mock DSN 与 e2e-client 的
 *  GATEWAY_PORT 都必须与它一致(可用 E2E_GATEWAY_PORT 覆盖)。 */
const PORT = Number(process.env.E2E_GATEWAY_PORT ?? 34567)

/** Sentry 摄取端点账本(进程内,`GET /__e2e/sentry-events` 暴露)。 */
const sentry = {
  /** 收到的摄取请求总数(含鉴权失败被拒的)。 */
  requests: 0,
  /** 真正携带 event item 的条数 —— e2e 断言读的就是这个。 */
  events: [],
  /** session item 条数(@sentry/node 默认自动上报会话,不是错误事件)。 */
  sessions: 0,
  /** 鉴权来源计数:标准头 / 查询串 / 两者都没有(被拒)。 */
  authHeader: 0,
  authQuery: 0,
  authMissing: 0,
}

/** Sentry 摄取路径:`/api/<project_id>/store/`(旧版 store API)与
 *  `/api/<project_id>/envelope/`(@sentry/node 7.x 实际使用的路径)。 */
const SENTRY_INGEST = /^\/api\/\d+\/(?:store|envelope)\/?$/

/** 读取请求体(必要时解 gzip —— Sentry node transport 超过阈值会压)。 */
function readBody(req, done) {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    if (String(req.headers['content-encoding'] ?? '').toLowerCase().includes('gzip')) {
      try {
        done(gunzipSync(raw))
        return
      } catch { /* 解压失败就按原文处理,让下面的解析去丢弃 */ }
    }
    done(raw)
  })
}

/** 拆 Sentry envelope(首行 envelope header,之后每项两行:item header + payload),
 *  或退化为单条 store JSON。返回 [{ type, payload }]。 */
function parseSentryItems(raw) {
  const text = raw.toString('utf8')
  const items = []
  const lines = text.split('\n')
  if (lines.length >= 3 && (lines[0] ?? '').startsWith('{')) {
    for (let i = 1; i + 1 < lines.length; i += 2) {
      const headerLine = lines[i] ?? ''
      if (!headerLine.startsWith('{')) continue
      try {
        items.push({ type: JSON.parse(headerLine).type, payload: lines[i + 1] })
      } catch { /* 跳过坏行 */ }
    }
    if (items.length > 0) return items
  }
  try {
    const event = JSON.parse(text)
    if (event !== null && typeof event === 'object') return [{ type: 'event', payload: text }]
  } catch { /* 不是 JSON */ }
  return []
}

/** 从 event payload 里摘出断言需要的字段(解析失败一律 null)。
 *
 * 2026-09-16(修复轮 1 / F-11):补 `tags` 与 `exception` —— 「渲染进程未捕获错误
 * 真实进链路」的断言必须能分辨事件来源(主进程 vs 渲染进程),否则只要有任何
 * 事件到达就会假绿(那正是这条断言要消灭的形态)。 */
function summarizeEvent(payload) {
  try {
    const event = JSON.parse(payload)
    const logentry = event?.logentry
    const exception = Array.isArray(event?.exception?.values) ? event.exception.values[0] : null
    const tags = event?.tags !== null && typeof event?.tags === 'object' ? event.tags : {}
    return {
      level: typeof event?.level === 'string' ? event.level : null,
      message: typeof event?.message === 'string'
        ? event.message
        : (typeof logentry?.message === 'string' ? logentry.message : null),
      exception_value: typeof exception?.value === 'string' ? exception.value : null,
      process_tag: typeof tags?.['picoaide.process'] === 'string' ? tags['picoaide.process'] : null,
      kind_tag: typeof tags?.['picoaide.kind'] === 'string' ? tags['picoaide.kind'] : null,
      release: typeof event?.release === 'string' ? event.release : null,
      event_id: typeof event?.event_id === 'string' ? event.event_id : null,
    }
  } catch {
    return {
      level: null,
      message: null,
      exception_value: null,
      process_tag: null,
      kind_tag: null,
      release: null,
      event_id: null,
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  process.stderr.write(`[gw] ${req.method} ${url.pathname}\n`)
  res.setHeader('Content-Type', 'application/json')

  // Sentry 兼容摄取端点。必须排在下方 `/api/*` 兜底之前,否则会被
  // `{ok:true}` 吞掉(SDK 只看 2xx,不会报错,断言就永远等不到事件)。
  if (SENTRY_INGEST.test(url.pathname)) {
    // 鉴权:@sentry/node 7.x 走**查询串**(sentry_key=...,见 @sentry/core 的
    // _encodedAuth:"Sending auth as part of the query string and not as custom
    // HTTP headers avoids CORS preflight requests"),X-Sentry-Auth 头是 Sentry
    // 的另一条标准通道。两者都认,但**必须有一个**,否则 401 —— 不做"无鉴权也
    // 照收"的宽松 mock,否则这条断言证明不了 DSN 真的被客户端采用。
    const authHeader = req.headers['x-sentry-auth']
    const queryKey = url.searchParams.get('sentry_key')
    readBody(req, (raw) => {
      sentry.requests += 1
      if (authHeader) sentry.authHeader += 1
      if (queryKey) sentry.authQuery += 1
      if (!authHeader && !queryKey) {
        sentry.authMissing += 1
        res.statusCode = 401
        res.end(JSON.stringify({ detail: 'missing X-Sentry-Auth header / sentry_key query' }))
        return
      }
      for (const item of parseSentryItems(raw)) {
        if (item.type === 'session') { sentry.sessions += 1; continue }
        if (item.type === 'event') sentry.events.push(summarizeEvent(item.payload))
      }
      res.statusCode = 200
      res.end(JSON.stringify({ event_id: randomBytes(16).toString('hex') }))
    })
    return
  }

  // 摄取账本:交给 e2e-client.mjs 断言「客户端 → 错误监控后端」链路真的通了。
  // `count` = 收到的 **event** 条数(session item 不算,否则 @sentry/node 每次
  // init 自动发的 session envelope 就能把计数顶到 1,又是一个假绿)。
  if (url.pathname === '/__e2e/sentry-events') {
    res.end(JSON.stringify({
      count: sentry.events.length,
      requests: sentry.requests,
      sessions: sentry.sessions,
      auth: { header: sentry.authHeader, query: sentry.authQuery, missing: sentry.authMissing },
      events: sentry.events.slice(-10),
    }))
    return
  }

  if (url.pathname === '/api/client/v2/auth/login') {
    res.end(JSON.stringify({ token: 'mock-token-123', user: { username: 'admin' } }))
    return
  }
  // 2026-09 客户端登录页方法选择器: 返回启用的认证方式(local 恒启用)。
  if (url.pathname === '/api/client/v2/auth/methods') {
    res.end(JSON.stringify({ methods: [{ name: 'local', configured: true }] }))
    return
  }
  if (url.pathname === '/api/client/v2/auth/me') {
    res.end(JSON.stringify({ username: 'admin', id: 1, department: 'dev', token: 'mock-token-123' }))
    return
  }
  if (url.pathname === '/api/client/v2/auth/usage') {
    // 真实契约(server handleUsageSummary):**直接字段**,没有 data 外壳。
    // account-card 的 UsageService 直接使用该响应作为 snapshot.data;
    // 旧 fixture 包了一层 data,导致 remaining_money/monthly_cost 等字段
    // 实际全是 undefined(账户卡静默显示空态,测试却"通过")——按真实形状返回。
    res.end(JSON.stringify({
      // 2026-09-11:配额字段已下线,员工唯一可花的钱 = 账户余额。
      // 键集合必须与 packages/client/account-card/src/usage-contract.ts 的
      // USAGE_PAYLOAD_KEYS 一致(形状不符时 UsageService 会保持空态)。
      is_admin: false,
      monthly_usage: 1234, monthly_cost: 12.3,
      today_usage: 0, today_cost: 0.5,
      yesterday_usage: 0, yesterday_cost: 0,
      total_usage: 0, total_cost: 25.6,
      balance_money: 88.5, balance_activated: true, balance_enabled: true,
      balance_monthly: 100, balance_mode: 'add',
    }))
    return
  }
  if (url.pathname === '/api/client/v2/config/bootstrap') {
    res.end(JSON.stringify({
      // 形状必须是一份**服务端真的会下发的** bootstrap,两条陷阱都在
      // server-connector/bootstrap.ts 的 validateBootstrap():
      //  ① `models` 为空/非数组 => 整份 config 被换成 EMPTY(`web: {}`),错误监控
      //     开关与 DSN 一起消失;
      //  ② `default_model` 缺失或不在 models 的 id 里 => 返回 fellBack=true。
      //     客户端 error-reporting.ts 现在把 fellBack 当"服务端配置不可用"直接
      //     return(2026-09-16 起),于是**一个字节都不发**。
      // 所以 default_model 必须显式给出**且命中** models 里的 id —— 少了它这条
      // 断言会以"链路没坏、只是配置被判为不可用"的方式静默变红。
      default_model: 'deepseek-v4',
      models: [
        { id: 'deepseek-v4', name: 'DeepSeek V4', provider: 'deepseek' },
        { id: 'pico-v4-pro', name: 'Pico AI V4 Pro', provider: 'picoai' },
      ],
      user: { username: 'admin', id: 1, department: 'dev' },
      usage: { balance: 100, quota: 1000 },
      serverTime: Date.now(),
      // 错误监控(2026-09-16 P0-5):**必须**是本 fixture 自己的本地 mock DSN。
      // 旧写法硬编码了生产 GlitchTip 地址 + public key(本仓 2026-08-27 刚对该域名
      // 做过一次 git filter-repo 清理,硬编码回来就是回归),而且缺
      // error_reporting_enabled 时 error-reporting.ts 走 `=== true` 判定为 false,
      // 直接 initSentry('') —— E2E 从来没有执行过上报链路(假绿)。
      // 三个字段是**一组**:enabled 决定 init、heartbeat 决定客户端发不发那条可被
      // 观测的正向事件、level 决定普通事件的阈值。少任何一个都会让断言失去意义。
      //
      // DSN 指向本进程的 Sentry 摄取端点(见上方 SENTRY_INGEST)。
      // public key 只能取 \w+:@sentry/utils 的 DSN_REGEX 是
      // /^(?:(\w+):)\/\/(?:(\w+)(?::(\w+)?)?@)/,写 `e2e-key` 会被判
      // "Invalid Sentry Dsn" 并静默降级(又一条假绿),所以是 `e2e_key`。
      //
      // 注意:127.0.0.1 这个 DSN 会被 **webadmin 侧**的 DSN 校验拒绝
      // (server/webadmin ErrorMonitoring.tsx 只收 http(s) 且服务端另有校验)。
      // 这是**有意**的:E2E 走的是**客户端**路径(bootstrap 下发 →
      // enterprise/error-reporting.ts 直接 initSentry),不经过 webadmin。
      web: {
        error_reporting_enabled: true,
        // 正向心跳(P1-2):客户端**只在**本开关打开时才发那条带 `picoaide.heartbeat`
        // tag 的 info 自检 `客户端错误上报链路自检 (<release>)` —— 它是"链路活着"
        // 的唯一正向信号(2026-09-16 起,无条件发 info 自检已被移除:level=error 的
        // 部署不该被自检噪声打搅)。本 fixture 必须打开它,否则永远等不到事件。
        error_reporting_heartbeat: true,
        // 阈值保持 debug:心跳事件带 tag、**绕过**阈值,所以这不是心跳能否到达的
        // 前提;留着 debug 是为了顺带把**普通**等级过滤路径也跑在真实配置下。
        error_reporting_level: 'debug',
        error_reporting_dsn: `http://e2e_key@127.0.0.1:${PORT}/1`,
      },
    }))
    return
  }
  if (url.pathname.includes('skill')) {
    res.end(JSON.stringify([
      { id: 'skill-1', name: '代码审计', description: 'CodeQL 审计', installed: true, version: '1.0.0' },
      { id: 'skill-2', name: '钉钉集成', description: 'DingTalk 办公', installed: false, version: '0.1.0' },
    ]))
    return
  }
  if (url.pathname === '/api/workspaces' || url.pathname === '/api/workspace' || url.pathname === '/api/pico/workspaces') {
    res.end(JSON.stringify({ workspaces: [
      { id: 'ws-1', name: '测试工作区', path: '/tmp/ws1', cwd: '/tmp/ws1' },
      { id: 'ws-2', name: '生产工作区', path: '/tmp/ws2', cwd: '/tmp/ws2' },
    ], current: 'ws-1' }))
    return
  }
  if (url.pathname.startsWith('/api/sessions') || url.pathname === '/api/conversations') {
    res.end(JSON.stringify({ sessions: [], session: null, conversations: [] }))
    return
  }
  if (url.pathname === '/api/cron' || url.pathname.startsWith('/api/cron/') || url.pathname === '/api/jobs' || url.pathname.startsWith('/api/jobs/')) {
    res.end(JSON.stringify({ jobs: [], items: [] }))
    return
  }
  if (url.pathname === '/api/client/v2/agent-presets' || url.pathname.startsWith('/api/client/v2/agent-presets/')) {
    res.end(JSON.stringify({
      presets: [
        { name: 'shared-demo', display_name: '共享演示', description: '演示预设', version: '1.0.0', author: 'admin', status: 'approved', reason: '', created_at: '2026-08-01T10:00:00+08:00' },
      ],
      installed: [],
      local: {},
    }))
    return
  }
  if (url.pathname === '/api/client/v2/shared-skills' || url.pathname.startsWith('/api/client/v2/shared-skills/')) {
    res.end(JSON.stringify({
      skills: [
        { name: 'codeql-demo', display_name: '代码审计演示', version: '1.0.0', description: '演示技能', author: 'admin', status: 'approved', reason: '', created_at: '2026-08-01T10:00:00+08:00' },
      ],
      installed: [],
      local: [],
    }))
    return
  }
  if (url.pathname.startsWith('/api/admin') || url.pathname.startsWith('/api/pico')) {
    res.end(JSON.stringify({ ok: true, items: [] }))
    return
  }
  if (url.pathname.startsWith('/api/')) {
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
})
server.listen(PORT, '127.0.0.1', () => console.log(`e2e mock gateway on ${PORT}`))
