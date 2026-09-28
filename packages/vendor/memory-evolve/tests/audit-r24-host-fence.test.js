/**
 * tests/audit-r24-host-fence.test.js — R24 B3（P1）判据：memory-evolve 的
 * **全部** `webServer.register` 注册点（读+写）都必须过同一份 Host 信任栅栏。
 *
 * 缺陷（X4 审计实跑，2026-09-26）：写侧唯一判据是 `Origin == Host`
 * （`lib/http-guard.js` 的 `sameOriginGuard`），而两端都可以被攻击者页面写成
 * 同一个值 ⇒ **DNS rebinding**（`Host: attacker.example` 解析到 127.0.0.1，
 * 浏览器同时把 `Origin` 填成 `http://attacker.example`、`Sec-Fetch-Site:
 * same-origin`）可以：
 *   - `GET /memory-evolve/api/memory` 读全部记忆；
 *   - `POST …/delete`、`…/archive` 删除/归档既有条目（**落盘**）；
 *   - `POST /memory-evolve/api/coi/tasks` 让本机 dispatch 外部 CLI 任务。
 * 同一个文件里早有正确判据（`localTrustFence` 的 Host 判据），但**只有**
 * `lib/skills-manager.js` 用它 —— 11 个注册点里 10 个没有 Host 栅栏。
 *
 * 修复：Host 栅栏提到共享模块的 `hostTrustFence`（唯一实现），成为
 * `guardRequest` / `guardRequestReasoned` 的**第一条**判据；`localTrustFence`
 * 复用同一份。每个注册点把注册时的 web ctx 传进守卫（读 `webRuntime.
 * trustedHosts`）。
 *
 * 本文件的三块判据（缺任何一块都有假绿空间）：
 *  A. **逐点rebinding 矩阵**：11 个注册点 × {读, 写} × {Host/Origin 都是
 *     攻击者域} ⇒ 403；同一批注册点在同机形态下照常工作（≠403）。
 *  B. **Host 名判据矩阵**：loopback 三形态放行；`trustedHosts` 声明放行、
 *     未声明拒绝；缺 Host 一律拒（fail-closed）；Host 自称 loopback 但 socket
 *     来自局域网 ⇒ 拒。
 *  C. **逐点 trustedHosts 穿线**：每个注册点在声明了 `trustedHosts` 时放行该
 *     权威 —— 这条同时证明"webCtx 真的传到了守卫"（漏传参数会让局域网被误拒）。
 *
 * 「改前失败」证据：把 `guardRequestReasoned` 的 `hostTrustFence` 调用去掉
 * （或把某个注册点的 4 个实参退回 3 个 + 让该点只判 Origin==Host），A 的
 * rebinding 断言在该点变红（200/201/400），C 的 trustedHosts 断言在该点变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installApi } from '../lib/api.js'
import { installBookmarks } from '../lib/bookmarks.js'
import { installCanvas } from '../lib/canvas.js'
import { installMermaid } from '../lib/mermaid.js'
import { NotificationStore, installNotifyWebApi } from '../lib/notify-web.js'
import { installUiSettings } from '../lib/ui-settings.js'
import { installPrompts } from '../lib/prompts.js'
import { installCoiApi } from '../lib/coi/api.js'
import { installBroadcastApi } from '../lib/coi/broadcast-api.js'
import { installAdvisorApi } from '../lib/advisor/api.js'
import { installSkillsManager } from '../lib/skills-manager.js'

/** 攻击者控制的域名（保留命名空间：公开仓纪律）。 */
const ATTACKER = 'attacker.example'
const LAN = '10.9.9.9:3456'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-r24-host-fence-'))
}

/**
 * 通用 fake ctx：录制 `webServer.register` 的路由，并提供最小服务面让 11 个
 * 安装函数都能装起来。`webRuntime` 只在显式传入时存在（模拟"未声明的局域网
 * 权威"这一默认形态）。
 */
