/**
 * PicoAide Harness client E2E automation.
 *
 * One command: build mock gateway up, launch the packaged app (or dev main),
 * drive it over CDP, log in, assert every client surface, capture screenshots,
 * and emit a Markdown report. Exits non-zero on any assertion failure.
 *
 * Usage:
 *   node scripts/e2e-client.mjs [--app <path-to-app-binary>] [--port 9223] [--shots <dir>] [--no-screenshot]
 *
 * Prerequisites: Xvfb on :99 (or another DISPLAY), the packaged app built at
 * dist/linux-unpacked/dsh-plugin-desktop (or a dev binary).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagedProductName } from './channel-build.ts'

/** 本次打包产物声明的产品名（渠道构建下即渠道名；见 channel-build.ts）。 */
const PRODUCT_NAME = packagedProductName()

/**
 * 厂商品牌（官方渠道的品牌名）。
 *
 * 只用于"渠道构建下不得出现"这条反向断言 —— 官方构建里它就是合法文案。
 */
const OFFICIAL_BRAND_NAME = 'PicoAide'

/**
 * 上游厂商标识：**任何构建**（含官方）都不得出现在品牌面上。
 *
 * 2026-09-12 修正：旧断言只查 `OFFICIAL_BRAND_NAME`（我方厂商名），于是它只能发现
 * "渠道构建漏出我方品牌"，**永远发现不了上游品牌泄漏**（DeepSeek 鱼形 mark /
 * 「DeepSeek Harness」/「DSH 本地构建」）；而且它只在官方构建跳过、只在登录页
 * 时刻跑、只读 `innerText`（图形看不见）。现在：官方构建也跑，检查移到主界面
 * 挂载之后，并同时查品牌槽的**归属**与被服务的 favicon/manifest 内容。
 *
 * 注意 `DeepSeek` 在**模型名**里是合法文案（模型选择器显示 DeepSeek-V4-Flash），
 * 所以正文扫描限定在登录页与 `document.title`，界面正文不整体扫。
 */
const UPSTREAM_BRAND_TOKENS = ['DeepSeek', 'deepseek-harness', 'DSH', 'DSH 本地构建']

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GATEWAY_PORT = 34567
const CDP_PORT = 9223
const DEFAULT_APP = join(PACKAGE_ROOT, 'dist', 'linux-unpacked', 'dsh-plugin-desktop')

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const appBinary = arg('--app', DEFAULT_APP)
const cdpPort = Number(arg('--port', String(CDP_PORT)))
const reportShots = !args.includes('--no-screenshot')
// 审计 2026-08-25 B-04:原固定 /tmp 路径会让并行 e2e/真实实例互相踩踏,
// 且 9223 被残留实例占用时复用错误目标卡死。改为唯一目录(pid+时间戳),
// 仍保证跨 spawn 边界可见(先试 /tmp,失败回退工作区 temp)。
let workDir = ''
let HOME_DIR = ''
for (const base of ['/tmp', './temp']) {
  try {
    const candidate = `${base}/dsh-e2e-${process.pid}-${Date.now()}`
    mkdirSync(candidate, { recursive: true })
    writeFileSync(join(candidate, '.probe'), 'ok')
    rmSync(join(candidate, '.probe'))
    workDir = candidate
    HOME_DIR = `${candidate}-home`
    mkdirSync(HOME_DIR, { recursive: true })
    break
  } catch {
    continue
  }
}
if (workDir === '') throw new Error('cannot create a writable e2e work directory')
console.log(`[e2e] workDir=${workDir} home=${HOME_DIR} port=${cdpPort}`)

const DISPLAY = process.env.DISPLAY ?? ':99'

/**
 * True for the application's own renderer targets. Since the embedded browser
 * is prewarmed at client start (2026-09-08), /json/list also carries the
 * browser's own page targets (/browser-shell, /browser-overlay); selecting one
 * of those instead of the app UI makes every assertion fail while the app is
 * actually healthy.
 */
