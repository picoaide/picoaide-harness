/**
 * Local pages for the dedicated browser window: the control shell (toolbar +
 * tab strip) and the AI-control mask (translucent overlay with the takeover
 * button). Both are plain HTML served by the plugin's own loopback webServer
 * routes and drive the browser through the same fenced API as the client UI.
 *
 * The mask is a full-content-area overlay shown while the agent controls the
 * browser: it blocks direct interaction with the page and offers the single
 * 「接管」 action. Taking over hides the mask and lets the user drive the
 * page; releasing (from the shell toolbar) restores the mask and the agent
 * resumes.
 * @module @picoaide/dsh-browser
 */

/** The control-shell page: toolbar with tabs, address bar, and control
 * buttons. Polls /api/pico/browser/state to stay in sync with the runtime. */
export const BROWSER_SHELL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PicoAide 浏览器</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px system-ui, sans-serif; background: #f2f3f5; color: #1a1d24; }
  @media (prefers-color-scheme: dark) {
    body { background: #181a1f; color: #e6e6e6; }
    input { background: #23252b; color: #e6e6e6; border-color: #3a3d45; }
    .tab { background: #23252b; }
    .tab.active { background: #2e3138; }
  }
  #bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid rgba(128,128,128,.25); }
  #addrbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid rgba(128,128,128,.25); }
  #addr {
    flex: 1; min-width: 0; padding: 6px 10px; border-radius: 6px;
    border: 1px solid rgba(128,128,128,.4); background: #fff; color: inherit; font: inherit;
  }
  #addr:focus { outline: 2px solid #2563eb; outline-offset: -1px; }
  #tabs { display: flex; align-items: center; gap: 4px; overflow-x: auto; flex: 1; min-width: 0; }
  .tab { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; max-width: 140px; overflow: hidden; background: #e6e7ea; }
  .tab.active { background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.15); }
  .tab .x { margin-left: 4px; opacity: .6; cursor: pointer; padding: 0 2px; }
  .tab .x:hover { opacity: 1; }
  button { padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; cursor: pointer; font: inherit; }
  button:disabled { opacity: .4; cursor: default; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  button.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
  #hint { font-size: 12px; color: #6b7280; margin-left: auto; }
  #notice { padding: 4px 10px; font-size: 12px; background: rgba(220,38,38,.12); color: #dc2626; display: none; }
  #notice.show { display: block; }
</style>
</head>
<body>
  <div id="bar">
    <div id="tabs"></div>
    <button id="newtab" title="新建标签页">+</button>
    <button id="back" title="后退">←</button>
    <button id="forward" title="前进">→</button>
    <button id="reload" title="刷新">⟳</button>
    <span id="hint"></span>
    <button id="takeover" title="接管/释放浏览器控制">接管</button>
    <button id="clear" title="清除浏览数据并关闭全部标签">清除</button>
    <button id="hide" title="隐藏窗口（不关闭）">隐藏</button>
  </div>
  <div id="addrbar">
    <input id="addr" type="text" placeholder="输入网址，回车访问（例如 https://example.com）" aria-label="地址栏" spellcheck="false" />
    <button id="go" title="访问地址">访问</button>
  </div>
  <div id="notice">用户接管中：AI 浏览器操作已暂停，释放后继续。</div>
<script>
  const $ = (id) => document.getElementById(id)
  let state = { tabs: [], controlled: false }
  const post = (action, body) =>
    fetch('/api/pico/browser/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then((r) => r.json()).catch(() => ({ ok: false }))
  const render = () => {
    const tabs = $('tabs')
    tabs.textContent = ''
    for (const tab of state.tabs) {
      const el = document.createElement('div')
      el.className = 'tab' + (tab.visible ? ' active' : '')
      el.title = tab.url
      el.textContent = (tab.title || tab.url || ('标签 ' + tab.id)).slice(0, 24) + (tab.loading ? '…' : '')
      el.addEventListener('click', () => post('switch-tab', { tab: tab.id }))
      const x = document.createElement('span')
      x.className = 'x'
      x.textContent = '×'
      x.addEventListener('click', (e) => { e.stopPropagation(); post('close-tab', { tab: tab.id }) })
      el.appendChild(x)
      tabs.appendChild(el)
    }
    const visible = state.tabs.find((t) => t.visible)
    $('back').disabled = !visible
    $('forward').disabled = !visible
    $('reload').disabled = !visible
    $('hint').textContent = visible ? (visible.title || visible.url || '') : ''
    // Address bar mirrors the visible tab (only when it is not focused, so
    // typing is never overwritten by the 1s poll).
    const addr = $('addr')
    if (document.activeElement !== addr) {
      addr.value = visible ? (visible.url || '') : ''
      addr.placeholder = visible ? '' : '输入网址，回车访问（例如 https://example.com）'
    }
    const to = $('takeover')
    if (state.controlled) {
      to.textContent = '释放接管'
      to.className = 'danger'
      $('notice').classList.add('show')
    } else {
      to.textContent = '接管'
      to.className = ''
      $('notice').classList.remove('show')
    }
  }
  const poll = () =>
    fetch('/api/pico/browser/state').then((r) => r.json()).then((next) => {
      state = next
      render()
    }).catch(() => {})
  $('newtab').addEventListener('click', () => post('open'))
  $('back').addEventListener('click', () => post('back'))
  $('forward').addEventListener('click', () => post('forward'))
  $('reload').addEventListener('click', () => post('reload'))
  // Address bar: navigate the VISIBLE tab. The user's own surface — the
  // runtime navigates immediately (the shell route passes user=true).
  const go = () => {
    const value = $('addr').value.trim()
    if (value === '') return
    const visible = state.tabs.find((t) => t.visible)
    if (visible === undefined) {
      // No tab yet: open one at the URL.
      post('open', { url: value }).then(() => poll())
    } else {
      post('navigate', { tab: visible.id, url: value }).then(() => poll())
    }
  }
  $('addr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go() }
  })
  $('go').addEventListener('click', go)
  // Explicit target state (not a toggle): the poll lags up to 1s, so a
  // toggle based on stale state can repeat the same action forever
  // (e.g. clicking 接管 twice keeps active:true; clicking 释放接管 when the
  // poll still shows controlled:true sends active:true again).
  $('takeover').addEventListener('click', () => {
    const active = state.controlled === false
    post('takeover', { active }).then(() => poll())
  })
  $('clear').addEventListener('click', () => post('clear-data').then(() => post('close-all')))
  $('hide').addEventListener('click', () => post('hide'))
  poll()
  setInterval(poll, 1000)
</script>
</body>
</html>`

/** The AI-control mask: translucent overlay + the takeover button.
 *
 * The mask is served as its own WebContentsView whose page paints a
 * translucent scrim; the view itself is created with `webPreferences.transparent:
 * true` (see electron-adapter.ts) so the rgba scrim blends with the TAB page
 * beneath it instead of the view's opaque white canvas. It polls the loopback
 * state to show what the agent is doing right now (in-flight tool + recent
 * operations), so the user knows when to take over. */
export const BROWSER_MASK_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    /* The scrim overlays the whole page; the status card sits at the BOTTOM
     * CENTER (not the middle) so the page content the AI is driving stays
     * visible behind the translucent overlay. */
    display: flex; align-items: flex-end; justify-content: center;
    padding: 0 0 18px 0;
    background: rgba(128, 128, 128, 0.28);
    font: 14px system-ui, sans-serif; color: #3a3f4a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: rgba(0, 0, 0, 0.38); color: #cfd3da; }
  }
  #card {
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    padding: 22px 30px; border-radius: 16px; max-width: 520px; min-width: 320px;
    background: rgba(255, 255, 255, 0.9); box-shadow: 0 8px 30px rgba(0,0,0,.18);
  }
  @media (prefers-color-scheme: dark) {
    #card { background: rgba(30, 32, 38, 0.92); }
  }
  #hint { margin: 0; font-weight: 500; }
  #status { margin: 0; font-size: 13px; color: #4b5563; min-height: 1.4em; }
  @media (prefers-color-scheme: dark) {
    #status { color: #aeb4bd; }
  }
  #status .busy { color: #1d4ed8; font-weight: 600; }
  #ops .busy { color: #1d4ed8; font-weight: 500; }
  @media (prefers-color-scheme: dark) {
    #status .busy, #ops .busy { color: #7ba7ff; }
  }
  #ops { list-style: none; margin: 0; padding: 0; width: 100%; max-height: 132px; overflow-y: auto; }
  #ops li { display: flex; gap: 8px; font-size: 12px; color: #6b7280; align-items: baseline; }
  @media (prefers-color-scheme: dark) {
    #ops li { color: #9aa1ab; }
  }
  #ops .time { flex: none; font-variant-numeric: tabular-nums; }
  #ops .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button {
    padding: 9px 22px; border-radius: 8px; border: none;
    background: #2563eb; color: #fff; font-size: 14px; cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
  .spinner {
    display: inline-block; width: 12px; height: 12px; margin-right: 6px;
    border: 2px solid #93c5fd; border-top-color: #2563eb; border-radius: 50%;
    vertical-align: -1px; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div id="card">
    <p id="hint">AI 正在控制浏览器</p>
    <p id="status">正在获取状态…</p>
    <ul id="ops"></ul>
    <button id="take">接管控制</button>
  </div>
<script>
  // Browser tool -> human label. Pure JS (no TS annotations): this inline
  // script is a string in TS source and is served verbatim to the page.
  const TOOL_LABELS = {
    'browser_open': '打开浏览器',
    'browser_new_tab': '新建标签页',
    'browser_navigate': '打开网页',
    'browser_reload': '刷新页面',
    'browser_go_back': '后退',
    'browser_go_forward': '前进',
    'browser_click': '点击',
    'browser_type': '输入文字',
    'browser_press': '按键',
    'browser_select': '选择下拉项',
    'browser_scroll': '滚动页面',
    'browser_screenshot': '截图',
    'browser_get_snapshot': '读取页面元素',
    'browser_get_text': '读取页面文字',
    'browser_list_tabs': '查看标签页',
    'browser_switch_tab': '切换标签页',
    'browser_close_tab': '关闭标签页',
    'browser_close': '关闭浏览器',
    'browser_eval': '执行脚本',
    'browser_fill_credentials': '填写登录表单',
    'browser_takeover': '接管',
    'browser_release': '释放接管',
    'browser_download': '下载文件',
    'browser_clear_data': '清除数据',
  }
  const label = (tool) => TOOL_LABELS[tool] || tool || '操作'
  const fmt = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
  const $ = (id) => document.getElementById(id)
  // Build the status line with DOM APIs only: op summaries can carry
  // model-provided URLs (never trust string concatenation into markup).
  const statusLine = (parts) => {
    const status = $('status')
    status.textContent = ''
    for (const part of parts) {
      if (typeof part === 'string') {
        status.appendChild(document.createTextNode(part))
      } else {
        const span = document.createElement('span')
        span.className = part.className || ''
        span.textContent = part.text
        status.appendChild(span)
      }
    }
  }
  const state = { busy: false, busyTool: '', latestOp: null, ops: [] }
  const render = () => {
    if (state.busy) {
      statusLine([
        { className: 'spinner', text: '' },
        '正在执行：',
        { className: 'busy', text: label(state.busyTool) },
      ])
    } else if (state.latestOp) {
      statusLine(['已空闲——最近操作：', { className: 'busy', text: label(state.latestOp.tool) }, ' ' + state.latestOp.summary])
    } else {
      statusLine(['等待 AI 开始操作…'])
    }
    const ops = $('ops')
    ops.textContent = ''
    for (const op of state.ops.slice(0, 3)) {
      const li = document.createElement('li')
      const t = document.createElement('span')
      t.className = 'time'
      t.textContent = fmt(op.time)
      const w = document.createElement('span')
      w.className = 'what'
      const tag = document.createElement('span')
      tag.className = 'busy'
      tag.textContent = label(op.tool)
      w.appendChild(tag)
      w.appendChild(document.createTextNode(' ' + op.summary))
      li.appendChild(t)
      li.appendChild(w)
      ops.appendChild(li)
    }
  }
  const poll = () => {
    Promise.all([
      fetch('/api/pico/browser/state').then((r) => r.json()).catch(() => null),
      fetch('/api/pico/browser/ops').then((r) => r.json()).catch(() => ({ ops: [] })),
    ]).then(([s, o]) => {
      if (s !== null) {
        state.busy = s.busy === true
        state.busyTool = s.busyTool || ''
        state.latestOp = s.latestOp || null
      }
      state.ops = Array.isArray(o && o.ops) ? o.ops : []
      render()
    }).catch(() => {})
  }
  $('take').addEventListener('click', () => {
    fetch('/api/pico/browser/takeover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: true }),
    }).then(() => {
      // The takeover hides the mask immediately; nothing else to refresh.
    }).catch(() => {})
  })
  poll()
  setInterval(poll, 700)
</script>
</body>
</html>`
