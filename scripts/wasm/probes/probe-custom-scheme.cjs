/**
 * W0-C 探针：自定义协议 `picoaide-app://<app_id>/` 能不能作为 WASM 应用的
 * 客户端内部 origin（用户 2026-09-19 拍板的载体）。
 *
 * 逐条判定（每条都必须可判真假，不做"看起来能用"的推断）：
 *   1. `protocol.handle('picoaide-app', …)` 能否服务内容（Electron 43.4.0）
 *   2. 页面 origin / secure context / 相对路径解析
 *   3. 同源 `fetch` 是否可达 handler，handler 收到的 Origin 头是什么
 *   4. **原生表单 POST**（CSP/form-action 语义的真正考验）是否可达 handler，方法/体是否完整
 *   5. 跨应用（`picoaide-app://other/`）是否被隔离（corsEnabled:false）
 *   6. Cookie 语义（自定义协议下 document.cookie / Set-Cookie 行为）
 *   7. 重定向（302）与状态码能否透传；`<img>` 等子资源是否走 handler
 *   8. 主进程 `loadURL('picoaide-app://…')`（内置浏览器视图的加载方式）能否成功
 *
 * 运行：
 *   xvfb-run -a env HOME=/tmp/... electron --no-sandbox scripts/wasm/probes/probe-custom-scheme.cjs
 */
const { app, BrowserWindow, protocol, net } = require('electron')

const SCHEME = 'picoaide-app'

// 与上游 dsh-app:// 同一组 privileges（见 deepseek-harness/apps/desktop/src/main.ts:30-40）。
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true },
}])

const log = (name, value) => console.log(`[probeC] ${name} = ${JSON.stringify(value)}`)
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

