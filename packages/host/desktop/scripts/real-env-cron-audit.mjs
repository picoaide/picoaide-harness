/**
 * Real-environment scheduled-job form audit (custom): drive the packaged app
 * against the real picoaide gateway, walk into the scheduled-job center,
 * open the new-job editor, and assert EVERY form control the v2 editor ships
 * (name / cron / workspace / agent preset / permission / prompt). Also
 * verifies the agent-preset roster loads non-empty (the merge's core feature).
 *
 * Usage:
 *   REAL_SERVER=https://picoaide-harness.kq0575.cn REAL_USER=user001 REAL_PASS=user001123456 \
 *   node scripts/real-env-cron-audit.mjs [--port 9224] [--shots .real-env-cron-shots]
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
const shotsDir = arg('--shots', join(PACKAGE_ROOT, '.real-env-cron-shots'))
const reportPath = join(PACKAGE_ROOT, '.real-env-cron-report.md')

const SERVER = process.env.REAL_SERVER ?? 'https://picoaide-harness.kq0575.cn'
const USER = process.env.REAL_USER ?? 'user001'
const PASS = process.env.REAL_PASS ?? ''
if (!PASS) {
  console.error('real-env-cron-audit: set REAL_PASS')
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

// --- CDP client (same contract as real-env-verify.mjs) ---
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

async function resetToLogin() {
  await ev(`(() => { try { localStorage.clear() } catch {}; try { sessionStorage.clear() } catch {}; return true })()`)
  await send('Page.reload', { ignoreCache: true })
  await wait(4000)
}

try {
  // 1. Reset to login
  await resetToLogin()
  await screenshot('c00-login')

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
  await wait(3000)

  // 3. Let the client settle (panel graph).
  await wait(2000)

  // 4. Open the scheduled-job center from the sidebar.
  const cronOpen = await clickLabel('定时任务', 3500)
  const cronView = await ev(`!!document.querySelector('[data-dsh-cron-view]')`)
  reportStep('定时任务中心面板挂载', cronOpen === 'CLICKED' && cronView === true)
  await screenshot('c01-cron-center')

  // 5. Click "新建任务" to open the job editor dialog.
  const createClicked = await clickLabel('+ 新建任务', 2500)
  if (createClicked !== 'CLICKED') {
    // Fallback: label may render without the "+" prefix spacing.
    const alt = await clickLabel('新建任务', 2500)
    reportStep('新建任务按钮可点击', alt === 'CLICKED', `alt=${alt}`)
  } else {
    reportStep('新建任务按钮可点击', true, 'clicked')
  }
  const dialog = await ev(`(() => {
    const d = document.querySelector('[role=dialog]')
    return d ? { text: d.textContent ?? '', html: d.outerHTML } : null
  })()`)
  reportStep('新建任务弹窗打开', dialog !== null)
  if (dialog === null) throw new Error('job editor dialog did not open')
  await screenshot('c02-job-editor')

  // 6. Enumerate ALL inputs/selects/textareas in the editor dialog.
  const controls = await ev(`(() => {
    const d = document.querySelector('[role=dialog]')
    if (!d) return null
    const out = { inputs: [], selects: [], textareas: [] }
    for (const el of d.querySelectorAll('input')) out.inputs.push({
      type: el.type ?? '', value: el.value ?? '', ph: el.placeholder ?? '',
      label: el.closest('div')?.querySelector('span')?.textContent?.trim() ?? '',
    })
    for (const el of d.querySelectorAll('select')) {
      const opts = [...el.options].map(o => ({ v: o.value, label: o.textContent?.trim() }))
      out.selects.push({ label: el.closest('div')?.querySelector('span')?.textContent?.trim() ?? '', options: opts, disabled: el.disabled })
    }
    for (const el of d.querySelectorAll('textarea')) out.textareas.push({
      value: el.value ?? '', label: el.closest('div')?.querySelector('span')?.textContent?.trim() ?? '',
    })
    return out
  })()`)
  if (controls === null) throw new Error('controls enumeration failed')
  reportStep('表单包含名称输入框', controls.inputs.some(i => i.label.includes('名称')),
    `inputs=${JSON.stringify(controls.inputs)}`)
  reportStep('表单包含 Cron 输入框', controls.inputs.some(i => i.label.includes('Cron')),
    `cron=${JSON.stringify(controls.inputs)}`)
  reportStep('表单包含执行内容文本域', controls.textareas.some(t => t.label.includes('执行内容') || t.label.includes('提示词')),
    `textareas=${JSON.stringify(controls.textareas)}`)
  const workspace = controls.selects.find(s => s.label.includes('项目'))
  reportStep('表单包含项目选择', workspace !== undefined, `options=${workspace?.options.length}`)
  const agent = controls.selects.find(s => s.label.includes('智能体'))
  reportStep('表单包含执行智能体选择', agent !== undefined, `label=${agent?.label} options=${agent?.options.length}`)
  // The core merge feature: the agent roster must carry real presets.
  reportStep('智能体下拉有可选项（roster 非空）', agent !== undefined && agent.options.length > 1,
    `options=${agent?.options.length} :: ${JSON.stringify(agent?.options)}`)
  const permission = controls.selects.find(s => s.label.includes('权限'))
  reportStep('表单包含权限选择', permission !== undefined, `options=${permission?.options.length}`)

  // 7. Close the dialog (Escape) and the center (返回聊天).
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => {})
  await wait(800)
  const dialogAfter = await ev(`!!document.querySelector('[role=dialog]')`)
  reportStep('弹窗可关闭（Esc）', dialogAfter === false)
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('返回聊天') && x.offsetParent); if (b) b.click(); return !!b })()`).catch(() => {})
  await wait(1200)
  await screenshot('c03-back')

  // 8. Chat input still usable after the panel.
  const chatOk = await ev(`!!document.querySelector('textarea, [contenteditable=true]')`)
  reportStep('返回后聊天输入区可用', chatOk === true)
  await screenshot('c04-chat')
} catch (cause) {
  console.error('real-env-cron-audit fatal:', cause instanceof Error ? cause.message : String(cause))
  results.push({ name: '脚本执行', ok: false, detail: cause instanceof Error ? cause.message : String(cause) })
}

// --- report ---
const failed = results.filter(r => !r.ok)
const lines = [
  '# PicoAide Harness 真实环境-定时任务表单审计报告',
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
if (failed.length > 0) {
  lines.push('', '## 失败项', ...failed.map(f => `- ${f.name}: ${f.detail}`))
}
writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8')
console.log(`\nreport: ${reportPath}`)
process.exit(failed.length > 0 ? 1 : 0)
