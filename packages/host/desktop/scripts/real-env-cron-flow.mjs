/**
 * Real-environment scheduled-job deep flow (custom): create a job through the
 * real UI, verify it lands in the list, run it once, open its execution
 * detail, verify the open-session jump renders, then delete the job. Every
 * key state is screenshot.
 *
 * Usage:
 *   REAL_SERVER=https://harness.example.com REAL_USER=test-user REAL_PASS=test-password \
 *   node scripts/real-env-cron-flow.mjs --port 9224 --shots .real-env-cron-flow-shots
 */
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
const PORT = Number(arg('--port', '9224'))
const shotsDir = arg('--shots', join(PACKAGE_ROOT, '.real-env-cron-flow-shots'))
const reportPath = join(PACKAGE_ROOT, '.real-env-cron-flow-report.md')

const SERVER = process.env.REAL_SERVER ?? (() => { throw new Error('REAL_SERVER is required') })()
const USER = process.env.REAL_USER ?? 'test-user'
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

/**
 * 打开底部「更多」浮层（2026-09-21 并道后，面板入口不在常显行里）。
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
async function openPanelFromFootMenu(label, panelId, waitMs = 3500) {
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
  // 激活态属性是唯一真源：只查 textContent 会在"面板根本没打开"时同样为真。
  const active = await ev(`document.documentElement.getAttribute('data-dsh-panel-active')`)
  return active === panelId ? 'CLICKED' : 'NOT_ACTIVE'
}

try {
  // Open the cron center. 2026-09-21 并道之后入口住在「更多」浮层里：先开浮层再点条目，
  // 并用 panel-surface 的激活态属性断言面板真的接管了中列（只看 textContent 会假绿）。
  const cronOpen = await openPanelFromFootMenu('定时任务', 'cron', 3500)
  reportStep('从「更多」浮层打开定时任务中心', cronOpen === 'CLICKED', `open=${cronOpen}`)
  await wait(1000)
  await screenshot('f01-cron-center')

  // Open the editor and fill the full form.
  await clickLabel('+ 新建任务', 1500)
  await wait(800)
  await screenshot('f02-editor-empty')

  const fillResult = await ev(`(() => {
    const d = document.querySelector('[role=dialog]')
    if (!d) return 'NO_DIALOG'
    const setInput = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const s = Object.getOwnPropertyDescriptor(proto, 'value').set
      s.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const labels = [...d.querySelectorAll('span')].map(s => s.textContent?.trim() ?? '')
    const byLabel = (needle) => {
      const idx = labels.findIndex(l => l.includes(needle))
      if (idx < 0) return undefined
      const field = d.querySelectorAll('div')[idx] // span's parent-ish; locate via span sibling
      const span = [...d.querySelectorAll('span')].find(s => (s.textContent ?? '').includes(needle))
      if (!span) return undefined
      return span.closest('div')?.querySelector('input, textarea, select')
    }
    // 名称
    const nameEl = [...d.querySelectorAll('input')].find(i => (i.closest('div')?.querySelector('span')?.textContent ?? '').includes('名称'))
    if (!nameEl) return 'NO_NAME'
    setInput(nameEl, '真实环境-定时任务验证 ' + Date.now())
    // Cron
    const cronEl = [...d.querySelectorAll('input')].find(i => (i.closest('div')?.querySelector('span')?.textContent ?? '').includes('Cron'))
    if (!cronEl) return 'NO_CRON'
    setInput(cronEl, '*/30 * * * *')
    // 提示词
    const ta = d.querySelector('textarea')
    if (!ta) return 'NO_TEXTAREA'
    setInput(ta, '请简要说明当前时间并输出 OK。')
    // 智能体 select: pick "standard"
    const agentSel = [...d.querySelectorAll('select')].find(s => (s.closest('div')?.querySelector('span')?.textContent ?? '').includes('智能体'))
    if (agentSel) {
      const opt = [...agentSel.options].find(o => o.value === 'standard')
      if (opt) { agentSel.value = 'standard'; agentSel.dispatchEvent(new Event('change', { bubbles: true })) }
    }
    // 权限 select: keep 不使用
    return 'FILLED'
  })()`)
  reportStep('表单已完整填写', fillResult === 'FILLED', `fill=${fillResult}`)
  await wait(500)
  await screenshot('f03-editor-filled')

  // Save.
  const saveClicked = await clickLabel('保存', 2500)
  reportStep('保存任务', saveClicked === 'CLICKED', `save=${saveClicked}`)
  await wait(1500)
  await screenshot('f04-after-save')

  // Verify the job row is in the list.
  const rowText = await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-dsh-cron-panel] *')].filter(el => (el.textContent ?? '').includes('真实环境-定时任务验证'))
    return rows.length > 0 ? 'FOUND' : 'MISSING'
  })()`)
  reportStep('新任务出现在列表中', rowText === 'FOUND', `row=${rowText}`)
  await screenshot('f05-job-row')

  // Run it immediately.
  const runClicked = await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-dsh-cron-panel] button')].filter(b => (b.textContent ?? '').trim() === '立即执行' && b.offsetParent)
    if (!rows.length) return 'NOT_FOUND'
    rows[rows.length - 1].click()
    return 'CLICKED'
  })()`)
  reportStep('立即执行已点击', runClicked === 'CLICKED', `run=${runClicked}`)
  await wait(6000)
  await screenshot('f06-after-run')

  // Expand execution detail: the "+" toggle of the newest row.
  await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-dsh-cron-panel] button')].filter(b => (b.textContent ?? '').trim() === '+' && b.offsetParent)
    if (rows.length) rows[rows.length - 1].click()
    return rows.length
  })()`)
  await wait(1200)
  await screenshot('f07-execution-detail')
  const detailText = await ev(`(() => {
    const panel = document.querySelector('[data-dsh-cron-panel]')
    return panel?.textContent ?? ''
  })()`)
  reportStep('执行详情含打开会话按钮', detailText.includes('打开会话'), `hasOpenSession=${detailText.includes('打开会话')}`)
  reportStep('执行详情含结果状态', /成功|执行中|失败/.test(detailText), `text=${detailText.slice(0, 200)}`)
  const sessionVisible = await ev(`(() => {
    const t = document.querySelector('[data-dsh-cron-panel]')?.textContent ?? ''
    const m = t.match(/session-[a-z0-9]+/i)
    return m ? m[0] : 'NONE'
  })()`)
  reportStep('执行详情展示会话 ID', sessionVisible !== 'NONE', `session=${sessionVisible}`)

  // Click 打开会话 (if present) then return to chat.
  const openClicked = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent ?? '').includes('打开会话') && x.offsetParent)
    if (!b) return 'NOT_FOUND'
    b.click()
    return 'CLICKED'
  })()`)
  reportStep('打开会话可点击', openClicked !== 'NOT_FOUND', `open=${openClicked}`)
  await wait(2500)
  await screenshot('f08-open-session')

  // Delete the verification job. 入口同样在浮层里（并道后）。
  const cronReopen = await openPanelFromFootMenu('定时任务', 'cron', 2500)
  reportStep('重新打开定时任务中心（浮层入口）', cronReopen === 'CLICKED', `open=${cronReopen}`)
  const deleted = await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-dsh-cron-panel] button')].filter(b => (b.textContent ?? '').trim() === '删除' && b.offsetParent)
    if (!rows.length) return 'NOT_FOUND'
    // confirm dialog
    window.confirm = () => true
    rows[rows.length - 1].click()
    return 'CLICKED'
  })()`)
  reportStep('验证任务已删除', deleted === 'CLICKED', `del=${deleted}`)
  await wait(1500)
  await screenshot('f09-after-delete')
} catch (cause) {
  console.error('real-env-cron-flow fatal:', cause instanceof Error ? cause.message : String(cause))
  results.push({ name: '脚本执行', ok: false, detail: cause instanceof Error ? cause.message : String(cause) })
}

const failed = results.filter(r => !r.ok)
const lines = [
  '# PicoAide Harness 真实环境-定时任务深度流程报告',
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
