/* ============================================================================
   内部小论坛 · 前端
   ----------------------------------------------------------------------------
   职责边界：**这一层不做业务判断**，只负责取数、渲染、动效与键盘可达性。
   校验、权限、事务全在 wasm 侧（`main.go`）——页面拿到的永远是 JSON 信封。

   两条硬纪律：
   1. 用户内容一律 `textContent` 渲染，全文件没有一处把用户输入拼进 `innerHTML`；
   2. 失败一律走 `showError()`：把平台的错误码与 message 原样显示在提示条上，
      不吞、不改写成人话（`HOST_DB_DENIED` 这种码本身就是给人看的）。
   ========================================================================== */

'use strict'

/* ---------- 常量 ---------- */
const PAGE_SIZE = 20
const MAX_TITLE = 120
const MAX_BODY = 4000
const SWAP_MS = 190 // 切版块/翻页时列表淡出的时长，与 app.css 的过渡时长对齐

/* ---------- DOM 小工具（全部走 createElement / textContent） ---------- */
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))

/**
 * 建一个元素。
 * @param {string} tag 标签名
 * @param {{class?:string, text?:string, attrs?:Record<string,string|number|boolean>, on?:Record<string,Function>}} [opts]
 * @param {Node[]} [children]
 */
function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag)
  if (opts.class) node.className = opts.class
  if (opts.text !== undefined) node.textContent = String(opts.text)
  for (const [key, value] of Object.entries(opts.attrs || {})) {
    if (value === false || value === null || value === undefined) continue
    if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, String(value))
  }
  for (const [type, handler] of Object.entries(opts.on || {})) node.addEventListener(type, handler)
  for (const child of children) if (child) node.appendChild(child)
  return node
}

/** 取一个内联 SVG 图标（精灵在 index.html 里，`<use>` 引用本地片段）。 */
function icon(id, cls = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', '#' + id)
  svg.appendChild(use)
  return svg
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

/** 用静态模板（`<template>`）克隆一个片段：内容全是固定文案，不含用户输入。 */
function fromTemplate(id) {
  return document.getElementById(id).content.cloneNode(true)
}

/* ---------- 时间与文本 ---------- */
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 相对时间（列表里读起来比绝对时间快）。 */
function relTime(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const diff = Date.now() - t
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return Math.floor(diff / MIN) + ' 分钟前'
  if (diff < DAY) return Math.floor(diff / HOUR) + ' 小时前'
  if (diff < 7 * DAY) return Math.floor(diff / DAY) + ' 天前'
  return fmtDate(iso, false)
}

/** 绝对时间（UTC 存、本地显示）。 */
function fmtDate(iso, withTime = true) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day
}

/** 展示名（缺失时回落账号）。 */
function whoName(row) {
  return (row && (row.author_display || row.author)) || '（未知）'
}

/** 头像里的首字。 */
function initialOf(text) {
  const s = String(text || '?').trim()
  return s ? Array.from(s)[0].toUpperCase() : '?'
}

/* ---------- 状态 ---------- */
const state = {
  me: null,
  boards: [],
  stats: null,
  statsAvailable: true,
  board: '',       // 当前版块 id（'' = 全部）
  q: '',           // 当前搜索词
  page: 1,
  total: null,
  hasMore: false,
  topics: [],
  topic: null,
  posts: [],
  loadingList: false,
  loadingDetail: false,
  loadSeq: 0,      // 列表请求序号：只认最后一次，防旧响应盖掉新列表
  newPostId: null, // 刚发出去的回帖 id（渲染时加滑入 + 高亮）
}

/* ---------- 网络：统一把错误信封翻成异常 ---------- */
async function api(path, options = {}) {
  let res
  try {
    res = await fetch(path, {
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...options,
    })
  } catch (cause) {
    const err = new Error('请求发不出去：' + (cause && cause.message ? cause.message : cause))
    err.code = 'NETWORK'
    throw err
  }
  let data = null
  try { data = await res.json() } catch { /* 非 JSON 响应：按状态码处理 */ }
  if (!res.ok) {
    const body = (data && data.error) ? data.error : {}
    const err = new Error(body.message || ('服务返回 HTTP ' + res.status))
    err.code = body.code || ('HTTP_' + res.status)
    err.status = res.status
    throw err
  }
  return data || {}
}

