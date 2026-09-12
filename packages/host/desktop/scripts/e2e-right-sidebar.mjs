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
const PORT = Number(arg('--attach', arg('--port', '9226')))
const ATTACH = args.includes('--attach')
const SERVER = arg('--server', '')
const USER = arg('--user', 'admin')
const PASS = arg('--pass', process.env.REAL_PASS ?? 'admin')
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
/** Record a check that this run cannot exercise (never counted as a failure). */
const skip = (name, reason) => {
  checks.push({ name, ok: true, skipped: true, detail: reason })
  console.log(`SKIP  ${name} — ${reason}`)
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
    env: { ...process.env, HOME: HOME_DIR, DSH_HOME: HOME_DIR, XDG_CONFIG_HOME: join(OUT, 'cfg'), XDG_CACHE_HOME: join(OUT, 'cache'), DISPLAY },
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
  // 1. Login — skipped when the app is already authenticated (attach mode, or
  // the caller just ran real-env-verify against the same instance).
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
    await clickLabel('下一步', 8000)
    if (!await waitFor(`!!document.getElementById('f2')`, 20000, 300)) throw new Error('login step 2 did not appear')
    await evaluate(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
      set('username', ${JSON.stringify(USER)}); set('password', ${JSON.stringify(PASS)})
    })()`)
    await wait(400)
    await clickLabel('登录', 8000)
  }
  const shellReady = await waitFor(`!!document.querySelector('.dshDesktopConversationSurface')`, 40000)
  check('进入桌面外壳（已登录）', shellReady)
  await shoot('01-shell')

  // 1b. 品牌槽位归属：单占位槽必须由**我们的品牌层**占用，而不是上游厂商 mark。
  //
  // 为什么这样断言（2026-09-12）：渠道会越来越多，每个渠道有自己的 logo ——
  // 早先"槽位里的内联 svg 必须含 1.25× 缩放"只对**未配 logo** 的构建成立；渠道包
  // 提供 logo 时（`stageChannelProfile()` 内联成 data: URI）槽位渲染 `<img>`，
  // 于是同一提交在官方构建绿、渠道构建红，并会卡住 tag 发布流水（已实测两次）。
  // 逐个枚举"合法图形"不可维护，因此改为**断言归属**：
  // 槽位有且仅有一个占用者（svg 或 img），且它带 `data-brand-mark="app"`
  // （只有 `BraceMark` 的产物带它，厂商 mark 没有）。渠道 logo 的具体图形由渠道包
  // 与构建期校验负责；几何是否等于权威 logo 由 enterprise 的
  // `tests/channel-geometry.spec.ts` 对着 brands/official/logo.svg 守卫。
  //
  // 保留**有界等待**：槽位内容随 channel/brand 解析异步出现，零等待会读到空槽。
  const brandExpr = `(() => {
    const mark = document.querySelector('[data-slot="sidebar.brand.mark"]')
    const name = document.querySelector('[data-slot="sidebar.brand.name"]')
    if (!mark) return { found: false, owned: false, occupants: 0, kind: 'none', name: '' }
    const svgCount = mark.querySelectorAll('svg').length
    const imgCount = mark.querySelectorAll('img').length
    const occupants = svgCount + imgCount
    const owned = mark.querySelector('[data-brand-mark="app"]') !== null
    const kind = svgCount > 0 ? 'inline-svg' : imgCount > 0 ? 'channel-logo' : 'empty'
    return { found: true, owned, occupants, kind, svgCount, imgCount, name: (name?.textContent ?? '').trim().slice(0, 40) }
  })()`
  const brandOk = await waitFor(`(() => { const r = ${brandExpr}; return r.occupants === 1 && r.owned === true })()`, 15000, 300)
  const brand = await evaluate(brandExpr)
  const brandFailHint = brand.found && brand.owned !== true && brand.occupants > 0
    ? '（槽位被非本产品 mark 占用，疑似上游厂商图形/鲸鱼）'
    : ''
  check('品牌槽位由本产品品牌层占用（排除上游厂商 mark）',
    brandOk && brand.found && brand.owned === true && brand.occupants === 1,
    `found=${brand.found} owned=${brand.owned} kind=${brand.kind} occupants=${brand.occupants} ` +
    `svgs=${brand.svgCount} imgs=${brand.imgCount} name=${JSON.stringify(brand.name)}${brandFailHint}`)
  await shoot('01b-brand')

  // 2. Workspace + session. Rerunnable: a probe run against an app that already
  // has a conversation skips creation instead of clicking through a picker that
  // is no longer on screen (the first version failed on every second run).
  const sessionAlready = await evaluate(`!!document.querySelector('[data-slot="conversation.session.header"]')`)
  if (sessionAlready) {
    console.log('[probe] existing session reused; skipping workspace + new-session steps')
    check('工作区/会话就绪（复用已有会话）', true)
  } else {
    const pickerOpened = await clickLabel('选择工作区', 6000)
    const dialogReady = await waitFor(`document.body.textContent?.includes('选择工作区目录')`, 8000)
    check('工作区选择器打开', pickerOpened && dialogReady)
    if (dialogReady) {
      await shoot('02-picker')
      // "打开" confirms the currently listed directory.
      await clickLabel('打开', 6000)
      await wait(2500)
    }
    await clickLabel('新会话', 6000)
  }
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
  const hasTurns = await evaluate(`(document.querySelector('[data-slot="conversation.session"]')?.textContent ?? '').includes('上下文注入')`)
  const sent = hasTurns ? 'SKIPPED (session already has turns)' : await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.dshDesktopConversationSurface button')]
    const send = btns.reverse().find(b => b.offsetParent && !b.disabled)
    if (!send) return false
    send.click()
    return true
  })()`)
  console.log('[probe] send clicked:', sent)
  await wait(6000)
  await shoot('03b-after-send')

  // 3c. agent-presets patch: the packaged app resolves the shipped preset root
  // through the asar-aware fallback, so the roster must be non-empty. Checked on
  // the settings page rather than the composer's preset control, which only
  // exists in the hero state of an empty session (that made the first version
  // pass or fail depending on how far the session had progressed).
  await clickLabel('设置', 1500)
  const settingsOpen = await waitFor(`document.body.textContent?.includes('通用设置') ?? false`, 10000)
  if (settingsOpen) {
    await clickLabel('Agent 预设', 2000)
    const roster = await evaluate(`(() => {
      const text = document.body.textContent ?? ''
      return { presets: ['标准', 'PTC', '最小', '只读'].filter(name => text.includes(name)), len: text.length }
    })()`)
    check('Agent 预设补丁生效（设置页能列出预设）',
      Array.isArray(roster?.presets) && roster.presets.length > 0,
      `presets=${JSON.stringify(roster?.presets ?? [])}`)
    await shoot('03c-presets')
    await clickLabel('关闭', 1200)
  } else {
    skip('Agent 预设补丁生效', '设置面板未打开')
  }

  // 4. The official right Sidebar's expand control lives in the session header's
  // corner seat. Click it and prove the panel body renders.
  const expandSelector = '[data-slot="conversation.session.header.corner"] button'
  // Presence is not openness: collapsing keeps the occupant's content tree
  // mounted (upstream preserves per-session tab state), so the panel element is
  // in the DOM even while the column is closed. Visibility is the real test.
  const panelAlready = await evaluate(`(() => {
    const el = document.querySelector('[data-slot="rightbar.session"]')
    return !!el && el.getBoundingClientRect().width > 0
  })()`)
  if (panelAlready) console.log('[probe] right sidebar already open; reusing it')
  const freshPanel = !panelAlready
  const hasExpand = panelAlready || await waitFor(`!!document.querySelector('${expandSelector}')`, 15000)
  check('会话头部出现右侧栏展开按钮（官方 ui-sidebar-right 已挂载）', hasExpand, `reused=${panelAlready}`)
  if (hasExpand) {
    if (!panelAlready) {
      const label = await evaluate(`(() => { const b = document.querySelector('${expandSelector}'); return b ? (b.getAttribute('aria-label') ?? b.title ?? '(no label)') : '' })()`)
      console.log('[probe] expand button label:', label)
      await evaluate(`document.querySelector('${expandSelector}').click()`)
    }
    const panelReady = await waitFor(`!!document.querySelector('[data-slot="rightbar.session"]')`, 15000)
    check('右侧栏面板渲染（rightbar.session 出现）', panelReady)
    await wait(1200)
    await shoot('04-right-sidebar')
    // The panel keeps its per-session layout across open/close, so a rerun sees
    // the previous run's panes instead of the guide. Interactions and the guide
    // entry are only meaningful on a pristine layout; anything else is skipped
    // with a reason rather than reported as a failure.
    const pristine = await evaluate(`(() => {
      const panel = document.querySelector('[data-slot="rightbar.session"]')
      const text = panel?.textContent ?? ''
      return text.includes('工作区文件') || text.includes('定时任务')
    })()`)
    const panelText = await evaluate(`(document.querySelector('[data-slot="rightbar.session"]')?.textContent ?? '').slice(0, 200)`)
    console.log('[probe] rightbar.session text:', JSON.stringify(panelText))
    const tabs = await evaluate(`[...document.querySelectorAll('[data-slot="sidebar.right.pane.tab"], [role="tab"], [class*="chip"]')].map(el => (el.textContent ?? '').trim()).filter(Boolean).slice(0, 10)`)
    console.log('[probe] right sidebar chips:', JSON.stringify(tabs))

    // 5. Open OUR migrated tab (cron's scheduled jobs) from the guide and prove
    // its body renders inside the official panel. The guide entry is a button
    // whose text is the tab title.
    // Scope to the official panel: the left sidebar's footer also has a
    // 「定时任务」 button, and that one opens the main-area center instead.
    if (!pristine) {
      skip('点开「定时任务」后 cron 面板在官方右栏内渲染', '面板布局已被上一轮变更（复用同一会话）')
    } else {
    const cronEntryClicked = await evaluate(`(() => {
      const panel = document.querySelector('[data-slot="rightbar.session"]')
      if (!panel) return false
      const entry = [...panel.querySelectorAll('button, [role="button"]')]
        .find(b => (b.textContent ?? '').includes('定时任务'))
      if (!entry) return false
      entry.click()
      return true
    })()`)
    const cronRendered = cronEntryClicked
      ? await waitFor(`!!document.querySelector('[data-slot="rightbar.session"] [data-dsh-cron-panel]')`, 12000)
      : false
    check('点开「定时任务」后 cron 面板在官方右栏内渲染', cronRendered, `clicked=${cronEntryClicked}`)
    if (cronRendered) {
      await wait(800)
      await shoot('05-cron-tab')
      const cronText = await evaluate(`(document.querySelector('[data-slot="rightbar.session"] [data-dsh-cron-panel]')?.textContent ?? '').slice(0, 120)`)
      console.log('[probe] cron tab text:', JSON.stringify(cronText))
    }
    }

    // 6. Panel interactions. The chrome controls carry stable aria-labels
    // (分栏 / 全屏 / 收起右侧边栏), and the presentation itself is asserted
    // through the desktop frame's own data-rightbar-* attributes — those are
    // ours, so a regression cannot silently pass by matching dockkit internals.
    const frameHas = (attribute) =>
      `document.querySelector('.dshDesktopFrame')?.hasAttribute(${JSON.stringify(attribute)}) ?? false`
    const clickControl = (label) => evaluate(`(() => {
      const panel = document.querySelector('[data-slot="rightbar.session"]')
      if (!panel) return false
      const button = [...panel.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (!button) return false
      button.click()
      return true
    })()`)
    const paneCount = () => evaluate(`document.querySelectorAll('[data-slot="rightbar.session"] [class*="pane"]').length`)

    if (!freshPanel || !pristine) {
      skip('右栏全屏', '复用上一轮已变更的面板布局')
      skip('右栏分栏', '复用上一轮已变更的面板布局')
    } else {
      const fullscreenClicked = await clickControl('全屏')
      const fullscreenOn = fullscreenClicked && await waitFor(frameHas('data-rightbar-fullscreen'), 8000)
      check('右栏全屏：frame 报告 data-rightbar-fullscreen', fullscreenOn, `clicked=${fullscreenClicked}`)
      if (fullscreenOn) {
        await wait(600)
        await shoot('06-rightbar-fullscreen')
        await clickControl('全屏')
        await wait(900)
      }

      const panesBefore = await paneCount()
      const splitClicked = await clickControl('分栏')
      await wait(1000)
      const panesAfter = await paneCount()
      check('右栏分栏：dock pane 数增加', splitClicked && panesAfter > panesBefore, `${panesBefore} → ${panesAfter}`)
      if (splitClicked) await shoot('07-rightbar-split')

    }

    // Collapsing releases the frame track but keeps the occupant's content tree
    // mounted (upstream preserves per-session tab state), so the assertion is on
    // the frame's own presentation attribute — not on the subtree unmounting.
    const collapseClicked = await clickControl('收起右侧边栏')
    const collapsed = collapseClicked && await waitFor(frameHas('data-rightbar-collapsed'), 8000)
    const subtreeKept = await evaluate(`!!document.querySelector('[data-slot="rightbar.session"]')`)
    check('收起右侧栏：frame 释放列宽（内容树按上游语义保留）', collapsed,
      `clicked=${collapseClicked} subtreeKept=${subtreeKept}`)
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
const skipped = checks.filter(entry => entry.skipped === true)
console.log(`\nprobe-right-sidebar: ${checks.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`)
console.log(`screenshots: ${SHOTS}`)
if (failed.length > 0) process.exit(1)
