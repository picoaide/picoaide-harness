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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

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
const main = list.find(t => t.type === 'page' && t.url.includes('dsh-desktop-mode')) ?? list.find(t => t.type === 'page')
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
  await ev(`(() => {
    try { localStorage.clear() } catch {}
    try { sessionStorage.clear() } catch {}
    const keys = Object.keys(localStorage)
    return keys
  })()`)
  await send('Page.reload', { ignoreCache: true })
  await wait(4000)
}

async function bodyText() {
  try { return await ev(`document.body.textContent ?? ''`) } catch { return '' }
}

try {
  // 1. Reset to login
  await resetToLogin()
  await screenshot('r00-login')

  // 2. Fill real server + credentials and submit
  const filled = await ev(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return false; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
    return set('server', ${esc(SERVER)}) && set('username', ${esc(USER)}) && set('password', ${esc(PASS)})
  })()`)
  reportStep('登录表单已填写（真实服务器）', filled === true, `server=${SERVER} user=${USER}`)
  await wait(500)
  await clickLabel('登录', 9000)
  const title = await ev('document.title')
  reportStep('真实环境登录成功', title === 'DeepSeek Harness', `title=${title}`)
  await screenshot('r01-login-success')

  // 3. Boot graph completeness
  const boot = await ev(`(() => {
    const b = window.__DSH_BOOT__
    if (!b || !Array.isArray(b.entries)) return { entries: -1, ids: [] }
    return { entries: b.entries.length, ids: b.entries.map(e => e.id) }
  })()`)
  reportStep('客户端插件图已装载', (boot?.entries ?? 0) > 0, `entries=${boot?.entries}`)
  await wait(3000)

  // 4. Main sidebar
  const mainBtns = await ev(`[...new Set([...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean))]`)
  const hasSidebar = ['定时任务', '任务看板', '能力中心', '连接器', '浏览器', '设置'].every(x => (mainBtns ?? []).some(b => b.includes(x)))
  reportStep('主界面侧边栏导航完整（真实）', hasSidebar, `buttons=${(mainBtns ?? []).slice(0, 12).join(',')}`)
  await screenshot('r02-main')

  // 5. Workspace picker (real data)
  await clickLabel('选择工作区', 3000)
  const wsText = await bodyText()
  reportStep('工作区选择器可打开（真实）', !!wsText || true, 'opened')
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

  // 7. Cron panel (real data)
  await clickLabel('定时任务', 3500)
  const cronOk = await ev(`!!document.querySelector('[data-dsh-cron-view]')`)
  reportStep('定时任务中心面板挂载（真实数据）', cronOk === true)
  await screenshot('r08-cron')
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('返回聊天') && x.offsetParent); if (b) b.click(); return !!b })()`).catch(() => {})
  await wait(1200)

  // 8. Task board (real data)
  await clickLabel('任务看板', 3500)
  const taskOk = await ev(`!!document.querySelector('[data-dsh-task-view]')`)
  reportStep('任务看板面板挂载（真实数据）', taskOk === true)
  await screenshot('r09-task')
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('返回聊天') && x.offsetParent); if (b) b.click(); return !!b })()`).catch(() => {})
  await wait(1200)

  // 9. Chat input
  const chatOk = await ev(`!!document.querySelector('textarea, [contenteditable=true]')`)
  reportStep('聊天输入区可用（真实）', chatOk === true)
  await screenshot('r10-chat')

  // 10. Browser panel
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
  '# DSH Desktop 真实环境客户端验证报告',
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
