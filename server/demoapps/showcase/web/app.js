/* ============================================================================
   能力全集 · 演示应用前端
   ----------------------------------------------------------------------------
   约束（平台契约，改代码前先读）：
   · 零外部依赖：没有 CDN、没有框架、没有外链字体；只用浏览器原生能力；
   · 渲染一律走 textContent / createElement —— **不拼 innerHTML**（用户与平台返回的
     文本原样当文本节点，天然转义）；
   · 唯一允许的跨边界调用是客户端 AI loop：POST /__picoaide/ai/chat（本机处理，
     绝不转发平台）；其余请求都是应用自己的 /api/*；
   · Cookie 不可用、Cache Storage 不可用（见「存储边界」那一屏），要留存的放应用库。
   ========================================================================== */

'use strict'

/** 页面级状态：最后一次请求的 traces、AI 的取消句柄。 */
const state = { aiAbort: null, lastTraces: [] }

// ------------------------------------------------------------------ 小工具

const $ = (sel, root) => (root || document).querySelector(sel)
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel))
const out = (name) => $(`[data-out="${name}"]`)

/** 建元素：只设 class 与文本（文本走 textContent，不解析 HTML）。 */
function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function clear(node) {
  if (!node) return
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** 微秒 → 人类可读（<1ms 用 µs，其余用 ms）。 */
function fmtMicros(v) {
  const n = Number(v) || 0
  if (n < 1000) return `${n} µs`
  return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} ms`
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 数字滚动：把微秒数从 0 滚到目标值（reduced-motion 下直接落定）。 */
function rollMicros(node, value) {
  if (!node) return
  const target = Number(value) || 0
  if (reduced() || target === 0) {
    node.textContent = fmtMicros(target)
    return
  }
  const started = performance.now()
  const duration = 460
  const tick = (now) => {
    const k = Math.min(1, (now - started) / duration)
    const eased = 1 - Math.pow(1 - k, 3)
    node.textContent = fmtMicros(Math.round(target * eased))
    if (k < 1) window.requestAnimationFrame(tick)
  }
  window.requestAnimationFrame(tick)
}

function setStatus(kind, text) {
  const chip = $('#statusChip')
  if (!chip) return
  chip.dataset.state = kind
  chip.textContent = text
}

function stamp(name, text) {
  const node = $(`#stamp-${name}`)
  if (node) node.textContent = text
}

// ------------------------------------------------------------------ 渲染零件

/** 字段列表（服务端给的是 [{label,value,kind}]，全部字符串）。 */
function fieldsBlock(fields) {
  const wrap = el('div', 'kv')
  ;(fields || []).forEach((f, i) => {
    const row = el('div', 'kvRow')
    row.style.setProperty('--i', String(i))
    row.appendChild(el('span', 'kvK', f.label))
    row.appendChild(el('span', 'kvV' + (f.kind ? ` ${f.kind}` : ''), f.value === '' ? '（空）' : f.value))
    wrap.appendChild(row)
  })
  return wrap
}

/** 数据表。 */
function tableBlock(table) {
  const wrap = el('div', 'tableWrap')
  if (table.title) wrap.appendChild(el('div', 'tableTitle', table.title))
  const scroll = el('div', 'tableScroll')
  const t = el('table', 'data')
  const thead = el('thead')
  const htr = el('tr')
  ;(table.columns || []).forEach((c) => htr.appendChild(el('th', null, c)))
  thead.appendChild(htr)
  t.appendChild(thead)
  const tbody = el('tbody')
  ;(table.rows || []).forEach((row, i) => {
    const tr = el('tr')
    tr.style.setProperty('--i', String(i))
    row.forEach((cell) => tr.appendChild(el('td', null, cell === '' ? '（空）' : cell)))
    tbody.appendChild(tr)
  })
  t.appendChild(tbody)
  scroll.appendChild(t)
  wrap.appendChild(scroll)
  if (table.note) wrap.appendChild(el('div', 'tableNote', table.note))
  return wrap
}

