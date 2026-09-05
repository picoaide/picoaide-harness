import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ApiError, AuthError, assertServerURLAllowed, changePassword, fetchJSON, gatewayFetch, login, normalizeServerURL } from './server-connector/auth.ts'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import {
  computeSkillContentHash,
  installSkillArchive,
  listInstalledSkills,
  listLocalSkills,
  packSkill,
  readProvenance,
  resolveSkillsDir,
  uninstallSkill,
  validateSkillName,
} from './skill-install.ts'
import { MAX_ARCHIVE_BYTES } from './archive-util.ts'
import type { Session } from './server-connector/config.ts'

/** 上传 body 上限(审计 2026-08-25 P2-2):本地 upload body 实际只含元数据
 * (archive 由 pack 后经 fetchJSON 出站);24MB 与服务端 MaxBodyBytes 对齐,
 * 未来若改为经本地 body 转发归档亦兼容 —— 非 base64 膨胀的实际需求。 */
const UPLOAD_BODY_BYTES = 24 * 1024 * 1024
import {
  installPresetArchive,
  listInstalledPresets,
  listLocalPresets,
  mapLocalPresets,
  packPreset,
  resolvePresetsDir,
  uninstallPreset,
  validatePresetId,
} from './agent-preset-install.ts'

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PicoAide 登录</title>
<style>
  :root {
    --bg: #ffffff;
    --fg: #1a1d24;
    --input-bg: #ffffff;
    --border: #d0d5dd;
    --err: #dc2626;
    --accent: #2563eb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --fg: #e6e6e6;
      --input-bg: #1a1d24;
      --border: #333333;
      --err: #f87171;
      --accent: #3b82f6;
    }
  }
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: var(--bg); color: var(--fg); }
  .card { width: 400px; max-width: 92vw; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 6px; font-weight: 700; }
  .tagline { font-size: 13px; color: var(--fg); opacity: 0.65; margin-bottom: 22px; }
  .stage { display: none; }
  .stage.active { display: block; }
  form { display: flex; flex-direction: column; gap: 12px; }
  input { padding: 11px 13px; border-radius: 9px; border: 1px solid var(--border); background: var(--input-bg); color: var(--fg); font-size: 14px; box-sizing: border-box; width: 100%; }
  button { padding: 11px; border-radius: 9px; border: none; background: var(--accent); color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
  button:disabled { opacity: 0.6; cursor: default; }
  .err { color: var(--err); font-size: 13px; min-height: 18px; margin-top: 4px; text-align: left; }
  .hint { color: var(--fg); opacity: 0.7; font-size: 12px; margin-top: 8px; }
  .back { background: transparent; color: var(--accent); border: none; font-size: 12px; cursor: pointer; padding: 6px 12px; margin: 0 0 14px; width: auto; }
  /* Step2 品牌区 */
  .brand { margin-bottom: 18px; min-height: 92px; }
  .brand img, .brand .fallback { width: 64px; height: 64px; border-radius: 14px; object-fit: contain; margin-bottom: 8px; }
  .brand .fallback { display: inline-flex; align-items: center; justify-content: center; background: #0f1115; color: #fff; font-size: 28px; font-weight: 700; }
  .brand-name { font-size: 20px; font-weight: 700; }
  .brand-tag { font-size: 12px; color: var(--fg); opacity: 0.6; }
  .welcome { font-size: 13px; margin-top: 6px; white-space: pre-wrap; }
  /* 方式选择器 */
  .methods { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-bottom: 14px; }
  .method { background: transparent; border: 1px solid var(--border); color: var(--fg); font-size: 13px; padding: 8px 14px; border-radius: 8px; width: auto; font-weight: 500; }
  .method.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .method.disabled { opacity: 0.45; cursor: not-allowed; }
  .pw-fields .spacer { opacity: 0; }
</style>
</head>
<body>
<div class="card">
  <!-- Step 1: 服务端地址 -->
  <div id="step1" class="stage active">
    <h1>连接服务端</h1>
    <div class="tagline">输入服务端地址以确认登录方式</div>
    <form id="f1">
      <input id="server" type="url" placeholder="https://ai.example.com" value="__DEFAULT_SERVER__" autocomplete="off" spellcheck="false" required>
      <button type="submit" id="next-btn">下一步</button>
      <div class="err" id="err-step1"></div>
    </form>
  </div>

  <!-- Step 2: 品牌 + 登录方式 -->
  <div id="step2" class="stage">
    <button type="button" class="back" id="back-btn">← 修改服务端地址</button>
    <div class="brand" id="brand-area"></div>
    <div id="methods" class="methods"></div>
    <form id="f2" style="display:none">
      <input id="username" placeholder="账号" autocomplete="username" style="display:none">
      <input id="password" type="password" placeholder="密码" autocomplete="current-password" style="display:none">
      <button type="submit" id="btn" style="display:none">登录</button>
    </form>
    <button type="button" id="browser-btn" style="display:none">使用浏览器登录</button>
    <div class="hint" id="waiting" style="display:none">请在弹出的浏览器窗口中完成授权，等待授权完成后此处会自动继续…</div>
    <div class="err" id="err-step2"></div>
  </div>
</div>
<script>
  // Desktop shell marker: the 0.1.2 token exchange clears the query string
  // after login, so stash the presentation parameters for the client shell
  // (token excluded — the exchange already minted the authority cookie).
  try {
    var dshEnv = location.search.replace(/[?&]token=[^&]*/gu, '').replace(/^&/, '?')
    if (/dsh-desktop-mode=/.test(dshEnv)) sessionStorage.setItem('dsh-desktop-env', dshEnv)
  } catch (e) { /* sessionStorage unavailable: keep the old query path */ }
  var f1 = document.getElementById('f1')
  var f2 = document.getElementById('f2')
  var err1 = document.getElementById('err-step1')
  var err2 = document.getElementById('err-step2')
  var btn = document.getElementById('btn')
  var browserBtn = document.getElementById('browser-btn')
  var methodsBox = document.getElementById('methods')
  var waiting = document.getElementById('waiting')
  var brandArea = document.getElementById('brand-area')
  var currentMethod = 'local'
  var currentMethods = []
  var currentBrand = null
  var pollTimer = null
  // 去除服务端地址尾部一个或多个斜杠(兼容带/不带 / 的用户输入)。
  // 纯字符串实现,禁用带反斜杠的正则:正斜杠转义(如 replace(反斜杠+/+$))
  // 中的反斜杠会被本页所在的 TS 模板字面量求值吃掉,浏览器收到的脚本变成
  // replace(//+$...) —— 双斜杠起行注释,整段内联脚本 SyntaxError,
  // 登录页所有监听器失效(历史坑,见 tests/auth-gate-login.spec.ts)。
  function trimServer(s) {
    while (s.charAt(s.length - 1) === '/') s = s.slice(0, -1)
    return s
  }
  // 品牌兜底图形:权威源为 brands/official/logo.svg(黑色圆角方块 + 白色花括号桥形,
  // 花括号 1.25x 放大)。任何 logo 兜底都必须与 logo.svg 一致,禁止字母 P 等
  // 编造图形(旧版 P 字 logo 已退役)。
  var BRACE_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" width="100%" height="100%" fill="none" aria-hidden="true"><g transform="translate(627 627) scale(1.25) translate(-627 -627)"><path d="M 334 409 C 300 409 273 431 273 466 V 548 C 273 582 254 607 220 620 C 254 633 273 658 273 692 V 775 C 273 810 300 843 334 843" fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/><path d="M 920 409 C 954 409 981 431 981 466 V 548 C 981 582 1000 607 1034 620 C 1000 633 981 658 981 692 V 775 C 981 810 954 843 920 843" fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/><line x1="435" y1="627" x2="817" y2="627" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round"/><circle cx="435" cy="627" r="65" fill="#FFFFFF"/><circle cx="817" cy="627" r="65" fill="#FFFFFF"/></g></svg>'

  // ---- Step1 → Step2: 并行探测 brand + methods(任一成功进 Step2) ----
  f1.addEventListener('submit', async function (e) {
    e.preventDefault()
    err1.textContent = ''
    var server = document.getElementById('server').value.trim()
    if (!server) { err1.textContent = '请填写服务端地址'; return }
    document.getElementById('next-btn').disabled = true
    document.getElementById('next-btn').textContent = '连接中…'
    try {
      var results = await Promise.allSettled([
        fetch('/api/pico/brand?server=' + encodeURIComponent(server)),
        fetch('/api/pico/auth/methods?server=' + encodeURIComponent(server)),
      ])
      var brandOk = results[0].status === 'fulfilled' && results[0].value.ok
      var methodsOk = results[1].status === 'fulfilled' && results[1].value.ok
      if (!brandOk && !methodsOk) {
        err1.textContent = '无法连接服务端，请检查地址与网络'
        return
      }
      if (brandOk) {
        try {
          var b = await results[0].value.json()
          currentBrand = b.enabled ? b : null
        } catch (e2) { currentBrand = null }
      } else {
        currentBrand = null
      }
      var ms = [{ name: 'local', configured: true, browser: false }]
      if (methodsOk) {
        try {
          var md = await results[1].value.json()
          if (md && md.methods && md.methods.length) ms = md.methods
        } catch (e3) { /* keep default */ }
      }
      showStep2(ms)
    } finally {
      document.getElementById('next-btn').disabled = false
      document.getElementById('next-btn').textContent = '下一步'
    }
  })

  function showStep2(methods) {
    currentMethods = methods.filter(function (m) { return !m.hidden })
    // 品牌区
    brandArea.innerHTML = renderBrand(currentBrand)
    // 方式选择器
    currentMethod = pickDefault(currentMethods)
    renderMethodButtons(currentMethods)
    updateFields()
    document.getElementById('step1').classList.remove('active')
    document.getElementById('step2').classList.add('active')
  }

  function renderBrand(b) {
    if (!b) {
      // 兜底:官方花括号 mark(与 logo.svg 一致), 而非字母/编造图形。
      var fallback = '<span class="fallback">' + BRACE_MARK_SVG + '</span>'
      return fallback + '<div class="brand-name">PicoAide</div><div class="brand-tag">Enterprise AI Gateway</div>'
    }
    var login = b.login || {}
    // logo_url 是相对路径(/api/client/v2/brand/logo/login): 在 Host 登录页需拼服务端地址。
    // 先统一去尾斜杠(trimServer),避免拼出 //api/client/v2/... 双斜杠路径。
    var server = trimServer(document.getElementById('server').value.trim())
    var logoUrl = login.logo_url ? (login.logo_url.indexOf('http') === 0 ? login.logo_url : server + login.logo_url) : ''
    // logo 加载失败时保留花括号兜底(与无品牌时同款)。
    // 安全:logoUrl 来自网关数据(管理员可控),仍须属性转义——旧实现直接拼
    // <img src="...">,网关被劫持/注入时可在登录页(认证前)形成 XSS(2026-09-01 审计)。
    var logo = logoUrl ? '<img src="' + esc(logoUrl) + '" alt="logo" onerror="this.style.display=&quot;none&quot;;this.nextElementSibling.style.display=&quot;inline-flex&quot;"><span class="fallback" style="display:none">' + BRACE_MARK_SVG + '</span>' : '<span class="fallback">' + BRACE_MARK_SVG + '</span>'
    var name = login.display_name || 'PicoAide'
    var tag = login.tagline ? '<div class="brand-tag">' + esc(login.tagline) + '</div>' : ''
    var welcome = login.welcome ? '<div class="welcome">' + esc(login.welcome) + '</div>' : ''
    return logo + '<div class="brand-name">' + esc(name) + '</div>' + tag + welcome
  }

  function pickDefault(methods) {
    // 密码方式优先(local/ldap); 否则首个可用浏览器方式。
    var pw = methods.filter(function (m) { return m.name === 'local' || m.name === 'ldap' })
    if (pw.length) return pw[0].name
    if (methods.length) return methods[0].name
    return 'local'
  }

  function renderMethodButtons(methods) {
    if (!methods.length) { methodsBox.innerHTML = ''; return }
    var only = methods.length === 1
    if (only) { methodsBox.innerHTML = ''; return }
    methodsBox.innerHTML = methods.map(function (m) {
      var label = ({ local: '本地账号', ldap: 'LDAP', openid: 'OpenID', oidc: 'OIDC' })[m.name] || m.name
      var configured = m.configured !== false
      return '<button type="button" data-method="' + m.name + '" class="method' +
        (m.name === currentMethod ? ' active' : '') +
        (configured ? '' : ' disabled') + '"' +
        (configured ? '' : ' title="该方式未配置"') + '>' + label + '</button>'
    }).join('')
    methodsBox.querySelectorAll('.method').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.classList.contains('disabled')) return
        currentMethod = b.dataset.method
        methodsBox.querySelectorAll('.method').forEach(function (x) { x.classList.remove('active') })
        b.classList.add('active')
        updateFields()
      })
    })
  }

  function isBrowserMethod(name) {
    var m = currentMethods.find(function (x) { return x.name === name })
    return !!m && m.browser === true
  }

  function updateFields() {
    var isPassword = currentMethod === 'local' || currentMethod === 'ldap'
    document.getElementById('username').style.display = isPassword ? '' : 'none'
    document.getElementById('password').style.display = isPassword ? '' : 'none'
    if (isPassword) document.getElementById('username').placeholder = currentMethod === 'ldap' ? 'LDAP 账号' : '账号'
    document.getElementById('btn').style.display = isPassword ? '' : 'none'
    f2.style.display = isPassword ? '' : 'none'
    browserBtn.style.display = isPassword ? 'none' : ''
    browserBtn.textContent = '使用 ' + methodLabel(currentMethod) + ' 登录'
    waiting.style.display = 'none'
  }

  function methodLabel(name) {
    return ({ local: '本地账号', ldap: 'LDAP', openid: 'OpenID', oidc: 'OIDC' })[name] || name
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  // 返回 Step1
  document.getElementById('back-btn').addEventListener('click', function () {
    document.getElementById('step2').classList.remove('active')
    document.getElementById('step1').classList.add('active')
    err2.textContent = ''
    // 复位浏览器授权守卫(2026-09-01 深挖):返回 Step1 时若 OIDC 授权尚未
    // 完成,按钮 disabled 与轮询需复位,否则用户只能重启应用再登录。
    resetBrowserLogin()
  })

  /**** 轮询登录状态: 用户去浏览器授权, 深链回桌面后 setSession, 此处检测到即刷新 ****/
  var pollAttempts = 0
  function startPoll() {
    if (pollTimer) clearInterval(pollTimer)
    pollAttempts = 0
    pollTimer = setInterval(async function () {
      pollAttempts++
      try {
        var r = await fetch('/api/pico/auth/state')
        if (!r.ok) return
        var d = await r.json().catch(function () { return {} })
        if (d.loggedIn === true) {
          clearInterval(pollTimer)
          location.replace('/' + location.search)
        }
      } catch (e4) {}
      // 超时上限(200 次 × 1.5s = 5 分钟):用户在浏览器里取消/失败了授权,
      // 不能无限轮询旧状态——超时复位按钮与提示(2026-09-01 深挖)。
      if (pollAttempts >= 200) resetBrowserLogin()
    }, 1500)
  }

  function resetBrowserLogin() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    pollAttempts = 0
    browserBtn.disabled = false
    waiting.style.display = 'none'
    err2.textContent = '浏览器授权未完成或已取消，请重试'
  }

  // ---- 浏览器方式(OpenID/OIDC): 打开授权页, 轮询等待深链回跳 ----
  async function browserLogin() {
    var server = document.getElementById('server').value.trim()
    if (!server) { err2.textContent = '请先填写服务端地址'; return }
    err2.textContent = ''
    waiting.style.display = 'block'
    browserBtn.disabled = true
    var name = currentMethod
    var base = trimServer(server)
    window.open(base + '/api/client/v2/auth/' + name + '/login?server=' + encodeURIComponent(server), '_blank')
    startPoll()
  }

  browserBtn.addEventListener('click', browserLogin)

  f2.addEventListener('submit', async function (e) {
    e.preventDefault()
    err2.textContent = ''
    var body = {
      server: document.getElementById('server').value.trim(),
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    }
    btn.disabled = true
    var btnLabel = btn.textContent
    btn.textContent = '登录中…'
    try {
      var res = await fetch('/api/pico/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        // 0057: 管理员重置密码后强制改密 —— 进入强制改密页而非应用。
        var okBody = await res.json().catch(function () { return null })
        if (okBody && okBody.must_change_password) { location.replace('/change-password' + location.search); return }
        location.replace('/' + location.search)
        return
      }
      var data = await res.json().catch(function () { return {} })
      var raw = String(data.error && data.error.message ? data.error.message : (data.error || ''))
      var msg = friendlyLoginError(raw) || ('登录失败 (' + res.status + ')')
      // 开放问题2: auditor 拒绝时提供「打开管理后台」入口。
      if (raw.toLowerCase().indexOf('auditor_not_allowed') >= 0) {
        var server = trimServer(document.getElementById('server').value.trim())
        err2.innerHTML = '审计账号不可登录客户端，请使用管理后台<br><a href="' + esc(server) + '/admin/" style="color:var(--accent);font-size:13px;text-decoration:underline">打开管理后台 ↗</a>'
      } else {
        err2.textContent = msg
      }
    } catch (e5) {
      err2.textContent = '网络错误，请检查服务端地址后重试'
    } finally {
      btn.disabled = false
      btn.textContent = btnLabel
    }
  })
  var friendlyLoginError = function (raw) {
    var code = raw.toLowerCase()
    if (code.indexOf('invalid_credentials') >= 0 || code.indexOf('invalid credentials') >= 0 || code.indexOf('unauthorized') >= 0) return '账号或密码错误'
    if (code.indexOf('rate') >= 0 || code.indexOf('too many') >= 0) return '登录尝试过于频繁，请稍后再试'
    if (code.indexOf('network') >= 0 || code.indexOf('timeout') >= 0 || code.indexOf('econnrefused') >= 0) return '无法连接服务端，请检查地址与网络'
    if (code.indexOf('disabled') >= 0 || code.indexOf('inactive') >= 0) return '账号已被禁用，请联系管理员'
    if (code.indexOf('auditor_not_allowed') >= 0) return '审计账号不可登录客户端，请使用管理后台'
    return raw
  }
