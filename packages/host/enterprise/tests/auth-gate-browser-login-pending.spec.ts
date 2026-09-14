import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/auth-gate.ts'
import { brandMarkSvg } from '../src/channel-geometry.ts'
import type { Session } from '../src/server-connector/config.ts'

/**
 * srvcore-1 客户端一半(R7 F3-N1)的**接线存在性**回归。
 *
 * 缺陷:deep-link.ts 新增的「未登录时只接受本机登录页正在等待的那台服务端」
 * 守卫(`noteBrowserLoginStarted`)在真实构建里**没有任何生产调用方** ——
 * `loginPageReportsPending` 恒为 false、判定分支不可达,新 API 只有测试在
 * 调用。真实部署形态下(https 攻击者域名),伪造的 `picoaide://auth?token=…&
 * server=https://attacker.example` 仍把真 token 发给攻击者并采纳其会话,且零告警。
 *
 * 关键架构事实(决定了接线的形状):登录页 HTML 由**宿主进程**经本地 HTTP 服务
 * 下发给 Electron 渲染进程(`window-options.ts`: contextIsolation/nodeIntegration
 * =false/sandbox=true),页面内联脚本**够不到**宿主模块作用域。所以接线不能是
 * "在页面脚本里直接调用 noteBrowserLoginStarted"(那是 ReferenceError,浏览器
 * 登录按钮整条链路失效),而必须经本地 HTTP 面登记:
 *   - 登录页发起浏览器 SSO 前 `POST /api/pico/auth/browser-login {server}`;
 *   - 取消/超时/返回上一步 `DELETE /api/pico/auth/browser-login`;
 *   - 宿主路由(与 login 同口径:`required` 持有性证明)调用共享单例。
 *
 * 本文件钉住三件事:
 *   1) 页面脚本确实在 `window.open` **之前**发出登记请求,复位时发出清除请求
 *      (把它删掉这里就红 —— 该洞不会再静默出现);
 *   2) 宿主路由确实写进 deep-link 的模块级单例,且随后伪造深链一个字节都不外发;
 *   3) 伪造 Origin 的本地进程登记不了(无持有性证明 → 403),不能把守卫反过来
 *      变成"先登记攻击者域名再触发深链"的帮凶。
 */

// ---------------------------------------------------------------------------
// 第一半:页面脚本的接线存在性(真实 LOGIN_HTML + jsdom 内联脚本)
// ---------------------------------------------------------------------------

/** 从 auth-gate.ts 提取 LOGIN_HTML 模板并求值(与 auth-gate-login.spec.ts 同款)。 */
function renderedLoginHTML(): string {
  const src = readFileSync(fileURLToPath(new URL('../src/auth-gate.ts', import.meta.url)), 'utf8')
  const m = src.match(/const LOGIN_HTML = `([\s\S]*?)`\n\nexport interface Config/)
  expect(m, 'LOGIN_HTML template must be findable').not.toBeNull()
  const fn = new Function('brandMarkSvg', `return \`${m![1]!}\``) // eslint-disable-line no-new-func
  return fn(brandMarkSvg)
}

/** 求值后的登录页内联脚本(真实模板,含运行时占位符替换)。 */
function loginScript(): string {
  const html = renderedLoginHTML()
    .replaceAll('__DEFAULT_SERVER__', '')
    .replaceAll('__DEFAULT_SERVER_MARK__', '')
    .replaceAll('__BACK_BUTTON__', '<button type="button" class="back" id="back-btn">← 修改服务端地址</button>')
    .replaceAll('__BRAND_NAME__', 'Test')
    .replaceAll('__BRAND_JSON__', JSON.stringify({
      title: 'Test',
      login: { displayName: 'Test', shortName: 'Test', tagline: '', welcome: '' },
      client: { displayName: 'Test', shortName: 'Test', tagline: '' },
    }))
  return html.match(/<script>([\s\S]*?)<\/script>/i)![1]!
}