/** 错误块：平台回的 code / message / details / hints 原样渲染。 */
function errorBlock(err) {
  const box = el('div', 'err')
  const head = el('div', 'errHead')
  head.appendChild(el('span', 'errCode', err.code || 'ERROR'))
  if (err.method) head.appendChild(el('span', 'errMethod', `来自 ${err.method}`))
  box.appendChild(head)
  box.appendChild(el('p', 'errMsg', err.message || ''))
  if (err.hints && err.hints.length) {
    box.appendChild(el('div', 'hintsTitle', '平台给的下一步（hints）'))
    const ul = el('ul', 'hints')
    err.hints.forEach((h) => ul.appendChild(el('li', 'hintItem', h)))
    box.appendChild(ul)
  }
  if (err.json) {
    const fold = el('details', 'fold')
    fold.appendChild(el('summary', null, 'details（原样 JSON）'))
    fold.appendChild(el('pre', 'pre', err.json))
    box.appendChild(fold)
  }
  return box
}

/** 一个能力步骤。 */
function stepBlock(step, index) {
  const box = el('div', 'step' + (step.ok ? '' : ' bad'))
  box.style.setProperty('--i', String(index))

  const head = el('div', 'stepHead')
  head.appendChild(el('span', 'badge ' + (step.ok ? 'ok' : 'bad'), step.ok ? '成功' : '失败'))
  head.appendChild(el('span', 'stepTitle', step.title))
  const micros = el('span', 'stepMicros', '')
  head.appendChild(micros)
  rollMicros(micros, step.micros)
  box.appendChild(head)

  if (step.note) box.appendChild(el('p', 'stepNote', step.note))
  if (step.error) box.appendChild(errorBlock(step.error))
  if (step.fields && step.fields.length) box.appendChild(fieldsBlock(step.fields))
  ;(step.tables || []).forEach((t) => box.appendChild(tableBlock(t)))
  return box
}

function noteLine(text) {
  return el('p', 'noteLine', text)
}

/** 把若干步骤渲染进某个结果区。 */
function renderSteps(target, steps) {
  const host = out(target)
  if (!host) return
  clear(host)
  ;(steps || []).forEach((s, i) => host.appendChild(stepBlock(s, i)))
}

/** 能力时间线（本次请求真实发生的宿主调用）。 */
function renderTraces(traces) {
  if (Array.isArray(traces)) state.lastTraces = traces
  const list = out('timeline')
  const summary = out('traceSummary')
  if (!list || !summary) return
  clear(list)
  clear(summary)
  const all = traces || []
  const okCount = all.filter((t) => t.ok).length
  const total = all.reduce((sum, t) => sum + (Number(t.micros) || 0), 0)

  const stats = el('div', 'stats')
  const add = (num, label) => {
    const s = el('div', 'stat')
    const n = el('span', 'statNum', '')
    n.textContent = String(num)
    s.appendChild(n)
    s.appendChild(el('span', 'statLabel', label))
    stats.appendChild(s)
  }
  add(all.length, '宿主调用')
  add(okCount, '成功')
  add(all.length - okCount, '被拒')
  const totalNode = el('div', 'stat')
  const tn = el('span', 'statNum', '')
  totalNode.appendChild(tn)
  totalNode.appendChild(el('span', 'statLabel', '总耗时'))
  rollMicros(tn, total)
  stats.appendChild(totalNode)
  summary.appendChild(stats)

  if (all.length === 0) {
    summary.appendChild(noteLine('这次请求一次宿主调用都没发生。'))
    return
  }
  all.forEach((t, i) => {
    const li = el('li', 'trItem' + (t.ok ? '' : ' bad'))
    li.style.setProperty('--i', String(i))
    const top = el('div', 'trTop')
    top.appendChild(el('span', 'badge ' + (t.ok ? 'ok' : 'bad'), t.ok ? 'OK' : '拒绝'))
    top.appendChild(el('span', 'trMethod', t.method))
    const m = el('span', 'trMicros', '')
    top.appendChild(m)
    rollMicros(m, t.micros)
    li.appendChild(top)
    if (t.note) li.appendChild(el('div', 'trNote', t.note))
    list.appendChild(li)
  })
}