function handle(req) {
  const url = new URL(req.url)
  const entry = {
    method: req.method,
    host: url.hostname,
    path: url.pathname,
    search: url.search,
    origin: req.headers.get('origin'),
    contentType: req.headers.get('content-type') ?? null,
    cookie: req.headers.get('cookie') ?? null,
    body: null,
    secFetchSite: req.headers.get('sec-fetch-site') ?? null,
    secFetchMode: req.headers.get('sec-fetch-mode') ?? null,
  }
  return (async () => {
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      try { entry.body = await req.text() } catch { entry.body = '<unreadable>' }
    }
    seen.push(entry)
    if (url.pathname === '/redirect') {
      return new Response(null, { status: 302, headers: { location: `${SCHEME}://${url.hostname}/after-redirect` } })
    }
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: true, host: url.hostname, method: req.method, echo: entry.body }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-handler': 'yes' },
      })
    }
    if (url.pathname === '/setcookie') {
      return new Response('c', { status: 200, headers: { 'set-cookie': 'probe=1; Path=/; SameSite=Lax' } })
    }
    if (url.pathname === '/pixel.png') {
      return new Response(Buffer.from('89504e470d0a1a0a', 'hex'), { status: 200, headers: { 'content-type': 'image/png' } })
    }
    return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  })()
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>app</title>
<style>body{font-family:system-ui}</style></head><body>
<h1>app</h1><img id="pix" src="/pixel.png">
<form id="f" method="post" action="/api/form"><input name="v" value="2"><button id="go">go</button></form>
</body></html>`

const step1 = `(async () => {
  const out = { href: location.href, origin: location.origin, secure: window.isSecureContext, crossOriginIsolated: window.crossOriginIsolated }
  document.cookie = 'a=1; SameSite=Lax'
  try { document.cookie = 'b=2; Secure; SameSite=Lax' } catch (e) { out.cookieThrew = String(e) }
  out.cookie = document.cookie
  try { const r = await fetch('/api/get', { headers: { 'x-probe': '1' } }); out.get = await r.json(); out.getHeader = r.headers.get('x-handler') }
  catch (e) { out.getErr = String(e) }
  try { const r = await fetch('/api/post', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'v=1' }); out.post = await r.json() }
  catch (e) { out.postErr = String(e) }
  try { const r = await fetch('${SCHEME}://other/api/cross'); out.cross = await r.text() }
  catch (e) { out.crossErr = String(e) }
  try { const r = await fetch('/redirect', { redirect: 'follow' }); out.redirectURL = r.url; out.redirectStatus = r.status }
  catch (e) { out.redirectErr = String(e) }
  try { const r = await fetch('/setcookie'); out.setCookieStatus = r.status; out.cookieAfterSetCookie = document.cookie }
  catch (e) { out.setCookieErr = String(e) }
  out.imgNatural = document.getElementById('pix').naturalWidth
  return out
})()`

app.whenReady().then(async () => {
  if (!COVERED_PLATFORM && REQUIRE_COVERED) {
    log("SKIP", { reason: "platform-not-covered", platform: PLATFORM, exitCode: 77 })
    app.exit(77)
    return
  }
  protocol.handle(SCHEME, handle)

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  const fail = []
  win.webContents.on('did-fail-load', (_e, code, desc, url) => fail.push({ code, desc, url }))

  let loaded = true
  try {
    await win.loadURL(`${SCHEME}://demo/`)
  } catch (cause) {
    loaded = false
    log('loadError', String(cause))
  }
  const page = loaded ? await win.webContents.executeJavaScript(step1) : {}

  // 原生表单 POST（会导航）—— 提交后从 handler 日志判定
  if (loaded) {
    const before = seen.length
    await win.webContents.executeJavaScript(`document.getElementById('f').submit(); true`)
    await new Promise((r) => setTimeout(r, 1200))
    log('formPostNavigated', {
      url: win.webContents.getURL(),
      requestsAfterSubmit: seen.slice(before),
      didFailLoad: fail,
    })
  }

  log('page', page)
  log('requestsSeen', seen)
  const formReq = seen.find((s) => s.path === '/api/form')
  const verdict = {
    platform: PLATFORM,
    platformCovered: COVERED_PLATFORM,
    handleServed: loaded && page.origin !== undefined,
    originIsSchemeHost: page.origin === `${SCHEME}://demo`,
    secureContext: page.secure === true,
    sameOriginFetchReachedHandler: page.get?.ok === true,
    fetchOriginHeader: seen.find((s) => s.path === '/api/get')?.origin ?? null,
    fetchSecFetchSite: seen.find((s) => s.path === '/api/get')?.secFetchSite ?? null,
    xhrPostReachedHandler: page.post?.ok === true && page.post?.echo === 'v=1',
    nativeFormPostReachedHandler: Boolean(formReq) && formReq.method === 'POST' && formReq.body === 'v=2',
    nativeFormOriginHeader: formReq?.origin ?? null,
    crossAppBlocked: page.cross === undefined,
    crossAppError: page.crossErr ?? null,
    cookiesWork: page.cookie === undefined ? null : page.cookie,
    setCookieStored: page.cookieAfterSetCookie ?? null,
    redirectFollowed: page.redirectURL ?? null,
    subresourceReachedHandler: seen.some((s) => s.path === '/pixel.png'),
    imgNaturalWidth: page.imgNatural ?? null,
  }
  log('VERDICT', verdict)
  // 判据自证（2026-09-19，审计 TST P0-A）：探针自己按**期望值**判定并设退出码，
  // 不再依赖调用方 grep 文本（那种写法既可能永远失败，也可能退化成存在性断言）。
  const required = ['handleServed', 'originIsSchemeHost', 'secureContext', 'sameOriginFetchReachedHandler',
    'xhrPostReachedHandler', 'nativeFormPostReachedHandler', 'crossAppBlocked', 'subresourceReachedHandler']
  const failed = required.filter((k) => verdict[k] !== true)
  // 负向期望：自定义协议下**不该**有 Origin/Sec-Fetch（实测），有反而是缺陷。
  if (verdict.fetchOriginHeader !== null) failed.push('fetchOriginHeader(must be null)')
  if (verdict.fetchSecFetchSite !== null) failed.push('fetchSecFetchSite(must be null)')
  if (verdict.nativeFormOriginHeader !== null) failed.push('nativeFormOriginHeader(must be null)')
  // cookie 必须不可用（""= 写不进去）。
  if (verdict.cookiesWork !== '') failed.push('cookiesWork(must be empty)')
  if (verdict.setCookieStored !== '') failed.push('setCookieStored(must be empty)')
  log('ASSERT', { failed })
  app.exit(failed.length === 0 ? 0 : 1)
}).catch((cause) => { console.error('[probeC] fatal', cause); app.exit(1) })