function makeCtx(options = {}) {
  const routes = []
  const noopDisposer = () => {}
  const services = {
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    skills: {
      list: async () => [],
      get: async () => undefined,
      register: () => noopDisposer,
      registerProvider: () => noopDisposer,
    },
    tools: { register: () => noopDisposer },
    systemPrompt: { context: () => noopDisposer },
    agents: { get: () => undefined },
    workspaceRegistry: { list: () => [] },
    agentPresets: { standingKeyFor: async () => ({ agentPreset: 'standard' }) },
    logger: { warn: () => {} },
  }
  if (options.webRuntime !== undefined) services.webRuntime = options.webRuntime
  const ctx = {
    routes,
    get: (key) => services[key],
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: noopDisposer }
      const disposer = callback(ctx)
      return { dispose: typeof disposer === 'function' ? disposer : noopDisposer }
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : noopDisposer
    },
    on: () => noopDisposer,
    ...services,
  }
  return ctx
}

/** 11 个注册点：id / 路由前缀 / 已注册的读路径 / 安装函数 / 拒绝时的错误码。
 *
 * `readPath` 必须是该模块**认识**的端点：`lib/advisor/api.js` 的未知端点判定
 * 排在守卫**之前**（`if (!known) return 404`），探针打未知路径会拿到 404 而看
 * 不到 Host 栅栏。其余注册点守卫在最前，路径只影响"放行后走到哪里"。 */
function registrationPoints(dir) {
  return [
    {
      id: 'lib/api.js',
      prefix: '/memory-evolve',
      readPath: '/memory-evolve/api/aliases',
      code: 'untrusted-host',
      mount: (ctx) => installApi(ctx, {
        store: {}, archive: {}, queue: {}, todoStore: {},
        getRuntime: () => ({}),
        updateRuntime: () => ({}),
        aliases: { all: () => ({}), set: () => ({ ok: true }), remove: () => ({ ok: true }) },
        config: { memoryDir: dir, skillDir: join(dir, 'skills') },
        resolveCwd: () => undefined,
      }),
    },
    { id: 'lib/bookmarks.js', prefix: '/memory-evolve/api/bookmarks', readPath: '/memory-evolve/api/bookmarks/state', code: 'untrusted-host', mount: (ctx) => installBookmarks(ctx, { memoryDir: dir }) },
    { id: 'lib/canvas.js', prefix: '/memory-evolve/api/canvas', readPath: '/memory-evolve/api/canvas/state', code: 'untrusted-host', mount: (ctx) => installCanvas(ctx, { memoryDir: dir }, () => undefined, () => null) },
    { id: 'lib/mermaid.js', prefix: '/memory-evolve/mermaid', readPath: '/memory-evolve/mermaid/mermaid.min.js', code: 'untrusted-host', mount: (ctx) => installMermaid(ctx) },
    {
      id: 'lib/notify-web.js',
      prefix: '/memory-evolve/api/notifications',
      readPath: '/memory-evolve/api/notifications/unread',
      code: 'untrusted-host',
      mount: (ctx) => installNotifyWebApi(ctx, { store: new NotificationStore(dir), resolveSenderName: (id) => id }),
    },
    { id: 'lib/ui-settings.js', prefix: '/memory-evolve/api/ui-settings', readPath: '/memory-evolve/api/ui-settings/state', code: 'untrusted-host', mount: (ctx) => installUiSettings(ctx, { getRunningSnapshot: () => ({ total: 0, groups: [] }) }) },
    { id: 'lib/prompts.js', prefix: '/memory-evolve/api/prompts', readPath: '/memory-evolve/api/prompts/injections', code: 'untrusted-host', mount: (ctx) => installPrompts(ctx, { memoryDir: dir }) },
    { id: 'lib/coi/api.js', prefix: '/memory-evolve/api/coi', readPath: '/memory-evolve/api/coi/adapters', code: 'untrusted-host', mount: (ctx) => installCoiApi(ctx, { config: {}, runtimeConfig: () => ({}), updateRuntimeConfig: () => ({ ok: true }), resolveCwd: () => undefined }) },
    {
      id: 'lib/coi/broadcast-api.js',
      prefix: '/memory-evolve/api/broadcast',
      readPath: '/memory-evolve/api/broadcast/messages',
      code: 'untrusted-host',
      mount: (ctx) => installBroadcastApi(ctx, {
        broadcast: { items: [], rooms: () => [] },
        presence: { get: () => undefined, roomStatus: () => [] },
      }),
    },
    {
      id: 'lib/advisor/api.js',
      prefix: '/memory-evolve/api/advisor',
      readPath: '/memory-evolve/api/advisor/config',
      // advisor 的未知端点 404 排在守卫之前（既有顺序，`advisor-api.test.js`
      // 钉住了它），所以写探针也要打**已注册**的端点才看得到 Host 栅栏。
      writePath: '/memory-evolve/api/advisor/toggle',
      // advisor 有自己的错误契约（reason → 400/403/413/415），Host 拒绝映射
      // 成 403 FORBIDDEN（见 guardDenialToContract）。
      code: 'FORBIDDEN',
      mount: (ctx) => installAdvisorApi(ctx, {
        configSnapshot: () => ({}), sessionExists: () => true, status: () => ({}),
        queryEvents: () => ({ events: [], seq: 0 }), queryRecords: () => ({ records: [] }),
        instructionsOf: () => [], scopesOf: () => ({}), setSessionOverride: () => ({}),
      }),
    },
    {
      id: 'lib/skills-manager.js',
      prefix: '/skills-manager',
      readPath: '/skills-manager/api/skills',
      // skills-manager 用自己的 403 契约（{error:'forbidden'}），Host 拒绝走
      // 同一份 hostTrustFence。
      code: null,
      mount: (ctx) => installSkillsManager(ctx, { stateFile: join(dir, 'skills-state.json') }),
    },
  ]
}

