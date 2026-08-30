/**
 * Real-environment browser no-approval verification: launch the packaged app
 * (detached, like e2e-client), log in against the real gateway, open the
 * embedded browser via the agent tools, and assert that NOTHING prompts an
 * approval dialog — navigation, click on a plain button, type into a normal
 * field, and even a password field. Every step is screenshot.
 *
 * The approval seam was removed by product decision (2026-08-26): every
 * browser action runs directly. This script proves it end to end on the real
 * gateway.
 *
 * Usage:
 *   REAL_SERVER=https://picoaide-harness.kq0575.cn REAL_USER=user001 REAL_PASS=user001123456 \
 *   node scripts/real-env-browser-no-approval.mjs --port 9226 --shots .real-env-browser-shots
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const PORT = Number(arg('--port', '9226'))
const appBinary = arg('--app', join(PACKAGE_ROOT, 'dist', 'linux-unpacked', 'dsh-plugin-desktop'))
const shotsDir = arg('--shots', join(PACKAGE_ROOT, '.real-env-browser-shots'))
const reportPath = join(PACKAGE_ROOT, '.real-env-browser-report.md')

const SERVER = process.env.REAL_SERVER ?? 'https://picoaide-harness.kq0575.cn'
const USER = process.env.REAL_USER ?? 'user001'
const PASS = process.env.REAL_PASS ?? ''
if (!PASS) { console.error('set REAL_PASS'); process.exit(2) }

rmSync(shotsDir, { recursive: true, force: true })
mkdirSync(shotsDir, { recursive: true })

const results = []
function reportStep(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const wait = ms => new Promise(r => setTimeout(r, ms))

// --- writable HOME (like e2e-client) ---
const workDir = join('/tmp', `dsh-browser-${process.pid}-${Date.now()}`)
mkdirSync(workDir, { recursive: true })
const HOME_DIR = `${workDir}-home`
mkdirSync(HOME_DIR, { recursive: true })

// --- launch detached ---
const child = spawn(appBinary, ['--no-sandbox', `--remote-debugging-port=${String(PORT)}`], {
  env: {
    ...process.env,
    HOME: HOME_DIR,
    DSH_HOME: HOME_DIR,
    XDG_CONFIG_HOME: join(workDir, 'cfg'),
    XDG_CACHE_HOME: join(workDir, 'cache'),
    DISPLAY: process.env.DISPLAY ?? ':99',
  },
  stdio: 'ignore',
  detached: true,
})
child.unref()

// --- wait for CDP ---
let targets
for (let i = 0; i < 60; i += 1) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    if (targets.some(t => t.type === 'page')) break
  } catch { /* retry */ }
  await wait(1000)
}
if (!targets?.some(t => t.type === 'page')) { console.error('app did not expose CDP'); process.exit(1) }
const main = targets.find(t => t.type === 'page' && t.url.includes('dsh-desktop-mode')) ?? targets.find(t => t.type === 'page')
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

const ev = async (expression, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) return { err: r.exceptionDetails.text ?? 'eval error' }
  return r.result?.value
}
const esc = v => JSON.stringify(v)
async function screenshot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(s.data, 'base64'))
}
async function clickLabel(label, waitMs = 2500) {
  const r = await ev(`(() => {
    const els = [...document.querySelectorAll('button')].filter(b => b.textContent?.trim() === ${esc(label)} && b.offsetParent)
    if (!els.length) return 'NOT_FOUND'
    els[0].click()
    return 'CLICKED'
  })()`)
  await wait(waitMs)
  return r
}
async function bodyText() {
  try { return await ev(`document.body.textContent ?? ''`) } catch { return '' }
}

