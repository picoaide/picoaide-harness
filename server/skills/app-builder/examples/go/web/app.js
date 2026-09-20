/**
 * 团队共享便签的前端。
 *
 * 分工（前后端分离）：
 *   - 页面**只做两件事**：向应用自己的 JSON 接口取/写数据、把结果渲染到 DOM；
 *   - 业务规则、准入判定、数据落库全在 wasm 后端（`main.go`），页面不复制一份。
 *
 * 三条硬规则（照抄即可）：
 *   1. **只用 `textContent` 渲染用户数据**，不要拼 `innerHTML`（那是 XSS 的入口）；
 *   2. **每个数据区块都有三态**：加载中 / 空 / 失败（失败要把后端给的人话显示出来）；
 *   3. 失败一律是 JSON 信封 `{"error":{"code","message"}}` —— 读 `message` 给人看，
 *      `code` 进 `console.error` 便于排障，**不要只说"失败了"**。
 *
 * AI 走**客户端 AI loop**：页面 `fetch('/__picoaide/ai/chat')` 由客户端本地处理
 * （绝不转发服务端），拿到回答后 POST 回本应用的 `/api/summaries` 落库。
 */
'use strict'

// ===== 小工具 =====

/** 取元素；缺失即抛错（页面被改坏时要立刻可见，而不是静默不工作）。 */
function el(id) {
  var node = document.getElementById(id)
  if (!node) throw new Error('页面缺少元素 #' + id)
  return node
}

/** 把后端的错误信封读成人话。 */
function readError(resp) {
  return resp.json().catch(function () { return {} }).then(function (body) {
    var err = (body && body.error) ? body.error : {}
    var code = err.code || ('HTTP ' + resp.status)
    console.error('[shared-notes] 接口失败:', code, err.message || '')
    return err.message || ('请求失败（' + code + '）')
  })
}

/** 统一的 fetch + 错误处理：非 2xx 一律抛出可直接显示的中文消息。 */
function callAPI(path, options) {
  return fetch(path, options).then(function (resp) {
    if (!resp.ok) return readError(resp).then(function (message) { throw new Error(message) })
    return resp.json()
  })
}

/** 渲染一条记录（**只用 textContent**，绝不拼 HTML 字符串）。 */
function renderItem(text, who) {
  var li = document.createElement('li')
  li.textContent = text
  var meta = document.createElement('span')
  meta.className = 'who'
  meta.textContent = who
  li.appendChild(meta)
  return li
}

// ===== 三态切换 =====

/** 区块状态：'loading' | 'empty' | 'error' | 'ready'。 */
function setState(nodes, state, message) {
  nodes.loading.hidden = state !== 'loading'
  if (nodes.empty) nodes.empty.hidden = state !== 'empty'
  nodes.error.hidden = state !== 'error'
  if (state === 'error') nodes.error.textContent = message || '出错了，请重试。'
  nodes.list.hidden = state !== 'ready'
}

// ===== 数据加载 =====

var notesView = {
  loading: el('notes-loading'),
  empty: el('notes-empty'),
  error: el('notes-error'),
  list: el('notes')
}
var summariesView = {
  loading: null,
  empty: el('summaries-empty'),
  error: el('notes-error'),
  list: el('summaries')
}

/** 身份与应用信息（页面标题、AI 保留路径都来自后端，页面不写死）。 */
var app = { title: '团队共享便签', ai_chat_path: '/__picoaide/ai/chat' }

function loadWhoami() {
  return callAPI('/api/whoami').then(function (data) {
    var user = (data && data.user) || {}
    if (data && data.app) app = data.app
    el('whoami').textContent = (user.display_name || user.username || '未知') +
      (user.username ? '（' + user.username + '）' : '')
    document.title = app.title
    el('title').textContent = app.title
  })
}

function loadData() {
  setState(notesView, 'loading')
  return callAPI('/api/notes').then(function (data) {
    var notes = (data && data.notes) || []
    var summaries = (data && data.summaries) || []

    notesView.list.textContent = ''
    if (notes.length === 0) {
      setState(notesView, 'empty')
    } else {
      notes.forEach(function (n) {
        notesView.list.appendChild(renderItem(n.body || '', (n.author || '') + ' · ' + (n.created_at || '')))
      })
      setState(notesView, 'ready')
    }
    el('notes-truncated').hidden = !(data && data.truncated)

    summariesView.list.textContent = ''
    summaries.forEach(function (s) {
      summariesView.list.appendChild(renderItem(s.summary || '', (s.author || '') + ' · ' + (s.created_at || '')))
    })
    summariesView.empty.hidden = summaries.length !== 0
    return data
  }).catch(function (err) {
    setState(notesView, 'error', err.message)
    throw err
  })
}

