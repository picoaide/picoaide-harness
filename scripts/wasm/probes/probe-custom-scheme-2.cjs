/**
 * W0-C2 探针：自定义协议在**平台真实约束**下的三个决定性验证。
 *
 * 1. **平台 CSP 是否放行自定义协议**：用生产 CSP 字符串
 *    （limits.AppContentSecurityPolicy：default-src 'none'; script-src 'self' 'unsafe-inline';
 *     style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;
 *     connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'）
 *    服务页面 → 内联脚本/同源 fetch/原生表单 POST 是否照常工作（`'self'` 是否解析成
 *    `picoaide-app://<app_id>`）。失败 ⇒ 容器方案必须改 CSP，属于"开工前必须知道"的事。
 * 2. **分区（partition）注册**：内置浏览器视图跑在 `persist:*` 分区里；
 *    `protocol.handle` 注册在 **partition session** 上时，页面能否加载并同源 fetch。
 * 3. **客户端 UI（http://127.0.0.1:<port>）能不能驱动应用**：从 http 页面 fetch
 *    `picoaide-app://<app_id>/…`（跨源）是否被拦。这决定"应用页与客户端自有 UI 的
 *    隔离是否成立"，以及服务端还需不需要替代 Origin 判据。
 *
 * 运行：xvfb-run -a env HOME=… electron --no-sandbox scripts/wasm/probes/probe-custom-scheme-2.cjs
 */
const http = require('node:http')
const { app, BrowserWindow, protocol, session } = require('electron')

const SCHEME = 'picoaide-app'
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true },
}])

const log = (n, v) => console.log(`[probeC2] ${n} = ${JSON.stringify(v)}`)
const seen = []

/**
 * 平台覆盖声明（**显式 skip，不静默**）：
 * 本探针的结论目前只对 **Linux** 有效 —— Windows / macOS 上的自定义协议行为
 * （registerSchemesAsPrivileged 时序、分区内协议注册、无 Origin、无 Cookie）
 * 尚未实测，属设计总纲 §17 认账第 1 条与 §16 W6「三平台跑同一协议探针」的待办。
 * 因此：
 *   1. 非 Linux 平台仍**照常执行全部断言**，按 0/1 退出码给结论 —— 不假装通过、
 *      也不静默跳过（假绿比红更贵）；
 *   2. 但额外打印 [skip-note] 并在 VERDICT 里标 platformCovered:false：调用方
 *      **不得**把它当作 W6 的三平台判据；
 *   3. 需要「未覆盖平台一律不产出结论」时设 PROBE_REQUIRE_COVERED_PLATFORM=1：
 *      非 Linux 平台打印 [skip] 并以退出码 77（显式 SKIP）收尾。
 * 门禁脚本对 77 的处理见 scripts/verify-wasm-client-only.sh 第 6 组。
 */
const PLATFORM = process.platform
const COVERED_PLATFORM = PLATFORM === "linux"
const REQUIRE_COVERED = process.env.PROBE_REQUIRE_COVERED_PLATFORM === "1"
if (!COVERED_PLATFORM) {
  console.log(`[skip-note] platform=${PLATFORM} 未覆盖：Windows/macOS 自定义协议行为尚未实测（§17 认账 1 / W6 待补）；本平台结论不作为验收证据`)
}

// 生产 CSP（limits.AppContentSecurityPolicy 的逐字拷贝）
const PLATFORM_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; " +
  "base-uri 'none'; frame-ancestors 'none'"

