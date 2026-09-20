/**
 * 官方右侧栏「终端」的行为探针（2026-09-20，DSH 0.1.6 升级后）。
 *
 * 为什么需要：`ui-sidebar-terminal` + `terminal-controller` 是 0.1.6 新增的两行
 * （rc.2 没有），默认启用，产品口径是**支持终端**。`e2e:sidebar` 只证明右栏渲染出
 * 了「新建终端 / 在会话工作区运行命令」这个入口，**没有点进去**；`e2e:client` 也不
 * 覆盖终端。于是"终端到底能不能开、能不能跑命令"在门禁里是空白 —— 本探针补上：
 *
 *   登录 → 建工作区/会话 → 展开右栏 → 点「新建终端」→ 断言 xterm 表面出现
 *   → 真敲 `echo <marker>` → 断言回显里出现 marker。
 *
 * 三个已知的假通过/假红坑（都踩过，勿简化）：
 *   1. `clickLabel` 必须跳过 `disabled` 按钮 —— 禁用按钮也能 `.click()`，"点了但没
 *      反应"会被记成成功（工作区选择器的「打开」在目录列表加载完前就是禁用的）。
 *   2. 「打开」点完必须断言对话框**真的关了**再点「新会话」，否则后续步骤全部在
 *      模态框后面空点。
 *   3. 终端是 xterm 的 **DOM renderer**（`.xterm-rows` 里有文本），不是 canvas；
 *      断言读 `.xterm-rows` 即可，不需要像素比对。
 *
 * 跑法（需要 Xvfb 与已打包的 unpacked 产物）：
 *   DISPLAY=:99 yarn workspace dsh-plugin-desktop e2e:terminal [--app <unpacked 可执行>] [--verbose]
 *
 * 产物：packages/host/desktop/.e2e-terminal/{shots/*.png,home/,cfg/}
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const VERBOSE = args.includes('--verbose')

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const APP = arg('--app', join(PKG, 'dist/linux-unpacked/dsh-plugin-desktop'))
const PORT = Number(arg('--port', '9228'))
const GATEWAY_PORT = 34567
const OUT = join(PKG, '.e2e-terminal')
const SHOTS = join(OUT, 'shots')
const HOME_DIR = join(OUT, 'home')
const DISPLAY = process.env.DISPLAY ?? ':99'
const MARKER = 'PICO_TERMINAL_OK_2026'

if (!existsSync(APP)) { console.error(`[probe] app not found: ${APP}`); process.exit(2) }
rmSync(OUT, { recursive: true, force: true })
for (const dir of [HOME_DIR, join(OUT, 'cfg'), join(OUT, 'cache'), SHOTS]) mkdirSync(dir, { recursive: true })

const wait = ms => new Promise(r => { setTimeout(r, ms) })
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- mock gateway (owns one only when nothing is listening yet) ---
let gateway
const LOGIN_SERVER = `http://127.0.0.1:${String(GATEWAY_PORT)}`
try {
  await fetch(`${LOGIN_SERVER}/api/client/v2/auth/login`, { method: 'POST' })
} catch {
  gateway = spawn(process.execPath, [join(PKG, 'scripts', 'e2e-fixture-gateway.mjs')], { detached: true, stdio: 'ignore' })
  gateway.unref()
  for (let i = 0; i < 20; i += 1) {
    try { await fetch(`${LOGIN_SERVER}/api/client/v2/auth/login`, { method: 'POST' }); break } catch { await wait(250) }
  }
}

const child = spawn(APP, ['--no-sandbox', '--lang=zh-CN', `--remote-debugging-port=${String(PORT)}`], {
  env: {
    ...process.env,
    HOME: HOME_DIR,
    DSH_HOME: HOME_DIR,
    XDG_CONFIG_HOME: join(OUT, 'cfg'),
    XDG_CACHE_HOME: join(OUT, 'cache'),
    DISPLAY,
  },
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
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(shot.data, 'base64'))
}
/** Click a visible, **enabled** button by exact label (disabled ones swallow the click). */
const clickLabel = async (label, timeout = 8000) => {
  const expr = `(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === ${JSON.stringify(label)} && x.offsetParent && !x.disabled)
    if (!b) return false
    b.click()
    return true
  })()`
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(expr)) return true
    await wait(300)
  }
  return false
}

