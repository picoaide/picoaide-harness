/**
 * Real-environment client verification: drive the packaged app against the
 * real picoaide gateway with a provided test account, walk every client
 * surface, capture screenshots, and emit a Markdown report.
 *
 * Usage:
 *   REAL_SERVER=https://harness.example.com REAL_USER=test-user REAL_PASS=... \
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

const SERVER = process.env.REAL_SERVER ?? (() => { throw new Error('REAL_SERVER is required') })()
const USER = process.env.REAL_USER ?? 'test-user'
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

/**
 * 打开底部「更多」浮层（2026-09-21 并道后，五个面板入口不在常显行里）。
 * @param waitMs - settle time after the click.
 * @returns `'OPENED'` / `'ALREADY_OPEN'` / `'NOT_FOUND'` / `'NOT_OPEN'`.
 */
async function openFootMenu(waitMs = 700) {
  const clicked = await ev(`(() => {
    const row = document.querySelector('.pico-foot-menu-trigger')
    if (row === null || row.offsetParent === null) return 'NOT_FOUND'
    if (row.getAttribute('aria-expanded') === 'true') return 'ALREADY_OPEN'
    row.click()
    return 'CLICKED'
  })()`)
  if (clicked === 'NOT_FOUND') return 'NOT_FOUND'
  await wait(waitMs)
  const open = await ev(`(() => {
    const row = document.querySelector('.pico-foot-menu-trigger')
    if (row === null) return false
    const menu = document.getElementById(row.getAttribute('aria-controls') ?? '')
    return row.getAttribute('aria-expanded') === 'true' && menu !== null && getComputedStyle(menu).display !== 'none'
  })()`)
  if (open !== true) return 'NOT_OPEN'
  return clicked === 'ALREADY_OPEN' ? 'ALREADY_OPEN' : 'OPENED'
}

/**
 * 点开「更多」浮层里的一个条目（先开浮层），并断言面板真的接管了中列。
 * @param label - 条目文案（`.pico-foot-menu-item` 的可见文本）。
 * @param panelId - 期望的 panel-surface PanelId。
 * @param waitMs - settle time after the click.
 * @returns `'CLICKED'` / `'NOT_FOUND'` / `'OPEN_FAILED'` / `'NOT_ACTIVE'`.
 */
