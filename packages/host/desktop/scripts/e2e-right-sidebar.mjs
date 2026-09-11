/**
 * 官方右侧栏视觉探针（2026-09-11，DSH 0.1.5 升级后）。
 *
 * 为什么需要：e2e-client 的 mock gateway 会话列表恒空，脚本从不真正创建会话，
 * 而官方右栏的展开按钮挂在 `conversation.session.header.corner`（会话作用域），
 * 没有会话就永远不出现 —— 于是"右侧栏换成官方实现"这件事在门禁里只有
 * `[data-slot="rightbar"]` 一条结构断言，没有任何渲染证据。
 *
 * 本探针走完整 UI 路径：mock 登录 → 选择工作区 → 新建会话 → 点会话头部的展开
 * 按钮 → 断言 `rightbar.session` 渲染出来并截图，供人眼复核。
 *
 * 跑法（需要 Xvfb 与已打包的 unpacked 产物）：
 *   DISPLAY=:99 yarn workspace dsh-plugin-desktop e2e:sidebar [--app <unpacked 可执行>]
 *
 * 产物：packages/host/desktop/.e2e-sidebar/{shots/*.png,home/}
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO = dirname(dirname(dirname(PKG)))
const APP = arg('--app', join(PKG, 'dist/linux-unpacked/dsh-plugin-desktop'))
const PORT = Number(arg('--port', '9226'))
const GATEWAY_PORT = 34567
const OUT = join(PKG, '.e2e-sidebar')
const SHOTS = join(OUT, 'shots')
const HOME_DIR = join(OUT, 'home')
const DISPLAY = process.env.DISPLAY ?? ':99'

if (!existsSync(APP)) { console.error(`[probe] app not found: ${APP}`); process.exit(2) }
rmSync(OUT, { recursive: true, force: true })
for (const dir of [HOME_DIR, join(OUT, 'cfg'), join(OUT, 'cache'), SHOTS]) mkdirSync(dir, { recursive: true })

const wait = ms => new Promise(r => { setTimeout(r, ms) })
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- mock gateway ---
let gateway
try {
  await fetch(`http://127.0.0.1:${String(GATEWAY_PORT)}/api/client/v2/auth/login`, { method: 'POST' })
} catch {
  gateway = spawn(process.execPath, [join(PKG, 'scripts', 'e2e-fixture-gateway.mjs')], { detached: true, stdio: 'ignore' })
  gateway.unref()
  for (let i = 0; i < 20; i += 1) {
    try { await fetch(`http://127.0.0.1:${String(GATEWAY_PORT)}/api/client/v2/auth/login`, { method: 'POST' }); break } catch { await wait(250) }
  }
}

const child = spawn(APP, ['--no-sandbox', '--lang=zh-CN', `--remote-debugging-port=${String(PORT)}`], {
  env: { ...process.env, HOME: HOME_DIR, DSH_HOME: HOME_DIR, XDG_CONFIG_HOME: join(OUT, 'cfg'), XDG_CACHE_HOME: join(OUT, 'cache'), DISPLAY },
  stdio: 'ignore',
  detached: true,
})
child.unref()

// --- CDP ---
let target
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)).json()
    target = list.find(t => t.type === 'page' && !t.url.includes('browser-shell') && !t.url.includes('browser-overlay'))
    if (target) break
  } catch { /* retry */ }
  await wait(500)
}
if (!target) { console.error('[probe] no CDP page target'); process.exit(1) }

// Node 24 ships a global WHATWG WebSocket (same as e2e-client.mjs), so this
// probe needs no `ws` dependency of its own.
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id
  pending.set(mid, { res, rej })
  ws.send(JSON.stringify({ id: mid, method, params }))
})
ws.onmessage = (data) => {
  const msg = JSON.parse(data.data)
  if (msg.id === undefined) return
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  if (msg.error) entry.rej(new Error(JSON.stringify(msg.error)))
  else entry.res(msg.result)
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
await send('Runtime.enable')
await send('Page.enable')

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result?.value
}
const waitFor = async (expression, timeout = 20000, interval = 400) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true } catch { /* retry */ }
    await wait(interval)
  }
  return false
}
const shoot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const path = join(SHOTS, `${name}.png`)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(`[probe] shot ${path}`)
}
const clickLabel = async (label, timeout = 4000) => {
  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === ${JSON.stringify(label)} && x.offsetParent)
    if (b) { b.click(); return true }
    return false
  })()`)
  if (clicked) return true
  return waitFor(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === ${JSON.stringify(label)} && x.offsetParent)
    if (!b) return false
    b.click()
    return true
  })()`, timeout)
}