/** 在某个结果区显示一个请求级错误（含平台信封）。 */
function renderRequestError(target, error) {
  const host = out(target)
  if (!host) return
  clear(host)
  host.appendChild(
    errorBlock({
      code: error.code || 'REQUEST_FAILED',
      method: error.status ? `HTTP ${error.status}` : '',
      message: error.message || String(error),
    }),
  )
}

// ------------------------------------------------------------------ 请求

async function api(path, options) {
  const opts = options || {}
  const init = {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {},
  }
  if (opts.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(opts.body)
  }
  const res = await fetch(path, init)
  const text = await res.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch (err) {
      payload = null
    }
  }
  if (!res.ok) {
    const envelope = payload && payload.error ? payload.error : null
    const failure = new Error(envelope ? envelope.message : text.slice(0, 300) || `HTTP ${res.status}`)
    failure.code = envelope ? envelope.code : `HTTP_${res.status}`
    failure.status = res.status
    throw failure
  }
  return payload
}

/** 通用骨架：请求期间在目标区放骨架屏。 */
function showSkeleton(target, rows) {
  const host = out(target)
  if (!host) return
  clear(host)
  for (let i = 0; i < (rows || 3); i++) {
    host.appendChild(el('span', 'skeleton skeleton-row'))
  }
}

// ------------------------------------------------------------------ 业务动作

/** 01/02：身份注入 + 访问模式。 */
async function loadWhoami(options) {
  const opts = options || {}
  if (!opts.silent) showSkeleton('identity', 4)
  setStatus('running', '读取身份…')
  try {
    const data = await api('/api/whoami')
    const idHost = out('identity')
    clear(idHost)
    idHost.appendChild(el('div', 'tableTitle', 'user（来自请求帧，应用没有登录逻辑）'))
    idHost.appendChild(
      fieldsBlock([
        { label: 'user.id', value: data.identity.id, kind: 'mono' },
        { label: 'user.username', value: data.identity.username, kind: 'mono' },
        { label: 'user.display_name', value: data.identity.display_name },
        { label: 'user.dept', value: data.identity.dept },
        { label: 'user.is_publisher', value: data.identity.is_publisher },
        { label: 'auth.mode / verified', value: `${data.frame.auth_mode} / ${data.frame.auth_verified}`, kind: 'mono' },
        { label: '帧里的 headers', value: (data.frame.header_keys || []).join(', ') || '（无）', kind: 'mono' },
        { label: '帧里有没有 Cookie', value: data.frame.cookie_header },
      ]),
    )
    idHost.appendChild(
      fieldsBlock([
        { label: 'abi / app_id', value: `${data.frame.abi} · ${data.frame.app_id}`, kind: 'mono' },
        { label: '应用版本', value: data.frame.version, kind: 'mono' },
        { label: '本次请求', value: `${data.frame.method} ${data.frame.path}`, kind: 'mono' },
        { label: '请求体字节数', value: data.frame.body_bytes, kind: 'mono' },
      ]),
    )

    const accessHost = out('access')
    clear(accessHost)
    accessHost.appendChild(
      fieldsBlock([
        { label: '配置里的 access', value: data.config.access, kind: 'mono' },
        { label: '名单条数', value: String(data.config.whitelist_count), kind: 'mono' },
        { label: '名单内容', value: (data.config.whitelist || []).join(', ') || '（空）', kind: 'mono' },
        { label: 'purpose', value: data.config.purpose },
        { label: 'data_sensitivity', value: data.config.data_sensitivity },
        { label: 'owner', value: data.config.owner },
        { label: '本次准入判定', value: (data.access.allowed ? '放行' : '拒绝') + (data.access.reason ? ` · ${data.access.reason}` : ''), kind: data.access.allowed ? 'ok' : 'bad' },
        { label: '判定说明', value: data.access.note },
      ]),
    )
    const assetFields = [
      { label: '保留资源 content_type', value: data.config_asset.content_type, kind: 'mono' },
      { label: '保留资源 size', value: `${data.config_asset.size} 字节`, kind: 'mono' },
      { label: '保留资源 encoding', value: data.config_asset.encoding, kind: 'mono' },
      { label: 'picoaide.app.json 原文' + (data.config.raw_truncated ? '（已截断）' : ''), value: data.config.raw, kind: 'code' },
    ]
    accessHost.appendChild(fieldsBlock(assetFields))
    if (data.config_asset.error) accessHost.appendChild(errorBlock(data.config_asset.error))

    renderTraces(data.traces)
    const ok = data.access.allowed
    setStatus(ok ? 'ok' : 'err', ok ? '身份已就绪' : '准入被拒')
    stamp('whoami', `刚刚 · 帧内身份 ${data.identity.username}`)
    updateFoot(`GET /api/whoami · 宿主调用 ${(data.traces || []).length} 次`)
  } catch (error) {
    renderRequestError('identity', error)
    setStatus('err', '读取身份失败')
  }
}

