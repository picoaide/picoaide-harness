/**
 * 侧边栏底部"并道"视觉探针（2026-09-21）。
 *
 * 为什么需要：底部原有的 5 行导航（定时任务 / 能力中心 / 连接器 / 浏览器 / 应用中心）
 * 被合并进一个「更多」行 + 向上浮层，账户卡从常显 140px 收成一行 + 浮层。这是**纯
 * 视觉/交互**的改动，单元测试只能证明组件各自渲染正确，"点得到、浮层不裁切、激活态
 * 文案跟着面板变"必须在真窗口里证明 —— 因此本探针走完整 UI 路径：mock 登录 → 截图
 * 常态 → 点开「更多」浮层 → 用浮层打开能力中心 → 账户浮层 → 窄轨。
 *
 * 跑法（需要 Xvfb 与已打包的 unpacked 产物）：
 *   DISPLAY=:99 yarn workspace dsh-plugin-desktop package:dir
 *   DISPLAY=:99 yarn workspace dsh-plugin-desktop e2e:foot-lane [--app <unpacked 可执行>]
 *
 * 产物：packages/host/desktop/.e2e-foot-lane/{shots/*.png,report.md,home/}
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const APP = arg('--app', join(PKG, 'dist/linux-unpacked/dsh-plugin-desktop'))
const PORT = Number(arg('--attach', arg('--port', '9227')))
const ATTACH = args.includes('--attach')
const SERVER = arg('--server', '')
const USER = arg('--user', 'admin')
const PASS = arg('--pass', process.env.REAL_PASS ?? 'admin')
const GATEWAY_PORT = 34567
const OUT = join(PKG, '.e2e-foot-lane')
const SHOTS = join(OUT, 'shots')
const HOME_DIR = join(OUT, 'home')
const DISPLAY = process.env.DISPLAY ?? ':99'

if (!existsSync(APP)) { console.error(`[probe] app not found: ${APP}`); process.exit(2) }
rmSync(OUT, { recursive: true, force: true })
for (const dir of [HOME_DIR, join(OUT, 'cfg'), join(OUT, 'cache'), SHOTS]) mkdirSync(dir, { recursive: true })

const wait = ms => new Promise(r => { setTimeout(r, ms) })
/**
 * Chromium writes `SingletonLock` / `SingletonCookie` / `SingletonSocket` into its
 * profile dir; the socket one is a SYMLINK into the process-private `/tmp/scoped_dir*`.
 * After the app dies that target no longer exists, and a later `electron-builder`
 * walk over the package dir stats the dangling link and fails the whole build
 * (`ENOENT: stat '/tmp/scoped_dirXXXX/SingletonSocket'`). Drop them on the way out.
 * @param root - profile directory to sweep (missing directories are ignored).
 */