const isAppPageTarget = (t) => t.type === 'page' && !/\/browser-(shell|overlay)(\?|$)/.test(t.url)

/** Pick the app renderer: post-login URL first, then the pre-login root page. */
function pickAppTarget(list) {
  const apps = list.filter(isAppPageTarget)
  return apps.find(t => t.url.includes('dsh-desktop-mode'))
    ?? apps.find(t => /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(t.url))
    ?? apps[0]
}

/** Minimal CDP client bound to the main application target. */
async function connectMain(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const main = pickAppTarget(list)
  if (!main) throw new Error('no page target')
  const ws = new WebSocket(main.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  ws.onmessage = data => {
    const msg = JSON.parse(data.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
    }
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  return { ws, send }
}

let child = undefined
let gateway = undefined
const results = []
let shotsDir = undefined

function reportStep(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function screenshot(cdp, name) {
  if (!reportShots) return
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const path = join(shotsDir, `${name}.png`)
  writeFileSync(path, Buffer.from(s.data, 'base64'))
}

const wait = ms => new Promise(r => setTimeout(r, ms))

/** Evaluate with a safe wrapper: innerText can throw on Shadow DOM nodes. */
async function evalSafe(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate error')
  return r.result?.value
}

async function clickLabel(cdp, label, waitMs = 2500) {
  const r = await evalSafe(cdp, `(() => {
    const els = [...document.querySelectorAll('button')].filter(b => b.textContent?.trim() === ${JSON.stringify(label)} && b.offsetParent)
    if (!els.length) return 'NOT_FOUND'
    els[0].click()
    return 'CLICKED'
  })()`)
  await wait(waitMs)
  return r
}

async function bodyText(cdp) {
  try { return await evalSafe(cdp, `document.body.textContent ?? ''`) }
  catch { return '' }
}

async function waitFor(cdp, expression, timeoutMs = 15000, interval = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const ok = await evalSafe(cdp, expression)
      if (ok) return true
    } catch { /* keep waiting */ }
    await wait(interval)
  }
  return false
}

async function main() {
  if (!existsSync(appBinary)) {
    console.error(`e2e-client: app binary not found at ${appBinary}`)
    console.error('Run `yarn workspace dsh-plugin-desktop package:dir` first (or pass --app).')
    process.exit(2)
  }

  if (reportShots) {
    shotsDir = join(PACKAGE_ROOT, '.e2e-shots')
    mkdirSync(shotsDir, { recursive: true })
  }

  // 1. Ensure a mock gateway is reachable; start one detached otherwise.
  let gatewayReady = false
  try {
    await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/client/v2/auth/login`, { method: 'POST' })
    gatewayReady = true
  } catch { /* start below */ }
  if (!gatewayReady) {
    gateway = spawn(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'e2e-fixture-gateway.mjs')], {
      detached: true, stdio: 'ignore',
    })
    gateway.unref()
    for (let i = 0; i < 20; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/client/v2/auth/login`, { method: 'POST' })
        gatewayReady = true
        break
      } catch { await wait(250) }
    }
  }
  if (!gatewayReady) throw new Error('mock gateway failed to start')

  // 2. Reuse an already-running app with CDP, otherwise launch one.
  let ready = false
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
    ready = list.some(isAppPageTarget)
  } catch { /* launch below */ }
  if (!ready) {
    // 断言语料是中文 UI(连接/能力中心/关闭等 marker),--lang 强制 Chromium
    // renderer 语言,与 runner 系统语言解耦(2026-09-06 CI 实测:en_US runner
    // 上 UI 变英文,中文 marker 断言失败)。
    child = spawn(appBinary, ['--no-sandbox', '--lang=zh-CN', `--remote-debugging-port=${String(cdpPort)}`], {
      env: {
        ...process.env,
        HOME: HOME_DIR,
        DSH_HOME: HOME_DIR,
        XDG_CONFIG_HOME: join(workDir, 'cfg'),
        XDG_CACHE_HOME: join(workDir, 'cache'),
        DISPLAY,
      },
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
  }

  // 3. Wait for CDP + a page target.
  ready = false
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      if (list.some(isAppPageTarget)) { ready = true; break }
    } catch { /* retry */ }
    await wait(500)
  }
  if (!ready) throw new Error('app did not expose CDP within 30s')
  reportStep('应用启动并暴露 CDP', true, `port ${cdpPort}`)

  const cdp = await connectMain(cdpPort)

  // 4. Log in against the mock gateway. The auth-gate serves a transient
  // "restoring session" page first (it re-requests the index after 1.2s), so
  // wait until the real login form (with a #f submit form) is present before
  // filling it — filling the restoring page would be wiped by its reload.
  // auth-gate 登录页已是两步式(2026-09):f1 服务端地址 → /api/pico/auth/methods
  // 探测 → f2 本地表单。e2e 脚本原按旧单页 #f 断言,2026-09-05 同步两步流程。
  const step1Ready = await waitFor(cdp, `!!document.getElementById('f1') && !!document.getElementById('server')`, 15000, 300)
  if (!step1Ready) throw new Error('login form did not appear within 15s')
  await evalSafe(cdp, `(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return false; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
    return set('server', 'http://127.0.0.1:${GATEWAY_PORT}')
  })()`)
  await wait(400)
  await clickLabel(cdp, '下一步', 7000)
  const step2Ready = await waitFor(cdp, `!!document.getElementById('f2') && !!document.getElementById('username') && !!document.getElementById('password')`, 15000, 300)
  if (!step2Ready) throw new Error('login method form did not appear within 15s')
  await evalSafe(cdp, `(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return false; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
    const ok = set('username', 'admin') && set('password', 'admin')
    return ok
  })()`)
  await wait(400)
  await clickLabel(cdp, '登录', 7000)
  const title = await evalSafe(cdp, 'document.title')
  // 断言对齐**本次构建声明的产品名**（渠道构建下是客户名），不硬编码厂商名:
  // 旧写法把厂商名直接写进断言,渠道构建的 E2E 于是永远红。
  const titleOk = title.includes(PRODUCT_NAME)
  // 白标不变量（2026-09-10 起，2026-09-12 修正口径）：
  //  · 渠道构建下**不得出现我方厂商名**（否则白标被洗掉）；
  //  · **任何构建**下登录页与 `document.title` 不得出现**上游**厂商标识
  //    （鱼形文案、「DeepSeek Harness」、「DSH 本地构建」）。
  // 旧写法把"上游泄漏"这条漏掉了：它查的是 OFFICIAL_BRAND_NAME，官方构建还整条跳过。
  const channelBuild = !PRODUCT_NAME.toLowerCase().includes(OFFICIAL_BRAND_NAME.toLowerCase())
  const loginText = await evalSafe(cdp, `document.body.innerText + ' ' + document.title`)
  const leaks = []
  if (typeof loginText === 'string') {
    if (channelBuild && loginText.includes(OFFICIAL_BRAND_NAME)) leaks.push(`vendor:${OFFICIAL_BRAND_NAME}`)
    for (const token of UPSTREAM_BRAND_TOKENS) {
      if (new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u').test(loginText)) leaks.push(`upstream:${token}`)
    }
    // `E2E_FORCE_BRAND_LEAK_CHECK=1`：官方构建也把厂商名当泄漏（用来证明门禁真的会红）。
    if (process.env.E2E_FORCE_BRAND_LEAK_CHECK === '1' && loginText.includes(OFFICIAL_BRAND_NAME)) {
      leaks.push(`forced-vendor:${OFFICIAL_BRAND_NAME}`)
    }
  }
  reportStep(
    '登录成功（mock gateway）且品牌面无厂商泄漏',
    titleOk && leaks.length === 0,
    `title=${title} expected=${PRODUCT_NAME}${leaks.length === 0 ? '' : ` leaks=${leaks.join(',')}`}`,
  )
  await screenshot(cdp, '01-login-main')

  // 4.5 Boot graph completeness: the host composes window.__DSH_BOOT__ from
  // every dsh.client package. Zero entries means the client UI can never
  // mount (the renderer sits at the parser-preload queue), even though the
  // login page itself passes — packaged asar layouts regress exactly here.
  const boot = await evalSafe(cdp, `(() => {
    const b = window.__DSH_BOOT__
    if (!b || !Array.isArray(b.entries)) return { entries: -1, ids: [] }
    return { entries: b.entries.length, ids: b.entries.map(e => e.id) }
  })()`)
  reportStep('客户端插件图已装载（__DSH_BOOT__ 非空）', (boot?.entries ?? 0) > 0,
    `entries=${boot?.entries} ids=${(boot?.ids ?? []).slice(0, 6).join(',')}`)

  // 5. Main surface assertions.
  const mainBtns = await evalSafe(cdp, `[...new Set([...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean))]`)
  const hasSidebar = ['定时任务', '能力中心', '连接器', '浏览器', '设置'].every(x => (mainBtns ?? []).includes(x) || (mainBtns ?? []).some(b => b.includes(x)))
  reportStep('主界面侧边栏导航完整', hasSidebar, `buttons=${(mainBtns ?? []).slice(0, 14).join(',')}`)

  // 6. Feature panels (open, assert content, screenshot, close).
  const panelChecks = [
    { label: '连接器', marker: '连接', shot: '03-connectors' },
    { label: '能力中心', marker: '能力中心', shot: '04-capability' },
    { label: '设置', marker: '关闭', shot: '05-settings' },
  ]
  for (const item of panelChecks) {
    const open = await clickLabel(cdp, item.label, 3000)
    // The skill center mounts a modal; re-read the current target since panel
    // switches can replace the document. Assert either a matching dialog or a
    // known surface text.
    const ok = open === 'CLICKED' && await (async () => {
      try {
        const dialogs = await evalSafe(cdp, `[...document.querySelectorAll('[role=dialog]')].map(d => d.textContent ?? '')`)
        if (dialogs.some(d => d?.includes(item.marker))) return true
      } catch { /* fall through */ }
      const text = await bodyText(cdp)
      return text.includes(item.marker)
    })()
    reportStep(`${item.label}面板可打开且含预期内容`, ok, `marker=${item.marker}`)
    await screenshot(cdp, item.shot)
    await clickLabel(cdp, '关闭', 1000)
  }

  // 7. Cron panel: 断言**可见性与让位**，不是"元素存在"。
  // 2026-09-12（P1-1，打包版真机复现）：`[data-dsh-cron-view]` 容器在未激活时也在
  // DOM 里（样式表 `display:none`），所以旧的"存在即通过"是假绿 —— 当时面板确实
  // 挂上了，但隐藏规则的选择器（`[data-pane='conversation']` / `[class*='centerCol']`）
  // 在我们自持 frame 下全不匹配，会话区不让位，画面是 407/407 分屏。
  // 现在同时断言：面板可见且**占满中列**、会话区子节点全部被抑制。
  await clickLabel(cdp, '定时任务', 3500)
  const cronLayout = await waitFor(cdp, `(() => {
    const view = document.querySelector('[data-dsh-cron-view]')
    const surface = document.querySelector('.dshDesktopConversationSurface')
    if (view === null || surface === null) return false
    const v = view.getBoundingClientRect()
    const s = surface.getBoundingClientRect()
    if (v.height <= 0 || getComputedStyle(view).display === 'none') return false
    // 面板必须吃掉中列的绝大部分高度（>90%），而不是与会话区平分。
    if (v.height < s.height * 0.9) return false
    const others = [...surface.children].filter(el => !el.hasAttribute('data-dsh-cron-view'))
    return others.every(el => getComputedStyle(el).display === 'none' || el.getBoundingClientRect().height === 0)
  })()`, 15000, 300)
  const cronDetail = await evalSafe(cdp, `(() => {
    const view = document.querySelector('[data-dsh-cron-view]')
    const surface = document.querySelector('.dshDesktopConversationSurface')
    const v = view?.getBoundingClientRect(); const s = surface?.getBoundingClientRect()
    return { view: v ? Math.round(v.height) : null, surface: s ? Math.round(s.height) : null }
  })()`)
  reportStep('定时任务中心面板占满中列（会话区已让位）', cronLayout,
    `cronH=${cronDetail?.view} surfaceH=${cronDetail?.surface}`)
  await screenshot(cdp, '06-cron')
  // Leave the cron board: its "返回聊天" header button removes the activation attr.
  await evalSafe(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('返回聊天') && x.offsetParent); if (b) b.click(); return !!b })()`).catch(() => {})
  await wait(1200)

  // 8. Chat input availability, SCOPED to the conversation column. Upstream
  // 0.1.2 rebuilt the composer around a plain input element (textarea-refactor),
  // so accept input/role=textbox too — but a document-wide querySelector matched
  // the sidebar search box instead, which made this step (and step 12) green
  // while the composer stayed empty (2026-09-08 audit; visible in 11-input.png).
  const composerSelector = '.dshDesktopConversationSurface textarea, '
    + '.dshDesktopConversationSurface [contenteditable="true"], '
    + '.dshDesktopConversationSurface [role="textbox"]'
  const chatOk = await evalSafe(cdp, `!!document.querySelector(${JSON.stringify(composerSelector)})`)
  reportStep('聊天输入区可用（限会话列）', !!chatOk, `hasComposer=${Boolean(chatOk)}`)
  await screenshot(cdp, '08-chat')

  // 9. Advanced mode marker.
  const mode = await evalSafe(cdp, `document.body.dataset.dshDesktopMode ?? ''`)
  reportStep('高级模式固定生效', mode === 'advanced', `mode=${mode}`)

  // 9b. rc.2 root-slot vocabulary. 0.1.5 renamed the frame's children
  // (`conversation` → `main` keyed, `details` → `rightbar`) and the failure
  // mode is SILENT: with the old names every upstream occupant waits forever on
  // an undeclared slot, so the window renders with an empty center and no
  // console error. Assert the live slot tree, not just that the app booted.
  const slotTree = await evalSafe(cdp, `[...new Set([...document.querySelectorAll('[data-slot]')].map(el => el.getAttribute('data-slot')))]`)
  const slots = Array.isArray(slotTree) ? slotTree : []
  const slotErrors = await evalSafe(cdp, `document.querySelectorAll('[data-slot-error]').length`)
  reportStep(
    'rc.2 根槽位已声明(main/rightbar，details 已消失)',
    slots.includes('main') && slots.includes('rightbar') && !slots.includes('details'),
    `slots=${slots.slice(0, 12).join(',')}`,
  )
  reportStep('会话主区已挂载且无槽位装配错误', slots.includes('main.conversation') && !slotErrors, `slotErrors=${slotErrors}`)

  // 9c. Brand seats + served brand assets (2026-09-12)。此前白标门禁只查
  // "登录页文案里有没有我方厂商名"，抓不到**上游**品牌：品牌槽的 fallback 是
  // 上游带动画的鱼形 mark（`EmptyHero` 的 `conversation.hero.brand.mark` 兜底），
  // 而被服务的 `/favicon.svg` 就是那条鱼、`/manifest.webmanifest` 写着
  // `DeepSeek Harness`/`DSH`。这里逐槽断言**归属**（`data-brand-mark="app"`），
  // 并对被服务的两个品牌文件做内容断言。
  const brandSeats = await evalSafe(cdp, `(() => {
    const seats = ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark']
    return seats.map(name => {
      const el = document.querySelector('[data-slot="' + name + '"]')
      if (el === null) return { name, present: false }
      const html = el.innerHTML
      return {
        name,
        present: true,
        owned: el.querySelector('[data-brand-mark="app"]') !== null || el.hasAttribute('data-brand-mark'),
        text: (el.textContent ?? '').trim().slice(0, 40),
        fishish: /48\\.8354|DeepSeek|deepseek-harness/i.test(html),
      }
    })
  })()`)
  const seats = Array.isArray(brandSeats) ? brandSeats : []
  const seatFailures = seats.filter(s => s.present && (s.owned !== true || s.fishish === true))
  const heroSeat = seats.find(s => s.name === 'conversation.hero.brand.mark')
  reportStep(
    '品牌槽位归属本产品（含 hero 槽，排除上游鱼形 mark）',
    seatFailures.length === 0,
    `seats=${seats.map(s => `${s.name}:${s.present ? (s.owned ? 'ours' : 'FOREIGN') : 'absent'}`).join(',')}`
      + (heroSeat?.present === true ? '' : '（hero 槽不在屏，跳过其归属断言）'),
  )
  // 注意：本脚本的 evalSafe 不带 awaitPromise（Promise 会被 returnByValue 序列化成
  // undefined），所以这里直接走 CDP 的 awaitPromise:true。
  const servedBrandResult = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const favicon = await fetch('/favicon.svg').then(r => r.ok ? r.text() : '').catch(() => '')
      const manifest = await fetch('/manifest.webmanifest').then(r => r.ok ? r.json() : null).catch(() => null)
      return {
        faviconIsSvg: favicon.trimStart().startsWith('<svg'),
        faviconUpstream: /48\\.8354|DeepSeek|deepseek-harness|FISH_LOGO/i.test(favicon),
        manifestName: manifest === null ? null : manifest.name,
        manifestShort: manifest === null ? null : manifest.short_name,
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })
  const servedBrand = servedBrandResult?.result?.value ?? null
  reportStep(
    '被服务的 favicon/manifest 为本产品品牌（非上游鱼形/厂商名）',
    servedBrand?.faviconIsSvg === true && servedBrand?.faviconUpstream === false
      && servedBrand?.manifestName === PRODUCT_NAME
      && String(servedBrand?.manifestShort ?? '') !== 'DSH',
    `faviconSvg=${servedBrand?.faviconIsSvg} upstream=${servedBrand?.faviconUpstream} `
      + `manifest=${JSON.stringify(servedBrand?.manifestName)}/${JSON.stringify(servedBrand?.manifestShort)}`,
  )

  // 10. Workspace picker (native dialog path).
  const wsClicked = await clickLabel(cdp, '选择工作区', 2500)
  const wsOpen = await evalSafe(cdp, `document.body.textContent?.includes('Selection') || document.body.textContent?.includes('选择工作区')`).catch(() => false)
  reportStep('工作区选择器可打开', wsClicked === 'CLICKED' && !!wsOpen, `click=${wsClicked}`)
  await screenshot(cdp, '09-workspace')
  // Native dialog may block; press Escape via CDP if the renderer still responds.
  await evalSafe(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => {})
  await wait(1000)

  // 11. Account page (settings -> 账号).
  await clickLabel(cdp, '设置', 2000).catch(() => {})
  await clickLabel(cdp, '账号', 2000).catch(() => {})
  const account = await bodyText(cdp)
  reportStep('账号页可打开（设置内）', account.includes('账号') || account.includes('user'), `len=${account.length}`)
  // 0061 余额:mock gateway 返回 balance_enabled=true + 88.5,侧边栏账户卡的
  // 主数字应显示余额,防止 account-card 余额渲染回归(等一拍轮询/刷新完成)。
  await wait(600)
  // 0061:先验证数据链路(mock gateway → enterprise session → account-card host
  // service → 本地端点),两个字段必须完整透传。
  let usageProbe = null
  try {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `fetch('/api/pico/account/usage').then(r=>r.json()).then(j=>({balance:j?.data?.balance_money ?? null, activated:j?.data?.balance_activated === true, enabled:j?.data?.balance_enabled === true}))`,
      returnByValue: true,
      awaitPromise: true,
    })
    usageProbe = probe?.result?.value ?? null
  } catch { usageProbe = null }
  reportStep('账户卡余额数据链路（balance=88.5/activated/enabled）',
    usageProbe?.enabled === true && usageProbe?.activated === true && usageProbe?.balance === 88.5, JSON.stringify(usageProbe))
  // 再验证渲染:账户卡在宽布局(sidebar.footer wide seat)下以余额为主数字。
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }).catch(() => {})
  await wait(800)
  const accountWithCard = await bodyText(cdp)
  // 精确断言格式化结果(¥88.50):includes('88.5') 对 ¥88.5 / 88.5 / ¥88.500 都成立,
  // 对"小数位回归"不敏感(2026-09-11 加固)。
  const balanceRendered = accountWithCard.includes('账户余额') && accountWithCard.includes('¥88.50')
  reportStep('账户卡渲染余额主数字（宽布局）', balanceRendered,
    `hasLabel=${accountWithCard.includes('账户余额')} hasAmount=${accountWithCard.includes('¥88.50')}`)
  await screenshot(cdp, '10-account')
  await clickLabel(cdp, '关闭', 800).catch(() => {})

  // 12. Composer input, scoped to the conversation column and verified by
  // reading the value back: "an element was found" is exactly the false green
  // this step used to report.
  const PROBE_TEXT = 'e2e 消息'
  const typed = await evalSafe(cdp, `(() => {
    const ta = document.querySelector(${JSON.stringify(composerSelector)})
    if (!ta) return { ok: false, reason: 'composer not found in the conversation column' }
    if (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') {
      const proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, ${JSON.stringify(PROBE_TEXT)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: ta.value === ${JSON.stringify(PROBE_TEXT)}, reason: 'value=' + JSON.stringify(ta.value) }
    }
    ta.textContent = ${JSON.stringify(PROBE_TEXT)}
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: (ta.textContent ?? '').includes(${JSON.stringify(PROBE_TEXT)}), reason: 'text=' + JSON.stringify(ta.textContent) }
  })()`)
  reportStep('会话输入区可输入消息（限会话列，回读校验）', !!typed?.ok, `${typed?.reason ?? 'no result'}`)
  await screenshot(cdp, '11-input')

  cdp.ws.close()
}

async function cleanup() {
  try { if (child) { child.kill('SIGKILL') } } catch { /* ignore */ }
  try { if (gateway) gateway.kill('SIGKILL') } catch { /* ignore */ }
  try { if (reportShots) await wait(200) } catch { /* ignore */ }
}

async function run() {
  try {
    await main()
  } catch (cause) {
    // A fatal error must fail the run: reporting only to stderr let the
    // script print "全部通过" and exit 0 when the app never came up
    // (2026-09-08 audit P0-1).
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error('e2e-client fatal:', message)
    reportStep('e2e 致命错误（应用未就绪）', false, message)
  } finally {
    await cleanup()
    const failed = results.filter(r => !r.ok)
    const lines = [
      '# PicoAide Harness 客户端 E2E 报告',
      '',
      `- 时间：${new Date().toISOString()}`,
      `- 应用：${appBinary}`,
      `- 结果：${results.length - failed.length}/${results.length} 通过`,
      '',
      '| 检查点 | 结果 | 详情 |',
      '| --- | --- | --- |',
      ...results.map(r => `| ${r.name} | ${r.ok ? '✅' : '❌'} | ${r.detail || ''} |`),
      '',
    ]
    const reportPath = join(PACKAGE_ROOT, '.e2e-report.md')
    writeFileSync(reportPath, lines.join('\n'))
    console.log(`\n报告：${reportPath}  截图：${shotsDir ?? '(disabled)'}`)
    if (failed.length > 0) {
      console.error(`\nE2E 结果：${failed.length} 项失败`)
      process.exitCode = 1
    } else {
      console.log('\nE2E 结果：全部通过')
    }
  }
}

await run()