/** 03~07：跑一遍全部能力。 */
async function runAll() {
  const card = out('define')
  clear(card)
  card.appendChild(noteLine('正在跑：建表 → 写入 → 查询 → 事务提交 → 事务回滚 → 日志 → 包内资源 …'))
  showSkeleton('crud', 2)
  setStatus('running', '跑全部能力…')
  try {
    const data = await api('/api/run', { method: 'POST', body: {} })
    const pick = (keys) => (data.steps || []).filter((s) => keys.indexOf(s.key) >= 0)
    renderSteps('define', pick(['define']))
    renderSteps('crud', pick(['insert', 'select']))
    renderSteps('tx', pick(['tx_commit', 'tx_rollback']))
    renderSteps('log', pick(['log']))
    renderSteps('assets', pick(['asset_entry', 'asset_config']))
    renderSteps('history', pick(['history']))
    renderTraces(data.traces)

    const failed = (data.steps || []).filter((s) => !s.ok).length
    setStatus(failed === 0 ? 'ok' : 'err', failed === 0 ? '全部能力跑通' : `${failed} 步被拒（看详情）`)
    stamp('run', `marker ${data.marker} · 总耗时 ${fmtMicros(data.total_micros)}`)
    stamp('log', '本次运行已写日志')
    updateFoot(`POST /api/run · marker ${data.marker} · 宿主调用 ${(data.traces || []).length} 次 · ${fmtMicros(data.total_micros)}`)
  } catch (error) {
    renderRequestError('define', error)
    renderRequestError('crud', error)
    setStatus('err', '运行失败')
  }
}

/** 05 的按钮：只跑事务（提交 / 回滚）。 */
async function runTx(mode) {
  showSkeleton('tx', 2)
  setStatus('running', mode === 'commit' ? '提交事务…' : '回滚事务…')
  try {
    const data = await api('/api/tx', { method: 'POST', body: { mode } })
    renderSteps('tx', data.steps || [])
    renderTraces(data.traces)
    const okMode = mode === 'commit' ? data.visible_rows === 2 : data.visible_rows === 0
    setStatus(okMode ? 'ok' : 'err', data.verdict)
    updateFoot(`POST /api/tx (${mode}) · 写入 ${data.affected} 条 · 库里可见 ${data.visible_rows} 条`)
  } catch (error) {
    renderRequestError('tx', error)
    setStatus('err', '事务演示失败')
  }
}

/** 06 的按钮：写一条日志。 */
async function writeLog() {
  showSkeleton('log', 2)
  setStatus('running', '写日志…')
  try {
    const data = await api('/api/log', { method: 'POST', body: { message: '页面按钮触发：' + new Date().toLocaleString('zh-CN') } })
    renderSteps('log', data.steps || [])
    renderTraces(data.traces)
    setStatus('ok', '日志已写入')
    stamp('log', '刚刚')
    updateFoot(`POST /api/log · 写入 ${data.message.length} 字符`)
  } catch (error) {
    renderRequestError('log', error)
    setStatus('err', '写日志失败')
  }
}

/** 11：读历史。 */
async function loadRuns() {
  showSkeleton('history', 3)
  setStatus('running', '读历史…')
  try {
    const data = await api('/api/runs?limit=20')
    const host = out('history')
    clear(host)
    host.appendChild(tableBlock(data.table))
    host.appendChild(noteLine(data.note))
    renderTraces(data.traces)
    setStatus('ok', `历史 ${data.row_count} 行`)
    stamp('runs', `最近 ${data.row_count} 行`)
    updateFoot(`GET /api/runs · 返回 ${data.row_count} 行 · 截断 ${data.truncated ? '是' : '否'}`)
  } catch (error) {
    renderRequestError('history', error)
    setStatus('err', '读历史失败')
  }
}

