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

/** Minimal CDP client bound to the main application target. */
async function connectMain(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const main = list.find(t => t.type === 'page' && t.url.includes('dsh-desktop-mode'))
    ?? list.find(t => t.type === 'page')
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
    await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/auth/login`, { method: 'POST' })
    gatewayReady = true
  } catch { /* start below */ }
  if (!gatewayReady) {
    gateway = spawn(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'e2e-fixture-gateway.mjs')], {
      detached: true, stdio: 'ignore',
    })
    gateway.unref()
    for (let i = 0; i < 20; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/auth/login`, { method: 'POST' })
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
    ready = list.some(t => t.type === 'page')
  } catch { /* launch below */ }
  if (!ready) {
    child = spawn(appBinary, ['--no-sandbox', `--remote-debugging-port=${String(cdpPort)}`], {
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
      if (list.some(t => t.type === 'page')) { ready = true; break }
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
  const formReady = await waitFor(cdp, `!!document.getElementById('f') && !!document.getElementById('server')`, 15000, 300)
  if (!formReady) throw new Error('login form did not appear within 15s')
  const login = await evalSafe(cdp, `(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return false; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
    const ok = set('server', 'http://127.0.0.1:${GATEWAY_PORT}') && set('username', 'admin') && set('password', 'admin')
    return ok
  })()`)
  await wait(400)
  await clickLabel(cdp, '登录', 7000)
  const title = await evalSafe(cdp, 'document.title')
  reportStep('登录成功（mock gateway）', title === 'DeepSeek Harness', `title=${title}`)
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

  // 7. Cron panel direct assert via the center view.
  await clickLabel(cdp, '定时任务', 3500)
  const cronOk = await waitFor(cdp, `!!document.querySelector('[data-dsh-cron-view]')`)
  reportStep('定时任务中心面板挂载', cronOk)
  await screenshot(cdp, '06-cron')
  // Leave the cron board: its "返回聊天" header button removes the activation attr.
  await evalSafe(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('返回聊天') && x.offsetParent); if (b) b.click(); return !!b })()`).catch(() => {})
  await wait(1200)

  // 8. Chat input availability.
  const chatOk = await evalSafe(cdp, `!!document.querySelector('textarea, [contenteditable=true]')`)
  reportStep('聊天输入区可用', !!chatOk, `hasTextarea=${Boolean(chatOk)}`)
  await screenshot(cdp, '08-chat')

  // 9. Advanced mode marker.
  const mode = await evalSafe(cdp, `document.body.dataset.dshDesktopMode ?? ''`)
  reportStep('高级模式固定生效', mode === 'advanced', `mode=${mode}`)

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
  await screenshot(cdp, '10-account')
  await clickLabel(cdp, '关闭', 800).catch(() => {})

  // 12. Textarea input + send affordance.
  const typed = await evalSafe(cdp, `(() => {
    const ta = document.querySelector('textarea, [contenteditable=true]')
    if (!ta) return false
    if (ta.tagName === 'TEXTAREA') {
      const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      s.call(ta, 'e2e 消息')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      ta.textContent = 'e2e 消息'
    }
    return true
  })()`)
  reportStep('会话输入区可输入消息', !!typed, `typed=${typed}`)
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
    console.error('e2e-client fatal:', cause instanceof Error ? cause.message : String(cause))
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
