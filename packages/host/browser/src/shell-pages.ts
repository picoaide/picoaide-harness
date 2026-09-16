/**
 * The v4.2 browser chrome pages.
 *
 * `BROWSER_SHELL_HTML` — the BrowserWindow base page: toolbar only (tab strip
 * + omnibox + empty state). Everything that must float ABOVE the tab
 * WebContentsViews (AI indicator capsule, activity panel, ⋮ menu, viewers,
 * busy mask pill) lives in `BROWSER_OVERLAY_HTML`, which is loaded in a
 * separate, transparent, always-on-top WebContentsView whose bounds ARE the
 * layout: the host switches the view rectangle per overlay mode (capsule →
 * panel rail → menu rect → full content), so the overlay page simply fills
 * its viewport with the active surface. Native child views render above the
 * window webContents in Electron, so shell-page fixed elements would be
 * hidden behind the tabs — this split is what keeps the AI UI visible.
 * @module @picoaide/dsh-browser
 */

export const BROWSER_SHELL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>AI 浏览器</title>
<style>
  :root {
    --surface: #f4f5f7;
    --surface-raised: #ffffff;
    --surface-hover: #eceef1;
    --text: #1a1d24;
    --text-muted: #6b7280;
    --border: #dcdfe4;
    --accent: #2563eb;
    --warning: #d97706;
    /* 实心胶囊上的文字色：填充色随主题翻，文字必须跟着翻，否则暗色下白字压浅橙
       （--warning #f0a03c 上白字 2.14:1）。取值见 2026-09-16 暗色审计：
       浅橙/浅蓝上都是深墨最稳（深墨 #1a1d24 在 #d97706 上 5.31:1、#f0a03c 上 7.87:1）。 */
    --on-warning: #1a1d24;
    --on-accent: #ffffff;
    --danger: #dc2626;
    --radius: 6px;
    --radius-lg: 8px;
    /* 独立文档：让原生滚动条/控件跟随应用主题（桌面壳设了 nativeTheme.themeSource）。 */
    color-scheme: light dark;
    font-size: 13px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #17181c;
      --surface-raised: #1f2126;
      --surface-hover: #26282e;
      --text: #e6e7ea;
      --text-muted: #a6a9b0;
      --border: #34363d;
      --accent: #6b9bff;
      --warning: #f0a03c;
      --on-warning: #1a1d24;
      --on-accent: #1a1d24;
      --danger: #f0726e;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tab .ai-dot { animation: none; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: var(--surface); color: var(--text); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
  #toast { position: fixed; top: 6px; left: 50%; transform: translateX(-50%); z-index: 999; max-width: 70%; padding: 5px 12px; border: 1px solid var(--danger); border-radius: 999px; background: var(--surface-raised); color: var(--danger); font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12); opacity: 0; pointer-events: none; transition: opacity 150ms ease; }
  #toast.show { opacity: 1; }
  button { font: inherit; color: inherit; background: none; border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 8px; cursor: pointer; transition: background 150ms ease, color 150ms ease, border-color 150ms ease; }
  button:hover { background: var(--surface-hover); }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
  button.icon { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  button.danger { color: var(--danger); border-color: var(--danger); }
  input { font: inherit; }
  [hidden] { display: none !important; }

  #tabstrip { display: flex; align-items: center; gap: 4px; height: 30px; padding: 0 8px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
  #tabstrip::-webkit-scrollbar { display: none; }
  .tab { display: flex; align-items: center; gap: 5px; height: 24px; max-width: 200px; padding: 0 8px; border-radius: var(--radius); cursor: pointer; white-space: nowrap; overflow: hidden; color: var(--text-muted); border: 1px solid transparent; flex: none; }
  .tab:hover { background: var(--surface-hover); }
  .tab.active { background: var(--surface-raised); color: var(--text); border-color: var(--border); box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .tab .favicon { width: 16px; height: 16px; border-radius: 3px; background: var(--surface-hover); flex: none; object-fit: contain; }
  .tab .ai-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; animation: breathe 2.4s ease-in-out infinite; }
  .tab .t { overflow: hidden; text-overflow: ellipsis; }
  .tab .x { opacity: 0; padding: 0 2px; font-size: 12px; color: var(--text-muted); }
  .tab:hover .x { opacity: 1; }
  .tab .x:hover { color: var(--danger); }
  #newtab { margin-left: auto; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: .45; } }

  #omnibox { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px; border-bottom: 1px solid var(--border); }
  #addr { flex: 1; min-width: 0; height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-raised); color: var(--text); }
  #addr:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
  #addr.secure { padding-left: 30px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14' fill='none'%3E%3Crect x='2.5' y='6' width='9' height='6' rx='1.5' stroke='%2316a34a' stroke-width='1.4'/%3E%3Cpath d='M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6' stroke='%2316a34a' stroke-width='1.4'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: 10px center; }
  #addr:focus { background-image: none; padding-left: 12px; }

  #empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-muted); }
  #empty .hero { font-size: 40px; opacity: .5; }
  #empty .msg { font-size: 14px; max-width: 420px; text-align: center; }
</style>
</head>
<body>
  <div id="toast" role="status" aria-live="polite"></div>
  <div id="tabstrip">
    <div id="tabs" style="display:flex;align-items:center;gap:4px;min-width:0;"></div>
    <button id="newtab" class="icon" title="新建标签页 (Ctrl+T)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
  </div>
  <div id="omnibox">
    <button id="go-back" class="icon" title="后退 (Alt+←)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M9.5 3.5L5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <button id="go-forward" class="icon" title="前进 (Alt+→)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 3.5L11 8l-4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <button id="reload" class="icon" title="刷新 (Ctrl+R)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5h-2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <input id="addr" type="text" placeholder="输入网址，回车访问（例如 https://example.com）" spellcheck="false" autocomplete="off" aria-label="地址栏"/>
    <button id="bm" class="icon" title="收藏到书签"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.4l-3.4 1.6.7-3.8L2.5 6.5l3.8-.5L8 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>
    <button id="menu-btn" class="icon" title="更多"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="13" cy="8" r="1.2" fill="currentColor"/></svg></button>
  </div>
  <div id="empty" hidden>
    <div class="hero">◎</div>
    <div class="msg">打开浏览器，AI 会在需要时自动打开网页。<br/>你也可以点右上角 ＋ 先自己逛起来。</div>
  </div>
<script>
  const $ = (id) => document.getElementById(id)
  const state = { tabs: [], controlled: false, busy: false, busyTool: '', uiMode: 'capsule' }
  // 2026-09-15 审计（P2）：原来是一个单向布尔 sseOk（onopen=true / onerror=false）。
  // EventSource 自己会重连，"连接开着但服务端不再推事件"时它恒为 true ⇒ 1.5s 兜底
  // 轮询永远不启动 ⇒ tab 条/前进后退按钮冻结（现场表现为"浏览器界面卡住"）。
  // 改判"最后一次收到事件的时间"，超过阈值即轮询。
  const SSE_STALE_MS = 4000
  let lastSseAt = 0

  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  let toastTimer = null
  const showToast = (text) => {
    const t = $('toast')
    t.textContent = String(text || '')
    t.classList.add('show')
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200)
  }

  /** 失败文案的唯一出处。401/403 就是 2026-09-15 现场主机日志里那条
   * 「refused a local write without browser proof」：浏览器分区还没拿到 BrowserAuth
   * 票据（蒙版页加载早于 cookie 交接）。打包版用户看不到 console，页面必须自己把
   * 话说清楚 —— 否则就是「点了『我来操作』整轮没反应、现场零证据」。 */
  const failureText = (status, data) => {
    if (status === 401 || status === 403) return '操作失败：浏览器会话凭据尚未就绪，请重试'
    if (status === 503) return '操作失败：浏览器服务尚未就绪，请重试'
    if (data && typeof data.error === 'string' && data.error !== '') return '操作失败：' + data.error
    if (status === 0) return '操作失败：无法连接到浏览器服务，请重试'
    return '操作失败（HTTP ' + status + '），请重试'
  }

  /** 读 JSON：4xx（代理异常时甚至是 HTML）一律不抛给调用点。 */
  const readJson = (r) => r.json().catch(() => null)

  /** 写操作的唯一出口（2026-09-15 审计 P1：页面按钮把所有失败都吞掉）：
   * 永远 resolve 成 { ok, status, data }，失败就地 toast。调用点靠 r.ok 决定要不要
   * 改动本地状态，杜绝"界面已经变了但服务端没接受"。 */
  /** Fetch with a deadline: a hung loopback request must not leave a button disabled forever. */
  const fetchWithTimeout = (url, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    return fetch(url, Object.assign({}, init, { signal: controller.signal })).finally(() => clearTimeout(timer))
  }
  const post = (action, body) => fetchWithTimeout('/api/pico/browser/' + action, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then(
    (r) => readJson(r).then((data) => ({ ok: r.ok === true, status: r.status, data })),
    () => ({ ok: false, status: 0, data: null }),
  ).then((r) => { if (!r.ok) showToast(failureText(r.status, r.data)); return r })

  /** post + refresh；失败文案由 post 统一 toast。 */
  const postErr = (action, body) => post(action, body).then(refresh)

  async function refresh() {
    try {
      const res = await fetch('/api/pico/browser/state')
      // 读面失败（403/代理 HTML）保持上一次状态：原来的 r.json() 抛错虽然被 catch，
      // 但一条 500 的 JSON 错误体会把 tab 条清空成"没有标签页"。
      if (res.ok !== true) return
      const next = await res.json()
      state.tabs = Array.isArray(next.tabs) ? next.tabs : []
      state.controlled = next.controlled === true
      state.busy = next.busy === true
      state.busyTool = next.busyTool || ''
      state.uiMode = next.ui && typeof next.ui.mode === 'string' ? next.ui.mode : 'capsule'
      render()
    } catch { /* keep last state */ }
  }

  /** 只有 http(s) 与 data:image/ 能进 img.src（见 render() 里的说明）。
   * 注意：本页脚本本体是 TS 模板字符串，正则里的转义斜杠会被外层模板吃掉 ——
   * 这里用 startsWith 判前缀，避免再踩一次（2026-09-15 自测抓到过）。 */
  const safeFavicon = (u) => {
    if (typeof u !== 'string') return ''
    const lower = u.toLowerCase()
    if (lower.startsWith('http:') || lower.startsWith('https:') || lower.startsWith('data:image/')) return u
    return ''
  }

  function render() {
    const strip = $('tabs')
    strip.textContent = ''
    for (const tab of state.tabs) {
      const el = document.createElement('div')
      el.className = 'tab' + (tab.visible ? ' active' : '')
      el.title = tab.url || tab.title
      const busy = state.busy && tab.visible
      el.innerHTML = '<img class="favicon" alt=""><span class="t">' + esc(tab.title || tab.url || '新标签') + (tab.loading ? '…' : '') + '</span>' + (busy ? '<span class="ai-dot"></span>' : '') + '<span class="x" title="关闭标签">×</span>'
      const icon = el.querySelector('.favicon')
      // 2026-09-15 审计（P2）：tab.favicon 是页面/服务端给的字符串，原来直接落进
      // img.src —— javascript:/file: 这类 scheme 也照设不误。只放行 http(s) 与
      // data:image/，其余（含空串）回落成空图标。
      const favicon = safeFavicon(tab.favicon)
      if (favicon === '') { icon.removeAttribute('src'); icon.style.display = 'none' }
      else { icon.src = favicon; icon.style.display = '' }
      el.addEventListener('click', (e) => {
        if (e.target.className === 'x') return
        if (!tab.visible) postErr('switch-tab', { tab: tab.id })
      })
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); postErr('close-tab', { tab: tab.id }) }
      })
      el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); postErr('close-tab', { tab: tab.id }) })
      strip.appendChild(el)
    }
    $('empty').hidden = state.tabs.length > 0

    const cur = state.tabs.find((t) => t.visible)
    $('addr').value = document.activeElement === $('addr') ? $('addr').value : (cur ? cur.url : '')
    $('addr').placeholder = cur ? '' : '输入网址，回车访问（例如 https://example.com）'
    if (cur) {
      try { $('addr').classList.toggle('secure', new URL(cur.url).protocol === 'https:') } catch { $('addr').classList.remove('secure') }
    } else {
      $('addr').classList.remove('secure')
    }
    $('go-back').disabled = !(cur && cur.canGoBack === true)
    $('go-forward').disabled = !(cur && cur.canGoForward === true)
    $('reload').disabled = !cur
  }

  $('newtab').addEventListener('click', () => postErr('open'))
  $('go-back').addEventListener('click', () => postErr('back'))
  $('go-forward').addEventListener('click', () => postErr('forward'))
  $('reload').addEventListener('click', () => postErr('reload'))
  $('bm').addEventListener('click', async () => {
    const cur = state.tabs.find((t) => t.visible)
    if (!cur) { alert('当前没有可收藏的页面'); return }
    // 2026-09-15 审计（P1）：原来不看返回状态就把星星点亮 —— 403（写证明缺失）时
    // 用户以为收藏成功，实际什么都没发生。现在只有服务端确认才给黄色反馈。
    const r = await post('bookmarks', { url: cur.url, title: cur.title })
    if (!r.ok) return
    $('bm').style.color = 'var(--warning)'
    setTimeout(() => { $('bm').style.color = '' }, 900)
  })
  // Address-bar submit: read the CURRENT DOM value at submit time (a
  // concurrent SSE refresh may re-render the field between edit and Enter —
  // reading inside the handler is what makes it race-free).
  const go = () => {
    const value = $('addr').value.trim()
    if (value === '') return
    const normalized = value.includes('://') ? value : 'https://' + value
    postErr('navigate', { url: normalized })
  }
  $('addr').addEventListener('keydown', (e) => {
    if (!state.controlled) return // masked: only 我来操作 unlocks the window
    if (e.key === 'Enter') {
      e.preventDefault()
      go()
    }
  })
  // ⋮ toggles the floating menu in the ALWAYS-ON-TOP overlay view — the shell
  // page cannot show popups above the tab views. A second click closes it.
  $('menu-btn').addEventListener('click', () => { void post('overlay', { mode: state.uiMode === 'menu' ? 'capsule' : 'menu' }) })

  document.addEventListener('keydown', (e) => {
    // While masked the whole window is locked (我来操作 is the only entry).
    if (!state.controlled && e.key !== 'Escape') return
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); $('addr').focus(); $('addr').select() }
    if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); postErr('open') }
    if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); const t = state.tabs.find((x) => x.visible); if (t) postErr('close-tab', { tab: t.id }) }
    if (e.ctrlKey && e.key.toLowerCase() === 'r') { e.preventDefault(); postErr('reload') }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      const tabs = state.tabs
      if (tabs.length > 1) {
        const idx = tabs.findIndex((x) => x.visible)
        const next = tabs[(idx + 1 + tabs.length) % tabs.length]
        if (next) postErr('switch-tab', { tab: next.id })
      }
    }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); postErr('back') }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); postErr('forward') }
    if (e.ctrlKey && e.key.toLowerCase() === 'a' && e.shiftKey) { e.preventDefault(); void post('overlay', { mode: state.uiMode === 'panel' ? 'capsule' : 'panel' }) }
    if (e.key === 'Escape') {
      // Close the floating surface only — Esc never releases control to the AI
      // (the 交给 AI button is the single way back; 2026-09-11).
      void post('overlay', { mode: 'capsule' })
    }
  })

  function connectStream() {
    try {
      const es = new EventSource('/api/pico/browser/stream')
      // onopen/onerror 不再翻状态标志：重连由 EventSource 自己负责，页面只关心
      // "最近一次真的有事件推过来是什么时候"（见 SSE_STALE_MS）。
      for (const ev of ['tab', 'tab-meta', 'busy', 'takeover', 'release', 'ops', 'state']) {
        es.addEventListener(ev, () => { lastSseAt = Date.now(); refresh() })
      }
    } catch { /* 连不上就纯靠兜底轮询 */ }
  }
  connectStream()
  refresh()
  setInterval(() => { if (Date.now() - lastSseAt > SSE_STALE_MS) refresh() }, 1500)
