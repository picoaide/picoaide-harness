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
  $('takeover').addEventListener('click', () => post('takeover', { active: !state.controlled }))
  $('clear').addEventListener('click', () => post('clear-data').then(() => post('close-all')))
  $('hide').addEventListener('click', () => post('hide'))
  poll()
  setInterval(poll, 1000)
</script>
</body>
</html>`

/** The AI-control mask: translucent overlay + the takeover button. */
export const BROWSER_MASK_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: rgba(128, 128, 128, 0.28);
    font: 14px system-ui, sans-serif; color: #3a3f4a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: rgba(0, 0, 0, 0.38); color: #cfd3da; }
  }
  #card {
    display: flex; flex-direction: column; align-items: center; gap: 14px;
    padding: 26px 34px; border-radius: 16px;
    background: rgba(255, 255, 255, 0.85); box-shadow: 0 8px 30px rgba(0,0,0,.18);
  }
  @media (prefers-color-scheme: dark) {
    #card { background: rgba(30, 32, 38, 0.88); }
  }
  #hint { margin: 0; font-weight: 500; }
  button {
    padding: 9px 22px; border-radius: 8px; border: none;
    background: #2563eb; color: #fff; font-size: 14px; cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
</style>
</head>
<body>
  <div id="card">
    <p id="hint">AI 正在控制浏览器</p>
    <button id="take">接管控制</button>
  </div>
<script>
  document.getElementById('take').addEventListener('click', () => {
    fetch('/api/pico/browser/takeover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: true }),
    })
  })
</script>
</body>
</html>`
