/**
 * R1-L2-1 真机探针：session 级 `webRequest.onBeforeRequest` 的**过滤器是否真的会触发**，
 * 以及闸门是否真的把"非应用窗口"发起的应用 scheme 请求挡在协议 handler 之外。
 *
 * 为什么必须真机：mock session 只能验回调逻辑，验不了 Chromium 是否匹配
 * `<scheme>://` 之下全部 URL 这种自定义 scheme 的 pattern。若 pattern 不匹配，
 * listener 永不触发 ⇒ `installAppSchemeRequestGate` 等于没装，而单测照样全绿（静默失效）。
 *
 * 判定（每条都必须可判真假，产物里带原始证据）：
 *   A 对照（**未装闸门**）：http 源页面 / 应用 B 的页面发起的 `<scheme>://` 请求**确实能抵达**
 *     handler（否则"装闸门后计数 0"只是"没人发请求"的假绿）
 *   B 装闸门后：白名单之外的发起来源（http 页面 / 应用 B 的页面）⇒ **handler 计数增量 = 0**
 *   C 闸门 listener 确实触发过（pattern 匹配）—— 这正是静默失效的那条
 *   D 应用窗口（白名单内）自身的请求（含子资源）⇒ 照常抵达 handler（**正例对照**）
 *   E 白名单谓词对应用窗口判 true、对其它窗口判 false
 *
 * 运行（与 xvfb-run 同一条命令）：
 *   HOME=/tmp/probe-home XDG_CONFIG_HOME=/tmp/probe-home/.config \
 *     xvfb-run -a packages/host/desktop/node_modules/electron/dist/electron --no-sandbox \
 *     temp/wasm-client-only/probe-app-scheme-gate.cjs
 * 退出码：所有 required 判定 PASS ⇒ 0；否则 1（自判定，不用外部 grep）。
 *
 * 两个实现坑（都踩过，写在这里省下一次）：
 *  1. 注释里**不能**写出"星号紧接斜杠"的 URL pattern（会提前结束块注释 ⇒ SyntaxError）；
 *  2. Electron 的 `webRequest.onBeforeRequest` 同一 session **只有一个 listener**，
 *     再注册一次会覆盖前一次（首版探针就是这样把自己的闸门覆盖掉的）；
 *  3. 默认行为是"最后一个窗口关闭即退出" —— 探针按阶段销毁窗口，必须注册
 *     `window-all-closed` no-op，否则会在阶段 A 之后静默退出并留下 exit 0（首版假绿）。
 */
const http = require('node:http')
const { app, BrowserWindow, protocol, session } = require('electron')
const { attest } = require('./probe-attest.cjs')

// 收编说明（L4 / 2026-09-20）：本文件由 **L2** 产出（temp/wasm-client-only/probe-app-scheme-gate.cjs，
// 收编时 sha256=a5e472299c245ea142fa0ef9f871fad356e6da96aacedd97f05e431bbb7070e9）。L4 只做两处**附加**标注、未改动任何判定逻辑与期望值：
//   1) 平台覆盖声明（同 probe-web-storage.cjs：非 Linux 打 [skip-note] + platformCovered，
//      PROBE_REQUIRE_COVERED_PLATFORM=1 时按 77 显式 SKIP）；
//   2) VERDICT 行补 platform/platformCovered。
// L2 记录的期望值（本探针自判定）：pattern 触发 6 次；装闸门后 http 页与应用 B 页请求的
// handler 增量 = 0（对照阶段各 1）；应用窗口自身 +2。

// ---------------------------------------------------------------------------
// 平台覆盖声明（**显式 skip，不静默**，L4 收编时统一加的约定）：本探针的结论目前只对
// Linux 有效 —— Windows / macOS 上的自定义协议行为未实测（设计总纲 §17 认账 1 /
// §16 W6 三平台待补）。非 Linux 仍照常执行全部断言，但额外打印 [skip-note] 且
// VERDICT 里 platformCovered=false；设 PROBE_REQUIRE_COVERED_PLATFORM=1 时按退出码 77
// 显式 SKIP（门禁 scripts/verify-wasm-client-only.sh 第 6 组对 77 记 SKIP 不记 FAIL）。
const PROBE_PLATFORM = process.platform
const PROBE_COVERED = PROBE_PLATFORM === "linux"
const PROBE_REQUIRE_COVERED = process.env.PROBE_REQUIRE_COVERED_PLATFORM === "1"
if (!PROBE_COVERED) {
  console.log(`[skip-note] platform=${PROBE_PLATFORM} 未覆盖：Windows/macOS 的自定义协议行为尚未实测（§17 认账 1 / W6 待补）；本平台结论不作为验收证据`)
}

const SCHEME = 'probe-app'
const APP_A = 'demo-a'
const APP_B = 'demo-b'

app.on('window-all-closed', () => {})

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true },
}])

