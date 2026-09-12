/**
 * Real-environment client verification: drive the packaged app against the
 * real picoaide gateway with a provided test account, walk every client
 * surface, capture screenshots, and emit a Markdown report.
 *
 * Usage:
 *   REAL_SERVER=https://picoaide-next.kq0575.cn REAL_USER=user001 REAL_PASS=... \
 *   node scripts/real-env-verify.mjs [--port 9224] [--shots .real-env-shots]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { packagedProductName } from './channel-build.ts'

/** 本次打包产物声明的产品名（渠道构建下即渠道名；见 channel-build.ts）。 */
const PRODUCT_NAME = packagedProductName()

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const PORT = Number(arg('--port', '9224'))
const shotsDir = arg('--shots', join(PACKAGE_ROOT, '.real-env-shots'))
const reportPath = join(PACKAGE_ROOT, '.real-env-report.md')

const SERVER = process.env.REAL_SERVER ?? 'https://picoaide-next.kq0575.cn'
const USER = process.env.REAL_USER ?? 'user001'
const PASS = process.env.REAL_PASS ?? ''

if (!PASS) {
  console.error('real-env-verify: set REAL_PASS (and optionally REAL_SERVER/REAL_USER)')
  process.exit(2)
}

rmSync(shotsDir, { recursive: true, force: true })
mkdirSync(shotsDir, { recursive: true })