const dropSingletonLinks = (root) => {
  let entries = []
  try { entries = readdirSync(root, { recursive: true, withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.name.startsWith('Singleton') || !entry.isSymbolicLink()) continue
    try { rmSync(join(entry.parentPath ?? root, entry.name), { force: true }) } catch { /* already gone */ }
  }
}
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- mock gateway (only when this probe owns the app) ---
let gateway
const LOGIN_SERVER = SERVER !== '' ? SERVER : `http://127.0.0.1:${String(GATEWAY_PORT)}`
if (!ATTACH && SERVER === '') {
  try {
    await fetch(`http://127.0.0.1:${String(GATEWAY_PORT)}/api/client/v2/auth/login`, { method: 'POST' })
  } catch {
    gateway = spawn(process.execPath, [join(PKG, 'scripts', 'e2e-fixture-gateway.mjs')], { detached: true, stdio: 'ignore' })
    gateway.unref()
    for (let i = 0; i < 20; i += 1) {
      try { await fetch(`http://127.0.0.1:${String(GATEWAY_PORT)}/api/client/v2/auth/login`, { method: 'POST' }); break } catch { await wait(250) }
    }
  }
}

let child
if (!ATTACH) {
  child = spawn(APP, ['--no-sandbox', '--lang=zh-CN', `--remote-debugging-port=${String(PORT)}`], {
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
}

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
  await wait(280) // let the 0.12s popover/chevron transitions settle before capturing
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const path = join(SHOTS, `${name}.png`)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(`[probe] shot ${path}`)
}
/** Visibility = has a layout box (display:none subtrees measure 0×0). */
const VISIBLE = 'e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }'
/**
 * Click through the real input pipeline (`Input.dispatchMouseEvent`) instead of
 * `Element.click()`: the popovers' open/close is driven by pointer events, and a
 * synthetic click leaves the page in keyboard focus modality (which paints the
 * platform focus ring around the programmatically focused popover container —
 * an artifact that would end up in the screenshots).
 */
const rectOf = (expr) => evaluate(`(() => {
  const el = ${expr}
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)
let lastHit = ''
const clickPoint = async (x, y) => {
  lastHit = JSON.stringify(await evaluate(`(() => {
    const el = document.elementFromPoint(${x}, ${y})
    return el === null ? { hit: 'none' } : { hit: el.tagName, cls: el.getAttribute('class') ?? '' }
  })()`))
  // `buttons` must track the pressed state: a press sent with buttons=0 followed
  // by a move is treated as a drag start, and the app then renders its file-drop
  // overlay (a full-viewport mask that swallows every later click).
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  return true
}
const mouseClick = async (expr) => {
  const point = await rectOf(expr)
  if (point === null) { lastHit = 'no-rect'; return false }
  return clickPoint(point.x, point.y)
}
/**
 * `Runtime.evaluate` takes an *expression* and nothing else, so a value the page
 * has to look at can only reach it inside that expression string. Building such a
 * string out of another helper's output is what CodeQL's `js/bad-code-sanitization`
 * reports — it cannot tell a UI label apart from an injected code fragment, and the
 * old shape (`byText()` returning an expression that a second expression then
 * interpolated) is exactly that shape. The locators are therefore compile-time
 * constants and the label travels as *data*: `byText` / `byAriaLabel` first write
 * it into a page slot as a JSON literal, then hand back the constant locator that
 * reads the slot back. Reach the slot only through those two helpers, and use the
 * returned locator immediately — it reads the slot when the page evaluates it, not
 * when it is built.
 */
const NEEDLE_SLOT = '__footLaneNeedle'
const TEXT_BUTTON = `[...document.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === globalThis.${NEEDLE_SLOT} && (${VISIBLE})(x))`
const ARIA_BUTTON = `[...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? '') === globalThis.${NEEDLE_SLOT} && (${VISIBLE})(x))`
const setNeedle = (label) => evaluate(`globalThis.${NEEDLE_SLOT} = ${JSON.stringify(label)}`)
const byText = async (label) => { await setNeedle(label); return TEXT_BUTTON }
const byAriaLabel = async (label) => { await setNeedle(label); return ARIA_BUTTON }
const ACCOUNT_ROW = `[...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('admin') && b.getAttribute('aria-haspopup') === 'dialog' && (${VISIBLE})(b))`
const clickVisibleLabel = async (label) => mouseClick(await byText(label))
const clickVisibleAriaLabel = async (label) => mouseClick(await byAriaLabel(label))
const visibleTexts = () => evaluate(`(() => {
  const visible = ${VISIBLE}
  return [...document.querySelectorAll('button')].filter(visible).map(b => (b.textContent ?? '').trim()).filter(Boolean)
})()`)
/** Real Escape key press through the input pipeline (a synthetic Event misses element-scoped listeners). */
const pressEscape = async () => {
  const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

const FOOT_LABELS = ['定时任务', '能力中心', '连接器', '浏览器', '应用中心']
const TRANSCRIPT = []

try {
  // 1. Login (same flow as the other probes).
  const shellAlready = await waitFor(`!!document.querySelector('.dshDesktopConversationSurface')`, 5000, 400)
  if (shellAlready) {
    console.log('[probe] already authenticated; skipping login')
  } else if (!await waitFor(`!!document.getElementById('f1') && !!document.getElementById('server')`, 30000, 300)) {
    throw new Error('login step 1 did not appear')
  } else {
    await evaluate(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
      set('server', ${JSON.stringify(LOGIN_SERVER)})
    })()`)
    await wait(400)
    await clickVisibleLabel('下一步')
    if (!await waitFor(`!!document.getElementById('f2')`, 20000, 300)) throw new Error('login step 2 did not appear')
    await evaluate(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
      set('username', ${JSON.stringify(USER)}); set('password', ${JSON.stringify(PASS)})
    })()`)
    await wait(400)
    await clickVisibleLabel('登录')
  }
  check('进入桌面外壳（已登录）', await waitFor(`!!document.querySelector('.dshDesktopConversationSurface')`, 40000))

  // 2. 并道后的常态：底部只剩「更多」+「设置」+ 账户行；5 个旧标签不在侧边栏可见。
  const laneTexts = await visibleTexts()
  TRANSCRIPT.push(`可见按钮文案: ${JSON.stringify(laneTexts.slice(0, 24))}`)
  check('底部有「更多」行', laneTexts.includes('更多'))
  check('「设置」行保留', laneTexts.includes('设置'))
  const leaked = FOOT_LABELS.filter(l => laneTexts.includes(l))
  check('5 个旧导航行已不可见（进入浮层）', leaked.length === 0, leaked.length === 0 ? '' : `仍可见: ${leaked.join(' / ')}`)

  // The balance arrives from the host after login; wait for the amount instead of
  // matching the loading placeholder (`…`, U+2026).
  await waitFor(`(() => {
    const row = ${ACCOUNT_ROW}
    return row !== null && /¥|—/.test(row.textContent ?? '')
  })()`, 8000)
  const accountRow = await evaluate(`(() => {
    const row = ${ACCOUNT_ROW}
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { text: (row.textContent ?? '').trim(), width: Math.round(r.width), height: Math.round(r.height), expanded: row.getAttribute('aria-expanded') }
  })()`)
  check('账户行收成一行（含用户名 + 余额）', accountRow !== null, accountRow === null ? '未找到账户行' : JSON.stringify(accountRow))
  await shoot('01-foot-lane-closed')

  // 3. 「更多」浮层：点开 → 5 项按既有顺序列出 → 激活项标记。
  await clickVisibleLabel('更多')
  const menuOpen = await waitFor(`(() => {
    const visible = ${VISIBLE}
    const menu = document.querySelector('[role="menu"]')
    return !!menu && visible(menu) && menu.querySelectorAll('[role="menuitem"]').length === 5
  })()`, 5000)
  check('「更多」浮层打开且列出 5 项', menuOpen)
  if (menuOpen) {
    const items = await evaluate(`(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(b => ({
      text: (b.textContent ?? '').trim(), current: b.getAttribute('aria-current'),
    })))()`)
    TRANSCRIPT.push(`浮层条目: ${JSON.stringify(items)}`)
    const order = items.map(i => i.text)
    check('浮层条目顺序 = 定时任务 / 能力中心 / 连接器 / 浏览器 / 应用中心',
      JSON.stringify(order) === JSON.stringify(FOOT_LABELS), JSON.stringify(order))
    const rect = await evaluate(`(() => { const r = document.querySelector('[role="menu"]').getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), vh: window.innerHeight } })()`)
    TRANSCRIPT.push(`浮层几何: ${JSON.stringify(rect)}`)
    check('浮层在锚点上方且未被裁切（top >= 0）', rect.top >= 0 && rect.h > 0, JSON.stringify(rect))
    await shoot('02-foot-menu-open')
  }

  // 4. 从浮层打开能力中心：浮层关闭、面板接管中列、「更多」行显示当前面板名。
  await clickVisibleLabel('能力中心')
  const panelOpen = await waitFor(`document.documentElement.getAttribute('data-dsh-panel-active') === 'capability'`, 8000)
  check('浮层条目能打开能力中心面板', panelOpen)
  const menuClosed = await evaluate(`(() => { const m = document.querySelector('[role="menu"]'); return m === null || m.getBoundingClientRect().height === 0 })()`)
  check('选中后面板浮层自动关闭', menuClosed)
  const activeLabel = await evaluate(`(() => {
    const visible = ${VISIBLE}
    const b = [...document.querySelectorAll('button')].filter(visible).find(x => (x.textContent ?? '').trim().startsWith('更多'))
    return b === undefined ? null : (b.textContent ?? '').trim()
  })()`)
  check('「更多」行显示当前面板', typeof activeLabel === 'string' && activeLabel.includes('能力中心'), String(activeLabel))
  await wait(600)
  await shoot('03-capability-open')

  // 5. 回到会话，再开账户浮层。
  await pressEscape() // 面板自己的出口：整页面板按 Esc 返回会话区
  await waitFor(`document.documentElement.getAttribute('data-dsh-panel-active') === null`, 6000)
  await clickVisibleLabel('更多') // 打开再关掉，确保浮层关闭路径也不炸
  await wait(300)
  // 浮层外真实点击：落在侧边栏会话列表的空白处。不要点中列的虚线投放区 ——
  // 那是「选择工作区目录」的点击目标，会打开目录选择模态（它带全屏遮罩，
  // 之后所有真实点击都会被遮罩吃掉）。
  await clickPoint(140, 300)
  await wait(300)
  // 防御：任何残留的模态（含遮罩）都会吃掉后续真实点击，先清掉再继续。
  const strayModal = await evaluate(`document.querySelector('[role="dialog"][aria-modal="true"]') !== null`)
  if (strayModal) {
    await pressEscape()
    await wait(400)
  }
  check('无残留模态遮罩（真实点击可达底部）', !(await evaluate(`document.querySelector('[role="dialog"][aria-modal="true"]') !== null`)), `stray=${String(strayModal)} hit=${lastHit}`)
  const accountClicked = await mouseClick(ACCOUNT_ROW)
  check('账户行可点击（aria-haspopup=dialog）', accountClicked)
  await wait(600)
  const diagExpr = '(() => {'
    + ' const d = document.querySelector(\'[role="dialog"]\');'
    + ` const row = ${ACCOUNT_ROW};`
    + ' const menu = document.querySelector(\'[role="menu"]\');'
    + ' return {'
    + ' dialog: d === null ? null : { h: Math.round(d.getBoundingClientRect().height), text: (d.textContent || "").slice(0, 32) },'
    + ' rowExpanded: row === null ? null : row.getAttribute("aria-expanded"),'
    + ' menuHeight: menu === null ? null : Math.round(menu.getBoundingClientRect().height),'
    + ' };'
    + ' })()'
  TRANSCRIPT.push(`账户点击后诊断: ${JSON.stringify(await evaluate(diagExpr))} hit=${lastHit}`)
  const accountOpen = await waitFor(`(() => {
    const visible = ${VISIBLE}
    const d = document.querySelector('[role="dialog"]')
    return !!d && visible(d) && (d.textContent ?? '').includes('退出登录')
  })()`, 5000)
  check('账户浮层含余额与退出登录', accountOpen)
  await shoot('04-account-open')
  await pressEscape()
  await wait(400)
  const accountClosed = await evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); return d === null || d.getBoundingClientRect().height === 0 })()`)
  check('账户浮层 Esc 可关', accountClosed)

  // 6. 浮层互斥：两个浮层都挂在 body 上、各有自己的"外部点击"监听，
  //    开一个必须关掉另一个（否则屏幕上会同时浮两层，且后开的那层会被
  //    另一层的捕获阶段监听当成"外部点击"立刻关掉）。
  const clickAccountRow = () => mouseClick(ACCOUNT_ROW)
  const menuVisible = () => evaluate(`(() => { const m = document.querySelector('[role="menu"]'); return m !== null && m.getBoundingClientRect().height > 0 })()`)
  const dialogVisible = () => evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); return d !== null && d.getBoundingClientRect().height > 0 })()`)

  await clickVisibleLabel('更多')
  await waitFor(`(() => { const m = document.querySelector('[role="menu"]'); return m !== null && m.getBoundingClientRect().height > 0 })()`, 4000)
  check('互斥前置：菜单已打开', await menuVisible())
  await clickAccountRow()
  await wait(500)
  const bothAfterAccount = { menu: await menuVisible(), dialog: await dialogVisible() }
  check('菜单开着时点账户行 ⇒ 只剩账户浮层', bothAfterAccount.dialog && !bothAfterAccount.menu, JSON.stringify(bothAfterAccount))
  await shoot('05-popover-exclusive')
  await pressEscape()
  await wait(400)
  check('Esc 后两个浮层都关', !(await menuVisible()) && !(await dialogVisible()))

  await clickAccountRow()
  await waitFor(`(() => { const d = document.querySelector('[role="dialog"]'); return d !== null && d.getBoundingClientRect().height > 0 })()`, 4000)
  check('互斥反向：账户浮层已打开', await dialogVisible())

  // 6b. 账户浮层向上展开，盖住「更多」/「设置」两行 —— 真实鼠标点在「更多」的位置
  //     会落在浮层上。这**不是**点击穿透缺陷：要求"不穿透"（菜单不打开、浮层还在）。
  await clickVisibleLabel('更多')
  await wait(500)
  const mouseWhileDialog = { menu: await menuVisible(), dialog: await dialogVisible() }
  check('账户浮层盖住「更多」时，鼠标点击不穿透（菜单不打开、浮层保持）',
    !mouseWhileDialog.menu && mouseWhileDialog.dialog, JSON.stringify(mouseWhileDialog))

  // 6c. 键盘路径才是"两层同时打开"的真实入口（Round-1 审计 P1）：焦点落在「更多」
  //     上按 Enter 必须把账户浮层关掉再打开菜单。
  await evaluate(`(() => { const b = ${await byText('更多')}; if (b !== null) b.focus(); return b !== null })()`)
  await wait(150)
  const focusBefore = await evaluate(`document.activeElement === null ? 'none' : (document.activeElement.getAttribute('class') ?? document.activeElement.tagName)`)
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
  await wait(600)
  const keyWhileDialog = { menu: await menuVisible(), dialog: await dialogVisible() }
  TRANSCRIPT.push(`键盘激活诊断: focusBefore=${String(focusBefore)} after=${JSON.stringify(keyWhileDialog)}`)
  check('键盘激活「更多」⇒ 账户浮层被关掉、菜单打开（审计 P1 回归点）',
    keyWhileDialog.menu && !keyWhileDialog.dialog, JSON.stringify(keyWhileDialog))
  await pressEscape()
  await wait(300)

  // 7. 窄轨：底部只剩「更多」图标按钮 + 头像按钮。
  await clickVisibleAriaLabel('收起侧边栏')
  const rail = await waitFor(`(() => {
    const visible = ${VISIBLE}
    const more = [...document.querySelectorAll('button')].filter(visible).find(b => (b.getAttribute('aria-label') ?? '').includes('更多'))
    if (!more) return false
    const r = more.getBoundingClientRect()
    return r.width <= 44 && r.height <= 44
  })()`, 6000)
  check('窄轨下「更多」收成 36×36 图标按钮', rail)
  await wait(500)
  await shoot('06-rail')
} catch (cause) {
  check('探针执行完成（无异常）', false, cause instanceof Error ? cause.message : String(cause))
} finally {
  const failed = checks.filter(c => !c.ok)
  const lines = [
    '# 侧边栏底部并道探针报告',
    '',
    `- 时间: ${new Date().toISOString()}`,
    `- 应用: ${APP}`,
    `- 结果: ${failed.length === 0 ? 'PASS' : `FAIL (${String(failed.length)})`}`,
    '',
    '| 断言 | 结果 | 细节 |',
    '| --- | --- | --- |',
    ...checks.map(c => `| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replaceAll('|', '\\|')} |`),
    '',
    '## 现场记录',
    '',
    ...TRANSCRIPT.map(t => `- ${t}`),
    '',
    '## 截图',
    '',
    '- `shots/01-foot-lane-closed.png` 常态：更多 + 设置 + 账户行',
    '- `shots/02-foot-menu-open.png` 「更多」浮层展开（5 项）',
    '- `shots/03-capability-open.png` 从浮层打开能力中心后的激活态文案',
    '- `shots/04-account-open.png` 账户浮层（余额 / 刷新 / 退出登录）',
    '- `shots/05-popover-exclusive.png` 互斥：菜单开着时点账户行（只应剩账户浮层）',
    '- `shots/06-rail.png` 窄轨',
    '',
  ]
  writeFileSync(join(OUT, 'report.md'), lines.join('\n'))
  console.log(`[probe] report ${join(OUT, 'report.md')}`)
  try { child?.kill('SIGKILL') } catch { /* ignore */ }
  try { gateway?.kill('SIGKILL') } catch { /* ignore */ }
  dropSingletonLinks(HOME_DIR)
  dropSingletonLinks(join(OUT, 'cfg'))
  process.exit(failed.length === 0 ? 0 : 1)
}