/** 协议 handler 调用账本。 */
const handlerCalls = []
/** 闸门 listener 触发账本。 */
const gateEvents = []
/** 应用 A 窗口的 webContentsId（白名单唯一成员）。 */
let appAWcId

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const progress = (step) => console.log(`[probeGate] step=${step}`)
const countFor = (suffix) => handlerCalls.filter((entry) => entry.url.includes(suffix)).length

/** 带超时的 loadURL（探针绝不悬住）。 */
async function loadWithTimeout(win, url, ms) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
  try {
    return await Promise.race([
      win.loadURL(url).then(() => 'loaded', (error) => `failed:${error && error.message ? error.message : String(error)}`),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 带超时的 executeJavaScript。 */
async function evalWithTimeout(wc, expression, ms) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) })
  try {
    return await Promise.race([wc.executeJavaScript(expression).catch(() => null), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** 页面脚本：`window.__fire(target)` 用三路（img / fetch / sendBeacon）打同一个 URL。 */
function pageScript() {
  return `
  window.__probe = { imgDone: false, fetchDone: false, beaconDone: false, errors: [] };
  window.__fire = function (target) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (done) return; done = true; resolve(window.__probe) };
      var img = new Image();
      img.onload = function () { window.__probe.imgDone = true; finish() };
      img.onerror = function () { window.__probe.imgDone = true; window.__probe.errors.push('img-error'); finish() };
      img.src = target;
      try {
        fetch(target).then(function () { window.__probe.fetchDone = true })
          .catch(function (error) { window.__probe.fetchDone = true; window.__probe.errors.push('fetch:' + error.message) });
      } catch (error) { window.__probe.errors.push('fetch-threw:' + error.message) }
      try { window.__probe.beaconDone = navigator.sendBeacon(target, 'ping') } catch (error) { window.__probe.errors.push('beacon:' + error.message) }
      setTimeout(finish, 1500);
    });
  };`
}

/** 本地 http 源（真 http，不是 data:/about: —— 那会被更早的层拦掉，分不清是谁拦的）。 */
function startPageServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><title>gate probe source</title><body>source<script>${pageScript()}</script></body>`)
  })
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })) })
}

async function main() {
  const watchdog = setTimeout(() => {
    console.log(`[probeGate] WATCHDOG fired; handlerCalls=${String(handlerCalls.length)} gateEvents=${String(gateEvents.length)}`)
    app.exit(3)
  }, 80_000)
  watchdog.unref?.()

  await app.whenReady()
  progress('ready')

  // ---- 协议 handler（带调用计数）：每个应用一页 + 同源子资源 ----
  session.defaultSession.protocol.handle(SCHEME, (request) => {
    handlerCalls.push({ url: request.url, method: request.method })
    const url = new URL(request.url)
    const appId = url.hostname
    if (url.pathname === '/page') {
      return new Response(`<!doctype html><meta charset="utf-8"><title>app ${appId}</title><body>app ${appId}<script>${pageScript()}</script>
<img id="own" src="${SCHEME}://${appId}/own.png"></body>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }
    if (url.pathname === '/own.png' || url.pathname === '/cross.png') {
      return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9v3lAAAAAElFTkSuQmCC', 'base64'), {
        headers: { 'Content-Type': 'image/png' },
      })
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  })

  const { server, port } = await startPageServer()
  const sourceUrl = `http://127.0.0.1:${String(port)}/page`

  // ---- 阶段 A（对照，未装闸门）----
  const sourceWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const sourceLoad = await loadWithTimeout(sourceWindow, sourceUrl, 8000)
  const sourceProbe = await evalWithTimeout(sourceWindow.webContents, `window.__fire('${SCHEME}://${APP_A}/from-http.png')`, 6000)
  await sleep(1200)
  const httpControl = countFor('/from-http.png')

  const appBWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const appBLoad = await loadWithTimeout(appBWindow, `${SCHEME}://${APP_B}/page`, 8000)
  const appBCross = await evalWithTimeout(appBWindow.webContents, `window.__fire('${SCHEME}://${APP_A}/from-app-b.png')`, 6000)
  await sleep(1200)
  const crossControl = countFor('/from-app-b.png')
  const ownBControl = countFor(`//${APP_B}/own.png`)
  progress(`control http=${String(httpControl)} cross=${String(crossControl)} ownB=${String(ownBControl)}`)

  // ---- 应用 A 的窗口（白名单成员）：先建好再装闸门 ----
  const appAWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  appAWcId = appAWindow.webContents.id
  const appALoad = await loadWithTimeout(appAWindow, `${SCHEME}://${APP_A}/page`, 8000)
  await sleep(800)
  const ownABefore = countFor(`//${APP_A}/own.png`)

  // ---- 阶段 B：装闸门（**只注册一次**）----
  const gatePattern = `${SCHEME}://${'*'}/${'*'}`
  session.defaultSession.webRequest.onBeforeRequest({ urls: [gatePattern] }, (details, callback) => {
    const isApp = details.webContentsId === appAWcId
    gateEvents.push({ url: details.url, webContentsId: details.webContentsId, resourceType: details.resourceType, isApp })
    if (typeof details.url === 'string' && details.url.startsWith(`${SCHEME}:`) && !isApp) {
      callback({ cancel: true })
      return
    }
    callback({})
  })
  progress('gate installed')

  // 白名单之外的两个来源各再发一次（换路径避免缓存）
  const sourceProbe2 = await evalWithTimeout(sourceWindow.webContents, `window.__fire('${SCHEME}://${APP_A}/gated-from-http.png')`, 6000)
  const appBCross2 = await evalWithTimeout(appBWindow.webContents, `window.__fire('${SCHEME}://${APP_A}/gated-from-app-b.png')`, 6000)
  await sleep(1500)
  const gatedHttp = countFor('/gated-from-http.png')
  const gatedCross = countFor('/gated-from-app-b.png')

  // 白名单内：应用 A 窗口自己的子资源必须照常通过
  const ownAAfter = await evalWithTimeout(appAWindow.webContents, `window.__fire('${SCHEME}://${APP_A}/own-gated.png')`, 6000)
  await sleep(800)
  const ownAGated = countFor('/own-gated.png')

  const checks = [
    {
      id: 'A1-control-http-page-reaches-the-handler-without-a-gate',
      required: false,
      pass: httpControl > 0,
      evidence: { sourceLoad, sourceProbe, httpControl },
    },
    {
      id: 'A2-control-cross-app-request-reaches-the-handler-without-a-gate',
      required: true,
      // 对照的骨架：它必须 >0，否则"装闸门后为 0"什么都证明不了。
      pass: crossControl > 0,
      evidence: { appBLoad, appBCross, crossControl, ownBControl },
    },
    {
      id: 'B1-gated-http-page-request-never-reaches-the-handler',
      required: true,
      pass: gatedHttp === 0,
      evidence: { gatedHttp, probe: sourceProbe2 },
    },
    {
      id: 'B2-gated-cross-app-request-never-reaches-the-handler',
      required: true,
      pass: gatedCross === 0,
      evidence: { gatedCross, probe: appBCross2, ownAGated },
    },
    {
      id: 'C-gate-listener-actually-fired',
      required: true,
      pass: gateEvents.length > 0,
      evidence: { gatePattern, gateEventCount: gateEvents.length, sample: gateEvents.slice(0, 6) },
    },
    {
      id: 'D-app-window-requests-pass-the-gate',
      required: true,
      // 正例对照：白名单内的窗口（含子资源）必须抵达 handler，否则闸门可能只是"全拦"。
      pass: ownAGated > 0 && ownABefore > 0 && appALoad === 'loaded',
      evidence: { appALoad, ownABefore, ownAGated, appAOwn: ownAAfter },
    },
    {
      id: 'E-whitelist-predicate-sees-only-the-app-window',
      required: true,
      pass: gateEvents.some((entry) => entry.isApp === true) && gateEvents.some((entry) => entry.isApp === false),
      evidence: {
        appAWcId,
        appEvents: gateEvents.filter((entry) => entry.isApp).length,
        foreignEvents: gateEvents.filter((entry) => !entry.isApp).length,
      },
    },
  ]

  server.close()
  const required = checks.filter((check) => check.required)
  const failures = required.filter((check) => !check.pass)
  console.log(`[probeGate] runtime = ${JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome })}`)
  for (const check of checks) {
    console.log(`[probeGate] ${check.pass ? 'PASS' : 'FAIL'} ${check.required ? 'required' : 'diagnostic'} ${check.id} ${JSON.stringify(check.evidence)}`)
  }
  console.log(`[probeGate] required=${required.length} pass=${required.length - failures.length} fail=${failures.length}`)
  console.log(`[probeGate] VERDICT = ${JSON.stringify({ platform: PROBE_PLATFORM, platformCovered: PROBE_COVERED, gatePattern, gateEventCount: gateEvents.length, handlerCalls: handlerCalls.length })}`)
  if (!PROBE_COVERED && PROBE_REQUIRE_COVERED) {
    console.log(`[skip] PROBE_REQUIRE_COVERED_PLATFORM=1 且平台未覆盖（${PROBE_PLATFORM}），按显式 SKIP 退出（77）`)
    // 显式 SKIP 也必须带证据（否则门禁无法区分"真探针如实跳过"与"根本没跑"）。
    attest({ probe: __filename, assertions: 0, pass: 0, fail: 0, skip: required.length, platformCovered: false })
    app.exit(77)
  }
  // 结构化证据行（R4-A N2）：required 断言逐条见上面的 checks 表。
  attest({
    probe: __filename,
    assertions: required.length,
    pass: required.length - failures.length,
    fail: failures.length,
    skip: 0,
    platformCovered: PROBE_COVERED,
  })
  app.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.log(`[probeGate] FATAL ${error && error.stack ? error.stack : String(error)}`)
  app.exit(2)
})