/* ---------- 错误提示条 ---------- */
let bannerTimer = 0
function showError(err, context) {
  const code = (err && err.code) || 'ERROR'
  const msg = (err && err.message) || String(err)
  $('#banner-code').textContent = code
  $('#banner-msg').textContent = context ? `${context}：${msg}` : msg
  const banner = $('#banner')
  banner.hidden = false
  banner.style.animation = 'none'   // 重新触发进场动画
  void banner.offsetWidth
  banner.style.animation = ''
  window.clearTimeout(bannerTimer)
  bannerTimer = window.setTimeout(hideError, 12000)
  liveSay(`${context || '出错了'}：${msg}`)
}

function hideError() {
  window.clearTimeout(bannerTimer)
  $('#banner').hidden = true
}

/* 屏幕阅读器播报区（视觉上不可见） */
const live = el('div', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } })
function liveSay(text) {
  live.textContent = ''
  window.setTimeout(() => { live.textContent = text }, 30)
}

/* ---------- 顶栏身份 ---------- */
function renderWho() {
  const me = state.me || {}
  const name = me.display_name || me.username || '未知用户'
  $('#who-name').textContent = name
  const sub = []
  if (me.username && me.username !== name) sub.push(me.username)
  if (me.dept) sub.push(me.dept)
  if (me.is_publisher) sub.push('发布者')
  $('#who-sub').textContent = sub.join(' · ') || '已登录'
  $('#who-avatar').textContent = initialOf(name)
  $('#who').setAttribute('title',
    `${name}${me.dept ? ' · ' + me.dept : ''}${me.is_publisher ? ' · 应用发布者' : ''}`)
}

/* ---------- 版块导航 + 统计 ---------- */
function renderBoards() {
  const nav = clear($('#board-nav'))
  const total = state.boards.reduce((sum, b) => sum + (Number(b.topic_count) || 0), 0)
  nav.appendChild(boardButton({ id: '', name: '全部主题', description: '不分版块', topic_count: total }))
  for (const board of state.boards) nav.appendChild(boardButton(board))

  const stats = clear($('#stats'))
  stats.appendChild(el('div', { class: 'stats-title', text: '本站统计' }))
  const rows = [
    ['主题', state.stats ? state.stats.topics : undefined],
    ['回帖', state.stats ? state.stats.posts : undefined],
    ['我的回帖', state.stats ? state.stats.mine : undefined],
  ]
  for (const [label, value] of rows) {
    const row = el('div', { class: 'stat-row' })
    row.appendChild(el('dt', { text: label }))
    row.appendChild(el('dd', { text: state.statsAvailable && value !== undefined ? String(value) : '—' }))
    stats.appendChild(row)
  }
  if (!state.statsAvailable) {
    stats.appendChild(el('div', { class: 'stat-note', text: '宿主这次没有返回统计（显示为「—」），原因见应用日志。' }))
  }
}

function boardButton(board) {
  const active = board.id === state.board
  return el('button', {
    class: 'board-item',
    attrs: { type: 'button', 'aria-current': active ? 'true' : 'false', title: board.description || board.name },
    on: { click: () => selectBoard(board.id) },
  }, [
    el('span', { class: 'board-dot', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'board-name', text: board.name }),
    el('span', { class: 'board-count', text: String(board.topic_count || 0) }),
  ])
}

function selectBoard(id) {
  if (state.board === id && state.page === 1) return
  state.board = id
  state.page = 1
  renderBoards()
  void loadTopics({ animate: true })
}