</script>
</body>
</html>`

export interface Config {
  defaultServer?: string
}

export const Config: z<Config> = z.object({
  defaultServer: z.string(),
})

// 0057 强制改密页: 登录后被管理员重置密码(必须改密才能使用)时展示。
// 与 LOGIN_HTML 无关联的关系不在此处理; 页面样式与登录页保持一致(浅色卡片)。
const CHANGE_PASSWORD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>修改密码</title>
<style>
  :root { --accent: #4176E6 }
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #F9FAFB; color: #1a1d24; }
  .card { width: 90%; max-width: 400px; padding: 36px 28px; background: #fff; border-radius: 14px; box-shadow: 0 8px 30px rgba(15,17,21,.06); }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .hint { font-size: 13px; color: #6b7280; margin: 0 0 20px; line-height: 1.6; }
  input { width: 100%; box-sizing: border-box; padding: 11px 12px; margin-bottom: 12px; border: 1px solid #d0d5dd; border-radius: 8px; font-size: 14px; }
  input:focus { outline: 2px solid var(--accent); border-color: transparent; }
  button { width: 100%; padding: 11px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .err { margin-top: 10px; font-size: 13px; color: #dc2626; min-height: 1em; }
</style>
</head>
<body>
<div class="card">
  <h1>修改密码</h1>
  <p class="hint">你的密码已被管理员重置，为保障账号安全需要先设置新密码；修改成功后请用新密码重新登录。</p>
  <form id="cf">
    <input id="oldpw" type="password" placeholder="当前密码(管理员设置的临时密码)" autocomplete="current-password" required>
    <input id="new1" type="password" placeholder="新密码(至少 10 位)" autocomplete="new-password" required>
    <input id="new2" type="password" placeholder="确认新密码" autocomplete="new-password" required>
    <button type="submit" id="cb">确认修改</button>
    <div class="err" id="cerr"></div>
  </form>
</div>
<script>
  var cf = document.getElementById('cf')
  var cerr = document.getElementById('cerr')
  var cb = document.getElementById('cb')
  cf.addEventListener('submit', async function (e) {
    e.preventDefault()
    var oldpw = document.getElementById('oldpw').value
    var p1 = document.getElementById('new1').value
    var p2 = document.getElementById('new2').value
    cerr.textContent = ''
    if (p1.length < 10) { cerr.textContent = '新密码至少 10 位'; return }
    if (p1 !== p2) { cerr.textContent = '两次输入的新密码不一致'; return }
    if (p1 === oldpw) { cerr.textContent = '新密码不能与当前密码相同'; return }
    cb.disabled = true
    cb.textContent = '提交中…'
    try {
      var res = await fetch('/api/pico/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: oldpw, new_password: p1 }),
      })
      if (res.ok) {
        // 改密成功后服务端已吊销全部会话(含当前): 回登录页用新密码重新登录。
        location.replace('/login' + location.search)
        return
      }
      var data = await res.json().catch(function () { return {} })
      cerr.textContent = String(data.error && data.error.message ? data.error.message : '修改失败')
    } catch (e5) {
      cerr.textContent = '网络错误，请检查服务端地址后重试'
    } finally {
      cb.disabled = false
      cb.textContent = '确认修改'
    }
  })
<\/script>
</body>
</html>`