try {
  // 1. Login
  if (!await waitFor(`!!document.getElementById('f1') && !!document.getElementById('server')`, 30000, 300)) {
    throw new Error('login step 1 did not appear')
  }
  await evaluate(`(() => {
    const el = document.getElementById('server')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(LOGIN_SERVER)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await wait(400)
  await clickLabel('下一步')
  if (!await waitFor(`!!document.getElementById('f2')`, 20000, 300)) throw new Error('login step 2 did not appear')
  await evaluate(`(() => {
    const set = (id, v) => {
      const el = document.getElementById(id)
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('username', 'admin'); set('password', 'admin')
  })()`)
  await wait(400)
  await clickLabel('登录')
  check('登录并进入桌面外壳', await waitFor(`!!document.querySelector('.dshDesktopConversationSurface')`, 40000))

  // 2. 工作区 + 会话（右栏展开按钮挂在会话头部的 corner 席位）
  await clickLabel('选择工作区')
  const dialogReady = await waitFor(`document.body.textContent?.includes('选择工作区目录')`, 10000)
  check('工作区选择器打开', dialogReady)
  if (dialogReady) {
    let closed = false
    for (let attempt = 0; attempt < 3 && !closed; attempt += 1) {
      await clickLabel('打开')
      closed = await waitFor(`!document.body.textContent?.includes('选择工作区目录')`, 6000, 400)
      if (!closed) await wait(1000)
    }
    check('工作区选择器已关闭（打开生效）', closed)
    await wait(1500)
  }
  await clickLabel('新会话')
  check('会话就绪（会话头部渲染）', await waitFor(`!!document.querySelector('[data-slot="conversation.session.header"]')`, 25000))

  // 让会话进入 thread 形态（corner 席位才出现）：mock 网关没有 LLM，助手回合会失败，
  // 但头部由用户回合渲染。
  await evaluate(`(() => {
    const el = document.querySelector('.dshDesktopConversationSurface textarea, .dshDesktopConversationSurface [contenteditable="true"], .dshDesktopConversationSurface [role="textbox"]')
    if (!el) return false
    el.focus()
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '终端探针')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      document.execCommand('insertText', false, '终端探针')
    }
    return true
  })()`)
  await wait(600)
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.dshDesktopConversationSurface button')]
    const send = btns.reverse().find(b => b.offsetParent && !b.disabled)
    if (send) { send.click(); return true }
    return false
  })()`)
  await wait(5000)

  // 3. 展开右侧栏，确认终端入口在
  check('右侧栏展开按钮可点', await evaluate(`(() => {
    const b = document.querySelector('[data-slot="conversation.session.header.corner"] button')
    if (!b) return false
    b.click()
    return true
  })()`))
  check('右侧栏面板渲染', await waitFor(`!!document.querySelector('[data-sidebar-right-panel]')`, 15000))
  const rightbarText = await evaluate(`(() => {
    const p = document.querySelector('[data-sidebar-right-panel]')
    return p === null ? '' : (p.textContent ?? '').trim().slice(0, 200)
  })()`)
  if (VERBOSE) console.log('[probe] rightbar text:', JSON.stringify(rightbarText))
  check('右栏存在「新建终端」入口', String(rightbarText).includes('新建终端'))
  await shoot('01-rightbar')

  // 4. 点开终端（TerminalGuide 的可点元素 = 承载「新建终端」标题的那个 button）
  const clicked = await evaluate(`(() => {
    const p = document.querySelector('[data-sidebar-right-panel]') ?? document
    const title = [...p.querySelectorAll('span, div')]
      .filter(el => (el.textContent ?? '').trim() === '新建终端' && el.offsetParent)
      .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]
    if (!title) return false
    ;(title.closest('button, [role="button"]') ?? title).click()
    return true
  })()`)
  check('「新建终端」可点', clicked)
  check('终端表面渲染（xterm）', await waitFor(`!!document.querySelector('.xterm .xterm-rows')`, 20000))
  await wait(2000)

  const tty = await evaluate(`(() => {
    const el = document.querySelector('.xterm')
    const rows = el?.querySelector('.xterm-rows')
    return {
      textarea: el?.querySelector('.xterm-helper-textarea') !== null && el !== null,
      prompt: rows === null || rows === undefined ? '' : (rows.textContent ?? '').slice(0, 200),
      tab: [...document.querySelectorAll('[data-dockkit-tab]')].map(t => (t.textContent ?? '').trim()),
    }
  })()`)
  if (VERBOSE) console.log('[probe] tty:', JSON.stringify(tty))
  check('终端标签出现且拿到了 shell 提示符', typeof tty?.prompt === 'string' && tty.prompt.length > 0, `prompt=${JSON.stringify(tty?.prompt ?? '')}`)
  check('终端可聚焦（xterm helper textarea）', tty?.textarea === true)
  await shoot('02-terminal')

  // 5. 真敲一条命令（xterm 的输入走隐藏 textarea 的键盘事件）
  await evaluate(`(() => {
    const el = document.querySelector('.xterm-helper-textarea') ?? document.querySelector('.xterm')
    if (!el) return false
    el.focus()
    if (el.click) el.click()
    return true
  })()`)
  for (const ch of `echo ${MARKER}`) {
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch })
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await wait(3000)
  await shoot('03-terminal-command')

  const echoed = await evaluate(`(() => {
    const rows = document.querySelector('.xterm .xterm-rows')
    return rows === null ? '' : (rows.textContent ?? '')
  })()`)
  check('命令在终端里执行并回显标记', String(echoed).includes(MARKER), `rows=${JSON.stringify(String(echoed).slice(0, 160))}`)
} catch (error) {
  check(`探针执行未抛异常（${String(error instanceof Error ? error.message : error)}）`, false)
  try {
    const logDir = join(OUT, 'cfg', 'PicoAide Harness', 'logs')
    if (existsSync(logDir)) {
      const files = readdirSync(logDir).sort()
      const latest = files[files.length - 1]
      if (latest !== undefined) {
        console.log(`[probe] app log ${latest} (tail):`)
        console.log(readFileSync(join(logDir, latest), 'utf8').split('\n').slice(-30).join('\n'))
      }
    }
  } catch { /* diagnostics are best-effort */ }
} finally {
  try { await Promise.race([send('Browser.close'), wait(2000)]) } catch { /* ignore */ }
  try { child.kill('SIGKILL') } catch { /* ignore */ }
}

const failed = checks.filter(c => !c.ok)
console.log(`\nprobe-terminal: ${String(checks.length - failed.length)} passed, ${String(failed.length)} failed`)
console.log(`screenshots: ${SHOTS}`)
process.exit(failed.length === 0 ? 0 : 1)