/* ---------- 主题列表 ---------- */
function renderListTitle() {
  const board = state.boards.find((b) => b.id === state.board)
  let title = board ? board.name : '全部主题'
  if (state.q) title += ` · 搜索「${state.q}」`
  $('#list-title').textContent = title

  const count = $('#list-count')
  if (state.loadingList) {
    count.textContent = '载入中'
    count.className = 'pill'
    return
  }
  count.textContent = (state.total === null || state.total === undefined)
    ? `${state.topics.length} 个主题`
    : `共 ${state.total} 个主题`
  count.className = state.q ? 'pill pill-accent' : 'pill'
}

function renderSkeleton() {
  const list = clear($('#topic-list'))
  for (let i = 0; i < 6; i++) list.appendChild(fromTemplate('tpl-skeleton'))
  clear($('#pager'))
}

function emptyState(title, hint) {
  const frag = fromTemplate('tpl-empty')
  frag.querySelector('.empty-title').textContent = title
  frag.querySelector('.empty-hint').textContent = hint
  return frag
}

function renderTopics() {
  const list = clear($('#topic-list'))
  if (state.topics.length === 0) {
    list.appendChild(state.q
      ? emptyState('没有找到相关主题', `换个关键词试试；当前搜的是「${state.q}」。`)
      : emptyState('这里还没有主题', '点右上角「发新帖」，写下第一条。'))
    renderPager()
    return
  }
  state.topics.forEach((topic, index) => {
    list.appendChild(el('li', {}, [topicCard(topic, index)]))
  })
  renderPager()
}

function topicCard(topic, index) {
  const active = Boolean(state.topic && state.topic.id === topic.id)
  return el('button', {
    class: 'topic-card' + (topic.pinned ? ' is-pinned' : ''),
    attrs: {
      type: 'button',
      'data-topic-id': topic.id,
      'aria-current': active ? 'true' : 'false',
      style: `--i:${Math.min(index, 14)}`,
    },
    on: { click: () => openTopic(topic.id) },
  }, [
    el('span', { class: 'tc-top' }, [
      topic.pinned ? pinBadge() : null,
      state.board ? null : el('span', { class: 'badge-board', text: boardName(topic.board_id) }),
    ]),
    el('span', { class: 'tc-title', text: topic.title }),
    el('span', { class: 'tc-meta' }, [
      el('span', { class: 'm' }, [el('span', { text: whoName(topic) })]),
      el('span', { class: 'm', attrs: { title: fmtDate(topic.last_reply_at) } }, [
        icon('i-clock'), el('span', { text: relTime(topic.last_reply_at) }),
      ]),
      el('span', { class: 'tc-replies', text: `${topic.reply_count} 回复` }),
    ]),
  ])
}

/** 只同步选中态：列表卡片不重建，避免每次点开主题都重播进场动画。 */
function syncListSelection() {
  for (const card of $$('#topic-list .topic-card')) {
    const active = Boolean(state.topic && card.dataset.topicId === state.topic.id)
    card.setAttribute('aria-current', active ? 'true' : 'false')
  }
}

function pinBadge() {
  return el('span', { class: 'badge-pin', attrs: { title: '已置顶' } },
    [icon('i-pin'), el('span', { text: '置顶' })])
}

function boardName(id) {
  const found = state.boards.find((b) => b.id === id)
  return found ? found.name : id
}

function renderPager() {
  const pager = clear($('#pager'))
  if (state.page <= 1 && !state.hasMore) return

  const prev = el('button', {
    class: 'btn btn-ghost btn-sm', attrs: { type: 'button' },
    on: { click: () => gotoPage(state.page - 1) },
  }, [icon('i-back'), el('span', { text: '上一页' })])
  prev.disabled = state.page <= 1

  const next = el('button', {
    class: 'btn btn-ghost btn-sm', attrs: { type: 'button' },
    on: { click: () => gotoPage(state.page + 1) },
  }, [el('span', { text: '下一页' })])
  next.disabled = !state.hasMore

  const totalPages = (state.total === null || state.total === undefined)
    ? null : Math.max(1, Math.ceil(state.total / PAGE_SIZE))

  pager.appendChild(prev)
  pager.appendChild(next)
  pager.appendChild(el('span', {
    class: 'page-now spacer',
    text: totalPages ? `第 ${state.page} / ${totalPages} 页` : `第 ${state.page} 页`,
  }))
}