/** 07 的补充：宿主直出 vs 交给 wasm。 */
async function checkStatic(path) {
  const host = out('static')
  clear(host)
  host.appendChild(el('span', 'skeleton skeleton-block'))
  const started = performance.now()
  let res = null
  let text = ''
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
    text = await res.text()
  } catch (error) {
    clear(host)
    host.appendChild(noteLine(`请求失败：${error.message}`))
    return
  }
  const ms = Math.round(performance.now() - started)
  const etag = res.headers.get('etag')
  // 谁答的？两条判据都是硬判据：
  //   · 响应体是应用自己的错误信封 ⇒ 一定走了 wasm（宿主直出不会产生它）；
  //   · 响应带 ETag ⇒ 一定是宿主直出（应用的响应头白名单里只有 content-type /
  //     cache-control / content-disposition / x-content-type-options，根本没有 etag）。
  let envelope = null
  try {
    const parsed = JSON.parse(text)
    if (parsed && parsed.error && typeof parsed.error.code === 'string') envelope = parsed.error
  } catch (err) {
    envelope = null
  }
  let verdict = '静态资源（宿主直出，本次响应没有 ETag）'
  let clue = '响应体不是应用的信封，content-type 与扩展名一致；线上这一条还会带强 ETag（本地假宿主没写）'
  let verdictKind = 'ok'
  if (envelope) {
    verdict = '交给 wasm（应用自己答）'
    clue = `响应体是应用自己的错误信封 ${envelope.code}；包内没有这个资源时宿主会把请求交给应用`
    verdictKind = 'mono'
  } else if (etag) {
    verdict = '宿主直出（不执行 wasm）'
    clue = `响应带强 ETag ${etag}；应用的响应头白名单里没有 etag，所以它只可能来自宿主`
  }
  clear(host)
  host.appendChild(
    fieldsBlock([
      { label: '请求路径', value: path, kind: 'mono' },
      { label: '谁答的', value: verdict, kind: verdictKind },
      { label: '判据', value: clue },
      { label: 'HTTP 状态', value: String(res.status), kind: 'mono' },
      { label: 'content-type', value: res.headers.get('content-type') || '（无）', kind: 'mono' },
      { label: 'content-length', value: res.headers.get('content-length') || '（无）', kind: 'mono' },
      { label: 'cache-control', value: res.headers.get('cache-control') || '（无）', kind: 'mono' },
      { label: '响应体字节数', value: String(new TextEncoder().encode(text).length), kind: 'mono' },
      { label: '往返耗时', value: `${ms} ms`, kind: 'mono' },
    ]),
  )
  if (envelope) {
    host.appendChild(errorBlock({ code: envelope.code, method: 'wasm 应用', message: envelope.message }))
  }
  updateFoot(`GET ${path} → ${res.status} · ${verdict}`)
}

// ------------------------------------------------------------------ 08 被拒的样子

async function loadVariants() {
  const chips = $('#variantChips')
  try {
    const data = await api('/api/denied')
    clear(chips)
    ;(data.variants || []).forEach((v, i) => {
      const btn = el('button', 'chip', v.title)
      btn.type = 'button'
      btn.dataset.kind = v.kind
      btn.title = v.why
      btn.addEventListener('click', () => triggerDenied(v.kind))
      if (i === 0) btn.classList.add('on')
      chips.appendChild(btn)
    })
  } catch (error) {
    clear(chips)
    chips.appendChild(noteLine(`违规形态清单读不到：${error.message}`))
  }
}