// ===== 新增便签 =====

el('note-form').addEventListener('submit', function (event) {
  // 原生表单提交会把页面导航走；这里必须阻止，改走 fetch。
  event.preventDefault()
  var body = el('note-body').value.trim()
  if (body === '') return
  var submit = el('note-submit')
  submit.disabled = true
  callAPI('/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: body })
  }).then(function () {
    el('note-body').value = ''
    return loadData()
  }).catch(function (err) {
    setState(notesView, 'error', err.message)
  }).then(function () {
    submit.disabled = false
  })
})

// ===== 客户端 AI loop：读流式响应 =====

/**
 * 读 `text/event-stream`：`delta` 带增量、`done` 收尾、`error` 报错（一律 JSON 信封）。
 * @param {Response} resp
 * @param {(text: string) => void} onDelta
 * @returns {Promise<string>} 完整回答
 */
function readStream(resp, onDelta) {
  if (!resp.body || !resp.body.getReader) return resp.text()
  var reader = resp.body.getReader()
  var decoder = new TextDecoder()
  var buffer = ''
  var acc = ''
  function handle(block) {
    var event = 'message'
    var data = ''
    block.split('\n').forEach(function (line) {
      if (line.indexOf('event:') === 0) event = line.slice(6).trim()
      else if (line.indexOf('data:') === 0) data += line.slice(5).trim()
    })
    if (data === '') return
    var payload = null
    try { payload = JSON.parse(data) } catch (e) { payload = null }
    if (event === 'delta') {
      acc += (payload && payload.delta) ? payload.delta : ''
      onDelta(acc)
    } else if (event === 'done') {
      if (payload && payload.content) { acc = payload.content; onDelta(acc) }
    } else if (event === 'error') {
      throw new Error(payload && payload.error
        ? (payload.error.code + '：' + payload.error.message)
        : data)
    }
  }
  function pump() {
    return reader.read().then(function (chunk) {
      if (chunk.done) return acc
      buffer += decoder.decode(chunk.value, { stream: true })
      var blocks = buffer.split('\n\n')
      buffer = blocks.pop()
      blocks.forEach(handle)
      return pump()
    })
  }
  return pump()
}

el('ai-summarize').addEventListener('click', function () {
  var btn = el('ai-summarize')
  var state = el('ai-state')
  var out = el('ai-out')
  btn.disabled = true
  state.textContent = '正在准备提示词…'
  out.hidden = true
  out.textContent = ''

  // ① 让 wasm 拼好提示词（它负责截断到 AI 桥的单条上限内）
  callAPI('/api/ai-prompt').then(function (data) {
    var prompt = (data && data.prompt) || ''
    if (prompt === '') throw new Error('还没有便签可以总结。')
    state.textContent = '正在等 AI…（首次使用会先让你授权一次；费用记在你自己账上）'
    // ② 调客户端 AI loop：保留路径由后端下发（app.ai_chat_path），页面不写死。
    return fetch(app.ai_chat_path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], stream: true })
    }).then(function (resp) {
      if (!resp.ok) {
        // 失败一律 JSON 信封：app_ai_denied / app_ai_unavailable / app_ai_invalid /
        // ai_balance_insufficient / ai_rate_limited / ai_cancelled（详见技能手册）。
        return readError(resp).then(function (message) { throw new Error(message) })
      }
      return readStream(resp, function (partial) {
        out.hidden = false
        out.textContent = partial
      })
    }).then(function (answer) {
      answer = (answer || '').trim()
      if (answer === '') throw new Error('AI 返回了空回答。')
      state.textContent = '已拿到回答，正在回传应用落库…'
      // ③ 结果回传应用自己的路由：wasm 在那里把它写进 summaries 表。
      return callAPI('/api/summaries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ summary: answer })
      })
    }).then(function () {
      state.textContent = '已写入应用库。'
      return loadData()
    })
  }).catch(function (err) {
    state.textContent = '没成功：' + ((err && err.message) ? err.message : String(err))
  }).then(function () {
    btn.disabled = false
  })
})

// ===== 启动：先取身份，再取数据（两步都失败也要给人话）=====
loadWhoami().then(loadData).catch(function (err) {
  setState(notesView, 'error', (err && err.message) ? err.message : '加载失败，请刷新重试。')
})