/** 起一个真实 node:http 服务器，按上游 WebServer 的最长前缀规则派发。 */
async function serve(routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    let best
    for (const route of routes) {
      if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue
      if (best === undefined || route.path.length > best.path.length) best = route
    }
    if (best === undefined) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"error":"not found"}')
      return
    }
    return best.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    localHost: `127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * 裸 http.request 打一条请求（`fetch` 会剥掉我们设的 Host ⇒ rebinding 形态
 * 造不出来，必须用裸请求；X4 审计第一版假阴性就是这个原因）。
 */
function raw(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let parsed = {}
        try { parsed = JSON.parse(data) } catch { /* 非 JSON 响应（mermaid 静态资源等） */ }
        resolve({ status: res.statusCode, data: parsed, text: data })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** 每个注册点起一次服务器，跑完 6 条读数。 */
async function readPoint(point, dir, webRuntime) {
  const ctx = makeCtx(webRuntime === undefined ? {} : { webRuntime })
  point.mount(ctx)
  assert.equal(ctx.routes.length, 1, `${point.id}: 期望恰好注册 1 条前缀路由，实际 ${ctx.routes.length}`)
  const server = await serve(ctx.routes)
  const { port, localHost } = server
  const readPath = point.readPath
  // 写探针默认打在未知路径上：写侧守卫先于路由，Host/Origin 判据在路由之前生效。
  const writePath = point.writePath ?? `${point.prefix}/__r24_probe__`
  const jsonBody = { probe: true }
  try {
    return {
      // ① rebinding：Host 与 Origin 都是攻击者域，且浏览器标注 same-origin
      //    （旧判据 Origin == Host 在这里**通过**，所以这条是杀死回退的读数）。
      rebindRead: await raw(port, 'GET', readPath, { host: ATTACKER, origin: `http://${ATTACKER}`, 'sec-fetch-site': 'same-origin' }),
      rebindWrite: await raw(port, 'POST', writePath, { host: ATTACKER, origin: `http://${ATTACKER}`, 'sec-fetch-site': 'same-origin' }, jsonBody),
      // ② 只有 Origin 合法（Host 非法）⇒ Host 栅栏拒；只有 Host 合法而 Origin
      //    非法 ⇒ 读侧无 Origin 判据（既有语义），写侧由 Origin 同源规则拒。
      originOnly: await raw(port, 'GET', readPath, { host: ATTACKER, origin: `http://${localHost}`, 'sec-fetch-site': 'same-origin' }),
      hostOnly: await raw(port, 'POST', writePath, { host: localHost, origin: `http://${ATTACKER}`, 'sec-fetch-site': 'same-origin' }, jsonBody),
      // ③ 正常本机形态照常工作（Host 与 Origin 都是 loopback）
      localRead: await raw(port, 'GET', readPath, { host: localHost, origin: `http://${localHost}`, 'sec-fetch-site': 'same-origin' }),
      localWrite: await raw(port, 'POST', writePath, { host: localHost, origin: `http://${localHost}`, 'sec-fetch-site': 'same-origin' }, jsonBody),
      // ④ 局域网形态：Host 是 trustedHosts 里已声明的权威（webCtx 穿线的判据）
      trustedRead: await raw(port, 'GET', readPath, { host: LAN, 'sec-fetch-site': 'same-origin' }),
      trustedWrite: await raw(port, 'POST', writePath, { host: LAN, origin: `http://${LAN}`, 'sec-fetch-site': 'same-origin' }, jsonBody),
      // ⑤ 未声明 trustedHosts 时，同一个局域网 Host 必须被拒
      untrustedRead: webRuntime === undefined
        ? await raw(port, 'GET', readPath, { host: LAN, 'sec-fetch-site': 'same-origin' })
        : null,
    }
  } finally {
    await server.close()
  }
}