// P1-11: transient page shown while the persisted session is still being
// restored; it re-requests the index (which now resolves to the app or the
// login form) without a user-visible login-form flash.
const RESTORING_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PicoAide</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fff; color: #616267; }
</style>
</head>
<body>
<p>正在恢复登录状态…</p>
<script>
  // Once the restoration completes, the next index request serves the app
  // (or the login form). Poll briefly, then reload for good measure.
  setTimeout(function () { location.reload() }, 1200)
<\/script>
</body>
</html>`

export const name = 'auth-gate'
export const inject = ['webServer', 'picoSession']

/**
 * Client-owned login surface served as the main window's first page when no
 * session exists. The user fills the server address and logs in through the
 * client's local API, which calls the gateway; on success the page reloads
 * into the DSH Web app in the same window.
 */
export function apply(ctx: Context, config: Config): void {
  const loginHTML = LOGIN_HTML.replaceAll('__DEFAULT_SERVER__', config.defaultServer ?? '')

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  /**
   * 流式读取上游 body 并带字节上限(审计 2026-08-25 P2-1/P2-2)。
   * 此前 install/archive 分支用 `Buffer.from(await upstream.arrayBuffer())`
   * 整段读入后才判 16MB——content-length 头可被不可信上游伪造/省略,真实
   * 大 body 会把 Host 进程内存打满。此函数边读边计数,超限即 cancel 并抛错。
   */
  const readBodyLimited = async (body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer> => {
    if (body === null) return Buffer.alloc(0)
    const reader = body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limit) {
          await reader.cancel().catch(() => undefined)
          throw new Error(`body exceeds ${limit} bytes`)
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }

  /**
   * 收集本地 POST body 并带上限(审计 2026-08-25 P2-2):login/upload 此前
   * `for await (const chunk of req)` 无界收集,同机恶意进程可打满内存。
   */
  const collectBody = async (req: IncomingMessage, limit: number): Promise<Buffer> => {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      total += (chunk as Buffer).byteLength
      if (total > limit) {
        // 只抛错不 destroy(审计 2026-08-25):destroy 会断开 socket,调用方
        // 的 413 json 响应无法送达;抛错后 for-await 停止消费,路由回 413。
        throw new Error(`request body exceeds ${limit} bytes`)
      }
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  }

  const session = (): Session | null => ctx.picoSession.getSession()

  /**
   * §4.5 双保险防御断言: /api/pico/* 写类操作禁止 auditor(理论不可达——
   * auditor 员工面登录已被服务端拒绝; 若未来边界放开, 此处拦截)。
   */
  const writeGuard = (): boolean => {
    const s = session()
    if (s !== null && s.role === 'auditor') {
      return false
    }
    return true
  }

  /**
   * Trust fence for every local route: loopback socket + Host + same-origin
   * markers. Refuses cross-site browser pages (CSRF / DNS-rebinding) and
   * non-loopback callers alike.
   */
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true
    json(res, 403, { error: 'forbidden' })
    return false
  }

  const gatewayError = (res: ServerResponse, cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : String(cause)
    json(res, 502, { error: `gateway error: ${message}` })
  }

  /**
   * Session-lost tripwire injected into the DSH app page: polls the local
   * auth state and reloads into the login page when the session is cleared
   * server-side (token revoked/expired/disabled). 5s cadence keeps the
   * window short without long-lived connections.
   */
  const SESSION_LOST_SCRIPT = `<script>