function gotoPage(page) {
  if (page < 1 || state.loadingList) return
  state.page = page
  void loadTopics({ animate: true })
}

async function loadTopics({ animate = false } = {}) {
  const list = $('#topic-list')
  // 连点两个版块时会有两次在飞的请求：只认最后发出那一次的结果，避免旧响应盖掉新列表。
  const seq = ++state.loadSeq
  if (animate) {
    list.classList.add('is-swapping')   // 先淡出
    await sleep(SWAP_MS)
  }
  state.loadingList = true
  renderListTitle()
  renderSkeleton()

  const params = new URLSearchParams()
  if (state.board) params.set('board', state.board)
  if (state.q) params.set('q', state.q)
  params.set('page', String(state.page))

  try {
    const data = await api('/api/topics?' + params.toString())
    if (seq !== state.loadSeq) return   // 已经有更新的请求了，丢弃这次
    state.topics = Array.isArray(data.topics) ? data.topics : []
    state.page = Number(data.page) || 1
    state.total = (data.total === null || data.total === undefined) ? null : Number(data.total)
    state.hasMore = Boolean(data.has_more)
  } catch (err) {
    if (seq !== state.loadSeq) return
    state.topics = []
    state.hasMore = false
    state.total = null
    showError(err, '读取主题列表失败')
  } finally {
    if (seq === state.loadSeq) {
      state.loadingList = false
      renderTopics()
      renderListTitle()
      list.classList.remove('is-swapping') // 再淡入（卡片本身还有 stagger 进场）
    }
  }
}

/* ---------- 详情与回帖 ---------- */
async function openTopic(id) {
  state.loadingDetail = true
  state.newPostId = null
  renderDetail()
  syncListSelection()
  try {
    const data = await api('/api/topics/' + encodeURIComponent(id))
    state.topic = data.topic || null
    state.posts = Array.isArray(data.posts) ? data.posts : []
    $('#layout').classList.add('show-detail')
  } catch (err) {
    state.topic = null
    state.posts = []
    showError(err, '打开主题失败')
    if (err.status === 404) void loadTopics({ animate: true })
  } finally {
    state.loadingDetail = false
    renderDetail()
    syncListSelection()
  }
}