</script>
</body>
</html>`

/** The AI overlay page. Rendered inside the transparent always-on-top view;
 * the view's bounds (host-controlled per mode) define the viewport — each
 * surface fills 100% of it. Modes: capsule (AI 指示 + 交给 AI), panel
 * (活动面板), menu (⋮ 菜单), viewer (书签/历史/下载), mask (AI 操作中拦截遮罩,
 * 其中只有 pill 上的「我来操作」按钮可交互 — 点遮罩其他地方不会夺取控制权).
 * The 我来操作 / 交给 AI button is the ONE control toggle in both directions. */
export const BROWSER_OVERLAY_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  :root {
    --surface: #f4f5f7;
    --surface-raised: #ffffff;
    --surface-hover: #eceef1;
    --text: #1a1d24;
    --text-muted: #6b7280;
    --border: #dcdfe4;
    --accent: #2563eb;
    --warning: #d97706;
    --on-warning: #1a1d24;
    --on-accent: #ffffff;
    --danger: #dc2626;
    --radius: 6px;
    --radius-lg: 8px;
    /* 独立文档：让原生滚动条/控件跟随应用主题（桌面壳设了 nativeTheme.themeSource）。 */
    color-scheme: light dark;
    font-size: 13px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #17181c;
      --surface-raised: #1f2126;
      --surface-hover: #26282e;
      --text: #e6e7ea;
      --text-muted: #a6a9b0;
      --border: #34363d;
      --accent: #6b9bff;
      --warning: #f0a03c;
      --on-warning: #1a1d24;
      --on-accent: #1a1d24;
      --danger: #f0726e;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .s-capsule .dot.busy, #pill .dot { animation: none; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: transparent; color: var(--text); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
  #otoast { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 999; max-width: 90%; padding: 5px 12px; border: 1px solid var(--danger); border-radius: 999px; background: var(--surface-raised); color: var(--danger); font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12); opacity: 0; pointer-events: none; transition: opacity 150ms ease; }
  #otoast.show { opacity: 1; }
  button { font: inherit; color: inherit; background: none; border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 8px; cursor: pointer; transition: background 150ms ease, color 150ms ease, border-color 150ms ease; }
  button:hover { background: var(--surface-hover); }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
  button.icon { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  button.danger { color: var(--danger); border-color: var(--danger); }
  input { font: inherit; }

  /* Exactly one surface is active per mode — the host-shrunk viewport IS the
     layout, so surfaces fill 100% of the view. */
  .surface { display: none; width: 100%; height: 100%; }
  body[data-mode="capsule"] .surface.s-capsule { display: flex; }
  body[data-mode="panel"] .surface.s-panel { display: flex; }
  body[data-mode="menu"] .surface.s-menu { display: flex; }
  body[data-mode="viewer"] .surface.s-viewer { display: flex; }
  body[data-mode="mask"] .surface.s-mask { display: flex; }

  /* ---------- capsule (AI 指示) ---------- */
  .s-capsule { align-items: center; gap: 6px; padding: 0 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-raised); box-shadow: 0 4px 16px rgba(0,0,0,.12); cursor: pointer; overflow: hidden; }
  .s-capsule .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); flex: none; }
  .s-capsule .dot.busy { background: var(--accent); animation: breathe 2.4s ease-in-out infinite; }
  .s-capsule .dot.paused { background: var(--warning); }
  .s-capsule .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The toggle is ALWAYS visible (never hover-revealed): 我来操作 / 交给 AI is
     the single control for handing the browser over and taking it back. */
  .s-capsule .take { flex: none; display: inline-flex; align-items: center; height: 24px; padding: 0 10px; font-size: 12px; background: var(--warning); border-color: var(--warning); color: var(--on-warning); }

  /* ---------- panel (AI 活动) ---------- */
  .s-panel { flex-direction: column; background: var(--surface-raised); border-left: 1px solid var(--border); box-shadow: -8px 0 28px rgba(0,0,0,.10); }
  .s-panel h2 { font-size: 13px; font-weight: 600; margin: 0; padding: 12px 14px 8px; display: flex; align-items: center; justify-content: space-between; }
  .s-panel .close { border: none; padding: 2px 6px; font-size: 14px; }
  #stream { flex: 1; overflow-y: auto; padding: 4px 14px 12px; }
  .op { display: flex; gap: 8px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid var(--border); }
  .op:last-child { border-bottom: none; }
  .op .time { flex: none; font-variant-numeric: tabular-nums; color: var(--text-muted); font-size: 11px; }
  .op .what { overflow: hidden; }
  .op .what .tool { color: var(--accent); font-weight: 500; }
  .op .what .fail { color: var(--danger); }
  .op .what .pause { color: var(--warning); }
  .op .who { color: var(--text-muted); font-size: 11px; flex: none; }
  #panel-bottom { padding: 10px 14px; border-top: 1px solid var(--border); display: flex; gap: 8px; }
  #panel-bottom button { flex: 1; height: 32px; }

  /* ---------- menu (⋮) ---------- */
  .s-menu { flex-direction: column; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 4px; }
  .s-menu .mi { display: flex; align-items: center; gap: 8px; width: 100%; border: none; padding: 6px 10px; border-radius: 4px; text-align: left; }
  .s-menu .mi:hover { background: var(--surface-hover); }
  .s-menu .mi.danger { color: var(--danger); }
  .s-menu .sep { height: 1px; background: var(--border); margin: 4px 0; }

  /* ---------- viewer (书签/历史/下载) ---------- */
  .s-viewer { flex-direction: column; background: var(--surface); }
  .s-viewer h2 { display: flex; align-items: center; gap: 10px; margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
  .s-viewer .list { flex: 1; overflow-y: auto; padding: 8px 16px; }
  .vrow { display: flex; gap: 10px; align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--border); }
  .vrow .main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vrow .meta { color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .vrow .rm { flex: none; }
  #viewer-search { margin-left: auto; width: 220px; height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); color: var(--text); }

  /* ---------- mask (AI 操作中拦截) ---------- */
  .s-mask { align-items: flex-end; justify-content: center; padding: 0 0 14px; background: rgba(10, 12, 16, 0.08); user-select: none; -webkit-user-select: none; }
  @media (prefers-color-scheme: dark) {
    .s-mask { background: rgba(0, 0, 0, 0.14); }
  }
  #pill { display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-radius: 999px; background: rgba(30, 34, 42, 0.86); color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.22); max-width: 80%; overflow: hidden; white-space: nowrap; }
  #pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #4f83ff; animation: breathe 1.6s ease-in-out infinite; }
  #pill #txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  #pill #pill-take { flex: none; height: 24px; padding: 0 12px; font-size: 12px; font-weight: 500; color: #fff; background: rgba(255, 255, 255, .14); border-color: rgba(255, 255, 255, .42); }
  #pill #pill-take:hover { background: rgba(255, 255, 255, .26); }

  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
</style>
</head>
<body data-mode="capsule">
  <div id="otoast" role="status" aria-live="polite"></div>
  <!-- capsule -->
  <div class="surface s-capsule" id="capsule" title="点击查看 AI 活动">
    <span class="dot" id="ai-dot"></span>
    <span class="label" id="ai-label" aria-live="polite">AI</span>
    <button class="take" id="ai-take">我来操作</button>
  </div>

  <!-- panel -->
  <div class="surface s-panel" id="panel">
    <h2>AI 活动 <button class="close" id="panel-close">×</button></h2>
    <div id="stream"></div>
    <div id="panel-bottom">
      <button id="hide-btn">隐藏窗口</button>
    </div>
  </div>

  <!-- menu -->
  <div class="surface s-menu" id="menu"></div>

  <!-- viewer -->
  <div class="surface s-viewer" id="viewer">
    <h2><span id="viewer-title"></span><input id="viewer-search" placeholder="搜索…" hidden/><button id="viewer-close" class="icon" style="margin-left:auto">×</button></h2>
    <div id="viewer-list" class="list"></div>
  </div>

  <!-- mask: the scrim is INERT — the pill's button is the only entry while
       the window is locked (whole-window click takeover was removed
       2026-09-11: a stray click anywhere used to steal the browser). -->
  <div class="surface s-mask" id="mask">
    <div id="pill">
      <span class="dot"></span>
      <span id="txt">AI 正在操作</span>
      <button id="pill-take" type="button">我来操作</button>
    </div>
  </div>

<script>
  const $ = (id) => document.getElementById(id)
  const state = { controlled: false, busy: false, busyTool: '', ops: [] }
  let mode = 'capsule'
  let viewerKind = ''
  // 2026-09-15 审计（P2）：原来是一个单向布尔 sseOk（onopen=true / onerror=false）。
  // EventSource 自己会重连，"连接开着但服务端不再推事件"时它恒为 true ⇒ 1.5s 兜底
  // 轮询永不启动 ⇒ 胶囊/面板状态冻结。改判"最后一次收到事件的时间"，超时即轮询。
  const SSE_STALE_MS = 4000
  let lastSseAt = 0

  const TOOL_LABELS = {
    'browser_open': '打开标签页', 'browser_navigate': '打开网页', 'browser_reload': '刷新页面',
    'browser_go_back': '后退', 'browser_go_forward': '前进', 'browser_click': '点击',
    'browser_type': '输入文字', 'browser_press': '按键', 'browser_select': '选择下拉项',
    'browser_scroll': '滚动页面', 'browser_screenshot': '截图', 'browser_get_snapshot': '读取页面元素',
    'browser_get_text': '读取页面文字', 'browser_list_tabs': '查看标签页', 'browser_switch_tab': '切换标签页',
    'browser_close_tab': '关闭标签页', 'browser_eval': '读取页面数据', 'browser_fill_credentials': '填写登录表单',
    'browser_takeover': '交给用户', 'browser_release': '恢复控制', 'browser_download': '下载文件',
    'browser_clear_data': '清除数据', 'browser_wait_for': '等待页面', 'browser_fill_form': '填写表单',
    'browser_upload_file': '上传文件', 'browser_bookmarks_add': '收藏页面',
    'browser_page_state': '页面变化', 'browser_page_crash': '页面恢复', 'browser_close': '关闭浏览器',
  }

  /** 失败文案的唯一出处。401/403 就是 2026-09-15 现场主机日志里那条
   * 「refused a local write without browser proof」：本页跑在浏览器分区，靠 cookie
   * 交接拿到 BrowserAuth 票据，交接没完成时所有写操作都被拒。打包版用户看不到
   * console —— 页面必须自己说出来，否则就是「点了『我来操作』整轮没反应、零证据」。 */
  const failureText = (status, data) => {
    if (status === 401 || status === 403) return '操作失败：浏览器会话凭据尚未就绪，请重试'
    if (status === 503) return '操作失败：浏览器服务尚未就绪，请重试'
    if (data && typeof data.error === 'string' && data.error !== '') return '操作失败：' + data.error
    if (status === 0) return '操作失败：无法连接到浏览器服务，请重试'
    return '操作失败（HTTP ' + status + '），请重试'
  }

  /** 读 JSON：4xx（代理异常时甚至是 HTML）一律不抛给调用点。 */
  const readJson = (r) => r.json().catch(() => null)

  /** 所有写操作（POST 与 DELETE 共用）的唯一出口（2026-09-15 审计 P1：页面按钮把
   * 所有失败都吞掉）。永远 resolve 成 { ok, status, data }，失败就地 toast；调用点
   * 靠 r.ok 决定要不要改本地状态，杜绝"界面已经变了但服务端没接受"。 */
  /** Fetch with a deadline: a hung loopback request must not leave a button disabled forever. */
  const fetchWithTimeout = (url, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    return fetch(url, Object.assign({}, init, { signal: controller.signal })).finally(() => clearTimeout(timer))
  }
  const request = (method, path, body) => {
    const init = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body || {})
    }
    return fetchWithTimeout('/api/pico/browser/' + path, init).then(
      (r) => readJson(r).then((data) => ({ ok: r.ok === true, status: r.status, data })),
      () => ({ ok: false, status: 0, data: null }),
    ).then((r) => { if (!r.ok) showToast(failureText(r.status, r.data)); return r })
  }
  const post = (action, body) => request('POST', action, body === undefined ? {} : body)
  const del = (query) => request('DELETE', query)

  /** 读面：非 2xx 直接抛，由调用点的 try/catch 变成页面上的可见文案。 */
  const getJson = async (path) => {
    const r = await fetchWithTimeout('/api/pico/browser/' + path)
    if (r.ok !== true) throw new Error('HTTP ' + r.status)
    return await r.json()
  }

  const labelOf = (tool) => TOOL_LABELS[tool] || tool || '操作'
  const fmtTime = (t) => {
    try {
      const d = new Date(t)
      const today = new Date()
      const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
      const time = d.toLocaleTimeString('zh-CN', { hour12: false })
      return sameDay ? time : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + time
    } catch { return '' }
  }
  let otoastTimer = null
  const showToast = (text) => {
    const t = $('otoast')
    t.textContent = String(text || '')
    t.classList.add('show')
    if (otoastTimer !== null) clearTimeout(otoastTimer)
    otoastTimer = setTimeout(() => t.classList.remove('show'), 3200)
  }
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  function applyMode(next) {
    mode = next
    document.body.dataset.mode = mode
    if (mode === 'mask') renderMask()
    if (mode === 'menu') renderMenu()
    if (mode === 'viewer') void renderViewer(viewerKind, $('viewer-search').value || '').catch(() => {})
  }

  /** Mask pill: the pill BUTTON is the ONLY browser entry while masked —
   * granting control here (我来操作) and returning it (交给 AI, the same
   * button in the capsule) are the one and only control toggle. The scrim
   * itself is inert: clicking elsewhere must never steal the browser. */
  function renderMask() {
    $('txt').textContent = state.busy ? 'AI 正在操作 · ' + labelOf(state.busyTool) : 'AI 空闲'
    const take = $('pill-take')
    // 正在接管中不要被一次并发的 refresh 把 pending 文案冲掉（见 takeControl）。
    if (!take.disabled) take.textContent = '我来操作'
    take.title = state.busy ? '暂停 AI，自己操作' : '自己操作浏览器'
  }

  async function refresh() {
    try {
      const next = await getJson('state')
      state.controlled = next.controlled === true
      state.busy = next.busy === true
      state.busyTool = next.busyTool || ''
      if (next.ui && next.ui.mode && next.ui.mode !== mode) applyModeInner(next.ui.mode)
      else if (mode === 'mask') renderMask()
      renderCapsule()
      renderStream()
    } catch { /* keep last state */ }
    try {
      const o = await getJson('ops')
      if (Array.isArray(o.ops)) state.ops = o.ops
      renderStream()
    } catch { /* ignore */ }
  }

  function renderCapsule() {
    const dot = $('ai-dot')
    const take = $('ai-take')
    let label = '我来操作'
    let title = '自己操作浏览器'
    if (state.controlled) {
      dot.className = 'dot paused'
      $('ai-label').textContent = '你正在操作'
      label = '交给 AI'
      title = '交回给 AI 继续操作'
      take.style.background = 'var(--accent)'; take.style.borderColor = 'var(--accent)'
      // 填充换成强调色时文字色必须一起换（暗色 --accent 是浅蓝，白字只有 2.71:1）。
      take.style.color = 'var(--on-accent)'
    } else if (state.busy) {
      dot.className = 'dot busy'
      $('ai-label').textContent = 'AI 操作中 · ' + labelOf(state.busyTool)
      title = '暂停 AI，自己操作'
      take.style.background = ''; take.style.borderColor = ''; take.style.color = ''
    } else {
      dot.className = 'dot'
      $('ai-label').textContent = 'AI'
      take.style.background = ''; take.style.borderColor = ''; take.style.color = ''
    }
    // 接管请求还在飞的时候保留「正在接管…」（见 takeControl），其余情况按状态刷新。
    if (!take.disabled) { take.textContent = label; take.title = title }
  }

  let streamSig = ''
  function renderStream() {
    const stream = $('stream')
    const ops = state.ops.slice(0, 40)
    // 2026-09-15 审计（P2）：原来每个 tick 都整表重建（textContent = '' 会把
    // scrollTop 打回 0）—— 用户往上翻一点就会被拽走，正在增长的 AI 时间线根本读不了。
    // 内容签名不变就一个节点都不动。
    const sig = JSON.stringify([state.busy, state.busyTool, ops])
    if (sig === streamSig) return
    // 贴底才自动跟随（新动作滚进视野）；用户已经翻上去看历史时就保住他的位置。
    const follow = stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 4
    const prevScroll = stream.scrollTop
    streamSig = sig
    stream.textContent = ''
    if (state.busy) {
      const line = document.createElement('div')
      line.className = 'op'
      line.innerHTML = '<span class="time"></span><div class="what"><span class="tool">正在执行：' + esc(labelOf(state.busyTool)) + '</span></div>'
      stream.appendChild(line)
    }
    if (ops.length === 0 && !state.busy) {
      const line = document.createElement('div')
      line.className = 'op'
      line.innerHTML = '<div class="what" style="color:var(--text-muted)">暂无操作记录</div>'
      stream.appendChild(line)
    }
    for (const op of ops) {
      const line = document.createElement('div')
      line.className = 'op'
      const cls = op.failed ? 'fail' : (op.tool === 'browser_takeover' || op.tool === 'browser_release') ? 'pause' : ''
      const who = op.actor === 'user' ? '<span class="who">你</span>' : ''
      line.innerHTML = '<span class="time">' + fmtTime(op.time) + '</span>' + who + '<div class="what"><span class="' + cls + '">' + esc(labelOf(op.tool)) + '</span> ' + esc(op.summary) + '</div>'
      stream.appendChild(line)
    }
    stream.scrollTop = follow ? stream.scrollHeight : prevScroll
  }

  function renderMenu() {
    const menu = $('menu')
    menu.textContent = ''
    // Each item issues exactly the POST(s) it needs, in order: the previous
    // "close menu then act" pair fired two racing POSTs whose arrival order was
    // unspecified (a viewer could open and then be immediately reset to the
    // capsule). post() returns the fetch promise, so awaiting it serializes
    // the calls.
    const items = [
      { label: '浏览历史', action: async () => { await openViewer('history') } },
      { label: '书签', action: async () => { await openViewer('bookmarks') } },
      { label: '下载', action: async () => { await openViewer('downloads') } },
      { sep: true },
      {
        label: '清除数据…',
        danger: true,
        action: async () => {
          if (!confirm('清除全部浏览数据（含登录状态）？')) return
          // 失败就留在菜单里：原来无论成败都关面板，用户以为已经清完
          // （而 403 时一个字节都没删）。失败文案由 post 统一 toast。
          const r = await post('clear-data')
          if (!r.ok) return
          await post('overlay', { mode: 'capsule' })
        },
      },
      { label: '隐藏窗口', action: async () => { await post('overlay', { mode: 'capsule' }); await post('hide') } },
      { label: '关闭', action: async () => { await post('overlay', { mode: 'capsule' }) } },
    ]
    for (const item of items) {
      if (item.sep) { const sep = document.createElement('div'); sep.className = 'sep'; menu.appendChild(sep); continue }
      const b = document.createElement('button')
      b.className = 'mi' + (item.danger ? ' danger' : '')
      b.textContent = item.label
      b.addEventListener('click', () => { void item.action() })
      menu.appendChild(b)
    }
    menu.classList.add('open')
    // Enter key lands on the first item for keyboard users.
    setTimeout(() => { menu.querySelector('.mi')?.focus() }, 0)
  }

  /** 打开查看器（⋮ 菜单的三个入口）。2026-09-15 审计：原来只发 POST 不看结果，
   * 模式切换被拒（403）时本地 kind 已经改掉，后续 1.5s 轮询会把一个并不存在的
   * 查看器内容拉出来。现在失败就回退 kind，并靠 post 的 toast 告知用户。 */
  async function openViewer(kind) {
    viewerKind = kind
    const r = await post('overlay', { mode: 'viewer' })
    if (!r.ok) viewerKind = ''
  }

  let viewerSig = ''
  async function renderViewer(kind, q) {
    viewerKind = kind
    const title = { bookmarks: '书签', history: '浏览历史', downloads: '下载' }[kind]
    $('viewer-title').textContent = title
    $('viewer-search').hidden = kind !== 'history' && kind !== 'bookmarks'
    const list = $('viewer-list')
    const prevScroll = list.scrollTop
    let rows = []
    try {
      if (kind === 'bookmarks') {
        const res = await getJson('bookmarks?q=' + encodeURIComponent(q))
        rows = (res.bookmarks || []).map((b) => ({ main: b.title, sub: b.url, meta: fmtTime(b.createdAt), openUrl: b.url, rm: '删除', rmAction: () => del('bookmarks?id=' + b.id) }))
      } else if (kind === 'history') {
        const res = await getJson('history?q=' + encodeURIComponent(q) + '&limit=200')
        rows = (res.entries || []).map((h) => ({ main: h.title || h.url, sub: h.url, meta: (h.actor === 'user' ? '你 · ' : 'AI · ') + fmtTime(h.time), openUrl: h.url }))
      } else {
        const res = await getJson('downloads?limit=200')
        rows = (res.downloads || []).map((d) => ({ main: d.fileName, sub: d.path || d.url, meta: d.status, open: d.status === 'done' && d.path ? '打开' : undefined, openAction: () => post('downloads/open', { id: d.id }).then((r) => { if (r.ok) showToast('已用系统默认程序打开') }), rm: '删除', rmAction: () => del('downloads?id=' + d.id) }))
      }
    } catch {
      // 2026-09-15 审计（P1）：原来这个 async 函数没有 try/catch，4xx 或非 JSON
      // （代理异常会回一整页 HTML）时 r.json() 抛异常，而 setInterval 既不 await 也
      // 不 catch ⇒ 未处理拒绝打断该 tick 的兜底轮询，现场表现为"查看器停在旧内容 /
      // 删除按钮点了没反应"。现在失败就地变成列表区文案，1.5s 轮询会继续重试。
      viewerSig = ''
      list.textContent = ''
      const fail = document.createElement('div')
      fail.style.color = 'var(--danger)'
      fail.style.padding = '20px 0'
      fail.textContent = '加载失败，请重试'
      list.appendChild(fail)
      return
    }
    // 内容没变就不重建（2026-09-15 审计 P2）：整表重建会把滚动位置打回顶部，
    // 下载进度那种每秒都在变的面板根本没法看。
    const sig = JSON.stringify([kind, rows.map((r) => [r.main, r.sub, r.meta, r.open || '', r.rm || '', r.openUrl || ''])])
    if (sig === viewerSig && list.childElementCount > 0) { list.scrollTop = prevScroll; return }
    viewerSig = sig
    list.textContent = ''
    if (rows.length === 0) { list.innerHTML = '<div style="color:var(--text-muted);padding:20px 0">暂无记录</div>'; return }
    for (const row of rows) {
      const el = document.createElement('div')
      el.className = 'vrow'
      el.innerHTML = '<div class="main"><div style="overflow:hidden;text-overflow:ellipsis">' + esc(row.main || row.sub) + '</div><div style="color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis">' + esc(row.sub) + '</div></div><span class="meta">' + esc(row.meta) + '</span>'
      if (row.openUrl) {
        const main = el.querySelector('.main')
        main.style.cursor = 'pointer'
        main.title = '在新标签页打开：' + row.openUrl
        main.addEventListener('click', () => {
          void post('overlay', { mode: 'capsule' })
          void post('navigate', { url: row.openUrl })
        })
      }
      if (row.open) {
        const b = document.createElement('button')
        b.className = 'rm'; b.textContent = row.open
        b.addEventListener('click', async () => { if (row.openAction) await row.openAction() })
        el.appendChild(b)
      }
      if (row.rm) {
        const b = document.createElement('button')
        b.className = 'rm danger'; b.textContent = row.rm
        b.addEventListener('click', async () => {
          // 删除失败（403/503）就不重绘：保留原行才是服务端状态的真相，失败文案
          // 由 del() 统一 toast —— 原来不看状态就重绘，用户以为删掉了。
          const r = await row.rmAction()
          if (r && r.ok === false) return
          await renderViewer(kind, q)
        })
        el.appendChild(b)
      }
      list.appendChild(el)
    }
    list.scrollTop = prevScroll
  }

  // ---- interactions ----
  $('capsule').addEventListener('click', (e) => {
    if (e.target.id === 'ai-take') return
    void post('overlay', { mode: 'panel' }).then((r) => { if (r.ok) refresh() })
  })
  $('ai-take').addEventListener('click', (e) => { e.stopPropagation(); void takeControl('ai-take', !state.controlled) })
  // ONE control toggle, both directions: the mask pill's 我来操作 and the
  // capsule's 交给 AI are the same button in its two states. No sidebar /
  // panel / Esc path may hand the browser back to the AI (2026-09-11).
  /**
   * 控制权切换（我来操作 / 交给 AI 同一个按钮的两个状态）。
   *
   * 2026-09-15 现场 P0：客户点「我来操作」整轮没反应，主机日志里只有一条
   * 「refused a local write without browser proof」—— 写证明还没交接完时，页面
   * 既不判状态也不给反馈。现在：点击期间按钮进 pending/disabled（防连点 +
   * 「正在接管…」反馈），失败由 post 统一 toast 出可读文案，且**不改本地状态**
   * （只有 refresh() 拿到服务端的 controlled 才切文案）。
   */
  async function takeControl(btnId, active) {
    const btn = $(btnId)
    if (!btn || btn.disabled) return
    const label = btn.textContent
    btn.disabled = true
    // 方向文案（2026-09-15 审计 P3）：旧实现不论接管还是交回都说「正在接管…」，
    // 用户点「交给 AI」时看到的是相反方向的动作。
    btn.textContent = active ? '正在接管…' : '正在交还…'
    const r = await post('takeover', { active })
    btn.disabled = false
    btn.textContent = label
    if (r.ok) await refresh()
  }
  $('pill-take').addEventListener('click', (e) => {
    e.stopPropagation()
    void takeControl('pill-take', true)
  })
  $('panel-close').addEventListener('click', () => { void post('overlay', { mode: 'capsule' }) })
  $('hide-btn').addEventListener('click', () => { void post('hide') })
  $('viewer-close').addEventListener('click', () => { void post('overlay', { mode: 'capsule' }) })
  $('viewer-search').addEventListener('input', (e) => { void renderViewer(viewerKind, e.target.value).catch(() => {}) })
  // The mask scrim is deliberately INERT: only #pill-take grants control.

  // Forward the browser shortcuts when keyboard focus lives in the overlay
  // (after panel/menu/viewer interactions) so Ctrl+T/W/R keep working; Ctrl+L
  // closes the overlay surface (the host then focuses the shell address bar).
  document.addEventListener('keydown', (e) => {
    // Escape only closes the floating surface. It must NEVER hand the browser
    // back to the AI: control changes only via the 我来操作/交给 AI button.
    if (e.key === 'Escape') {
      void post('overlay', { mode: 'capsule' })
      return
    }
    // While masked the window is locked and the pill button is the only entry;
    // Enter/Space mirror it for keyboard users.
    if (!state.controlled) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        void takeControl('pill-take', true)
      }
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); void post('overlay', { mode: 'capsule' }) }
    if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); void post('open').then((r) => { if (r.ok) refresh() }) }
    if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); void getJson('state').then((s) => { const t = (s.tabs || []).find((x) => x.visible); if (t) void post('close-tab', { tab: t.id }).then((r) => { if (r.ok) refresh() }) }).catch(() => {}) }
    if (e.ctrlKey && e.key.toLowerCase() === 'r') { e.preventDefault(); void post('reload').then((r) => { if (r.ok) refresh() }) }
  })

  // Menu auto-close: a bounds-based menu never sees outside clicks — release
  // the mode after 15s of inactivity so it does not linger over the page.
  let menuTimer = null
  function armMenuAutoClose() {
    if (menuTimer !== null) clearTimeout(menuTimer)
    menuTimer = setTimeout(() => {
      if (mode === 'menu') post('overlay', { mode: 'capsule' })
    }, 15000)
  }
  function applyModeInner(next) {
    applyMode(next)
    if (next === 'menu') armMenuAutoClose()
  }

  function connectStream() {
    try {
      const es = new EventSource('/api/pico/browser/stream')
      // onopen/onerror 不再翻状态标志：重连由 EventSource 自己负责，页面只关心
      // "最近一次真的有事件推过来是什么时候"（见 SSE_STALE_MS）。
      for (const ev of ['tab', 'tab-meta', 'busy', 'takeover', 'release', 'ops', 'state']) {
        es.addEventListener(ev, () => { lastSseAt = Date.now(); refresh() })
      }
    } catch { /* 连不上就纯靠兜底轮询 */ }
  }
  connectStream()
  refresh()
  setInterval(() => {
    if (Date.now() - lastSseAt > SSE_STALE_MS) refresh()
    // Live-refresh open viewers (downloads progress) without stealing the
    // search input's focus. renderViewer 自己 catch 了读面失败（并在列表区显示
    // 「加载失败，请重试」）；这里的 catch 是第二道保险：绝不能让一条未处理拒绝
    // 打断整个 tick 的兜底轮询（2026-09-15 审计 P1）。
    if (mode === 'viewer' && document.activeElement !== $('viewer-search')) {
      void renderViewer(viewerKind, $('viewer-search').value || '').catch(() => {})
    }
  }, 1500)
</script>
</body>
</html>`
