/**
 * app.js —— 留言板页面脚本（vanilla JS，零依赖、零构建、无外部请求）。
 *
 * 三条纪律（这个文件就是范例）：
 *   1. **只用 `textContent` 渲染用户数据**：留言正文、账号、部门全部走 textContent，
 *      绝不 `innerHTML` 拼字符串 —— 那是 XSS 的唯一入口。静态结构放在 HTML 的
 *      `<template>` 里克隆，脚本里连一个 HTML 字符串都没有。
 *   2. **失败一律是 JSON 信封** `{"error":{"code","message"}}`：`message` 给人看，
 *      `code` 进 console 便于排障 —— 不要只说"失败了"。宿主拒绝（如 DB_DENIED）也走
 *      同一个信封，所以一套错误处理就够。
 *   3. **动效是增强不是依赖**：`prefers-reduced-motion` 下所有动画/过渡都关掉，
 *      脚本侧（FLIP、折叠）也走 `motionReduced()` 分支直接跳到终态。
 *
 * 状态全部来自接口：身份来自 `/api/me`（平台注入请求帧，页面不自己判断登录），
 * 列表来自 `/api/notes`。cookie 在应用协议下不可用，所以页面不存任何本地状态。
 */
(() => {
  'use strict'

  /** 与后端 main.go 的 bodyMaxRunes 对齐：正文按**字符**（码点）算，1–500。 */
  const MAX_CHARS = 500
  /** 一次拉多少条（后端缺省 100、上限 200）。 */
  const PAGE_LIMIT = 100
  /** 静默轮询：留言板也是共享的，别人写完自己这边过一会儿也该看到。 */
  const POLL_MS = 30000
  /** 折叠动画时长，与 app.css 的 .is-collapsing 对齐。 */
  const COLLAPSE_MS = 320
  /** 删除的二次确认窗口。 */
  const ARM_MS = 4000

  const byId = (id) => document.getElementById(id)
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const motionReduced = () => motionQuery.matches

  const dom = {
    wall: byId('wall'),
    skeleton: byId('skeleton'),
    empty: byId('empty'),
    streamError: byId('stream-error'),
    truncated: byId('truncated'),
    count: byId('stream-count'),
    form: byId('note-form'),
    body: byId('note-body'),
    submit: byId('btn-submit'),
    submitLabel: byId('btn-submit').querySelector('.primary-label'),
    counter: byId('counter'),
    meter: byId('meter'),
    meterFill: byId('meter-fill'),
    formError: byId('form-error'),
    tpl: byId('tpl-note'),
    chipUser: byId('chip-user'),
    chipAccess: byId('chip-access'),
    refresh: byId('btn-refresh'),
    live: byId('live'),
  }

  const state = {
    me: { username: '', display_name: '', dept: '', isPublisher: false },
    /** 当前列表（渲染用的规范形状）。 */
    notes: [],
    /** 上一次渲染过的 id 集合：用来判断"哪些是新来的"。 */
    known: new Set(),
    loaded: false,
    busy: false,
    timer: 0,
  }

  // ---------------------------------------------------------------------------
  // 接口
  // ---------------------------------------------------------------------------

  /**
   * 统一的 fetch + 错误处理：非 2xx 一律抛出**可直接显示**的中文消息，
   * 并把平台的错误码挂在 `error.code` 上（排障时看 console）。
   */
  async function callAPI(path, options) {
    const resp = await fetch(path, options)
    const raw = await resp.text()
    let payload = null
    try {
      payload = raw ? JSON.parse(raw) : null
    } catch (err) {
      payload = null
    }
    if (!resp.ok) {
      const info = (payload && payload.error) || {}
      const boom = new Error(info.message || `请求失败（HTTP ${resp.status}）`)
      boom.code = info.code || `HTTP_${resp.status}`
      boom.status = resp.status
      console.error('[board] 接口失败:', boom.code, info.message || '')
      throw boom
    }
    if (payload === null) {
      throw new Error('服务端返回的不是 JSON')
    }
    return payload
  }

  /** 把接口数据收敛成渲染用的形状（缺字段一律兜底，渲染层不再判空）。 */
  function normalize(raw) {
    if (!Array.isArray(raw)) return []
    return raw
      .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
      .map((item) => ({
        id: String(item.id),
        body: String(item.body ?? ''),
        author: String(item.author ?? ''),
        author_display: String(item.author_display ?? ''),
        created_at: Number(item.created_at) || 0,
        dept: String(item.dept ?? ''),
      }))
  }

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  const pad2 = (n) => String(n).padStart(2, '0')

  /** 屏幕阅读器播报（视觉动画的等价物：新留言、删除、失败都要说一声）。 */
  function announce(text) {
    // 先清空再写：内容相同时也能触发播报。
    dom.live.textContent = ''
    window.setTimeout(() => { dom.live.textContent = text }, 60)
  }

  function fmtClock(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }

  /** 相对时间（中文口语），绝对时间挂在 title 上。 */
  function fmtTime(ms) {
    if (!ms) return ''
    const date = new Date(ms)
    const diff = Date.now() - ms
    if (diff < 0) return fmtClock(date)
    if (diff < 45_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    const days = Math.floor(diff / 86_400_000)
    if (days === 1) return `昨天 ${fmtClock(date)}`
    if (days < 7) return `${days} 天前`
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${fmtClock(date)}`
  }

  function fmtFull(ms) {
    if (!ms) return ''
    const d = new Date(ms)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtClock(d)}:${pad2(d.getSeconds())}`
  }

  /** 账号 → 色相：同一个人的头像颜色稳定（纯 CSS 变量，不需要图片）。 */
  function hueOf(seed) {
    let hash = 0
    for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 360
    return hash
  }

  const initialOf = (text) => (Array.from(text)[0] || '·').toUpperCase()

  const sameUser = (a, b) => a.toLowerCase() === b.toLowerCase()

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  /** 我能删这条吗？（真正的判定在服务端，这里只决定画不画按钮） */
  function canDelete(note) {
    if (!note.author) return false
    if (state.me.isPublisher) return true
    return Boolean(state.me.username) && sameUser(note.author, state.me.username)
  }

  /** 克隆模板造一张卡片 —— 用户数据只经过 textContent。 */
  function buildCard(note) {
    const card = dom.tpl.content.firstElementChild.cloneNode(true)
    card.dataset.id = note.id

    const label = note.author_display || note.author || '（未知）'
    const avatar = card.querySelector('.avatar')
    avatar.style.setProperty('--h', String(hueOf(note.author || label)))
    avatar.textContent = initialOf(label)

    card.querySelector('.name').textContent = label

    const mine = Boolean(state.me.username) && sameUser(note.author, state.me.username)
    const metaParts = []
    if (mine) metaParts.push('我')
    if (note.author && note.author !== label) metaParts.push('@' + note.author)
    if (note.dept) metaParts.push(note.dept)
    card.querySelector('.meta').textContent = metaParts.join(' · ') || '—'
    if (mine) card.classList.add('is-mine')

    // 正文：唯一正确的渲染方式是 textContent（保留换行由 CSS 的 pre-wrap 负责）。
    card.querySelector('.body').textContent = note.body

    const time = card.querySelector('.time')
    time.dateTime = note.created_at ? new Date(note.created_at).toISOString() : ''
    time.title = fmtFull(note.created_at)
    time.textContent = fmtTime(note.created_at)

    const del = card.querySelector('.del')
    if (canDelete(note)) {
      del.hidden = false
      del.setAttribute('aria-label', `删除 ${label} 的这条留言`)
    }
    return card
  }

  /** 记录所有卡片的位置（FLIP 的 FIRST 步）。 */
  function snapshot() {
    const map = new Map()
    dom.wall.querySelectorAll('.note').forEach((node) => {
      map.set(node.dataset.id, { node, rect: node.getBoundingClientRect() })
    })
    return map
  }

  /** FLIP 的 LAST + INVERT + PLAY：位置变了的卡片从旧位置滑回新位置。 */
  function playFlip(before, after) {
    if (motionReduced()) return
    after.forEach((entry, id) => {
      const was = before.get(id)
      if (!was) return
      const dx = was.rect.left - entry.rect.left
      const dy = was.rect.top - entry.rect.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      entry.node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: 340, easing: 'cubic-bezier(.22,.61,.36,1)' },
      )
    })
  }

  function renderCount() {
    const total = state.notes.length
    dom.count.textContent = total ? `${total} 条` : '暂无'
  }

  function updateEmpty() {
    dom.empty.hidden = state.notes.length > 0
  }

  /**
   * 全量渲染。
   * @param {Array} list 规范化的留言（已按 created_at 倒序）
   * @param {{stagger?: boolean}} options stagger=true 时做首次进场的错落动画
   * @returns {Set<string>} 本次新出现的 id
   */
  function renderAll(list, options = {}) {
    const before = state.loaded ? snapshot() : null
    const fresh = new Set()
    const fragment = document.createDocumentFragment()

    list.forEach((note, index) => {
      const card = buildCard(note)
      if (options.stagger) {
        card.classList.add('is-enter')
        // 只给前 12 张错落延迟：再多就变成"等动画"而不是"看内容"。
        card.style.setProperty('--i', String(Math.min(index, 12)))
      } else if (!state.known.has(note.id)) {
        card.classList.add('is-new')
        fresh.add(note.id)
        window.setTimeout(() => card.classList.remove('is-new'), 1600)
      }
      fragment.appendChild(card)
    })

    dom.wall.replaceChildren(fragment)
    if (before) playFlip(before, snapshot())

    state.notes = list
    state.known = new Set(list.map((note) => note.id))
    renderCount()
    updateEmpty()
    return fresh
  }

  /** 新留言：插到最前面 + 滑入高亮（不重排整列）。 */
  function prependNote(note) {
    const card = buildCard(note)
    card.classList.add('is-new')
    dom.wall.insertBefore(card, dom.wall.firstElementChild)
    window.setTimeout(() => card.classList.remove('is-new'), 1600)

    state.notes.unshift(note)
    state.known.add(note.id)
    renderCount()
    updateEmpty()
  }

  /** 删除：先折叠自己（height 过渡），再 FLIP 其余卡片补位。 */
  function collapseAndRemove(card) {
    return new Promise((resolve) => {
      if (motionReduced()) {
        card.remove()
        resolve()
        return
      }
      const height = card.getBoundingClientRect().height
      card.style.height = `${height}px`
      // 下一帧再加类：让浏览器先认下"当前高度"，过渡才有起点。
      requestAnimationFrame(() => {
        card.classList.add('is-collapsing')
        window.setTimeout(() => {
          const before = snapshot()
          card.remove()
          playFlip(before, snapshot())
          resolve()
        }, COLLAPSE_MS)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // 状态显示
  // ---------------------------------------------------------------------------

  function accessLabel(config) {
    const count = Number(config && config.whitelist_count) || 0
    switch (config && config.access) {
      case 'whitelist':
        return `名单准入 · ${count} 个账号`
      case 'login':
        return '登录可用'
      case 'public':
        return '匿名可达（历史模式）'
      default:
        return `访问模式：${(config && config.access) || '未知'}`
    }
  }

  function applyMe(payload) {
    const user = payload.user || {}
    const config = payload.config || {}
    state.me = {
      username: String(user.username || ''),
      display_name: String(user.display_name || ''),
      dept: String(user.dept || ''),
      isPublisher: Boolean(user.is_publisher),
    }
    const name = state.me.display_name || state.me.username || '未知'
    dom.chipUser.textContent = name + (state.me.dept ? ` · ${state.me.dept}` : '')
    dom.chipUser.title = [
      `账号：${state.me.username || '—'}`,
      `部门：${state.me.dept || '—'}`,
      `发布者：${state.me.isPublisher ? '是' : '否'}`,
    ].join('\n')

    dom.chipAccess.textContent = accessLabel(config)
    dom.chipAccess.title = [
      `access=${config.access || '—'}`,
      `负责人：${config.owner || '—'}`,
      `名单条数：${config.whitelist_count ?? 0}`,
      `数据级别：${config.data_sensitivity || '—'}`,
    ].join('\n')
  }

  function showStreamError(message) {
    dom.streamError.textContent = message
    dom.streamError.hidden = false
  }

  function hideStreamError() {
    dom.streamError.hidden = true
  }

  function showFormError(message) {
    dom.formError.textContent = message
    dom.formError.hidden = false
  }

  function hideFormError() {
    dom.formError.hidden = true
  }

  // ---------------------------------------------------------------------------
  // 输入区：字数计数 + 计数条变色 + 发布
  // ---------------------------------------------------------------------------

  /** 与后端一致：先去掉首尾空白，再按**码点**数字符。 */
  const charCount = (text) => Array.from(text.trim()).length

  function refreshComposer() {
    const used = charCount(dom.body.value)
    const over = used > MAX_CHARS
    const percent = Math.min(100, (used / MAX_CHARS) * 100)

    dom.counter.textContent = String(used)
    dom.meterFill.style.width = `${percent}%`
    dom.meter.classList.toggle('is-warn', !over && used >= MAX_CHARS * 0.8)
    dom.meter.classList.toggle('is-over', over)

    if (over) {
      showFormError(`超出 ${used - MAX_CHARS} 字，删减后再发布。`)
    } else {
      hideFormError()
    }
    dom.submit.disabled = state.busy || used === 0 || over
  }

  async function submitNote() {
    if (state.busy) return
    const text = dom.body.value.trim()
    const used = charCount(text)
    if (used === 0 || used > MAX_CHARS) return

    state.busy = true
    refreshComposer()
    dom.submitLabel.textContent = '发布中…'
    try {
      const data = await callAPI('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
      if (data && data.note) {
        prependNote(normalize([data.note])[0])
      }
      dom.body.value = ''
      hideFormError()
      announce('已发布一条留言')
      dom.body.focus()
    } catch (err) {
      showFormError(err.message)
      announce(`发布失败：${err.message}`)
    } finally {
      state.busy = false
      dom.submitLabel.textContent = '发布'
      refreshComposer()
    }
  }

  // ---------------------------------------------------------------------------
  // 删除（作者本人或发布者；服务端还会再判一次）
  // ---------------------------------------------------------------------------

  function disarm(button) {
    button.dataset.armed = ''
    button.classList.remove('is-confirming')
    button.querySelector('.del-text').textContent = '删除'
    if (button._armTimer) {
      window.clearTimeout(button._armTimer)
      button._armTimer = 0
    }
  }

  function arm(button) {
    button.dataset.armed = '1'
    button.classList.add('is-confirming')
    button.querySelector('.del-text').textContent = '确认删除'
    announce('再点一次确认删除')
    button._armTimer = window.setTimeout(() => disarm(button), ARM_MS)
  }

  async function removeNote(id, card, button) {
    button.disabled = true
    try {
      await callAPI(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' })
      disarm(button)
      await collapseAndRemove(card)
      state.notes = state.notes.filter((note) => note.id !== id)
      state.known.delete(id)
      renderCount()
      updateEmpty()
      hideStreamError()
      announce('已删除一条留言')
    } catch (err) {
      button.disabled = false
      disarm(button)
      showStreamError(`删除失败：${err.message}（${err.code}）`)
      announce(`删除失败：${err.message}`)
    }
  }

  dom.wall.addEventListener('click', (event) => {
    const button = event.target.closest('.del')
    if (!button || button.disabled) return
    const card = button.closest('.note')
    if (!card || !card.dataset.id) return
    if (button.dataset.armed === '1') {
      removeNote(card.dataset.id, card, button)
      return
    }
    arm(button)
  })

  // ---------------------------------------------------------------------------
  // 加载 / 刷新 / 轮询
  // ---------------------------------------------------------------------------

  const sameList = (list) =>
    list.length === state.notes.length &&
    list.every((note, index) => {
      const old = state.notes[index]
      return old.id === note.id && old.body === note.body
    })

  async function refresh(options = {}) {
    if (state.busy) return
    dom.refresh.disabled = true
    dom.refresh.classList.add('is-spinning')
    try {
      const data = await callAPI(`/api/notes?limit=${PAGE_LIMIT}`)
      const list = normalize(data.notes)
      dom.truncated.hidden = !data.truncated
      hideStreamError()
      if (sameList(list)) return
      const fresh = renderAll(list)
      if (fresh.size > 0) announce(`有 ${fresh.size} 条新留言`)
      else if (!options.silent) announce('列表已是最新')
    } catch (err) {
      if (!options.silent) showStreamError(`刷新失败：${err.message}（${err.code}）`)
    } finally {
      dom.refresh.disabled = false
      dom.refresh.classList.remove('is-spinning')
    }
  }

  function startPolling() {
    if (state.timer) return
    state.timer = window.setInterval(() => {
      // 页面在后台时不打扰（应用窗口被切走时也没必要轮询）。
      if (document.visibilityState === 'visible') refresh({ silent: true })
    }, POLL_MS)
  }

  async function boot() {
    try {
      const [me, list] = await Promise.all([
        callAPI('/api/me'),
        callAPI(`/api/notes?limit=${PAGE_LIMIT}`),
      ])
      applyMe(me)
      dom.skeleton.remove()
      const notes = normalize(list.notes)
      dom.truncated.hidden = !list.truncated
      renderAll(notes, { stagger: true })
      state.loaded = true
      announce(`已加载 ${notes.length} 条留言`)
      startPolling()
    } catch (err) {
      dom.skeleton.remove()
      showStreamError(`读取失败：${err.message}（${err.code}）`)
      dom.chipUser.textContent = '读取失败'
      dom.chipAccess.textContent = '读取失败'
      announce('留言读取失败')
    } finally {
      refreshComposer()
    }
  }

  // ---------------------------------------------------------------------------
  // 事件绑定
  // ---------------------------------------------------------------------------

  dom.form.addEventListener('submit', (event) => {
    // 原生表单提交会把页面导航走（应用页还会被安全策略挡下），一律改走 fetch。
    event.preventDefault()
    submitNote()
  })

  dom.body.addEventListener('input', refreshComposer)

  dom.body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      if (!dom.submit.disabled) submitNote()
    }
  })

  dom.refresh.addEventListener('click', () => {
    refresh()
  })

  motionQuery.addEventListener('change', () => {
    // 用户在系统里切换"减少动态效果"后，按钮/卡片状态不用重算，这里只留个钩子。
    document.documentElement.dataset.reducedMotion = motionReduced() ? '1' : '0'
  })

  boot()
})()