function renderDetail() {
  const pane = clear($('#detail'))

  if (state.loadingDetail) {
    pane.appendChild(el('div', { class: 'detail-scroll' }, [
      el('div', { class: 'detail-head' }, [
        el('div', { class: 'sk', attrs: { style: 'height:18px;width:78%' } }),
        el('div', { class: 'sk', attrs: { style: 'margin-top:12px;height:10px;width:52%' } }),
      ]),
      el('div', { class: 'detail-body' }, [
        el('div', { class: 'sk', attrs: { style: 'height:12px;margin-bottom:9px' } }),
        el('div', { class: 'sk', attrs: { style: 'height:12px;width:84%;margin-bottom:9px' } }),
        el('div', { class: 'sk', attrs: { style: 'height:12px;width:62%' } }),
      ]),
    ]))
    return
  }

  if (!state.topic) {
    pane.appendChild(el('div', { class: 'detail-scroll' }, [
      emptyState('选一个主题看详情', '左边点主题卡片，正文和全部回帖会显示在这里。'),
    ]))
    return
  }

  const topic = state.topic
  const me = state.me || {}
  const canDelete = topic.author === me.username || Boolean(me.is_publisher)

  const head = el('div', { class: 'detail-head' }, [
    el('h2', { class: 'detail-title', text: topic.title }),
    el('div', { class: 'detail-meta' }, [
      topic.pinned ? pinBadge() : null,
      el('span', { class: 'badge-board', text: boardName(topic.board_id) }),
      el('span', { text: whoName(topic) }),
      el('span', { attrs: { title: fmtDate(topic.created_at) }, text: '发布于 ' + relTime(topic.created_at) }),
      el('span', { text: `${topic.reply_count} 条回帖` }),
    ]),
  ])

  const actions = el('div', { class: 'detail-actions' })
  actions.appendChild(el('button', {
    class: 'btn btn-ghost btn-sm only-narrow', attrs: { type: 'button', 'data-back': '1' },
    on: { click: () => $('#layout').classList.remove('show-detail') },
  }, [icon('i-back'), el('span', { text: '返回列表' })]))

  actions.appendChild(el('button', {
    class: 'btn btn-ghost btn-sm', attrs: { type: 'button' },
    on: { click: () => togglePin(topic) },
  }, [icon('i-pin'), el('span', { text: topic.pinned ? '取消置顶' : '置顶' })]))

  if (canDelete) {
    actions.appendChild(el('button', {
      class: 'btn btn-danger btn-sm', attrs: { type: 'button', 'data-armed': '0' },
      on: { click: (event) => onDeleteClick(event.currentTarget, topic) },
    }, [icon('i-trash'), el('span', { text: '删除主题' })]))
  }
  head.appendChild(actions)

  const scroll = el('div', { class: 'detail-scroll' }, [
    head,
    el('div', { class: 'detail-body', text: topic.body || '（没有正文）' }),
    el('div', { class: 'posts-head', text: `回帖 · ${state.posts.length}` }),
  ])
  if (state.posts.length === 0) {
    scroll.appendChild(emptyState('还没有人回帖', '做第一个回复的人吧。'))
  } else {
    for (const post of state.posts) scroll.appendChild(renderPost(post))
  }

  pane.appendChild(scroll)
  pane.appendChild(renderReplyBox())
}

function renderReplyBox() {
  const box = el('textarea', {
    attrs: {
      id: 'reply-body', rows: '3', maxlength: String(MAX_BODY),
      placeholder: '写下你的回复…（⌘/Ctrl + Enter 直接发送）',
    },
  })
  const hint = el('span', { class: 'reply-hint', text: `0 / ${MAX_BODY}` })
  box.addEventListener('input', () => {
    hint.textContent = `${Array.from(box.value).length} / ${MAX_BODY}`
  })
  box.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void submitReply()
    }
  })

  const send = el('button', {
    class: 'btn btn-primary btn-sm', attrs: { type: 'button', id: 'reply-send' },
    on: { click: () => void submitReply() },
  }, [icon('i-reply'), el('span', { text: '回复' })])

  return el('form', {
    class: 'reply', attrs: { id: 'reply-form' },
    on: { submit: (event) => { event.preventDefault(); void submitReply() } },
  }, [
    el('label', { attrs: { for: 'reply-body' }, text: '回帖' }),
    box,
    el('div', { class: 'reply-foot' }, [hint, send]),
  ])
}

function renderPost(post) {
  const isNew = Boolean(state.newPostId && post.id === state.newPostId)
  return el('article', {
    class: 'post' + (isNew ? ' is-new' : ''),
    attrs: { 'data-post-id': post.id },
  }, [
    el('div', { class: 'post-head' }, [
      el('span', { class: 'avatar-sm', attrs: { 'aria-hidden': 'true' }, text: initialOf(whoName(post)) }),
      el('span', { class: 'post-who', text: whoName(post) }),
      el('span', { class: 'post-when', attrs: { title: fmtDate(post.created_at) }, text: relTime(post.created_at) }),
    ]),
    el('div', { class: 'post-body', text: post.body }),
  ])
}

/* ---------- 动作：回帖 / 置顶 / 删除 ---------- */
function setBusy(button, busy, label) {
  if (!button) return
  button.disabled = busy
  const span = button.querySelector('span')
  if (span && label !== undefined) span.textContent = label
}