/** 切出具名函数的源码(花括号配平;正则截断会在函数体内出现嵌套大括号时失效)。 */
function extractFunction(script: string, header: string): string {
  const start = script.indexOf(header)
  expect(start, `login page script must define ${header}`).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = script.indexOf('{', start); i < script.length; i += 1) {
    if (script[i] === '{') depth += 1
    if (script[i] === '}') {
      depth -= 1
      if (depth === 0) return script.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces while extracting ${header}`)
}

interface PageHarness {
  events: string[]
  openCalls: string[]
  fetchCalls: Array<{ url: string, method: string, body: string }>
  err2: { textContent: string }
  browserBtn: { disabled: boolean }
  waiting: { style: { display: string } }
  browserLogin: () => Promise<void>
  resetBrowserLogin: () => void
}

/**
 * 在最小 DOM 桩上执行**真实登录页脚本**里的 `browserLogin` / `resetBrowserLogin`
 * (本包没有 jsdom 依赖,故不自造整页渲染;这两个函数正是接线所在)。
 * 页面脚本是渲染进程代码:它够不到宿主模块,必须经本地 HTTP 面登记 —— 这里
 * 记录的正是"它到底发了什么请求、按什么顺序"。
 */
function bootLoginPage(opts: { server?: string, registrationStatus?: number } = {}): PageHarness {
  const script = loginScript()
  // 自有断言:模板求值后的脚本必须仍是合法 JS(捕获 `\/` 之类转义破坏)。
  expect(() => { new Function(script) }).not.toThrow() // eslint-disable-line no-new-func

  const events: string[] = []
  const openCalls: string[] = []
  const fetchCalls: PageHarness['fetchCalls'] = []
  const serverValue = opts.server ?? 'https://real-corp.example/'
  const status = opts.registrationStatus ?? 200

  const factory = new Function('document', 'window', 'fetch', `
    var err2 = { textContent: '' }
    var waiting = { style: { display: 'none' } }
    var browserBtn = { disabled: false }
    var currentMethod = 'oidc'
    var pollTimer = 7
    var pollAttempts = 0
    function trimServer(s) { while (s.charAt(s.length - 1) === '/') s = s.slice(0, -1); return s }
    function startPoll() {}
    function clearInterval() {}
    ${extractFunction(script, 'function resetBrowserLogin()')}
    ${extractFunction(script, 'async function browserLogin()')}
    return { browserLogin: browserLogin, resetBrowserLogin: resetBrowserLogin, err2: err2, waiting: waiting, browserBtn: browserBtn }
  `) // eslint-disable-line no-new-func

  const page = factory(
    { getElementById: () => ({ value: serverValue, style: {}, textContent: '' }) },
    {
      open: (url: string) => { events.push(`open ${url}`); openCalls.push(url); return null },
    },
    async (input: unknown, init?: { method?: string, body?: string }) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      fetchCalls.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' })
      events.push(`fetch ${method} ${url}`)
      return { ok: status === 200, status, json: async () => ({ ok: status === 200 }) }
    },
  ) as PageHarness

  page.events = events
  page.openCalls = openCalls
  page.fetchCalls = fetchCalls
  return page
}

describe('登录页浏览器 SSO 的待登录目标登记(srvcore-1 客户端一半接线)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers the pending server over the local API before opening the browser login URL', async () => {
    const h = bootLoginPage()
    await h.browserLogin()

    // ① 登记请求确实发出过,且带的是用户填写的服务端(不是别的来源)。
    const registration = h.fetchCalls.find((c) => c.url.startsWith('/api/pico/auth/browser-login'))
    expect(registration, '登录页必须在打开浏览器前登记待登录服务端').toBeDefined()
    expect(registration!.method).toBe('POST')
    expect(JSON.parse(registration!.body)).toEqual({ server: 'https://real-corp.example/' })

    // ② 顺序必须是"先登记、后 window.open":反过来就有竞态 —— 深链可能先回来。
    const registrationIndex = h.events.findIndex((e) => e.startsWith('fetch POST /api/pico/auth/browser-login'))
    const openIndex = h.events.findIndex((e) => e.startsWith('open '))
    expect(registrationIndex).toBeGreaterThanOrEqual(0)
    expect(openIndex).toBeGreaterThan(registrationIndex)

    // ③ 打开的还是远端 SSO 地址(原来那条链路不能改坏)。
    expect(h.openCalls[0]).toBe('https://real-corp.example/api/client/v2/auth/oidc/login?server=https%3A%2F%2Freal-corp.example%2F')
  })

  it('clears the pending target when the browser login is reset (cancel/timeout/back)', async () => {
    const h = bootLoginPage()
    await h.browserLogin()
    h.resetBrowserLogin()

    const clearing = h.fetchCalls.find((c) => c.url.startsWith('/api/pico/auth/browser-login') && c.method === 'DELETE')
    expect(clearing, '取消/返回时必须清除待登录目标(否则迟到/伪造的回跳仍被接受)').toBeDefined()
  })

  it('fails closed instead of opening the browser when the registration is refused', async () => {
    const h = bootLoginPage({ registrationStatus: 403 })
    await h.browserLogin()

    // 登记被拒还继续打开浏览器 = 员工授权成功后回跳必然被深链守卫拒绝,
    // 表现为"授权完成却永远登不进去";这里必须当场停下并给出可读提示。
    expect(h.openCalls).toEqual([])
    expect(h.err2.textContent).toContain('无法登记浏览器登录')
    expect(h.browserBtn.disabled).toBe(false)
    expect(h.waiting.style.display).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// 第二半:宿主路由把登记写进 deep-link 的共享单例,伪造深链被拦下
// ---------------------------------------------------------------------------

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

/** 让 `guard()` 放行的最小伪造头;`withCookie` = 真页面持有的 dsh-auth cookie。 */
function fakeReq(method: string, url: string, body?: string, withCookie = false): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...(withCookie ? { cookie: 'dsh-auth-127.0.0.1:3080=v1.signature' } : {}),
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse, read: () => { code: number, body: any } } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      body = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

const SESSIONLESS = null

interface HostHarness {
  handler: (path: string) => Route['handler']
  index: (html: string) => string
  /** 宿主 index 被请求过几次 —— 锁"首个登录页请求之前"的启动窗口(R3-N1b)。 */
  indexCalls: () => number
  gateway: Array<{ url: string, authorization: string | null }>
  /** 被深链采纳的会话(applySession 实际收到的) —— 出站为空之外的第二道断言。 */
  applied: Session[]
  /** 本用例那份 deep-link 模块单例里的待登录目标(auth-gate 写的就是它)。 */
  pending: () => string | null
  warns: string[]
  fire: (url: string) => void
}

/**
 * 深链预验证是 fire-and-forget(`void (async …)()`),一次"被接受"的深链可能
 * 在本用例的断言跑完之后才真正 fetch。若那一下落到**下一个用例**刚装好的
 * fetch 桩上,就会把上一条用例的出站记进下一条的账(实测:重负载并发跑整套
 * 时出现过一次)。因此 fetch 桩只把记录投递给"当前活跃的收集器",用例结束
 * 时先把收集器清空再还原桩 —— 迟到的调用直接丢弃,不再污染后来者。
 */
let activeGateway: HostHarness['gateway'] | null = null

/**
 * 装一个 auth-gate(真实 deep-link 模块,不 mock)+ 真实深链监听器。
 * fetch 全部打桩:HTTP 一条都出不去,记录"token 到底发去了哪"。
 *
 * **每条用例都重建一次模块注册表**:待登录目标是模块级单例,若沿用静态 import,
 * 前一条用例的 `noteLoginPageWired()` 会让后一条用例"未接线"的前置条件失真
 * (实测:把 apply() 里的接线删掉后,官方构建用例仍会因残留状态而假绿)。
 * 用例内的 auth-gate 与深链监听器必须来自**同一次** fresh import,才能共享单例。
 * @param config - auth-gate 配置(缺省 = 官方构建:没有预置服务端地址)。
 * @param current - 已登录会话;缺省 null = 未登录。
 */
async function hostHarness(config: Partial<Config> = {}, current: Session | null = SESSIONLESS): Promise<HostHarness> {
  vi.resetModules()
  const gate: typeof import('../src/auth-gate.ts') = await import('../src/auth-gate.ts')
  const link: typeof import('../src/deep-link.ts') = await import('../src/deep-link.ts')

  const routes: Route[] = []
  const gateway: HostHarness['gateway'] = []
  const applied: Session[] = []
  const warns: string[] = []
  let indexCb: ((html: string) => string) | null = null
  let indexCalls = 0
  const fence = {
    requestRejection: (req: { headers: Record<string, unknown> }) =>
      (req.headers['cookie'] === undefined ? (401 as const) : undefined),
  }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => (name === 'connection' ? fence : undefined),
    logger: { info: vi.fn(), warn: (m: string) => { warns.push(String(m)) }, error: vi.fn() },
    picoSession: {
      isRestored: () => true,
      isLoggedIn: () => current !== null,
      getSession: () => current,
      setSession: vi.fn(),
      clear: vi.fn(),
    },
    webServer: {
      tapIndex: (cb: (html: string) => string) => { indexCb = cb; return () => {} },
      register: (route: Route) => { routes.push(route); return () => {} },
    },
  }
  gate.apply(ctx as never, config as Config)

  // 真实深链监听器共享同一份模块级单例(与 session-service 的安装方式一致)。
  let listener: ((url: unknown) => void) | null = null
  const linkCtx = {
    on: (event: string, cb: (url: unknown) => void) => {
      if (event === 'pico/deep-link') listener = cb
      return () => {}
    },
    logger: { info: () => {}, warn: (m: string) => { warns.push(String(m)) }, error: () => {} },
  } as unknown as Context
  link.installDeepLinkListener(linkCtx, (session) => { applied.push(session) }, () => current, 'picoaide')

  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {}
    // 只投给当前用例的收集器(见 activeGateway 的说明)。
    activeGateway?.push({
      url: String(input),
      authorization: headers.Authorization ?? headers.authorization ?? null,
    })
    return new Response('{"user":{"username":"alice"}}', { status: 200, headers: { 'content-type': 'application/json' } })
  }))

  const harness: HostHarness = {
    gateway,
    applied,
    pending: () => link.pendingBrowserLoginServer(),
    warns,
    fire: (url: string) => listener?.(url),
    indexCalls: () => indexCalls,
    index: (html: string) => { indexCalls += 1; return indexCb!(html) },
    handler: (path: string) => {
      const route = routes.find((r) => r.kind === 'exact' && r.path === path)
        ?? routes.find((r) => r.kind === 'prefix' && r.path === path)
      if (route === undefined) throw new Error(`no route ${path}`)
      return route.handler
    },
  }
  activeGateway = gateway
  return harness
}

/** 触发一次伪造深链并等它跑完(预验证是 fire-and-forget)。 */
async function fireAndSettle(fire: (url: string) => void, server: string): Promise<void> {
  fire(`picoaide://auth?token=REAL-EMPLOYEE-TOKEN&server=${encodeURIComponent(server)}&user=eve`)
  await new Promise((r) => setTimeout(r, 60))
}

describe('宿主侧的待登录目标登记(srvcore-1 客户端一半接线)', () => {
  afterEach(() => {
    // 先摘掉收集器再还原 fetch:迟到的 fire-and-forget 出站会被丢弃。
    // (待登录目标不用手动清:每条用例都 vi.resetModules() + fresh import。)
    activeGateway = null
    vi.unstubAllGlobals()
  })

  it('refuses a forged deep link after the login page registered a different server, sending no token', async () => {
    const h = await hostHarness()
    // ① 真页面 (持 dsh-auth cookie) 登记 real-corp —— 宿主必须写进共享单例。
    const { res, read } = fakeRes()
    await h.handler('/api/pico/auth/browser-login')(
      fakeReq('POST', '/api/pico/auth/browser-login', '{"server":"https://real-corp.example/"}', true), res)
    expect(read().code).toBe(200)
    expect(h.pending()).toBe('https://real-corp.example')

    // ② 攻击者的回跳:token 一个字节都不许出站,会话不许被采纳,且必须留痕。
    await fireAndSettle(h.fire, 'https://attacker.example')
    expect(h.gateway).toEqual([])
    expect(h.warns.join(' ')).toContain('no local login is waiting')

    // ③ 正确的那台服务端照常放行(不误伤真实 SSO;书写变体归一后同一台)。
    await fireAndSettle(h.fire, 'https://REAL-CORP.example')
    expect(h.gateway).toHaveLength(1)
    expect(new URL(h.gateway[0]!.url).hostname).toBe('real-corp.example')
    expect(h.gateway[0]!.authorization).toBe('Bearer REAL-EMPLOYEE-TOKEN')
  })

  it('refuses a local process that tries to register the pending server without browser proof', async () => {
    const h = await hostHarness()
    const { res, read } = fakeRes()
    await h.handler('/api/pico/auth/browser-login')(
      fakeReq('POST', '/api/pico/auth/browser-login', '{"server":"https://attacker.example"}'), res)
    expect(read().code).toBe(403)
    expect(read().body.error).toBe('browser session proof required')
    // 没登记成功 ⇒ 守卫不能反过来被攻击者"预登记"自己的域名。
    expect(h.pending()).toBeNull()
  })

  it('clears the pending target on DELETE so a late callback is refused', async () => {
    const h = await hostHarness()
    const post = fakeRes()
    await h.handler('/api/pico/auth/browser-login')(
      fakeReq('POST', '/api/pico/auth/browser-login', '{"server":"https://real-corp.example"}', true), post.res)
    expect(h.pending()).toBe('https://real-corp.example')

    const del = fakeRes()
    await h.handler('/api/pico/auth/browser-login')(
      fakeReq('DELETE', '/api/pico/auth/browser-login', undefined, true), del.res)
    expect(del.read().code).toBe(200)
    expect(h.pending()).toBeNull()

    await fireAndSettle(h.fire, 'https://real-corp.example')
    expect(h.gateway).toEqual([])
    expect(h.warns.join(' ')).toContain('no local login is waiting')
  })

  it('arms the guard with the configured default server when the login page is served', async () => {
    // 渠道构建预置了服务端地址:未登录时登录页显示的就是它。登录页一被下发,
    // 就用它武装守卫 —— 否则"用户从未点过浏览器登录"的窗口里,伪造深链仍然成立。
    const h = await hostHarness({ defaultServer: 'https://harness.example' })
    h.index('<!DOCTYPE html><html><head></head><body></body></html>')
    expect(h.pending()).toBe('https://harness.example')

    await fireAndSettle(h.fire, 'https://attacker.example')
    expect(h.gateway).toEqual([])
    expect(h.warns.join(' ')).toContain('no local login is waiting')
  })

  it('rejects an unsafe or empty server from the registration route', async () => {
    const h = await hostHarness()
    for (const body of ['{"server":"file:///etc/passwd"}', '{"server":"  "}', '{"server":42}', 'not json']) {
      const { res, read } = fakeRes()
      await h.handler('/api/pico/auth/browser-login')(
        fakeReq('POST', '/api/pico/auth/browser-login', body, true), res)
      expect(read().code, body).toBe(400)
    }
    expect(h.pending()).toBeNull()
  })

  // -------------------------------------------------------------------------
  // R3-N1a(P0):官方/无预置地址构建的严格模式。上面 6 条用例恰好绕过这条真实
  // 路径 —— 它们要么配了 defaultServer(渠道构建),要么显式调过
  // noteBrowserLoginStarted。官方渠道包 brands/official/brand.json 的
  // server_url 是空串,于是"没点过浏览器登录"的默认构建里守卫整条是死的。
  // -------------------------------------------------------------------------

  it('refuses a forged deep link in an official build without a configured default server (R3-N1a)', async () => {
    // hostHarness() 不传 defaultServer = 官方构建(configuredServer === '')。
    const h = await hostHarness()
    // 登录页照常下发(旧实现只在这里武装,而 configuredServer === '' 把它挡掉了)。
    h.index('<!DOCTYPE html><html><head></head><body></body></html>')
    expect(h.pending(), '没有预置地址 ⇒ 不登记任何等待目标').toBeNull()

    await fireAndSettle(h.fire, 'https://attacker.example')

    // 两条断言缺一不可:token 不外发 + 攻击者服务端不被采纳为会话。
    expect(h.gateway, 'token 一个字节都不许出站').toEqual([])
    expect(h.applied, '攻击者服务端不得被采纳为会话').toEqual([])
    expect(h.warns.join(' ')).toContain('no local login is waiting')
  })

  it('refuses a startup deep link before the login page is ever requested (R3-N1a/N1b)', async () => {
    // 冷启动路径:深链作为启动参数/second-instance/open-url 先到,index 还没被请求。
    const h = await hostHarness()
    expect(h.indexCalls()).toBe(0)

    await fireAndSettle(h.fire, 'https://attacker.example')

    expect(h.gateway).toEqual([])
    expect(h.applied).toEqual([])
    expect(h.warns.join(' ')).toContain('no local login is waiting')
  })

  it('arms the guard synchronously at apply(), before the first login page request (R3-N1b window)', async () => {
    const h = await hostHarness({ defaultServer: 'https://harness.example/' })
    expect(h.indexCalls(), '本用例刻意不请求 index').toBe(0)
    expect(h.pending()).toBe('https://harness.example')

    // 启动窗口内到达的伪造深链:拒绝且零出站。
    await fireAndSettle(h.fire, 'https://attacker.example')
    expect(h.gateway).toEqual([])
    expect(h.applied).toEqual([])
    expect(h.warns.join(' ')).toContain('no local login is waiting')

    // 预置那台(书写变体)照常放行 —— 窗口消失不等于误伤。
    await fireAndSettle(h.fire, 'https://HARNESS.example')
    expect(h.applied).toHaveLength(1)
    expect(h.gateway.map((c) => new URL(c.url).hostname)).toEqual(['harness.example'])
  })

  it('accepts the OIDC callback in an official build once the login page registered the server', async () => {
    // 不能把"官方构建一律拒绝"做成"官方构建登不进去":真页面在 window.open 之前
    // 用持有性证明登记用户填写的服务端(见第一半的页面脚本用例),回跳必须被接受。
    const h = await hostHarness()

    // ① 未登记时:合法域名也不采纳(否则守卫等于没开)。
    await fireAndSettle(h.fire, 'https://corp.example')
    expect(h.applied).toEqual([])

    // ② 真页面(持 dsh-auth cookie)登记。
    const { res, read } = fakeRes()
    await h.handler('/api/pico/auth/browser-login')(
      fakeReq('POST', '/api/pico/auth/browser-login', '{"server":"https://corp.example/"}', true), res)
    expect(read().code).toBe(200)

    // ③ 浏览器回跳(同一台,书写变体)被接受。
    await fireAndSettle(h.fire, 'https://CORP.example')
    expect(h.applied).toHaveLength(1)
    expect(h.gateway).toHaveLength(1)
    expect(new URL(h.gateway[0]!.url).hostname).toBe('corp.example')
    expect(h.gateway[0]!.authorization).toBe('Bearer REAL-EMPLOYEE-TOKEN')
  })

  it('chains the real login page registration to the host route (official build, no default server)', async () => {
    // 端到端形态:用**真实登录页脚本**发出的登记请求体喂给真实宿主路由,再让
    // 浏览器回跳到达 —— 证明官方构建下"登记先于深链"这条链路真的成立。
    const page = bootLoginPage({ server: 'https://corp.example/' })
    await page.browserLogin()
    const registration = page.fetchCalls.find((c) => c.url.startsWith('/api/pico/auth/browser-login'))
    expect(registration?.method).toBe('POST')
    const openAt = page.events.findIndex((e) => e.startsWith('open '))
    const registerAt = page.events.findIndex((e) => e.startsWith('fetch POST /api/pico/auth/browser-login'))
    expect(openAt, '登记必须早于 window.open').toBeGreaterThan(registerAt)

    const h = await hostHarness()
    const { res, read } = fakeRes()
    await h.handler('/api/pico/auth/browser-login')(
      fakeReq('POST', '/api/pico/auth/browser-login', registration!.body, true), res)
    expect(read().code).toBe(200)

    const callbackServer = new URL(page.openCalls[0]!).searchParams.get('server')!
    await fireAndSettle(h.fire, callbackServer)
    expect(h.applied).toHaveLength(1)
    expect(h.warns.join(' ')).not.toContain('no local login is waiting')
  })

  it('keeps same-origin spellings accepted but refuses other origins and malformed links', async () => {
    const h = await hostHarness({ defaultServer: 'https://harness.example' })

    // 等价书写(大小写/默认端口/子路径)是同一台 ⇒ 不许误伤。
    for (const variant of ['https://HARNESS.example/', 'https://harness.example:443', 'https://harness.example/some/sub/path']) {
      await fireAndSettle(h.fire, variant)
    }
    expect(h.applied).toHaveLength(3)

    // 非默认端口/降级 scheme/前缀域名(拼写近似但不是同源)⇒ 拒绝。
    for (const hostile of ['https://harness.example:8443', 'http://harness.example', 'https://harness.example.attacker.example']) {
      await fireAndSettle(h.fire, hostile)
    }
    expect(h.applied, '只有同源书写变体放行').toHaveLength(3)
    expect(h.gateway.every((c) => new URL(c.url).hostname === 'harness.example')).toBe(true)

    // 缺 server / server 为空:token 无处可挂,同样必须拒绝且零出站。
    h.fire('picoaide://auth?token=REAL-EMPLOYEE-TOKEN&user=eve')
    h.fire('picoaide://auth?token=REAL-EMPLOYEE-TOKEN&server=&user=eve')
    await new Promise((r) => setTimeout(r, 60))
    expect(h.applied).toHaveLength(3)
    expect(h.warns.join(' ')).toContain('without server/user')
  })

  it('refuses a cross-server deep link before any request while signed in (F12 stays ahead of fetch)', async () => {
    const session: Session = { serverURL: 'https://harness.example', username: 'alice', token: 'tok-current' }
    const h = await hostHarness({ defaultServer: 'https://harness.example' }, session)

    await fireAndSettle(h.fire, 'https://attacker.example')

    expect(h.gateway).toEqual([])
    expect(h.applied).toEqual([])
    expect(h.warns.join(' ')).toContain('refused server switch')
  })
})