(function () {
  var known = true
  setInterval(function () {
    fetch('/api/pico/auth/state').then(function (r) { return r.json() }).then(function (d) {
      if (known && d.loggedIn === false) location.reload()
      known = d.loggedIn === true
    }).catch(function () {})
  }, 5000)
})()
<\/script>`

  ctx.effect(() => {
    const disposers = [
      // The main window's first page: the login form while logged out, the
      // DSH Web app once a session exists. Server-side replacement (not a
      // client redirect) keeps the initial loadURL from being aborted.
      // While logged in, inject the session-lost tripwire into the app page.
      ctx.webServer.tapIndex((html) => {
      // P1-11: while the persisted session is still restoring, serve a
      // lightweight "loading" page that re-requests the index once ready —
      // never flash the login form over an existing valid session.
      if (!ctx.picoSession.isRestored()) return RESTORING_HTML
      const restored = ctx.picoSession.getSession()
      // 0057: 会话带强制改密标记(管理员重置密码) → 一律回强制改密页,
      // 即使应用重启后仍在(业务 API 在改密完成前也被服务端 403)。
      if (restored !== null && restored.mustChangePassword === true) return CHANGE_PASSWORD_HTML
      if (!ctx.picoSession.isLoggedIn()) return loginHTML
      return html.replace('</head>', SESSION_LOST_SCRIPT + '</head>')
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/login',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(loginHTML)
        },
      }),

      // 0057 强制改密页(管理员重置密码后; 完成前业务 API 均被 403)。
      ctx.webServer.register({
        kind: 'exact', path: '/change-password',
        handler: (_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(CHANGE_PASSWORD_HTML)
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/login',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          // 审计 2026-08-25 P2-2:body 上限 64KB(登录表单远小于此)。
          const raw = await collectBody(req, 64 * 1024).catch(() => null)
          if (raw === null) return json(res, 413, { error: 'body too large' })
          let body: { server?: unknown; username?: unknown; password?: unknown }
          try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
          if (typeof body.server !== 'string' || typeof body.username !== 'string' || typeof body.password !== 'string') {
            return json(res, 400, { error: 'missing fields' })
          }
          try {
            const sess = await login(body.server, body.username, body.password)
            ctx.picoSession.setSession(sess)
            // 0057: 强制改密标记 → 登录页跳转强制改密页(而非直接进应用)。
            json(res, 200, { ok: true, must_change_password: sess.mustChangePassword === true })
          } catch (err) {
            // AuthError carries a user-facing message (账号或密码错误 etc.).
            const status = err instanceof AuthError && err.kind === 'network' ? 502 : 401
            json(res, status, { error: err instanceof Error ? err.message : 'login failed' })
          }
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/password',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          const raw = await collectBody(req, 64 * 1024).catch(() => null)
          if (raw === null) return json(res, 413, { error: 'body too large' })
          let body: { old_password?: unknown; new_password?: unknown }
          try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
          if (typeof body.old_password !== 'string' || typeof body.new_password !== 'string') {
            return json(res, 400, { error: 'missing fields' })
          }
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          try {
            await changePassword(s.serverURL, s.token, body.old_password, body.new_password)
            // 服务端已吊销该用户全部令牌(含当前): 清除本地会话 → 客户端回登录页。
            ctx.picoSession.clear()
            json(res, 200, { ok: true })
          } catch (err) {
            const status = err instanceof AuthError
              ? (err.kind === 'network' ? 502 : 401)
              : (err instanceof ApiError ? 400 : 500)
            json(res, status, { error: err instanceof Error ? err.message : 'change password failed' })
          }
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/state',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          // 单次读取会话快照(旧实现取 s 后又两次 getSession(),并发登出
          // 会给出 loggedIn:true 但 username/role 缺失的不一致响应)。
          const current = ctx.picoSession.getSession()
          json(res, 200, current === null
            ? { loggedIn: false }
            : {
                loggedIn: true,
                username: current.username,
                serverURL: current.serverURL,
                role: current.role ?? '',
                // 0057: 账号来源与可改密标志(客户端设置-账号页据此渲染改密入口)。
                source: current.source ?? '',
                password_changeable: current.passwordChangeable === true,
                must_change_password: current.mustChangePassword === true,
              })
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/logout',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          // Revoke the gateway token server-side before clearing locally
          // (M1): the server token must not outlive the local session.
          const s = session()
          if (s !== null) {
            try {
              await fetchJSON(s.serverURL, '/api/client/v2/auth/logout', { token: s.token, method: 'POST' })
            } catch {
              // The local session is still cleared even if the server is
              // unreachable; the token expires via its own TTL.
            }
          }
          ctx.picoSession.clear()
          json(res, 200, { ok: true })
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/methods',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          // 登录页(未登录)需要显示启用方式:用登录页填的 server 地址,
          // 或已有 session 的 server。服务端该端点为公开端(无需 token)。
          const s = session()
          let serverParam = ''
          try {
            const q = new URL(req.url ?? '/', 'http://localhost').searchParams
            serverParam = q.get('server') ?? ''
          } catch { /* ignore malformed query */ }
          const serverURL: string = serverParam || s?.serverURL || ''
          if (serverURL === '') return json(res, 200, { methods: [{ name: 'local', configured: true }] })
          try {
            assertServerURLAllowed(serverURL)
            const data = await fetchJSON(serverURL, '/api/client/v2/auth/methods')
            json(res, 200, data)
          } catch {
            // 服务端不可达:降级只显示 local(恒启用),登录页仍可提交密码。
            json(res, 200, { methods: [{ name: 'local', configured: true }] })
          }
        },
      }),

      // v3b: 登录页品牌代理(公开, 无需 token): ?server=<url> 转发服务端
      // /api/brand; 未传 server 且无 session 时回退默认(登录页回退本地品牌)。
      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/brand',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          const s = session()
          let serverParam = ''
          try {
            serverParam = new URL(req.url ?? '/', 'http://localhost').searchParams.get('server') ?? ''
          } catch { /* ignore malformed query */ }
          const serverURL: string = serverParam || s?.serverURL || ''
          if (serverURL === '') return json(res, 200, { enabled: false })
          try {
            assertServerURLAllowed(serverURL)
            const data = await fetchJSON(serverURL, '/api/client/v2/brand')
            json(res, 200, data)
          } catch {
            json(res, 200, { enabled: false })
          }
        },
      }),

      // Skill store proxy: /api/pico/skills (catalog), /archive (download),
      // and /install (verify + unpack into the user skill root), all
      // forwarded to the gateway. Method dispatch lives inside one handler:
      // the route table has no per-method matching.
      ctx.webServer.register({
        kind: 'prefix', path: '/api/pico/skills',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          if (pathname === '/api/pico/skills' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/marketplace/skills', { token: s.token })
              // Augment the gateway catalog with the locally installed skill
              // names so the panel can render per-skill install state.
              const installed = await listInstalledSkills(resolveSkillsDir())
              json(res, 200, { ...data, installed })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                // The session is no longer valid: clear it so the injected
                // tripwire reloads into the login page (M2).
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              gatewayError(res, cause)
            }
            return
          }
          const installMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (installMatch !== null) {
            const name = decodeURIComponent(installMatch[1]!)
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${normalizeServerURL(s.serverURL)}/api/client/v2/marketplace/skills/${encodeURIComponent(name)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
              const length = Number(upstream.headers.get('content-length') ?? '0')
              if (length > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: 'archive too large' })
              }
              // 审计 2026-08-25 P2-1:流式读取+上限(头可能被伪造/省略)。
              const archive = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (archive === null) return json(res, 413, { error: 'archive too large' })
              const checksum = upstream.headers.get('x-skill-checksum') ?? undefined
              const version = upstream.headers.get('x-skill-version') ?? undefined
              const result = await installSkillArchive({
                name,
                archive,
                checksum,
                version,
                skillsDir: resolveSkillsDir(),
                // 溯源(D6):记录渠道与来源服务端,客户端据此显示归属。
                channel: 'market',
                server: s.serverURL,
              })
              json(res, 200, { ok: true, name: result.name, version: result.version })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              // Install refusals (checksum, unsafe archive, no SKILL.md) are
              // client errors; gateway/IO failures are upstream errors.
              const message = cause instanceof Error ? cause.message : String(cause)
              const isRefusal = /checksum|archive|SKILL\.md|invalid skill name|link entry|too large|traversal|empty path/u.test(message)
              json(res, isRefusal ? 422 : 502, { error: message })
            }
            return
          }
          const uninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (uninstallMatch !== null) {
            const name = decodeURIComponent(uninstallMatch[1]!)
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              // Purely local operation — no gateway round-trip needed.
              await uninstallSkill(resolveSkillsDir(), name)
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /not installed/u.test(message) ? 404 : 500, { error: message })
            }
            return
          }
          const archiveMatch = req.method === 'GET'
            ? /^\/api\/pico\/skills\/([^/]+)\/archive$/u.exec(pathname)
            : null
          if (archiveMatch === null) return json(res, 404, { error: 'not found' })
          const name = decodeURIComponent(archiveMatch[1]!)
          // B8(2026-09-01):归档下载分支此前未校验 name——解码后的名字会
          // 原样拼进 Content-Disposition(如 %22 → `"` 产生畸形头)。与
          // install/uninstall 分支对齐,先验名再放行。
          try {
            validateSkillName(name)
          } catch (cause) {
            return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
          }
          try {
            const upstream = await gatewayFetch(
              `${normalizeServerURL(s.serverURL)}/api/client/v2/marketplace/skills/${encodeURIComponent(name)}/archive`,
              { headers: { Authorization: `Bearer ${s.token}` } },
            )
            if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
            // P1-12: bound the download like the install path — a huge or
            // anomalous archive must not be buffered into memory wholesale.
            const declared = upstream.headers.get('content-length')
            if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
            const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
            if (content === null) {
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
            // Pass through the upstream integrity headers (M3): the server
            // signs archives with X-Skill-Checksum / X-Skill-Version.
            const headers: Record<string, string> = {
              'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
              'Content-Length': String(content.length),
            }
            const disposition = upstream.headers.get('content-disposition')
            headers['Content-Disposition'] = disposition ?? `attachment; filename="${name}.zip"`
            for (const key of ['x-skill-checksum', 'x-skill-version']) {
              const value = upstream.headers.get(key)
              if (value !== null) headers[key] = value
            }
            res.writeHead(200, headers)
            res.end(content)
          } catch (cause) {
            if (cause instanceof AuthError && cause.kind === 'auth_expired') {
              ctx.picoSession.clear()
              return json(res, 401, { error: 'auth expired' })
            }
            gatewayError(res, cause)
          }
        },
      }),

      // Shared-agent proxy: /api/pico/agent-presets (list + upload + install
      // + uninstall + archive). Uploads pack a locally authored preset (the
      // 创造模式 roster's user root) and forward the archive to the gateway;
      // installs download an approved archive, verify it, and unpack it into
      // the same root so the upstream roster discovers it.
      ctx.webServer.register({
        kind: 'prefix', path: '/api/pico/agent-presets',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          const presetsDir = resolvePresetsDir()

          // GET /api/pico/agent-presets -> gateway catalog + installed + local.
          if (pathname === '/api/pico/agent-presets' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/agent-presets', { token: s.token })
              const installed = await listInstalledPresets(presetsDir)
              const local = await mapLocalPresets(presetsDir, data.presets ?? [])
              json(res, 200, { ...data, installed, local })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              gatewayError(res, cause)
            }
            return
          }

          // POST /api/pico/agent-presets/upload { name } -> pack + gateway.
          if (pathname === '/api/pico/agent-presets/upload' && req.method === 'POST') {
            // 审计 2026-08-25 P2-2:body 上限(本地 body 仅元数据,24MB 兼容上限)。
            const raw = await collectBody(req, UPLOAD_BODY_BYTES).catch(() => null)
            if (raw === null) return json(res, 413, { error: 'body too large' })
            let body: { name?: unknown }
            try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            if (name === '') return json(res, 400, { error: 'missing name' })
            try {
              const packed = await packPreset(presetsDir, name)
              const gateway = await fetchJSON(s.serverURL, '/api/client/v2/agent-presets', {
                token: s.token,
                method: 'POST',
                body: {
                  name: packed.name,
                  // Display title travels with the archive so the review
                  // board and the shared library show the friendly name
                  // (not the directory id).
                  ...packed.displayName === undefined ? {} : { display_name: packed.displayName },
                  ...packed.description === undefined ? {} : { description: packed.description },
                  archive: packed.archive.toString('base64'),
                },
                timeoutMs: 30000,
              })
              json(res, 200, { ok: true, preset: gateway.preset })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              if (cause instanceof ApiError) {
                // Gateway envelope: surface its human-readable message with
                // the code-appropriate status (NAME_TAKEN→409, PENDING_LIMIT→429).
                // 2026-09-02:透传服务端原始状态码(不再一律 422)——归属/锁定/
                // 版本冲突各有语义(409/403)。
                const status = cause.status ?? (cause.code === 'PENDING_LIMIT' ? 429
                  : cause.code === 'NAME_TAKEN' || cause.code.startsWith('VERSION_') ? 409
                    : cause.code === 'APP_LOCKED' ? 403
                      : cause.code === 'NOT_FOUND' ? 404
                        : 422)
                return json(res, status, { error: cause.message })
              }
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /too large|过大/u.test(message) ? 413 : 422, { error: message })
            }
            return
          }

          // POST /api/pico/agent-presets/:name/install -> download + verify + unpack.
          const installMatch = req.method === 'POST'
            ? /^\/api\/pico\/agent-presets\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (installMatch !== null) {
            const name = decodeURIComponent(installMatch[1]!)
            try {
              validatePresetId(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${normalizeServerURL(s.serverURL)}/api/client/v2/agent-presets/${encodeURIComponent(name)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
              const declared = upstream.headers.get('content-length')
              if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
              const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (content === null) {
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
              const checksum = upstream.headers.get('x-preset-checksum') ?? undefined
              const presetVersion = upstream.headers.get('x-preset-version') ?? undefined
              await installPresetArchive({
                name, archive: content, checksum, presetsDir,
                // 溯源(D6):与技能同构,记录版本/渠道/来源服务端。
                version: presetVersion, channel: 'org', server: s.serverURL,
              })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              const message = cause instanceof Error ? cause.message : String(cause)
              const isRefusal = /checksum|archive|agent\.cordis\.yml|invalid preset id|link entry|too large|traversal|empty path|already exists/u.test(message)
              json(res, isRefusal ? 422 : 502, { error: message })
            }
            return
          }

          // POST /api/pico/agent-presets/:name/uninstall -> local removal.
          const uninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/agent-presets\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (uninstallMatch !== null) {
            const name = decodeURIComponent(uninstallMatch[1]!)
            try {
              await uninstallPreset(presetsDir, name)
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /not installed/u.test(message) ? 404 : 500, { error: message })
            }
            return
          }

          // GET /api/pico/agent-presets/:name/archive -> passthrough download.
          const archiveMatch = req.method === 'GET'
            ? /^\/api\/pico\/agent-presets\/([^/]+)\/archive$/u.exec(pathname)
            : null
          if (archiveMatch === null) return json(res, 404, { error: 'not found' })
          const name = decodeURIComponent(archiveMatch[1]!)
          // B8(2026-09-01):与 install/uninstall 对齐,归档下载分支先验名再拼
          // Content-Disposition(此前解码后的 quote 会产出畸形头)。
          try {
            validatePresetId(name)
          } catch (cause) {
            return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
          }
          try {
            const upstream = await gatewayFetch(
              `${normalizeServerURL(s.serverURL)}/api/client/v2/agent-presets/${encodeURIComponent(name)}/archive`,
              { headers: { Authorization: `Bearer ${s.token}` } },
            )
            if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
            const declared = upstream.headers.get('content-length')
            if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
            const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
            if (content === null) {
              return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
            }
            const headers: Record<string, string> = {
              'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
              'Content-Length': String(content.length),
            }
            const disposition = upstream.headers.get('content-disposition')
            headers['Content-Disposition'] = disposition ?? `attachment; filename="${name}.zip"`
            for (const key of ['x-preset-checksum', 'x-preset-version']) {
              const value = upstream.headers.get(key)
              if (value !== null) headers[key] = value
            }
            res.writeHead(200, headers)
            res.end(content)
          } catch (cause) {
            if (cause instanceof AuthError && cause.kind === 'auth_expired') {
              ctx.picoSession.clear()
              return json(res, 401, { error: 'auth expired' })
            }
            gatewayError(res, cause)
          }
        },
      }),

      // Shared-skill proxy: /api/pico/shared-skills (list + upload + install
      // + uninstall). Lists the gateway's shared store (approved versions),
      // the local skill root (disk), and the installed set; uploads pack a
      // locally authored skill directory and forward it; installs download an
      // approved archive, verify it, and unpack it into the user skill root.
      ctx.webServer.register({
        kind: 'prefix', path: '/api/pico/shared-skills',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          const skillsDir = resolveSkillsDir()

          if (pathname === '/api/pico/shared-skills' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/shared-skills', { token: s.token })
              const installed = await listInstalledSkills(skillsDir)
              const local = await listLocalSkills(skillsDir)
              json(res, 200, { ...data, installed, local })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              gatewayError(res, cause)
            }
            return
          }

          if (pathname === '/api/pico/shared-skills/upload' && req.method === 'POST') {
            // 审计 2026-08-25 P2-2:body 上限(本地 body 仅元数据,24MB 兼容上限)。
            const raw = await collectBody(req, UPLOAD_BODY_BYTES).catch(() => null)
            if (raw === null) return json(res, 413, { error: 'body too large' })
            let body: { name?: unknown; version?: unknown }
            try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            // 版本号不再由代理兜底 '1.0.0':以包内 SKILL.md 的 version 为准
            // (决策 2026-09-01「包内即真相」)。此前的硬编码让服务端永远只
            // 看到 1.0.0,「版本必须递增/不可复用」在链路上无从判断。
            const version = typeof body.version === 'string' && body.version.trim() !== '' ? body.version.trim() : undefined
            if (name === '') return json(res, 400, { error: 'missing name' })
            try {
              const packed = await packSkill(skillsDir, name, version)
              const gateway = await fetchJSON(s.serverURL, '/api/client/v2/shared-skills', {
                token: s.token,
                method: 'POST',
                body: {
                  name: packed.name,
                  ...packed.displayName === undefined ? {} : { display_name: packed.displayName },
                  version: packed.version,
                  ...packed.description === undefined ? {} : { description: packed.description },
                  archive: packed.archive.toString('base64'),
                },
                timeoutMs: 30000,
              })
              json(res, 200, { ok: true, skill: gateway.skill })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              if (cause instanceof ApiError) {
                // 2026-09-02:透传服务端原始状态码(不再一律 422)——归属/锁定/
                // 版本冲突各有语义(409/403),客户端按状态码分别提示。
                const status = cause.status ?? (cause.code === 'PENDING_LIMIT' ? 429
                  : cause.code === 'NAME_TAKEN' || cause.code.startsWith('VERSION_') ? 409
                    : cause.code === 'APP_LOCKED' ? 403
                      : cause.code === 'NOT_FOUND' ? 404
                        : 422)
                return json(res, status, { error: cause.message })
              }
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /too large|过大/u.test(message) ? 413 : 422, { error: message })
            }
            return
          }

          // POST /api/pico/shared-skills/:name/:version/install -> download + verify + unpack.
          const installMatch = req.method === 'POST'
            ? /^\/api\/pico\/shared-skills\/([^/]+)\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (installMatch !== null) {
            const name = decodeURIComponent(installMatch[1]!)
            const version = decodeURIComponent(installMatch[2]!)
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${normalizeServerURL(s.serverURL)}/api/client/v2/shared-skills/${encodeURIComponent(name)}/${encodeURIComponent(version)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
              const declared = upstream.headers.get('content-length')
              if (declared !== null && Number(declared) > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
              const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (content === null) {
                return json(res, 413, { error: `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）` })
              }
              const checksum = upstream.headers.get('x-skill-checksum') ?? undefined
              const ver = upstream.headers.get('x-skill-version') ?? version
              await installSkillArchive({ name, archive: content, checksum, skillsDir, version: ver, channel: 'org', server: s.serverURL })
              json(res, 200, { ok: true, name, version: ver })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              const message = cause instanceof Error ? cause.message : String(cause)
              const isRefusal = /checksum|archive|SKILL\.md|invalid skill name|link entry|too large|traversal|empty path/u.test(message)
              json(res, isRefusal ? 422 : 502, { error: message })
            }
            return
          }

          // POST /api/pico/shared-skills/:name/:version/uninstall -> local removal.
          const uninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/shared-skills\/([^/]+)\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (uninstallMatch !== null) {
            const name = decodeURIComponent(uninstallMatch[1]!)
            try {
              await uninstallSkill(skillsDir, name)
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause)
              json(res, /not installed/u.test(message) ? 404 : 500, { error: message })
            }
            return
          }

          return json(res, 404, { error: 'not found' })
        },
      }),

      // Capability catalog proxy: /api/pico/capabilities (list).
      // Aggregates the gateway's unified catalog (market skills + org shared
      // skills + shared agents) and unions local-disk state: installed set,
      // installed version (best-effort from frontmatter/metadata), and the
      // locally authored rows (for the 「我的」 partition).
      ctx.webServer.register({
        kind: 'prefix', path: '/api/pico/capabilities',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (!guard(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          if (pathname !== '/api/pico/capabilities' || req.method !== 'GET') {
            return json(res, 404, { error: 'not found' })
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const source = url.searchParams.get('source')
          if (source !== 'market' && source !== 'org' && source !== 'local') {
            return json(res, 400, { error: 'invalid source' })
          }
          try {
            const skillsDir = resolveSkillsDir()
            const presetsDir = resolvePresetsDir()
            // 本地创作分区的状态匹配:服务端 ?source=own 返回 author-own
            // 任意状态(含 pending/rejected + 拒因)——用 own 结果匹配本地
            // 上传行的 status/reason(2026-09-01 契约修复:此前匹配 org 而
            // org 仅含 approved,本地行状态徽章恒空)。
            const matchSource = source === 'local' ? 'own' : source
            const data = await fetchJSON(s.serverURL, `/api/client/v2/capabilities?source=${encodeURIComponent(matchSource)}`, { token: s.token })
            const items = (data as { items?: Array<Record<string, unknown>> }).items ?? []
            const installedSkills = new Set(await listInstalledSkills(skillsDir))
            const installedPresets = new Set(await listInstalledPresets(presetsDir))
            const localSkills = await listLocalSkills(skillsDir)
            const localPresets = await listLocalPresets(presetsDir)
            // installedVersion:优先读安装器写的 .install-version 标记
            // (可靠);否则退回 SKILL.md frontmatter 的 version(best-effort)。
            const localSkillVersions = new Map<string, string | undefined>()
            // 溯源(D6):优先读 .picoaide/release.json(应用 ID/渠道/版本 +
            // 安装时内容哈希),回退旧 .install-version 标记;并重算当前内容
            // 哈希判定「是否被本地修改过」。
            const provenance = new Map<string, { appId: string, channel: string, version: string, dirty: boolean }>()
            for (const r of localSkills) {
              const dir = join(skillsDir, r.name)
              const prov = await readProvenance(dir)
              if (prov !== undefined) {
                let dirty = false
                if (prov.archiveChecksum !== undefined) {
                  const now = await computeSkillContentHash(dir).catch(() => undefined)
                  dirty = now !== undefined && now !== prov.archiveChecksum
                }
                provenance.set(r.name, { appId: prov.appId, channel: prov.channel, version: prov.version, dirty })
                localSkillVersions.set(r.name, prov.version !== '' ? prov.version : r.version)
                continue
              }
              const marker = join(dir, '.install-version')
              const mv = await readFile(marker, 'utf8').then(s => s.trim()).catch(() => undefined)
              localSkillVersions.set(r.name, mv ?? r.version)
            }

            // 本地创作行(我的分区):磁盘上存在的技能/预设,带上传状态(若在
            // 服务端 catalog 里存在同名同 kind 的行,则取其 status——本机
            // 作者是自己的上传,服务端 ListVisible* 已含 author-own 任意状态)。
            const localRows: Array<Record<string, unknown>> = []
            for (const l of localSkills) {
              const match = items.find(i => (i as { kind?: string }).kind === 'skill' && (i as { name?: string }).name === l.name)
              const prov = provenance.get(l.name)
              localRows.push({
                kind: 'skill', source: 'local', name: l.name, displayName: l.displayName ?? l.name,
                // 运行时名 = SKILL.md 的 name(上游据它注册技能),与目录名不同时
                // 面板会显式提示,避免「装完才知道该 @ 什么」。
                runtimeName: l.displayName ?? l.name,
                version: prov?.version !== undefined && prov.version !== '' ? prov.version : (l.version ?? '1.0.0'),
                description: l.description ?? '', author: '',
                // 归属与本地改动(D6):面板据此显示「来自市场 · vX · 已本地修改」。
                ...prov === undefined ? {} : { originChannel: prov.channel, originAppId: prov.appId, dirty: prov.dirty },
                status: match !== undefined ? (match as { status?: string }).status : undefined,
                reason: match !== undefined ? (match as { reason?: string }).reason : undefined,
                versions: [], isLocal: true, uploadStatus: match !== undefined ? (match as { status?: string }).status : undefined,
              })
            }
            for (const l of localPresets) {
              const match = items.find(i => (i as { kind?: string }).kind === 'agent' && (i as { name?: string }).name === l.name)
              const dir = join(presetsDir, l.name)
              const prov = await readProvenance(dir)
              let dirty = false
              if (prov?.archiveChecksum !== undefined) {
                const now = await computeSkillContentHash(dir).catch(() => undefined)
                dirty = now !== undefined && now !== prov.archiveChecksum
              }
              localRows.push({
                kind: 'agent', source: 'local', name: l.name, displayName: l.displayName ?? l.name,
                version: prov?.version !== undefined && prov.version !== '' ? prov.version : '1.0.0',
                description: l.description ?? '', author: '',
                ...prov === undefined ? {} : { originChannel: prov.channel, originAppId: prov.appId, dirty },
                status: match !== undefined ? (match as { status?: string }).status : undefined,
                reason: match !== undefined ? (match as { reason?: string }).reason : undefined,
                versions: [], isLocal: true, uploadStatus: match !== undefined ? (match as { status?: string }).status : undefined,
              })
            }

            if (source === 'local') {
              // 「我的」定案(2026-09-04):已安装(商店渠道/其他) + 本地制作。
              // 已安装商店行取自 market+org 目录(installed=true 的行),
              // originChannel/provenance 已在上游 enriched 计算。
              if (localRows.length > 0 || true) {
                const [mkt, org] = await Promise.all([
                  fetchJSON(s.serverURL, `/api/client/v2/capabilities?source=market`, { token: s.token }).catch(() => ({ items: [] })),
                  fetchJSON(s.serverURL, `/api/client/v2/capabilities?source=org`, { token: s.token }).catch(() => ({ items: [] })),
                ])
                const storeInstalled = [...(mkt as { items?: Array<Record<string, unknown>> }).items ?? [], ...(org as { items?: Array<Record<string, unknown>> }).items ?? []]
                  .filter((i) => {
                    const kind = (i as { kind?: string }).kind ?? ''
                    const name = (i as { name?: string }).name ?? ''
                    return kind === 'skill' ? installedSkills.has(name) : installedPresets.has(name)
                  })
                  .map((i) => ({
                    ...i,
                    source: (i as { source?: string }).source ?? 'market',
                    displayName: ((i as { display_name?: string }).display_name ?? i.name) as string,
                    installed: true,
                    // 0059 官方字段透传(与 enriched 同构)。
                    official: (i as { official?: boolean }).official ?? false,
                    downloads: Number((i as { downloads?: number }).downloads ?? 0),
                    calls: Number((i as { calls?: number }).calls ?? 0),
                    score: Number((i as { score?: number }).score ?? 0),
                  }))
                return json(res, 200, { items: [...storeInstalled, ...localRows] })
              }
              return json(res, 200, { items: localRows })
            }

            // 已装版本:best-effort(技能 metadata.yaml / frontmatter 的 version;
            // preset 的 preset.yml 无 version 字段,取 '1.0.0' 兜底,hasUpdate 不精确时
            // 以 approved 最高 ± 已装版本为准)。
            const enriched = items.map(i => {
              const kind = i.kind as string
              const name = i.name as string
              const installed = kind === 'skill' ? installedSkills.has(name) : installedPresets.has(name)
              const installedVersion = kind === 'skill' ? localSkillVersions.get(name) : undefined
              return {
                ...i,
                // 服务端为 snake_case(display_name 等),客户端读驼峰
                // displayName——统一在此映射,避免卡片标题恒等于 name、
                // 搜索/归并失效(2026-09-01 深挖)。
                displayName: (i as { display_name?: string; displayName?: string }).displayName
                  ?? (i as { display_name?: string }).display_name
                  ?? i.name,
                // 2026-09-02 归属权:is_owner 由服务端按 apps.owner 计算,
                // 客户端上传预检依赖它(「我的」与「他人」同名区分)。
                isOwner: (i as { is_owner?: boolean }).is_owner ?? false,
                // 0059 官方机制:蓝标 + 市场排序评分(score 由服务端计算)。
                official: (i as { official?: boolean }).official ?? false,
                downloads: Number((i as { downloads?: number }).downloads ?? 0),
                calls: Number((i as { calls?: number }).calls ?? 0),
                score: Number((i as { score?: number }).score ?? 0),
                installed,
                installedVersion,
                hasUpdate: false, // 客户端按 versions 与 installedVersion 计算
              }
            })
            json(res, 200, { items: enriched })
          } catch (cause) {
            if (cause instanceof AuthError && cause.kind === 'auth_expired') {
              ctx.picoSession.clear()
              return json(res, 401, { error: 'auth expired' })
            }
            gatewayError(res, cause)
          }
        },
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'pico auth-gate routes')
}