function makeHandler(tag) {
  return async (req) => {
    const url = new URL(req.url)
    seen.push({ tag, method: req.method, host: url.hostname, path: url.pathname, origin: req.headers.get('origin') })
    if (url.pathname.startsWith('/api/')) {
      let body = ''
      try { body = await req.text() } catch { /* ignore */ }
      return new Response(JSON.stringify({ ok: true, method: req.method, echo: body }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(PAGE, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PLATFORM_CSP },
    })
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1>csp</h1>
<form id="f" method="post" action="/api/form"><input name="v" value="3"></form>
<script>
  window.__inlineRan = true
  window.__run = async () => {
    const out = { inlineRan: window.__inlineRan === true, sec: window.isSecureContext, origin: location.origin }
    try { const r = await fetch('/api/get'); out.get = await r.json() } catch (e) { out.getErr = String(e) }
    try { const r = await fetch('/api/post', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'v=9' }); out.post = await r.json() } catch (e) { out.postErr = String(e) }
    return out
  }
</script></body></html>`

app.whenReady().then(async () => {
  if (!COVERED_PLATFORM && REQUIRE_COVERED) {
    log("SKIP", { reason: "platform-not-covered", platform: PLATFORM, exitCode: 77 })
    app.exit(77)
    return
  }
  // 默认 session + 一个浏览器分区（内置浏览器的形态）
  protocol.handle(SCHEME, makeHandler('default'))
  const PART = 'persist:probe-app-partition'
  const partSes = session.fromPartition(PART)
  try {
    partSes.protocol.handle(SCHEME, makeHandler('partition'))
    log('partitionHandleRegistered', true)
  } catch (cause) {
    log('partitionHandleRegistered', String(cause))
  }

  // ---- 1+2：分区页面的 CSP 行为 ----
  const win = new BrowserWindow({ show: false, webPreferences: { partition: PART, contextIsolation: true, sandbox: true } })
  const violations = []
  win.webContents.on('console-message', (_e, _lvl, message) => {
    if (/Content Security Policy|Refused to/i.test(message)) violations.push(message)
  })
  let loaded = true
  try { await win.loadURL(`${SCHEME}://demo/`) } catch (cause) { loaded = false; log('partitionLoadError', String(cause)) }
  const pageOut = loaded ? await win.webContents.executeJavaScript('window.__run()') : {}

  // 原生表单 POST（导航）—— 分区 handler 是否收到、CSP form-action 是否放行
  let formOut = null
  if (loaded) {
    const before = seen.length
    await win.webContents.executeJavaScript(`document.getElementById('f').submit(); true`)
    await new Promise((r) => setTimeout(r, 1200))
    formOut = { url: win.webContents.getURL(), after: seen.slice(before) }
  }

  // ---- 3：客户端 UI（http 源）能否 fetch 应用 ----
  const dshServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body><script>window.__go = async () => { const out = {}; ' +
      `try { const r = await fetch("${SCHEME}://demo/api/from-ui"); out.status = r.status; out.text = await r.text() } catch (e) { out.error = String(e) } ` +
      'return out }</script></body></html>')
  })
  const uiPort = await new Promise((r) => dshServer.listen(0, '127.0.0.1', () => r(dshServer.address().port)))
  const uiWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  await uiWin.loadURL(`http://127.0.0.1:${uiPort}/`)
  const uiOut = await uiWin.webContents.executeJavaScript('window.__go()')

  log('partitionPage', pageOut)
  log('cspViolations', violations)
  log('partitionFormPost', formOut)
  log('uiToAppFetch', uiOut)
  log('requestsSeen', seen)

  const verdict = {
    platform: PLATFORM,
    platformCovered: COVERED_PLATFORM,
    partitionServed: loaded,
    inlineScriptAllowedUnderPlatformCsp: pageOut?.inlineRan === true,
    fetchAllowedUnderPlatformCsp: pageOut?.get?.ok === true,
    postAllowedUnderPlatformCsp: pageOut?.post?.ok === true,
    nativeFormPostAllowedUnderPlatformCsp: Boolean(formOut?.after?.some((s) => s.tag === 'partition' && s.path === '/api/form' && s.method === 'POST')),
    cspViolationCount: violations.length,
    uiHttpOriginCanDriveApp: uiOut?.status === 200,
    uiError: uiOut?.error ?? null,
  }
  log('VERDICT', verdict)
  // 判据自证（2026-09-19，审计 TST P0-A）：按期望值判定并设退出码。
  const failed = []
  for (const k of ['partitionServed', 'inlineScriptAllowedUnderPlatformCsp', 'fetchAllowedUnderPlatformCsp',
    'postAllowedUnderPlatformCsp', 'nativeFormPostAllowedUnderPlatformCsp']) {
    if (verdict[k] !== true) failed.push(k)
  }
  if (verdict.cspViolationCount !== 0) failed.push('cspViolationCount(must be 0)')
  // 负向期望：客户端自有 UI（http 源）**不该**能驱动应用 origin。
  if (verdict.uiHttpOriginCanDriveApp !== false) failed.push('uiHttpOriginCanDriveApp(must be false)')
  log('ASSERT', { failed })
  app.exit(failed.length === 0 ? 0 : 1)
}).catch((cause) => { console.error('[probeC2] fatal', cause); app.exit(1) })