try {
  // 1. Login against the mock gateway (two-step form, same as e2e-client).
  if (!await waitFor(`!!document.getElementById('f1') && !!document.getElementById('server')`, 20000, 300)) {
    throw new Error('login step 1 did not appear')
  }
  await evaluate(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('server', 'http://127.0.0.1:${String(GATEWAY_PORT)}')
  })()`)
  await wait(400)
  await clickLabel('下一步', 8000)
  if (!await waitFor(`!!document.getElementById('f2')`, 20000, 300)) throw new Error('login step 2 did not appear')
  await evaluate(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    set('username', 'admin'); set('password', 'admin')
  })()`)
  await wait(400)
  await clickLabel('登录', 8000)
  const shellReady = await waitFor(`!!document.querySelector('.dshDesktopConversationSurface')`, 25000)
  check('登录后进入桌面外壳', shellReady)
  await shoot('01-shell')

  // 2. Pick a workspace through the native browse picker (the dialog opens on
  // the harness home, which is writable in this probe).
  const pickerOpened = await clickLabel('选择工作区', 6000)
  const dialogReady = await waitFor(`document.body.textContent?.includes('选择工作区目录')`, 8000)
  check('工作区选择器打开', pickerOpened && dialogReady)
  if (dialogReady) {
    await shoot('02-picker')
    // "打开" confirms the currently listed directory.
    await clickLabel('打开', 6000)
    await wait(2500)
  }

  // 3. Start a session (the app creates it locally; the mock gateway only
  // serves auth/branding).
  await clickLabel('新会话', 6000)
  const headerReady = await waitFor(`!!document.querySelector('[data-slot="conversation.session.header"]')`, 25000)
  check('会话头部渲染（会话已创建）', headerReady)
  await shoot('03-session')

  const slots = await evaluate(`[...new Set([...document.querySelectorAll('[data-slot]')].map(el => el.getAttribute('data-slot')))]`)
  console.log('[probe] slots:', (slots ?? []).join(','))

  // 3b. A brand-new session renders the hero (no header chrome), and the right
  // Sidebar's expand control lives in the session header corner — so push the
  // session into its thread form with one message. The mock gateway has no LLM,
  // so the assistant turn may fail; the header renders from the user turn.
  const composerInfo = await evaluate(`(() => {
    const el = document.querySelector('.dshDesktopConversationSurface textarea, .dshDesktopConversationSurface [contenteditable="true"], .dshDesktopConversationSurface [role="textbox"]')
    return el ? { tag: el.tagName, editable: el.getAttribute('contenteditable'), placeholder: el.getAttribute('placeholder') ?? el.getAttribute('data-placeholder') ?? '' } : null
  })()`)
  console.log('[probe] composer:', JSON.stringify(composerInfo))
  await evaluate(`(() => {
    const el = document.querySelector('.dshDesktopConversationSurface textarea, .dshDesktopConversationSurface [contenteditable="true"], .dshDesktopConversationSurface [role="textbox"]')
    if (!el) return false
    el.focus()
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '右侧栏探针消息')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      document.execCommand('insertText', false, '右侧栏探针消息')
    }
    return true
  })()`)
  await wait(600)
  const sent = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.dshDesktopConversationSurface button')]
    const send = btns.reverse().find(b => b.offsetParent && !b.disabled)
    if (!send) return false
    send.click()
    return true
  })()`)
  console.log('[probe] send clicked:', sent)
  await wait(6000)
  await shoot('03b-after-send')

  // 4. The official right Sidebar's expand control lives in the session header's
  // corner seat. Click it and prove the panel body renders.
  const expandSelector = '[data-slot="conversation.session.header.corner"] button'
  const hasExpand = await waitFor(`!!document.querySelector('${expandSelector}')`, 15000)
  check('会话头部出现右侧栏展开按钮（官方 ui-sidebar-right 已挂载）', hasExpand)
  if (hasExpand) {
    const label = await evaluate(`(() => { const b = document.querySelector('${expandSelector}'); return b ? (b.getAttribute('aria-label') ?? b.title ?? '(no label)') : '' })()`)
    console.log('[probe] expand button label:', label)
    await evaluate(`document.querySelector('${expandSelector}').click()`)
    const panelReady = await waitFor(`!!document.querySelector('[data-slot="rightbar.session"]')`, 15000)
    check('右侧栏面板渲染（rightbar.session 出现）', panelReady)
    await wait(1200)
    await shoot('04-right-sidebar')
    const panelText = await evaluate(`(document.querySelector('[data-slot="rightbar.session"]')?.textContent ?? '').slice(0, 200)`)
    console.log('[probe] rightbar.session text:', JSON.stringify(panelText))
    const tabs = await evaluate(`[...document.querySelectorAll('[data-slot="sidebar.right.pane.tab"], [role="tab"], [class*="chip"]')].map(el => (el.textContent ?? '').trim()).filter(Boolean).slice(0, 10)`)
    console.log('[probe] right sidebar chips:', JSON.stringify(tabs))
  }
} catch (cause) {
  check('探针执行完成', false, cause instanceof Error ? cause.message : String(cause))
  await shoot('99-failure').catch(() => {})
} finally {
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  try { gateway?.kill('SIGKILL') } catch { /* ignore */ }
  ws.close()
}

const failed = checks.filter(entry => !entry.ok)
console.log(`\nprobe-right-sidebar: ${checks.length - failed.length}/${checks.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (failed.length > 0) process.exit(1)