const results = []
function reportStep(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const wait = ms => new Promise(r => setTimeout(r, ms))

// --- CDP client ---
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
// The AI browser plugin prewarms its own WebContentsViews, so /json/list carries
// `browser-shell` and `browser-overlay` page targets. Picking the first page
// target attached this script to the browser shell (title 「AI 浏览器」) and every
// surface assertion failed against the wrong document — e2e-client already
// carries the same exclusion.
const main = list.find(t => t.type === 'page'
    && !t.url.includes('browser-shell') && !t.url.includes('browser-overlay')
    && t.url.includes('dsh-desktop-mode'))
  ?? list.find(t => t.type === 'page' && !t.url.includes('browser-shell') && !t.url.includes('browser-overlay'))
if (!main) { console.error('no page target'); process.exit(1) }
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

/**
 * Poll an expression until it is truthy.
 * @param expression - browser expression returning a boolean.
 * @param timeoutMs - how long to keep polling.
 * @param intervalMs - poll interval.
 * @returns whether the expression became truthy in time.
 */
async function waitFor(expression, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await ev(expression)
    if (value === true) return true
    await wait(intervalMs)
  }
  return false
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

/** Clear persisted auth (settings/session) then reload so the login form shows. */
async function resetToLogin() {
  // Sign out through the product's own control. Two wrong turns are recorded
  // here so nobody repeats them: clearing Web Storage alone leaves the
  // cookie-authenticated session alive (the form never appears), while
  // `Network.clearBrowserCookies` also drops the app's own process-token
  // cookie and locks the window out with "dsh web authentication required;
  // reopen the URL printed by dsh web." — a state only an app restart clears.
  if (await ev(`!!document.getElementById('f1')`)) return
  if (await ev(`!!document.querySelector('.dshDesktopConversationSurface')`)) {
    await clickLabel('退出登录', 2500)
    if (await waitFor(`!!document.getElementById('f1')`, 20000)) return
  }
  await ev(`(() => { try { localStorage.clear(); sessionStorage.clear() } catch {} })()`)
  await send('Page.reload', { ignoreCache: true })
  if (!await waitFor(`!!document.getElementById('f1')`, 20000)) {
    console.log('[real-env] login form did not appear after sign-out; continuing')
  }
}

async function bodyText() {
  try { return await ev(`document.body.textContent ?? ''`) } catch { return '' }
}

try {
  // 1. Reset to login
  await resetToLogin()
  await screenshot('r00-login')

  // 2. Fill the real server, advance to the method form, then submit. The
  // auth-gate login is TWO steps (server → /auth/methods probe → local form);
  // setting every field at once and clicking 登录 left the run on step 1 — it
  // only ever worked when a previous manual session happened to be signed in.
  const filledServer = await ev(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return false; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
    return set('server', ${esc(SERVER)})
  })()`)
  await wait(400)
  await clickLabel('下一步', 2000)
  const step2 = await waitFor(`!!document.getElementById('f2')?.offsetParent`, 20000)
  const filledCreds = step2 && await ev(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return false; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
    return set('username', ${esc(USER)}) && set('password', ${esc(PASS)})
  })()`)
  reportStep('登录表单已填写（真实服务器，两步）', filledServer === true && filledCreds === true,
    `server=${SERVER} user=${USER} step2=${step2}`)
  await wait(500)
  await clickLabel('登录', 3000)
  // The auth-gate serves a plain login page (no client bundle) until the session
  // exists, and a cold first boot of the client graph takes seconds. Asserting on
  // the document title passed on the login page itself — the product name is in
  // that title too ("<brand> 登录"), which made this the same false green as the
  // composer assertion in e2e-client. Wait for the desktop shell instead.
  const shellUp = await waitFor(`!!document.querySelector('.dshDesktopConversationSurface')`, 60000)
  const title = await ev('document.title')
  reportStep('真实环境登录成功（客户端外壳已挂载）', shellUp, `shell=${shellUp} title=${title}`)
  await screenshot('r01-login-success')

  // 3. Boot graph completeness
  const bootUp = await waitFor(`!!(window.__DSH_BOOT__ && Array.isArray(window.__DSH_BOOT__.entries))`, 30000)
  const boot = bootUp
    ? await ev(`({ entries: window.__DSH_BOOT__.entries.length, ids: window.__DSH_BOOT__.entries.map(e => e.id) })`)
    : { entries: -1, ids: [] }
  reportStep('客户端插件图已装载', (boot?.entries ?? 0) > 0, `entries=${boot?.entries}`)
  await wait(3000)

  // 4. Main sidebar
  const mainBtns = await ev(`[...new Set([...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean))]`)
  const hasSidebar = ['定时任务', '能力中心', '连接器', '浏览器', '设置'].every(x => (mainBtns ?? []).some(b => b.includes(x)))
  reportStep('主界面侧边栏导航完整（真实）', hasSidebar, `buttons=${(mainBtns ?? []).slice(0, 12).join(',')}`)
  await screenshot('r02-main')

  // 5. Workspace picker (real data). The previous form of this check was
  // `!!wsText || true` — a tautology that reported PASS even with no dialog.
  await clickLabel('选择工作区', 1500)
  const pickerOpen = await waitFor(`document.body.textContent?.includes('选择工作区目录') ?? false`, 10000)
  reportStep('工作区选择器可打开（真实）', pickerOpen, `dialog=${pickerOpen}`)
  await screenshot('r03-workspaces')
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => {})
  await wait(1000)

  // 6. Feature panels: connectors / skills / settings
  await clickLabel('连接器', 3000)
  const connOk = (await bodyText()).includes('连接器')
  reportStep('连接器面板打开（真实数据）', connOk)
  await screenshot('r04-connectors')
  await clickLabel('关闭', 1000)

  await clickLabel('能力中心', 3000)
  const skillOk = (await bodyText()).includes('能力中心')
  reportStep('能力中心面板打开（真实数据）', skillOk)
  await screenshot('r05-skills')
  await clickLabel('关闭', 1000).catch(() => {})

  await clickLabel('设置', 2500)
  const setOk = (await bodyText()).includes('设置') || (await bodyText()).includes('关闭')
  reportStep('设置面板打开', setOk)
  await screenshot('r06-settings')
  await clickLabel('账号', 2000).catch(() => {})
  const account = await bodyText()
  reportStep('账号页可打开（设置内）', account.includes('账号') || account.includes('user'), `len=${account.length}`)
  await screenshot('r07-account')
  await clickLabel('关闭', 1000).catch(() => {})

  // 7. Cron panel (real data)。2026-09-12（P1-1）：只断言"元素存在"是假绿 ——
  // 容器未激活时也在 DOM 里（样式表 display:none）。改为断言**可见且占满中列、
  // 会话区已让位**（打包版真机复现过"面板与会话 407/407 分屏"的回归）。
  await clickLabel('定时任务', 3500)
  const cronOk = await waitFor(`(() => {
    const view = document.querySelector('[data-dsh-cron-view]')
    const surface = document.querySelector('.dshDesktopConversationSurface')
    if (view === null || surface === null) return false
    const v = view.getBoundingClientRect(); const s = surface.getBoundingClientRect()
    if (v.height <= 0 || getComputedStyle(view).display === 'none') return false
    if (v.height < s.height * 0.9) return false
    return [...surface.children]
      .filter(el => !el.hasAttribute('data-dsh-cron-view'))
      .every(el => getComputedStyle(el).display === 'none' || el.getBoundingClientRect().height === 0)
  })()`, 15000)
  reportStep('定时任务中心面板占满中列（真实数据，会话区已让位）', cronOk === true)
  await screenshot('r08-cron')
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('返回聊天') && x.offsetParent); if (b) b.click(); return !!b })()`).catch(() => {})
  await wait(1200)

  // 8. Chat input, scoped to the conversation column: a document-wide selector
  // matched the sidebar's search box (the same false green e2e-client had).
  const chatSelector = '.dshDesktopConversationSurface textarea, '
    + '.dshDesktopConversationSurface [contenteditable="true"], '
    + '.dshDesktopConversationSurface [role="textbox"]'
  const chatOk = await waitFor(`!!document.querySelector(${esc(chatSelector)})`, 15000)
  reportStep('聊天输入区可用（真实，限会话列）', chatOk, `selector=${chatSelector.slice(0, 40)}…`)
  await screenshot('r09-chat')

  // 9. Browser panel
  await clickLabel('浏览器', 3000).catch(() => {})
  const browserText = await bodyText()
  reportStep('浏览器面板可打开', browserText.includes('浏览') || browserText.includes('地址'), `len=${browserText.length}`)
  await screenshot('r11-browser')
} catch (cause) {
  console.error('real-env-verify fatal:', cause instanceof Error ? cause.message : String(cause))
  results.push({ name: '脚本执行', ok: false, detail: cause instanceof Error ? cause.message : String(cause) })
}

// --- report ---
const failed = results.filter(r => !r.ok)
const lines = [
  '# PicoAide Harness 真实环境客户端验证报告',
  '',
  `- 时间：${new Date().toISOString()}`,
  `- 服务：${SERVER}`,
  `- 账号：${USER}`,
  `- 结果：${results.length - failed.length}/${results.length} 通过`,
  '',
  '| 检查点 | 结果 | 详情 |',
  '| --- | --- | --- |',
  ...results.map(r => `| ${r.name} | ${r.ok ? '✅' : '❌'} | ${r.detail || ''} |`),
  '',
]
writeFileSync(reportPath, lines.join('\n'))
console.log(`\n报告：${reportPath}  截图：${shotsDir}`)
ws.close()
process.exit(failed.length > 0 ? 1 : 0)