async function submitReply() {
  if (!state.topic) return
  const box = $('#reply-body')
  if (!box) return
  const body = box.value.trim()
  if (!body) {
    showError({ code: 'VALIDATION', message: '回帖内容不能为空' }, '发送失败')
    box.focus()
    return
  }

  const send = $('#reply-send')
  setBusy(send, true, '发送中…')
  try {
    const data = await api('/api/topics/' + encodeURIComponent(state.topic.id) + '/posts', {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
    if (data.topic) state.topic = data.topic
    if (data.post) {
      state.posts.push(data.post)
      state.newPostId = data.post.id
    }
    hideError()
    renderDetail()
    renderTopics() // 列表里的回复数与时间也要跟着变
    liveSay('回复已发布')

    const node = document.querySelector(`[data-post-id="${state.newPostId}"]`)
    if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // 高亮只播一次：动画结束后摘掉标记，之后的任何重渲染都不再闪
    window.setTimeout(() => { state.newPostId = null }, 2600)
    const again = $('#reply-body')
    if (again) again.focus()
  } catch (err) {
    showError(err, '发送失败')
    setBusy($('#reply-send'), false, '回复')
  }
}

async function togglePin(topic) {
  try {
    const data = await api('/api/topics/' + encodeURIComponent(topic.id) + '/pin', { method: 'POST' })
    const pinned = Boolean(data.pinned)
    if (state.topic && state.topic.id === topic.id) state.topic.pinned = pinned
    const inList = state.topics.find((t) => t.id === topic.id)
    if (inList) inList.pinned = pinned
    hideError()
    renderDetail()
    await loadTopics()
    liveSay(pinned ? '已置顶' : '已取消置顶')
  } catch (err) {
    showError(err, '置顶失败')
  }
}

/** 删除是两步的：第一次点击把按钮变成「确认删除？」，4 秒内再点才真的删。 */
function onDeleteClick(button, topic) {
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1'
    setBusy(button, false, '确认删除？')
    window.setTimeout(() => {
      if (button.isConnected && button.dataset.armed === '1') {
        button.dataset.armed = '0'
        setBusy(button, false, '删除主题')
      }
    }, 4000)
    return
  }
  button.dataset.armed = '0'
  setBusy(button, true, '删除中…')
  void deleteTopic(topic)
}

async function deleteTopic(topic) {
  try {
    const data = await api('/api/topics/' + encodeURIComponent(topic.id), { method: 'DELETE' })
    state.topic = null
    state.posts = []
    hideError()
    liveSay(`已删除主题，连带 ${data.posts_deleted || 0} 条回帖`)
    renderDetail()
    await refreshBootstrap(true)
    await loadTopics({ animate: true })
  } catch (err) {
    showError(err, '删除失败')
    renderDetail()
  }
}

/* ---------- 发新帖模态框 ---------- */
let lastFocused = null

function openModal() {
  const select = $('#f-board')
  clear(select)
  const boards = state.boards.length ? state.boards : [{ id: '', name: '（还没有版块）' }]
  for (const board of boards) {
    const attrs = { value: board.id }
    if (board.id === state.board) attrs.selected = true
    select.appendChild(el('option', { attrs, text: board.name }))
  }
  select.disabled = state.boards.length === 0
  $('#topic-form').reset()
  if (state.board) select.value = state.board
  $('#form-error').hidden = true
  updateCounter('#f-title', '#c-title', MAX_TITLE)
  updateCounter('#f-body', '#c-body', MAX_BODY)

  lastFocused = document.activeElement
  $('#modal').hidden = false
  window.setTimeout(() => $('#f-title').focus(), 60)
}

function closeModal() {
  $('#modal').hidden = true
  if (lastFocused && lastFocused.isConnected) lastFocused.focus()
}

function updateCounter(inputSel, counterSel, max) {
  const n = Array.from($(inputSel).value).length
  const counter = $(counterSel)
  counter.textContent = `${n} / ${max}`
  counter.style.color = n > max ? 'var(--danger)' : ''
}

async function submitTopic(event) {
  event.preventDefault()
  const boardId = $('#f-board').value
  const title = $('#f-title').value.trim()
  const body = $('#f-body').value.trim()
  const errBox = $('#form-error')
  const fail = (message) => {
    errBox.textContent = message
    errBox.hidden = false
    errBox.style.animation = 'none'  // 重新触发抖动
    void errBox.offsetWidth
    errBox.style.animation = ''
  }

  if (!boardId) return fail('请选择一个版块')
  if (!title) return fail('标题不能为空')
  if (Array.from(title).length > MAX_TITLE) return fail(`标题最多 ${MAX_TITLE} 个字`)
  if (!body) return fail('正文不能为空')
  if (Array.from(body).length > MAX_BODY) return fail(`正文最多 ${MAX_BODY} 个字`)

  const submit = $('#f-submit')
  submit.disabled = true
  submit.textContent = '发布中…'
  errBox.hidden = true

  try {
    const data = await api('/api/topics', {
      method: 'POST',
      body: JSON.stringify({ board_id: boardId, title, body }),
    })
    closeModal()
    hideError()
    state.q = ''
    $('#search-input').value = ''
    $('#search-clear').hidden = true
    state.board = boardId
    state.page = 1
    await refreshBootstrap(true)
    await loadTopics({ animate: true })
    if (data.topic) await openTopic(data.topic.id)
    liveSay('主题已发布')
  } catch (err) {
    fail(`${err.code || 'ERROR'}：${err.message}`)
    showError(err, '发帖失败')
  } finally {
    submit.disabled = false
    submit.textContent = '发布主题'
  }
}

/* ---------- 启动 ---------- */
async function refreshBootstrap(silent = false) {
  try {
    const data = await api('/api/bootstrap')
    state.me = data.me || null
    state.boards = Array.isArray(data.boards) ? data.boards : []
    state.stats = data.stats || null
    state.statsAvailable = data.stats_available !== false
    renderWho()
    renderBoards()
    if (!silent) hideError()
  } catch (err) {
    showError(err, '初始化失败')
    state.boards = []
    state.stats = null
    state.statsAvailable = false
    renderWho()
    renderBoards()
  }
}

function bindEvents() {
  $('#search-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const value = $('#search-input').value.trim()
    state.q = value
    state.page = 1
    $('#search-clear').hidden = value === ''
    void loadTopics({ animate: true })
  })
  $('#search-input').addEventListener('input', (event) => {
    $('#search-clear').hidden = event.target.value.trim() === ''
  })
  $('#search-clear').addEventListener('click', () => {
    $('#search-input').value = ''
    $('#search-clear').hidden = true
    state.q = ''
    state.page = 1
    void loadTopics({ animate: true })
  })

  $('#new-topic-btn').addEventListener('click', openModal)
  $('#banner-close').addEventListener('click', hideError)
  $('#topic-form').addEventListener('submit', submitTopic)
  $('#f-title').addEventListener('input', () => updateCounter('#f-title', '#c-title', MAX_TITLE))
  $('#f-body').addEventListener('input', () => updateCounter('#f-body', '#c-body', MAX_BODY))

  for (const node of $$('#modal [data-close]')) node.addEventListener('click', closeModal)

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#modal').hidden) closeModal()
      else $('#layout').classList.remove('show-detail')
      return
    }
    // 「/」聚焦搜索框（焦点不在输入控件里时）
    const tag = (event.target.tagName || '').toLowerCase()
    if (event.key === '/' && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
      event.preventDefault()
      $('#search-input').focus()
    }
  })
}

async function boot() {
  document.body.appendChild(live)
  bindEvents()
  await refreshBootstrap()
  await loadTopics({ animate: true })
  const first = state.topics[0]
  if (first) await openTopic(first.id)
}

void boot()