async function triggerDenied(kind) {
  $$('#variantChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.kind === kind))
  showSkeleton('denied', 3)
  setStatus('running', '触发一次故意违规…')
  try {
    const data = await api('/api/denied', { method: 'POST', body: { kind } })
    const host = out('denied')
    clear(host)
    const head = el('div', 'stepHead')
    head.appendChild(el('span', 'badge ' + (data.matches_expected ? 'ok' : 'warn'), data.matches_expected ? '与文档一致' : '与文档不一致'))
    head.appendChild(el('span', 'stepTitle', data.title))
    host.appendChild(head)
    host.appendChild(noteLine(`本次调用：${data.call}`))
    host.appendChild(
      fieldsBlock([
        { label: '为什么会被拒', value: data.why },
        { label: '文档预期 code', value: data.expected_code, kind: 'mono' },
        { label: '本次实际', value: `${data.actual.denied ? '被拒' : '没有被拒'} · ${data.actual.code}`, kind: data.actual.denied ? 'mono' : 'bad' },
        { label: '实际 message', value: data.actual.message },
      ]),
    )
    if (data.error) {
      host.appendChild(errorBlock(data.error))
    } else {
      host.appendChild(noteLine('宿主没有拒绝这次调用（本地预览宿主的闸门比平台窄；真实平台会按文档拒绝）。'))
    }
    const fold = el('details', 'fold')
    fold.appendChild(el('summary', null, '宿主回的错误信封（原样 JSON-RPC）'))
    fold.appendChild(el('pre', 'pre', data.envelope))
    host.appendChild(fold)
    host.appendChild(noteLine(data.note))
    renderTraces(data.traces)
    setStatus(data.matches_expected ? 'ok' : 'err', data.matches_expected ? '平台按文档拒绝了' : '本次没有被拒')
    updateFoot(`POST /api/denied (${kind}) · ${data.actual.code}`)
  } catch (error) {
    renderRequestError('denied', error)
    setStatus('err', '触发失败')
  }
}

// ------------------------------------------------------------------ 09 客户端 AI

const AI_CODES = [
  ['app_ai_denied', '403', '使用者尚未授权（或已撤销）⇒ 引导他打开应用详情页的 AI 面板点授权；未授权不消耗任何 token'],
  ['app_ai_unavailable', '503 / 401', '客户端 AI 不可用 / 未登录 ⇒ 提示稍后重试，不要绕回 wasm 自己实现'],
  ['app_ai_invalid', '400 / 405 / 413', '请求体不合法、方法不是 POST、或请求体过大 ⇒ 修请求（messages ≤64 条、单条 ≤16 KiB）'],
  ['ai_balance_insufficient', '402', '使用者余额不足 ⇒ 提示他去看余额，不显示金额、不要重试'],
  ['ai_rate_limited', '429', '上游限流 ⇒ 稍后重试，不要在循环里猛调'],
  ['ai_cancelled', '499', '页面关闭或主动取消 ⇒ 正常收尾，不是故障'],
  ['app_ai_transport', '—（客户端侧）', '请求根本没到宿主（本机协议层异常）'],
  ['app_ai_protocol', '—（客户端侧）', '响应/帧形状不是契约承诺的那一个（含没有 done 收尾）'],
]

function aiHint(code) {
  const row = AI_CODES.find((c) => c[0] === code)
  if (row) return row[2]
  return '客户端回了契约之外的错误码，已原样显示（请按 message 排障）。'
}

function renderAiCodes() {
  const host = $('#aiCodes')
  if (!host) return
  clear(host)
  AI_CODES.forEach((row) => {
    const line = el('div', 'codeRow')
    line.appendChild(el('span', 'errCode', row[0]))
    line.appendChild(el('span', null, `${row[1]} · ${row[2]}`))
    host.appendChild(line)
  })
}

function bubble(who, text, kind) {
  const box = el('div', 'bubble' + (kind ? ` ${kind}` : ''))
  box.appendChild(el('span', 'who', who))
  const body = el('div', 'body', text || '')
  box.appendChild(body)
  return box
}

/** 解析一个 SSE 帧（event: / data: 行）—— 与客户端 app-ai 的读法同源。 */
function parseFrame(frame) {
  let event = 'message'
  const data = []
  frame.split(/\r?\n/).forEach((line) => {
    if (line === '' || line.charAt(0) === ':') return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  })
  if (data.length === 0) return event === 'done' ? { type: 'done' } : { type: 'ignore' }
  let payload = null
  try {
    payload = JSON.parse(data.join('\n'))
  } catch (err) {
    return { type: 'error', failure: { code: 'app_ai_protocol', message: 'SSE 帧不是合法 JSON' } }
  }
  if (event === 'delta') {
    const delta = payload ? payload.delta : null
    if (typeof delta !== 'string') return { type: 'error', failure: { code: 'app_ai_protocol', message: 'delta 帧缺少字符串 delta' } }
    return { type: 'delta', delta }
  }
  if (event === 'done') return { type: 'done' }
  if (event === 'error') {
    const nested = payload && typeof payload.error === 'object' && payload.error ? payload.error : payload
    return {
      type: 'error',
      failure: {
        code: (nested && nested.code) || 'app_ai_protocol',
        message: (nested && nested.message) || '错误帧没有可识别的信封',
      },
    }
  }
  return { type: 'ignore' }
}

function frameBoundary(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

async function askAi() {
  const input = $('#aiPrompt')
  const host = out('ai')
  const question = (input.value || '').trim()
  clear(host)
  if (question === '') {
    host.appendChild(noteLine('先写一句话再发送。'))
    input.focus()
    return
  }
  host.appendChild(bubble('我', question, 'me'))
  const reply = bubble('AI', '', 'ai')
  const body = $('.body', reply)
  host.appendChild(reply)

  const controller = new AbortController()
  state.aiAbort = controller
  $('#btnAi').disabled = true
  $('#btnAiStop').hidden = false
  setStatus('running', 'AI 正在回答…')

  let full = ''
  let shown = 0
  let pumpHandle = null
  let caret = el('span', 'caret')
  body.appendChild(caret)
  const paint = () => {
    if (reduced()) {
      body.textContent = full
      return
    }
    if (shown < full.length) {
      const stride = Math.max(1, Math.round((full.length - shown) / 10))
      shown = Math.min(full.length, shown + stride)
    }
    body.textContent = full.slice(0, shown)
    if (shown < full.length) {
      pumpHandle = window.requestAnimationFrame(paint)
    } else {
      pumpHandle = null
      body.appendChild(caret)
    }
  }

  const finish = (errorInfo) => {
    if (pumpHandle) window.cancelAnimationFrame(pumpHandle)
    pumpHandle = null
    shown = full.length
    body.textContent = full
    $('#btnAi').disabled = false
    $('#btnAiStop').hidden = true
    if (caret.parentNode) caret.parentNode.removeChild(caret)
    if (errorInfo) {
      host.appendChild(
        errorBlock({
          code: errorInfo.code,
          method: '客户端 AI loop（/__picoaide/ai/chat）',
          message: errorInfo.message,
          hints: [aiHint(errorInfo.code)],
        }),
      )
      const benign = errorInfo.code === 'ai_cancelled'
      setStatus(benign ? 'ok' : 'err', benign ? '这一轮已取消（正常收尾）' : `AI 失败：${errorInfo.code}`)
    } else {
      setStatus('ok', 'AI 回答完成')
    }
    updateFoot(`POST /__picoaide/ai/chat · ${errorInfo ? errorInfo.code : 'done'} · ${full.length} 字`)
  }

  try {
    const res = await fetch('/__picoaide/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ messages: [{ role: 'user', content: question }], stream: true }),
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (!res.ok) {
      let payload = null
      const text = await res.text()
      try {
        payload = JSON.parse(text)
      } catch (err) {
        payload = null
      }
      const nested = payload && payload.error ? payload.error : payload
      finish({
        code: (nested && nested.code) || `HTTP_${res.status}`,
        message: (nested && nested.message) || text.slice(0, 300) || `HTTP ${res.status}`,
      })
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      for (;;) {
        const at = frameBoundary(buffer)
        if (at === -1) break
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at).replace(/^(\r?\n){1,2}/, '')
        const event = parseFrame(frame)
        if (event.type === 'delta') {
          full += event.delta
          if (reduced()) {
            body.textContent = full
            body.appendChild(caret)
          } else if (pumpHandle === null) {
            if (caret.parentNode) caret.parentNode.removeChild(caret)
            pumpHandle = window.requestAnimationFrame(paint)
          }
        } else if (event.type === 'error') {
          done = true
          reader.cancel().catch(() => undefined)
          finish(event.failure)
          return
        } else if (event.type === 'done') {
          done = true
        }
      }
      if (done) break
    }
    reader.cancel().catch(() => undefined)
    if (!done) {
      finish({ code: 'app_ai_protocol', message: '流在没有 done 事件的情况下结束（不当作正常回复）' })
      return
    }
    finish(null)
  } catch (error) {
    const aborted = error && error.name === 'AbortError'
    finish(
      aborted
        ? { code: 'ai_cancelled', message: '这一轮被取消（页面关闭或用户点了停止）' }
        : { code: 'app_ai_transport', message: `本机 AI 桥不可达：${error && error.message ? error.message : String(error)}` },
    )
  } finally {
    state.aiAbort = null
  }
}

// ------------------------------------------------------------------ 页面骨架

function updateFoot(text) {
  const node = $('#footMeta')
  if (node) node.textContent = text
}

function setupCards() {
  const scroller = $('#scroller')
  if (!scroller) return
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in')
          io.unobserve(entry.target)
        }
      })
    },
    { root: scroller, threshold: 0.06 },
  )
  $$('.card', scroller).forEach((card, i) => {
    card.style.setProperty('--d', `${(i % 5) * 55}ms`)
    io.observe(card)
  })
}