async function openPanelFromFootMenu(label, panelId, waitMs = 3000) {
  const opened = await openFootMenu()
  if (opened !== 'OPENED' && opened !== 'ALREADY_OPEN') return opened === 'NOT_FOUND' ? 'NOT_FOUND' : 'OPEN_FAILED'
  const clicked = await ev(`(() => {
    const items = [...document.querySelectorAll('.pico-foot-menu-item')].filter(b => b.offsetParent)
    const hit = items.find(b => (b.textContent ?? '').trim() === ${esc(label)})
    if (hit === undefined) return 'NOT_FOUND'
    hit.click()
    return 'CLICKED'
  })()`)
  await wait(waitMs)
  if (clicked !== 'CLICKED') return clicked
  // 激活态属性是唯一真源：只查 `document.body.textContent` 会在面板根本没打开时同样为真。
  const active = await ev(`document.documentElement.getAttribute('data-dsh-panel-active')`)
  return active === panelId ? 'CLICKED' : 'NOT_ACTIVE'
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

  // 4. Main sidebar. 2026-09-21 并道改造：底部只剩「更多」一行（+ 设置 + 账户行），
  //    五个面板入口在浮层里 —— 而浮层收起时条目仍挂在 DOM 里（display:none），
  //    `textContent` 不分可见性 ⇒ 这一列的按钮必须按**可见性**收集，否则恒为假红。
  const sidebar = await ev(`(() => {
    const visible = (el) => el.offsetParent !== null
    const names = [...document.querySelectorAll('button')].filter(visible).map(b => (b.textContent ?? '').trim()).filter(Boolean)
    return { names, hasMore: names.includes('更多'), hasSettings: names.includes('设置') }
  })()`)
  const hasSidebar = sidebar?.hasMore === true && sidebar?.hasSettings === true
  reportStep('主界面侧边栏导航完整（真实）', hasSidebar,
    `more=${sidebar?.hasMore} settings=${sidebar?.hasSettings} buttons=${(sidebar?.names ?? []).slice(0, 12).join(',')}`)
  await screenshot('r02-main')

  // 5. Workspace picker (real data). The previous form of this check was
  // `!!wsText || true` — a tautology that reported PASS even with no dialog.
  await clickLabel('选择工作区', 1500)
  const pickerOpen = await waitFor(`document.body.textContent?.includes('选择工作区目录') ?? false`, 10000)
  reportStep('工作区选择器可打开（真实）', pickerOpen, `dialog=${pickerOpen}`)
  await screenshot('r03-workspaces')
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => {})
  await wait(1000)

  // 6. Feature panels: connectors / skills / settings.
  //    2026-09-21 并道之后连接器与能力中心在「更多」浮层里：先开浮层再点条目，
  //    并用激活态属性判定面板真的打开（`textContent` 检查在"没打开"时也可能为真）。
  const connOpen = await openPanelFromFootMenu('连接器', 'connectors', 3000)
  const connOk = connOpen === 'CLICKED' && (await bodyText()).includes('连接器')
  reportStep('连接器面板打开（真实数据）', connOk, `open=${connOpen}`)
  await screenshot('r04-connectors')
  await clickLabel('返回聊天', 1200).catch(() => {})
  await clickLabel('关闭', 1000).catch(() => {})

  const skillOpen = await openPanelFromFootMenu('能力中心', 'capability', 3000)
  const skillOk = skillOpen === 'CLICKED' && (await bodyText()).includes('能力中心')
  reportStep('能力中心面板打开（真实数据）', skillOk, `open=${skillOpen}`)
  await screenshot('r05-skills')
  await clickLabel('返回聊天', 1200).catch(() => {})
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
  // 入口同样在「更多」浮层里（2026-09-21 并道），点击后先验激活态属性。
  const cronOpen = await openPanelFromFootMenu('定时任务', 'cron', 3000)
  reportStep('从「更多」浮层打开定时任务中心（真实）', cronOpen === 'CLICKED', `open=${cronOpen}`)
  const cronOk = await waitFor(`(() => {
    // 2026-09-20：容器标记统一成共享协议的 data-dsh-panel-surface，激活态由
    // html[data-dsh-panel-active] 唯一表达（四个整页面板共用一套语义）。
    if (document.documentElement.getAttribute('data-dsh-panel-active') !== 'cron') return false
    const view = document.querySelector('[data-dsh-panel-surface="cron"]')
    const surface = document.querySelector('.dshDesktopConversationSurface')
    if (view === null || surface === null) return false
    const v = view.getBoundingClientRect(); const s = surface.getBoundingClientRect()
    if (v.height <= 0 || getComputedStyle(view).display === 'none') return false
    if (v.height < s.height * 0.9) return false
    return [...surface.children]
      .filter(el => !el.hasAttribute('data-dsh-panel-surface'))
      .every(el => getComputedStyle(el).display === 'none' || el.getBoundingClientRect().height === 0)
  })()`, 15000)
  reportStep('定时任务中心面板占满中列（真实数据，会话区已让位）', cronOk === true && cronOpen === 'CLICKED',
    `open=${cronOpen}`)
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

  // 9. Browser entry：2026-09-21 并道之后它在「更多」浮层里，点击唤起的是**独立
  //    浏览器窗口**（不是中列面板），所以这里断言的是"条目点得到 + 浮层收起"，
  //    窗口本身由 real-env-browser-no-approval.mjs 负责。
  const browserOpen = await openPanelFromFootMenu('浏览器', 'browser', 2500)
  // `browser` 不是 panel-surface 的 PanelId（浏览器在独立窗口）⇒ openPanelFromFootMenu
  // 的激活态比对预期是 NOT_ACTIVE；这里只要求"点得到"（CLICKED / NOT_ACTIVE 都算）。
  const browserText = await bodyText()
  reportStep('浏览器条目可点（真实）', browserOpen === 'CLICKED' || browserOpen === 'NOT_ACTIVE',
    `open=${browserOpen} textLen=${browserText.length}`)
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