test('[R24 B3] rebinding 形态（Host/Origin 都是攻击者域）在全部 11 个注册点上读与写都拒', async () => {
  const dir = tempDir()
  const matrix = []
  try {
    for (const point of registrationPoints(dir)) {
      const r = await readPoint(point, dir, { trustedHosts: [LAN] })
      matrix.push({ point, r })
      assert.equal(r.rebindRead.status, 403, `${point.id} 读面 rebinding 未拒（${r.rebindRead.status}）：${r.rebindRead.text.slice(0, 120)}`)
      assert.equal(r.rebindWrite.status, 403, `${point.id} 写面 rebinding 未拒（${r.rebindWrite.status}）：${r.rebindWrite.text.slice(0, 120)}`)
      if (point.code !== null) {
        assert.equal(r.rebindRead.data.code, point.code, `${point.id} 读面拒绝码`)
        assert.equal(r.rebindWrite.data.code, point.code, `${point.id} 写面拒绝码`)
      }
      assert.notEqual(r.originOnly.status, undefined)
      assert.equal(r.originOnly.status, 403, `${point.id}：Origin 合法而 Host 非法必须拒`)
      // "只有 Host 合法而 Origin 不合法"：读侧既有语义不设 Origin 判据（GET 的
      // 跨站由 Host 栅栏 + Sec-Fetch-Site 承担），写侧由 Origin 同源规则拒。
      assert.ok(r.hostOnly.status >= 400, `${point.id}：Host 合法而 Origin 非法的写请求必须拒（实际 ${r.hostOnly.status}）`)
      // 正常本机形态照常工作（守卫不得把 GUI 打死）。
      assert.notEqual(r.localRead.status, 403, `${point.id}：本机读被误拒`)
      assert.notEqual(r.localWrite.status, 403, `${point.id}：本机写被误拒`)
    }
    // 逐点读数矩阵（施工与复核的对照表）。
    const rows = matrix.map(({ point, r }) =>
      `[R24 ${point.id}] rebindRead=${r.rebindRead.status} rebindWrite=${r.rebindWrite.status} originOnly=${r.originOnly.status} hostOnly=${r.hostOnly.status} localRead=${r.localRead.status} localWrite=${r.localWrite.status} trustedRead=${r.trustedRead.status} trustedWrite=${r.trustedWrite.status}`)
    console.log(rows.join('\n'))
    assert.equal(matrix.length, 11, '注册点数量变化：请同步本判据')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[R24 B3] webCtx 必须穿到守卫：11 个注册点都放行已声明的 trustedHosts，未声明时拒绝', async () => {
  const dir = tempDir()
  try {
    for (const point of registrationPoints(dir)) {
      // 声明了权威 ⇒ 该 Host 放行（要求守卫真的读到了 webRuntime）。
      const declared = await readPoint(point, dir, { trustedHosts: [LAN] })
      assert.notEqual(declared.trustedRead.status, 403, `${point.id}：已声明的 trustedHosts 被拒 —— webCtx 没传到守卫？`)
      assert.notEqual(declared.trustedWrite.status, 403, `${point.id}：已声明的 trustedHosts 写请求被拒 —— webCtx 没传到守卫？`)
      // 未声明 ⇒ 同一个 Host 一律拒（默认不放宽到任意主机）。
      const undeclared = await readPoint(point, dir, undefined)
      assert.equal(undeclared.untrustedRead.status, 403, `${point.id}：未声明的非 loopback Host 未被拒`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[R24 B3] Host 名判据矩阵：loopback 三形态放行、缺 Host 拒、socket 非 loopback 拒', async () => {
  const dir = tempDir()
  try {
    const ctx = makeCtx()
    installBookmarks(ctx, { memoryDir: dir })
    const handler = ctx.routes[0].handler
    const call = async (headers, socket) => {
      const res = { status: 0, body: '', writeHead(status) { this.status = status }, end(text) { this.body = text ?? '' } }
      const req = { method: 'GET', url: '/memory-evolve/api/bookmarks/__r24_probe__', headers, socket }
      await handler(req, res)
      return res
    }
    const loopbackSocket = { remoteAddress: '127.0.0.1' }
    for (const host of ['127.0.0.1:3456', 'localhost:3456', '[::1]:3456']) {
      const res = await call({ host }, loopbackSocket)
      assert.notEqual(res.status, 403, `loopback 形态 ${host} 被误拒`)
    }
    // 缺 Host：真实 HTTP/1.1 请求必然带 Host，缺失只出现在非标准载体上 ⇒
    // fail-closed（没有可判证据时不做信任假设）。
    assert.equal((await call({}, loopbackSocket)).status, 403, '缺 Host 必须拒（fail-closed）')
    // Host 自称 loopback 但 socket 来自局域网 ⇒ 拒（`dsh web --host 0.0.0.0` 时
    // 的伪造形态）。
    assert.equal((await call({ host: '127.0.0.1:3456' }, { remoteAddress: '10.0.0.7' })).status, 403, 'Host 自称 loopback 但 socket 非 loopback 必须拒')
    // 攻击者域 ⇒ 拒。
    assert.equal((await call({ host: ATTACKER }, loopbackSocket)).status, 403, '攻击者域必须拒')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('[R24 B3] 结构性：Host 栅栏只有一份实现，且没有注册点保留本地副本', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const libDir = fileURLToPath(new URL('../lib', import.meta.url))
  const walk = (dir) => readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : (entry.endsWith('.js') ? [full] : [])
  })
  const files = walk(libDir)
  const definitions = files.filter((file) => /function\s+hostTrustFence\s*\(/.test(readFileSync(file, 'utf8')))
  assert.deepEqual(
    definitions.map((file) => file.slice(libDir.length + 1)),
    ['http-guard.js'],
    'Host 栅栏必须只有 lib/http-guard.js 一份实现',
  )
  // 其它模块不得再自己判 Host（本地副本 = 策略漂移，FIX-04 的教训）。判据只看
  // **定义**，不看注释里的说明文字。
  const copies = files
    .filter((file) => !file.endsWith('http-guard.js'))
    .filter((file) => {
      const src = readFileSync(file, 'utf8')
      return /function\s+hostTrustFence\s*\(|(?:const|let|var)\s+hostIsLoopback\b|function\s+sameOriginGuard\s*\(/.test(src)
    })
  assert.deepEqual(copies, [], 'Host 判据出现本地副本')
})