function setupSpy() {
  const scroller = $('#scroller')
  const links = $$('#segs .seg')
  if (!scroller || links.length === 0) return
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]))
  const spy = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        links.forEach((a) => a.classList.remove('on'))
        const link = byId.get(entry.target.id)
        if (link) {
          link.classList.add('on')
          link.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduced() ? 'auto' : 'smooth' })
        }
      })
    },
    { root: scroller, rootMargin: '-42% 0px -52% 0px' },
  )
  $$('section.card', scroller).forEach((section) => spy.observe(section))
  links.forEach((a) => {
    a.addEventListener('click', (event) => {
      event.preventDefault()
      const target = document.getElementById(a.getAttribute('href').slice(1))
      if (target) target.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' })
    })
  })
}

function setupActions() {
  $$('[data-act]').forEach((node) => {
    const act = node.dataset.act
    if (act === 'ai' || act === 'ai-stop') return
    node.addEventListener('click', () => {
      if (act === 'whoami') loadWhoami()
      else if (act === 'run') runAll()
      else if (act === 'tx') runTx(node.dataset.mode)
      else if (act === 'log') writeLog()
      else if (act === 'runs') loadRuns()
      else if (act === 'static') checkStatic(node.dataset.static)
    })
  })
  const aiBtn = $('#btnAi')
  if (aiBtn) aiBtn.addEventListener('click', askAi)
  const stopBtn = $('#btnAiStop')
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      if (state.aiAbort) state.aiAbort.abort()
    })
  }
  const input = $('#aiPrompt')
  if (input) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) askAi()
    })
  }
}