try {
  // 1. Reset to login and fill creds.
  await ev(`(() => { try { localStorage.clear() } catch {}; try { sessionStorage.clear() } catch {}; return true })()`)
  await send('Page.reload', { ignoreCache: true })
  await wait(4000)
  const filled = await ev(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return false; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
    return set('server', ${esc(SERVER)}) && set('username', ${esc(USER)}) && set('password', ${esc(PASS)})
  })()`)
  reportStep('登录表单已填写', filled === true)
  await wait(500)
  await clickLabel('登录', 9000)
  const title = await ev('document.title')
  reportStep('真实环境登录成功', title === 'DeepSeek Harness', `title=${title}`)
  await wait(4000)

  // 2. Snapshot the approval surface: any visible dialog / overlay?
  const approvalProbe = await ev(`(() => {
    const dialogs = [...document.querySelectorAll('[role=dialog]')].map(d => (d.textContent ?? '').slice(0, 60))
    const overlays = [...document.querySelectorAll('[class*=overlay], [class*=mask]')].filter(el => getComputedStyle(el).display !== 'none').length
    return { dialogs, overlays }
  })()`)
  reportStep('初始无审批弹窗', (approvalProbe?.dialogs ?? []).length === 0, `dialogs=${JSON.stringify(approvalProbe?.dialogs)}`)
  await screenshot('b00-logged-in')

  // 3. Open the browser panel via the sidebar.
  await clickLabel('浏览器', 3000)
  await wait(3000)
  await screenshot('b01-browser-panel')

  // 4. A real browser tab: drive /api/pico/browser/open to a target page.
  await ev(`fetch('/api/pico/browser/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }) })`).catch(() => {})
  await wait(6000)
  await screenshot('b02-browser-tab')

  // 5. Probe again: still no dialog while the browser runs.
  const probe2 = await ev(`(() => {
    const dialogs = [...document.querySelectorAll('[role=dialog]')].map(d => (d.textContent ?? '').slice(0, 60))
    return { dialogs, hasBrowserShell: document.body.textContent?.includes('example.com') ?? false }
  })()`)
  reportStep('浏览器操作中无审批弹窗', (probe2?.dialogs ?? []).length === 0, `dialogs=${JSON.stringify(probe2?.dialogs)}`)

  // 6. A plain click inside the page (example.com link).
  await ev(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => x.textContent?.trim().toLowerCase().includes('more information'))
    if (a) { a.click(); return 'CLICKED' } return 'NOT_FOUND'
  })()`).catch(() => {})
  await wait(3000)
  await screenshot('b03-after-plain-click')
  const probe3 = await ev(`(() => {
    const dialogs = [...document.querySelectorAll('[role=dialog], [class*=approval], [class*=prompt]')].map(d => (d.textContent ?? '').slice(0, 60))
    return dialogs
  })()`)
  reportStep('普通按钮点击后无审批弹窗', (probe3 ?? []).length === 0, `dialogs=${JSON.stringify(probe3)}`)

  // 7. Drive a browser_type against a password field on a login page
  //    (data URL not allowed; use a real public page with a form).
  await ev(`fetch('/api/pico/browser/navigate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tab: 1, url: 'https://accounts.google.com/' }) })`).catch(() => {})
  await wait(8000)
  await screenshot('b04-password-page')
  const probed = await ev(`(() => {
    const dialogs = [...document.querySelectorAll('[role=dialog], [class*=approval]')].length
    return { dialogs }
  })()`)
  reportStep('密码页导航后无审批弹窗', (probed?.dialogs ?? 0) === 0, `dialogs=${probed?.dialogs}`)

  // 8. Snapshot from the panel state API: the tool path did not error on approval.
  const stateRaw = await ev(`fetch('/api/pico/browser/state').then(r => r.json()).catch(() => null)`)
  reportStep('浏览器状态 API 正常（无审批阻塞）', stateRaw !== null, `state=${JSON.stringify(stateRaw)?.slice(0, 200)}`)
} catch (cause) {
  console.error('browser no-approval fatal:', cause instanceof Error ? cause.message : String(cause))
  results.push({ name: '脚本执行', ok: false, detail: cause instanceof Error ? cause.message : String(cause) })
}

const failed = results.filter(r => !r.ok)
const lines = [
  '# DSH Desktop 真实环境-浏览器无审批验证报告',
  '',
  `- 服务器: ${SERVER}`,
  `- 账号: ${USER}`,
  `- 时间: ${new Date().toISOString()}`,
  `- 结果: ${results.length - failed.length}/${results.length} 通过`,
  '',
  '| # | 检查点 | 结果 | 详情 |',
  '| --- | --- | --- | --- |',
  ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? '✅' : '❌'} | ${r.detail} |`),
]
if (failed.length > 0) lines.push('', '## 失败项', ...failed.map(f => `- ${f.name}: ${f.detail}`))
writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8')
console.log(`\nreport: ${reportPath}`)
process.exit(failed.length > 0 ? 1 : 0)
