/**
 * The v4 browser shell: one local page served by the plugin's loopback
 * webServer driving the dedicated BrowserWindow. Two-row chrome (session
 * segments + tabs / omnibox), the bottom-right AI indicator capsule (the
 * single breathing point), the floating activity panel (session switcher +
 * action stream + 我来操作/交给 AI), the ⋮ menu with bookmark/history/
 * download viewers, and the empty states. State is pushed over SSE
 * (/api/pico/browser/stream) with a polling fallback; all actions go through
 * the fenced loopback API.
 * @module @picoaide/dsh-browser
 */

export const BROWSER_SHELL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PicoAide 浏览器</title>
<style>
  :root {
    --surface: #f4f5f7;
    --surface-raised: #ffffff;
    --surface-hover: #eceef1;
    --text: #1a1d24;
    --text-muted: #6b7280;
    --border: #dcdfe4;
    --accent: #2563eb;
    --accent-soft: rgba(37, 99, 235, .12);
    --warning: #d97706;
    --danger: #dc2626;
    --success: #16a34a;
    --radius: 6px;
    --radius-lg: 8px;
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
      --accent-soft: rgba(107, 155, 255, .16);
      --warning: #f0a03c;
      --danger: #f0726e;
      --success: #4ade80;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    background: var(--surface); color: var(--text);
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    overflow: hidden;
  }
  button { font: inherit; color: inherit; background: none; border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 8px; cursor: pointer; transition: background 150ms ease, color 150ms ease, border-color 150ms ease; }
  button:hover { background: var(--surface-hover); }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
  button.icon { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  button.acc { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.acc:hover { opacity: .9; }
  button.warn { background: var(--warning); border-color: var(--warning); color: #fff; }
  button.danger { color: var(--danger); border-color: var(--danger); }
  svg { display: block; }
  [hidden] { display: none !important; }

  /* ---------- TabStrip ---------- */
  #tabstrip { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
  #tabstrip::-webkit-scrollbar { display: none; }
  .segment { display: flex; align-items: center; gap: 6px; padding-right: 6px; border-right: 1px solid var(--border); margin-right: 6px; min-width: 0; }
  .seg-head { display: flex; align-items: center; gap: 5px; height: 22px; padding: 0 4px; border-radius: 4px; cursor: pointer; white-space: nowrap; color: var(--text-muted); }
  .seg-head:hover { background: var(--surface-hover); }
  .seg-head.fore { color: var(--text); font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); flex: none; }
  .dot.busy { background: var(--accent); animation: breathe 2.4s ease-in-out infinite; }
  .dot.paused { background: var(--warning); }
  .dot.arch { background: var(--text-muted); opacity: .6; }
  .dot.fore { background: var(--accent); }
  .seg-head .more { opacity: 0; font-size: 12px; padding: 0 2px; }
  .seg-head:hover .more { opacity: 1; }
  .tab { display: flex; align-items: center; gap: 5px; height: 24px; max-width: 180px; padding: 0 6px; border-radius: var(--radius); cursor: pointer; white-space: nowrap; overflow: hidden; color: var(--text-muted); border: 1px solid transparent; }
  .tab:hover { background: var(--surface-hover); }
  .tab.active { background: var(--surface-raised); color: var(--text); border-color: var(--border); box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .tab .favicon { width: 16px; height: 16px; border-radius: 3px; background: var(--surface-hover); flex: none; overflow: hidden; }
  .tab .favicon img { width: 16px; height: 16px; display: block; }
  .tab .ai-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; animation: breathe 2.4s ease-in-out infinite; }
  .tab .t { overflow: hidden; text-overflow: ellipsis; }
  .tab .x { opacity: 0; padding: 0 2px; font-size: 12px; color: var(--text-muted); }
  .tab:hover .x { opacity: 1; }
  .tab .x:hover { color: var(--danger); }
  #newtab { margin-left: auto; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: .45; } }

  /* ---------- Omnibox ---------- */
  #omnibox { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px; border-bottom: 1px solid var(--border); }
  #addr { flex: 1; min-width: 0; height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-raised); color: var(--text); font: inherit; }
  #addr:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
  #addr.secure { padding-left: 30px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14' fill='none'%3E%3Crect x='2.5' y='6' width='9' height='6' rx='1.5' stroke='%2316a34a' stroke-width='1.4'/%3E%3Cpath d='M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6' stroke='%2316a34a' stroke-width='1.4'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: 10px center; }
  #addr.ins { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14' fill='none'%3E%3Cpath d='M7 6V2.5M7 6l2-2M7 6L5 4' stroke='%23d97706' stroke-width='1.4' stroke-linecap='round'/%3E%3Cpath d='M3 8v3h8V8' stroke='%23d97706' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: 10px center; }
  #addr:focus { background-image: none; padding-left: 12px; }
  #menu-btn { margin-left: auto; }

  /* ---------- AI indicator ---------- */
  #ai-indicator {
    position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 6px;
    height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--surface-raised); box-shadow: 0 4px 16px rgba(0,0,0,.12); cursor: pointer; z-index: 40;
  }
  #ai-indicator .dot { width: 8px; height: 8px; }
  #ai-indicator .label { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #ai-indicator .take {
    display: none; margin-left: 2px; height: 24px; padding: 0 10px; font-size: 12px;
    background: var(--warning); border-color: var(--warning); color: #fff;
  }
  #ai-indicator:hover .take { display: inline-flex; align-items: center; }

  /* ---------- Floating activity panel ---------- */
  #panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: 340px; z-index: 50;
    background: var(--surface-raised); border-left: 1px solid var(--border);
    box-shadow: -8px 0 28px rgba(0,0,0,.10); transform: translateX(105%); transition: transform 200ms ease-out;
    display: flex; flex-direction: column;
  }
  #panel.open { transform: translateX(0); }
  #panel h2 { font-size: 13px; font-weight: 600; margin: 0; padding: 12px 14px 8px; display: flex; align-items: center; justify-content: space-between; }
  #panel .close { border: none; padding: 2px 6px; font-size: 14px; }
  #session-switcher { display: flex; gap: 4px; padding: 0 12px 8px; overflow-x: auto; scrollbar-width: none; }
  #session-switcher::-webkit-scrollbar { display: none; }
  .sess-cap { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--border); cursor: pointer; white-space: nowrap; font-size: 12px; color: var(--text-muted); }
  .sess-cap:hover { background: var(--surface-hover); }
  .sess-cap.selected { background: var(--accent-soft); border-color: var(--accent); color: var(--text); }
  #stream { flex: 1; overflow-y: auto; padding: 4px 14px 12px; }
  .op { display: flex; gap: 8px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid var(--border); }
  .op:last-child { border-bottom: none; }
  .op .time { flex: none; font-variant-numeric: tabular-nums; color: var(--text-muted); font-size: 11px; }
  .op .what { overflow: hidden; }
  .op .what .tool { color: var(--accent); font-weight: 500; }
  .op .what .fail { color: var(--danger); }
  .op .what .pause { color: var(--warning); }
  #panel-bottom { padding: 10px 14px; border-top: 1px solid var(--border); display: flex; gap: 8px; }
  #panel-bottom button { flex: 1; height: 32px; }
  #panel-archived { padding: 0 14px 8px; display: flex; flex-wrap: wrap; gap: 6px; }
  .arch-chip { font-size: 12px; padding: 3px 8px; border-radius: 999px; border: 1px dashed var(--border); color: var(--text-muted); cursor: pointer; }
  .arch-chip:hover { border-color: var(--accent); color: var(--text); }

  /* ---------- Table viewers ---------- */
  #viewer { position: fixed; inset: 0; z-index: 60; background: var(--surface); display: none; flex-direction: column; }
  #viewer.open { display: flex; }
  #viewer h2 { display: flex; align-items: center; gap: 10px; margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
  #viewer .list { flex: 1; overflow-y: auto; padding: 8px 16px; }
  .vrow { display: flex; gap: 10px; align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--border); }
  .vrow .main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vrow .meta { color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .vrow .rm { flex: none; }
  #viewer-search { margin-left: auto; width: 220px; height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); color: var(--text); font: inherit; }

  /* ---------- Empty states ---------- */
  #empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-muted); }
  #empty .hero { font-size: 40px; opacity: .5; }
  #empty .msg { font-size: 14px; max-width: 420px; text-align: center; }

  /* ---------- Context menu ---------- */
  #menu { position: fixed; z-index: 70; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 4px; display: none; min-width: 180px; }
  #menu.open { display: block; }
  #menu .mi { display: flex; align-items: center; gap: 8px; width: 100%; border: none; padding: 6px 10px; border-radius: 4px; text-align: left; }
  #menu .mi:hover { background: var(--surface-hover); }
  #menu .mi.danger { color: var(--danger); }
  #menu .sep { height: 1px; background: var(--border); margin: 4px 0; }
</style>
</head>
<body>
  <div id="tabstrip">
    <div id="segments" style="display:flex;align-items:center;gap:6px;min-width:0;"></div>
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
    <div class="msg">打开浏览器，AI 会在你的会话中自动创建标签页。<br/>你也可以点右上角 ＋ 先自己逛起来。</div>
  </div>
  <div id="viewer">
    <h2><span id="viewer-title"></span><input id="viewer-search" placeholder="搜索…" hidden/><button id="viewer-close" class="icon" style="margin-left:auto">×</button></h2>
    <div id="viewer-list" class="list"></div>
  </div>
  <div id="ai-indicator" title="点击查看 AI 活动">
    <span class="dot" id="ai-dot"></span>
    <span class="label" id="ai-label">AI</span>
    <button id="ai-take" class="take">我来操作</button>
  </div>
  <div id="panel">
    <h2>AI 活动 <button class="close" id="panel-close">×</button></h2>
    <div id="session-switcher"></div>
    <div id="panel-archived"></div>
    <div id="stream"></div>
    <div id="panel-bottom">
      <button id="take-btn">我来操作</button>
      <button id="hide-btn">隐藏窗口</button>
    </div>
  </div>
  <div id="menu"></div>
<script>
  const $ = (id) => document.getElementById(id)
  const state = { groups: [], controlled: false, foreground: null, ops: [] }
  let selectedSession = null
  let sseOk = false

  const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">'
  const X_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
  const PAUSE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4.5" y="3" width="2.4" height="10" rx="1" fill="currentColor"/><rect x="9.1" y="3" width="2.4" height="10" rx="1" fill="currentColor"/></svg>'
  const PLAY_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 3.5l7 4.5-7 4.5v-9z" fill="currentColor"/></svg>'
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

  const post = (action, body) => fetch('/api/pico/browser/' + action, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then((r) => r.json()).catch(() => ({ ok: false }))

  const labelOf = (tool) => TOOL_LABELS[tool] || tool || '操作'
  const fmtTime = (t) => { try { return new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '' } }
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  async function refresh() {
    try {
      const next = await fetch('/api/pico/browser/state').then((r) => r.json())
      state.groups = Array.isArray(next.groups) ? next.groups : []
      state.controlled = next.controlled === true
      state.foreground = next.foreground
      // Ensure a selected session (foreground or first active).
      if (!state.groups.some((g) => g.key === selectedSession)) {
        selectedSession = (state.groups.find((g) => g.key === state.foreground) || state.groups.find((g) => g.status === 'active') || state.groups[0] || null)?.key || null
      }
      render()
    } catch { /* keep last state */ }
    try {
      const o = await fetch('/api/pico/browser/ops').then((r) => r.json())
      if (Array.isArray(o.ops)) state.ops = o.ops
      renderStream()
    } catch { /* ignore */ }
  }

  function busyGroup() {
    // Only groups with an in-flight tool are "AI 操作中".
    const actives = state.groups.filter((g) => g.status === 'active' && g.busy)
    if (actives.length === 0) return null
    return actives.find((g) => g.key === state.foreground) || actives[0]
  }

  function render() {
    // ---- segment strip ----
    const segs = $('segments')
    segs.textContent = ''
    for (const g of state.groups) {
      const seg = document.createElement('div')
      seg.className = 'segment'
      const head = document.createElement('button')
      head.className = 'seg-head' + (g.key === state.foreground ? ' fore' : '') + (g.status === 'archived' ? ' arch' : '')
      head.title = g.label + (g.status === 'archived' ? '（已结束）' : '')
      const dotCls = g.busy ? 'busy' : state.controlled ? 'paused' : g.status === 'archived' ? 'arch' : g.key === state.foreground ? 'fore' : ''
      head.innerHTML = '<span class="dot ' + dotCls + '"></span><span>' + esc(g.label) + '</span><span class="more">⋯</span>' 
      head.addEventListener('click', (e) => { e.stopPropagation(); openSegmentMenu(g, head) })
      seg.appendChild(head)
      for (const tab of g.tabs) {
        const el = document.createElement('div')
        el.className = 'tab' + (tab.active && g.key === state.foreground ? ' active' : '')
        el.title = tab.url || tab.title
        const busy = g.busy && tab.active
        el.innerHTML = '<span class="favicon"></span><span class="t">' + esc(tab.title || tab.url || '新标签') + (tab.loading ? '…' : '') + '</span>' + (busy ? '<span class="ai-dot"></span>' : '') + '<span class="x" title="关闭标签">×</span>' 
        el.addEventListener('click', (e) => {
          if (e.target.className === 'x') return
          post('switch-group', { group: g.key }).then(() => post('switch-tab', { tab: tab.id }))
        })
        el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); post('close-tab', { tab: tab.id }) })
        seg.appendChild(el)
      }
      segs.appendChild(seg)
    }
    $('empty').hidden = state.groups.length > 0 || state.groups.some((g) => g.tabs.length > 0)

    // ---- omnibox ----
    const active = state.groups.find((g) => g.key === state.foreground && g.status === 'active' && g.tabs.length > 0)
    const cur = active ? active.tabs.find((t) => t.active) : undefined
    $('addr').value = document.activeElement === $('addr') ? $('addr').value : (cur ? cur.url : '')
    $('addr').placeholder = cur ? '' : '输入网址，回车访问（例如 https://example.com）'
    if (cur) {
      $('addr').classList.remove('ins')
      try {
        $('addr').classList.toggle('secure', new URL(cur.url).protocol === 'https:')
      } catch { $('addr').classList.remove('secure') }
    } else {
      $('addr').classList.remove('secure', 'ins')
    }

    // ---- ai indicator ----
    const dot = $('ai-dot')
    const label = $('ai-label')
    const takeBtn = $('ai-take')
    if (state.controlled) {
      dot.className = 'dot paused'; dot.style.background = 'var(--warning)'
      label.textContent = '你正在操作'
      takeBtn.textContent = '交给 AI'
      takeBtn.className = 'take'; takeBtn.style.display = 'inline-flex'
      takeBtn.style.background = 'var(--accent)'; takeBtn.style.borderColor = 'var(--accent)'
    } else {
      const bg = busyGroup()
      if (bg !== null) {
        dot.className = 'dot busy'
        const count = state.groups.filter((g) => g.busy).length
        label.textContent = count > 1 ? 'AI 操作中 · ' + count + ' 个会话' : 'AI 操作中 · ' + bg.label
      } else {
        dot.className = 'dot'; dot.style.background = 'var(--text-muted)'
        label.textContent = 'AI'
      }
      takeBtn.textContent = '我来操作'
      takeBtn.className = 'take'
      takeBtn.style.background = ''; takeBtn.style.borderColor = ''
    }

    // ---- panel switcher & archived ----
    const sw = $('session-switcher')
    sw.textContent = ''
    for (const g of state.groups) {
      if (g.status === 'archived') continue
      const cap = document.createElement('button')
      cap.className = 'sess-cap' + (g.key === selectedSession ? ' selected' : '')
      const capDot = g.busy ? 'busy' : state.controlled ? 'paused' : ''
      cap.innerHTML = '<span class="dot ' + capDot + '" style="width:6px;height:6px;"></span><span>' + esc(g.label) + '</span>' 
      cap.addEventListener('click', () => { selectedSession = g.key; renderStream() })
      sw.appendChild(cap)
    }
    const arch = $('panel-archived')
    arch.textContent = ''
    for (const g of state.groups) {
      if (g.status !== 'archived') continue
      const chip = document.createElement('button')
      chip.className = 'arch-chip'
      chip.innerHTML = esc(g.label) + '（已结束）<span style="opacity:.6"> · ' + g.tabs.length + ' 页</span>' 
      chip.addEventListener('click', () => { selectedSession = g.key; renderStream() })
      arch.appendChild(chip)
    }
    renderStream()
  }

  function renderStream() {
    const stream = $('stream')
    stream.textContent = ''
    const sel = state.groups.find((g) => g.key === selectedSession)
    const busy = sel !== undefined && sel.busy
    if (busy) {
      const line = document.createElement('div')
      line.className = 'op'
      line.innerHTML = '<span class="time"></span><div class="what"><span class="tool">正在执行：' + esc(labelOf(sel.busyTool)) + '</span></div>' 
      stream.appendChild(line)
    }
    const ops = state.ops.filter((op) => op.group === '' || op.group === selectedSession).slice(0, 40)
    if (ops.length === 0 && !busy) {
      const line = document.createElement('div')
      line.className = 'op'
      line.innerHTML = '<div class="what" style="color:var(--text-muted)">暂无操作记录' + (sel && sel.status === 'archived' ? '（会话已结束）' : '') + '</div>'
      stream.appendChild(line)
    }
    for (const op of ops) {
      const line = document.createElement('div')
      line.className = 'op'
      const cls = op.failed ? 'fail' : op.tool === 'browser_takeover' || op.tool === 'browser_release' ? 'pause' : ''
      line.innerHTML = '<span class="time">' + fmtTime(op.time) + '</span><div class="what"><span class="' + cls + '">' + esc(labelOf(op.tool)) + '</span> ' + esc(op.summary) + '</div>' 
      stream.appendChild(line)
    }
    const take = $('take-btn')
    if (state.controlled) {
      take.textContent = '交给 AI'; take.className = 'acc'
      take.title = '让 AI 继续操作 (Esc)'
    } else {
      take.textContent = '我来操作'; take.className = ''
      take.title = '暂停 AI，自己操作'
    }
  }

  function openSegmentMenu(group, anchor) {
    const menu = $('menu')
    menu.textContent = ''
    const items = []
    if (group.status === 'active') {
      items.push({ label: group.key === state.foreground ? '正在查看' : '查看此会话', action: () => post('switch-group', { group: group.key }) })
      items.push({ label: '折叠', action: () => {} })
      items.push({ label: '重命名…', action: () => { const name = prompt('会话名称', group.label); if (name) { group.label = name.trim(); render() } } })
      items.push({ sep: true })
      items.push({ label: '关闭标签页（' + group.tabs.length + '）', danger: true, action: () => { if (confirm('关闭「' + group.label + '」的全部标签页？')) post('close-group', { group: group.key }) } })
    } else {
      items.push({ label: '查看此会话', action: () => { selectedSession = group.key; openPanel(); renderStream() } })
      items.push({ sep: true })
      items.push({ label: '关闭（丢弃记录）', danger: true, action: () => { if (confirm('丢弃「' + group.label + '」的浏览记录？')) post('close-group', { group: group.key }) } })
    }
    for (const item of items) {
      if (item.sep) { const sep = document.createElement('div'); sep.className = 'sep'; menu.appendChild(sep); continue }
      const b = document.createElement('button')
      b.className = 'mi' + (item.danger ? ' danger' : '')
      b.textContent = item.label
      b.addEventListener('click', () => { closeMenu(); item.action() })
      menu.appendChild(b)
    }
    menu.classList.add('open')
    const r = anchor.getBoundingClientRect()
    menu.style.left = Math.min(r.left, innerWidth - 220) + 'px'
    menu.style.top = (r.bottom + 4) + 'px'
  }
  function closeMenu() { $('menu').classList.remove('open') }
  document.addEventListener('click', (e) => { if (!e.target.closest('#menu') && !e.target.closest('.seg-head') && !e.target.closest('#menu-btn') && !Number(e.target?.closest?.('button')?.dataset?.menuKeep)) closeMenu() })

  function openPanel() { $('panel').classList.add('open') }
  function closePanel() { $('panel').classList.remove('open') }

  // ---- viewers ----
  async function openViewer(kind) {
    const title = { bookmarks: '书签', history: '浏览历史', downloads: '下载' }[kind]
    $('viewer-title').textContent = title
    const search = $('viewer-search')
    search.hidden = true
    $('viewer').classList.add('open')
    await renderViewer(kind, '')
  }
  async function renderViewer(kind, q) {
    const list = $('viewer-list')
    list.textContent = ''
    let rows = []
    let meta = ''
    if (kind === 'bookmarks') {
      const res = await fetch('/api/pico/browser/bookmarks?q=' + encodeURIComponent(q)).then((r) => r.json())
      rows = (res.bookmarks || []).map((b) => ({ main: b.title, sub: b.url, meta: fmtTime(b.createdAt), rm: '删除', rmAction: () => fetch('/api/pico/browser/bookmarks?id=' + b.id, { method: 'DELETE' }) }))
    } else if (kind === 'history') {
      const res = await fetch('/api/pico/browser/history?q=' + encodeURIComponent(q) + '&limit=200').then((r) => r.json())
      rows = (res.entries || []).map((h) => ({ main: h.title || h.url, sub: h.url, meta: (h.actor === 'user' ? '你 · ' : 'AI · ') + fmtTime(h.time) }))
    } else {
      const res = await fetch('/api/pico/browser/downloads?limit=200').then((r) => r.json())
      rows = (res.downloads || []).map((d) => ({ main: d.fileName, sub: d.path || d.url, meta: d.status, rm: '删除', rmAction: () => fetch('/api/pico/browser/downloads?id=' + d.id, { method: 'DELETE' }) }))
    }
    if (rows.length === 0) { list.innerHTML = '<div style="color:var(--text-muted);padding:20px 0">暂无记录</div>'; return }
    for (const row of rows) {
      const el = document.createElement('div')
      el.className = 'vrow'
      el.innerHTML = '<div class="main"><div style="overflow:hidden;text-overflow:ellipsis">' + esc(row.main || row.sub) + '</div><div class="sub" style="color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis">' + esc(row.sub) + '</div></div><span class="meta">' + esc(row.meta) + '</span>'
      if (row.rm) {
        const b = document.createElement('button')
        b.className = 'rm danger'; b.textContent = row.rm
        b.addEventListener('click', async () => { await row.rmAction(); await renderViewer(kind, q) })
        el.appendChild(b)
      }
      list.appendChild(el)
    }
    void meta
  }

  // ---- events ----
  $('newtab').addEventListener('click', () => post('open'))
  $('go-back').addEventListener('click', () => post('back'))
  $('go-forward').addEventListener('click', () => post('forward'))
  $('reload').addEventListener('click', () => post('reload'))
  $('bm').addEventListener('click', async () => {
    const fg = state.foreground
    if (fg === undefined || !state.groups.some((g) => g.key === fg && g.tabs.length > 0)) { alert('当前没有可收藏的页面'); return }
    const cur = state.groups.find((g) => g.key === fg).tabs.find((t) => t.active)
    if (cur === undefined) return
    await fetch('/api/pico/browser/bookmarks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: cur.url, label: cur.title }) })
    $('bm').style.color = 'var(--warning)'
    setTimeout(() => { $('bm').style.color = '' }, 900)
  })
  const go = () => {
    const value = $('addr').value.trim()
    if (value === '') return
    const normalized = /^[a-z]+:\/\//i.test(value) ? value : 'https://' + value
    if (state.foreground === null || !state.groups.some((g) => g.key === state.foreground && g.tabs.length > 0)) {
      post('open', { url: normalized })
    } else {
      post('navigate', { url: normalized })
    }
  }
  $('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go() } })
  $('menu-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    const menu = $('menu')
    menu.textContent = ''
    const items = [
      { label: '浏览历史', action: () => openViewer('history') },
      { label: '书签', action: () => openViewer('bookmarks') },
      { label: '下载', action: () => openViewer('downloads') },
      { sep: true },
      { label: '清除数据…', danger: true, action: () => { if (confirm('清除全部浏览数据（含登录状态）？')) post('clear-data') } },
      { label: '隐藏窗口', action: () => post('hide') },
    ]
    for (const item of items) {
      if (item.sep) { const sep = document.createElement('div'); sep.className = 'sep'; menu.appendChild(sep); continue }
      const b = document.createElement('button')
      b.className = 'mi' + (item.danger ? ' danger' : '')
      b.textContent = item.label
      b.addEventListener('click', () => { closeMenu(); item.action() })
      menu.appendChild(b)
    }
    menu.classList.add('open')
    const r = e.target.getBoundingClientRect()
    menu.style.left = Math.min(r.left - 180, innerWidth - 200) + 'px'
    menu.style.top = (r.bottom + 4) + 'px'
  })
  $('ai-indicator').addEventListener('click', () => { openPanel(); refresh() })
  $('ai-take').addEventListener('click', (e) => { e.stopPropagation(); toggleControl() })
  $('take-btn').addEventListener('click', toggleControl)
  function toggleControl() {
    const active = !state.controlled
    post('takeover', { active }).then(() => refresh())
  }
  $('hide-btn').addEventListener('click', () => post('hide'))
  $('panel-close').addEventListener('click', closePanel)
  $('viewer-close').addEventListener('click', () => $('viewer').classList.remove('open'))

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); $('addr').focus(); $('addr').select() }
    if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); post('open') }
    if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); const fg = state.foreground; const g = state.groups.find((x) => x.key === fg); const t = g && g.tabs.find((x) => x.active); if (t) post('close-tab', { tab: t.id }) }
    if (e.ctrlKey && e.key.toLowerCase() === 'r') { e.preventDefault(); post('reload') }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); post('back') }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); post('forward') }
    if (e.ctrlKey && e.key.toLowerCase() === 'a' && e.shiftKey) { e.preventDefault(); if ($('panel').classList.contains('open')) closePanel(); else openPanel() }
    if (e.key === 'Escape') { closePanel(); closeMenu(); if (state.controlled) toggleControl() }
  })

  // ---- stream (SSE with polling fallback) ----
  function connectStream() {
    try {
      const es = new EventSource('/api/pico/browser/stream')
      es.onopen = () => { sseOk = true }
      es.onerror = () => { sseOk = false }
      es.onmessage = () => refresh()
      es.addEventListener('group', () => refresh())
      es.addEventListener('tab', () => refresh())
      es.addEventListener('tab-meta', () => refresh())
      es.addEventListener('busy', () => refresh())
      es.addEventListener('foreground', () => refresh())
      es.addEventListener('takeover', () => refresh())
      es.addEventListener('release', () => refresh())
      es.addEventListener('ops', () => refresh())
    } catch { sseOk = false }
  }
  connectStream()
  refresh()
  setInterval(() => { if (!sseOk) refresh() }, 1500)
</script>
</body>
</html>`