function seedEmptyStates() {
  const hints = {
    crud: '点上面或底部的「跑一遍全部能力」，这里会显示 db.exec 写入与 db.query 读回的真实结果。',
    tx: '点「提交」或「回滚」：两个按钮都会在事务里写两条，然后用库里的数据证明结果。',
    log: '点「写一条日志」，这里会显示平台接受的条数与被丢弃的条数。',
    assets: '点「跑一遍全部能力」，这里会显示 assets.read 的 content_type / size / encoding。',
    history: '点「刷新历史」，读应用库里的真实数据。',
  }
  Object.keys(hints).forEach((key) => {
    const host = out(key)
    if (host && host.childElementCount === 0) host.appendChild(noteLine(hints[key]))
  })
  const tl = out('timeline')
  if (tl && tl.childElementCount === 0) tl.appendChild(el('li', 'trNote', '还没有请求 —— 每次请求后这里会列出真实的宿主调用。'))
}

function boot() {
  setupCards()
  setupSpy()
  setupActions()
  renderAiCodes()
  seedEmptyStates()
  // 首屏：把身份、访问模式、违规形态清单、时间线填上（其余留给按钮，方便演示时逐个点）。
  loadWhoami()
  loadVariants()
  updateFoot('已就绪：点「跑一遍全部能力」开始')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
