import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ApiError, AuthError, assertServerURLAllowed, changePassword, fetchJSON, gatewayFetch, login, normalizeServerURL } from './server-connector/auth.ts'
import { applyPinnedFingerprintsFromEnv, defaultTlsStorePath, installCertificateVerification } from './server-connector/tls.ts'
import { browserSameOriginMarker, isLoopbackRequest } from './loopback.ts'
import { clearBrowserLoginPending, noteBrowserLoginStarted, noteLoginPageWired, pendingBrowserLoginServer } from './deep-link.ts'
import {
  computeSkillContentHash,
  describeArchiveFailure,
  INSTALL_VERSION_FILE,
  installSkillArchive,
  isStoreProvenance,
  listInstalledSkills,
  listLocalSkills,
  packSkill,
  readProvenance,
  resolveSkillsDir,
  uninstallSkill,
  validateSkillName,
} from './skill-install.ts'
import { MAX_ARCHIVE_BYTES } from './archive-util.ts'
import { createWasmAppsRoute } from './wasm-apps.ts'
import { registerWasmAppTools } from './wasm-app-tools.ts'
import { createAiRowsConsentStore, defaultAiRowsConsentPath } from './wasm-apps-ai-rows-consent.ts'
import { brandMarkSvg } from './channel-geometry.ts'
import { hostCopy, hostLocaleFrom, tryNormalizeHostLocale, type HostLocale } from 'dsh-plugin-desktop/host-locale'
import { LOCALE_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-client-locale'
import { absolutizeChannelAssets, asChannelPayload, brandChannel, mergeChannel, type BrandConfig, type ChannelConfig } from './channel-content.ts'
import type { Session } from './server-connector/config.ts'

// 品牌文案类型定义在 channel-content.ts（纯数据模块，客户端面也能值导入），
// 这里转出以保持 auth-gate 既有入口形状。
export type { BrandConfig }

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

/**
 * Client-owned login surface served as the main window's first page when no
 * session exists. The user fills the server address and logs in through the
 * client's local API, which calls the gateway; on success the page reloads
 * into the DSH Web app in the same window.
 *
 * 文案与 `<html lang>` 随宿主语言（见 LOGIN_COPY 与 renderLoginPage）。
 */
/**
 * 登录页文案（zh 是原文逐字保留, en 是镜像）。
 *
 * 语言由**渲染方按请求/按渲染**解析后传入（`hostLocaleFrom`）—— 绝不在模块级
 * 捕获：`t()`/文案一旦落在模块常量里，用户切语言后这一页会永远停在启动时的
 * 语言（同类根因见 `packages/host/connectors/src/client/status-label.ts` 的注释）。
 */
interface LoginCopy {
  /** `<title>` 里品牌名之后的词（品牌名由 apply() 单独替换）。 */
  titleSuffix: string
  connectTitle: string
  connectTagline: string
  next: string
  usernamePlaceholder: string
  passwordPlaceholder: string
  signIn: string
  browserSignIn: string
  waiting: string
  needServer: string
  connecting: string
  cannotConnect: string
  methodLocal: string
  methodUnconfigured: string
  ldapUsername: string
  /** 含 `{method}` 占位符。 */
  signInWith: string
  browserCancelled: string
  needServerFirst: string
  browserRegisterFailed: string
  signingIn: string
  /** 含 `{status}` 占位符。 */
  signInFailed: string
  auditorDenied: string
  adminConsole: string
  networkError: string
  badCredentials: string
  tooManyAttempts: string
  accountDisabled: string
}

const LOGIN_COPY: Readonly<Record<HostLocale, LoginCopy>> = {
  zh: {
    titleSuffix: '登录',
    connectTitle: '连接服务端',
    connectTagline: '输入服务端地址以确认登录方式',
    next: '下一步',
    usernamePlaceholder: '账号',
    passwordPlaceholder: '密码',
    signIn: '登录',
    browserSignIn: '使用浏览器登录',
    waiting: '请在弹出的浏览器窗口中完成授权，等待授权完成后此处会自动继续…',
    needServer: '请填写服务端地址',
    connecting: '连接中…',
    cannotConnect: '无法连接服务端，请检查地址与网络',
    methodLocal: '本地账号',
    methodUnconfigured: '该方式未配置',
    ldapUsername: 'LDAP 账号',
    signInWith: '使用 {method} 登录',
    browserCancelled: '浏览器授权未完成或已取消，请重试',
    needServerFirst: '请先填写服务端地址',
    browserRegisterFailed: '无法登记浏览器登录，请重试',
    signingIn: '登录中…',
    signInFailed: '登录失败 ({status})',
    auditorDenied: '审计账号不可登录客户端，请使用管理后台',
    adminConsole: '打开管理后台 ↗',
    networkError: '网络错误，请检查服务端地址后重试',
    badCredentials: '账号或密码错误',
    tooManyAttempts: '登录尝试过于频繁，请稍后再试',
    accountDisabled: '账号已被禁用，请联系管理员',
  },
  en: {
    titleSuffix: 'Sign in',
    connectTitle: 'Connect to the server',
    connectTagline: 'Enter the server address to load the available sign-in methods',
    next: 'Next',
    usernamePlaceholder: 'Username',
    passwordPlaceholder: 'Password',
    signIn: 'Sign in',
    browserSignIn: 'Sign in with browser',
    waiting: 'Complete the authorization in the browser window that just opened; this page continues automatically.',
    needServer: 'Enter the server address',
    connecting: 'Connecting…',
    cannotConnect: 'Cannot reach the server — check the address and your network',
    methodLocal: 'Local account',
    methodUnconfigured: 'This method is not configured',
    ldapUsername: 'LDAP username',
    signInWith: 'Sign in with {method}',
    browserCancelled: 'Browser sign-in was not completed or was cancelled. Please try again.',
    needServerFirst: 'Enter the server address first',
    browserRegisterFailed: 'Could not start browser sign-in. Please try again.',
    signingIn: 'Signing in…',
    signInFailed: 'Sign-in failed ({status})',
    auditorDenied: 'Audit accounts cannot sign in to the desktop client. Please use the admin console.',
    adminConsole: 'Open admin console ↗',
    networkError: 'Network error — check the server address and try again',
    badCredentials: 'Incorrect username or password',
    tooManyAttempts: 'Too many sign-in attempts. Please try again later.',
    accountDisabled: 'This account has been disabled. Contact your administrator.',
  },
}

/**
 * 把一份文案序列化成可安全内联进 `<script>` 的 JS 字面量。
 *
 * `JSON.stringify` 不转义 `<`，文案里一个 `</script>` 就能从字符串里逃逸出来改写
 * 登录页 —— 登录页是认证前唯一的 HTML 面，这里按不可信输入处理（与
 * `brandScriptLiteral` 同一口径）。
 * @param value - 待内联的值。
 * @returns 形如 `{"key":"…"}` 的安全字面量。
 */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c')
}

/**
 * 登录页（认证前第一个界面）。
 *
 * 语言由调用方按请求解析（`hostLocaleFrom`）后传入；返回的 HTML 仍带
 * `__BRAND_NAME__` / `__DEFAULT_SERVER__` 等占位符，由 `apply()` 做属性转义替换。
 * @param locale - 本次渲染的宿主语言。
 * @returns 独立 HTML 文档。
 */
export function renderLoginPage(locale: HostLocale): string {
  const c = hostCopy(locale, LOGIN_COPY.zh, LOGIN_COPY.en)
  return `<!DOCTYPE html>
<html lang="${hostCopy(locale, 'zh-CN', 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__BRAND_NAME__ ${c.titleSuffix}</title>
<style>
  :root {
    --bg: #ffffff;
    --fg: #1a1d24;
    --input-bg: #ffffff;
    --border: #d0d5dd;
    --err: #dc2626;
    --accent: #2563eb;
    /* 实心强调按钮上的文字色：暗色 --accent 是浅蓝 #3b82f6，白字只有 3.68:1，
       所以暗色改用深墨（6.23:1）。亮色保持白字（5.17:1）。 */
    --accent-fg: #ffffff;
    --brand-tile-bg: #0f1115;
    --brand-tile-fg: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --fg: #e6e6e6;
      --input-bg: #1a1d24;
      --border: #333333;
      --err: #f87171;
      --accent: #3b82f6;
      --accent-fg: #0b1220;
      --brand-tile-bg: #f9fafb;
      --brand-tile-fg: #0f1115;
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
  button { padding: 11px; border-radius: 9px; border: none; background: var(--accent); color: var(--accent-fg); font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
  button:disabled { opacity: 0.6; cursor: default; }
  .err { color: var(--err); font-size: 13px; min-height: 18px; margin-top: 4px; text-align: left; }
  .hint { color: var(--fg); opacity: 0.7; font-size: 12px; margin-top: 8px; }
  .back { background: transparent; color: var(--accent); border: none; font-size: 12px; cursor: pointer; padding: 6px 12px; margin: 0 0 14px; width: auto; }
  /* Step2 渠道区(名称/标语/logo 来自服务端 /api/client/v2/channel) */
  .brand { margin-bottom: 18px; min-height: 92px; }
  .brand img, .brand .fallback { width: 64px; height: 64px; border-radius: 14px; object-fit: contain; margin-bottom: 8px; }
  /* 品牌兜底方块：亮=深底白 mark，暗=浅底深 mark（与 logo-dark.svg 的配对方向一致）。
     原先写死 #0f1115，暗色下与页面底色 1.00:1（方块轮廓彻底消失）。 */
  .brand .fallback { display: inline-flex; align-items: center; justify-content: center; background: var(--brand-tile-bg); color: var(--brand-tile-fg); font-size: 28px; font-weight: 700; }
  .brand-name { font-size: 20px; font-weight: 700; }
  .brand-tag { font-size: 12px; color: var(--fg); opacity: 0.6; }
  .welcome { font-size: 13px; margin-top: 6px; white-space: pre-wrap; }
  /* 方式选择器 */
  .methods { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-bottom: 14px; }
  .method { background: transparent; border: 1px solid var(--border); color: var(--fg); font-size: 13px; padding: 8px 14px; border-radius: 8px; width: auto; font-weight: 500; }
  .method.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .method.disabled { opacity: 0.45; cursor: not-allowed; }
  .pw-fields .spacer { opacity: 0; }
</style>
</head>
<body>
<div class="card">
  <!-- Step 1: 服务端地址 -->
  <div id="step1" class="stage active">
    <h1>${c.connectTitle}</h1>
    <div class="tagline">${c.connectTagline}</div>
    <form id="f1">
      <input id="server" type="url" placeholder="https://ai.example.com" value="__DEFAULT_SERVER__" __DEFAULT_SERVER_MARK__ autocomplete="off" spellcheck="false" required>
      <button type="submit" id="next-btn">${c.next}</button>
      <div class="err" id="err-step1"></div>
    </form>
  </div>

  <!-- Step 2: 品牌 + 登录方式 -->
  <div id="step2" class="stage">
    __BACK_BUTTON__
    <div class="brand" id="brand-area"></div>
    <div id="methods" class="methods"></div>
    <form id="f2" style="display:none">
      <input id="username" placeholder="${c.usernamePlaceholder}" autocomplete="username" style="display:none">
      <input id="password" type="password" placeholder="${c.passwordPlaceholder}" autocomplete="current-password" style="display:none">
      <button type="submit" id="btn" style="display:none">${c.signIn}</button>
    </form>
    <button type="button" id="browser-btn" style="display:none">${c.browserSignIn}</button>
    <div class="hint" id="waiting" style="display:none">${c.waiting}</div>
    <div class="err" id="err-step2"></div>
  </div>
</div>
<script>
  // 页面脚本文案（由 apply() 之外的 renderLoginPage 按语言注入）。
  var T = ${scriptLiteral(hostCopy(locale, LOGIN_COPY.zh, LOGIN_COPY.en))}
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
  var currentChannel = null
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
  // 渠道兜底图形:权威源为 brands/official/logo.svg(黑色圆角方块 + 白色花括号桥形,
  // 花括号 1.25x 放大)。任何 logo 兜底都必须与 logo.svg 一致,禁止字母 P 等
  // 编造图形(旧版 P 字 logo 已退役)。
  var BRACE_MARK_SVG = ${JSON.stringify(brandMarkSvg('currentColor'))}

  // 随包分发的品牌文案(channel.json 的 identity/copy,由 profile 组装期注入)。
  // 登录页要在这里就显示品牌 —— 此刻还没有服务端可问。__BRAND_JSON__ 由
  // apply() 替换成安全的 JS 字面量;缺失时用中性占位,绝不写厂商名。
  var BRAND = __BRAND_JSON__

  // ---- Step1 → Step2: 并行探测 channel + methods(任一成功进 Step2) ----
  async function connect(server) {
    err1.textContent = ''
    if (!server) { err1.textContent = T.needServer; return false }
    document.getElementById('next-btn').disabled = true
    document.getElementById('next-btn').textContent = T.connecting
    try {
      var results = await Promise.allSettled([
        fetch('/api/pico/channel?server=' + encodeURIComponent(server)),
        fetch('/api/pico/auth/methods?server=' + encodeURIComponent(server)),
      ])
      var channelOk = results[0].status === 'fulfilled' && results[0].value.ok
      var methodsOk = results[1].status === 'fulfilled' && results[1].value.ok
      if (!channelOk && !methodsOk) {
        err1.textContent = T.cannotConnect
        return false
      }
      if (channelOk) {
        try {
          var c = await results[0].value.json()
          // 渠道内容总是生效(无 enabled 开关):有内容即用, 空载荷回退内置兜底。
          currentChannel = c && (c.login || c.client || c.title) ? c : null
        } catch (e2) { currentChannel = null }
      } else {
        currentChannel = null
      }
      var ms = [{ name: 'local', configured: true, browser: false }]
      if (methodsOk) {
        try {
          var md = await results[1].value.json()
          if (md && md.methods && md.methods.length) ms = md.methods
        } catch (e3) { /* keep default */ }
      }
      showStep2(ms)
      return true
    } finally {
      document.getElementById('next-btn').disabled = false
      document.getElementById('next-btn').textContent = T.next
    }
  }

  f1.addEventListener('submit', async function (e) {
    e.preventDefault()
    await connect(document.getElementById('server').value.trim())
  })

  // 渠道包预置了服务端域名 → 跳过"输入服务端地址"这一步,直接进登录:
  // 员工看到的第一个界面就是账号密码(或点一下就用浏览器 SSO 登录),
  // 而不是"请输入你公司的地址"。
  //
  // 判据是**服务端写的标记**(data-default-server),不是"输入框有值":浏览器
  // 在 reload 时会恢复表单值,用"有值"判断会让未渠道化的构建也触发自动连接。
  //
  // 写法注意:这里刻意用"函数声明 + void 调用",而不是把 IIFE 直接写在行首。
  // 本脚本是无分号(ASI)风格,而紧跟在一个调用语句之后的左圆括号不会触发自动
  // 分号插入 —— 解析器会把上一行读成"调用那个函数的返回值",一执行就抛
  // TypeError,后面所有语句(包括 #f2 登录表单的提交处理)全部不注册。
  // 症状极具迷惑性:Step1→Step2 正常(它注册在前面),点「登录」却只是原生提交、
  // 页面刷新回 Step1。2026-09-10 客户端 E2E 从 13/13 掉到 5/13 就是这个原因,
  // 而"脚本能被 new Function 解析"的语法测试**抓不到**(它语法上是合法的)。
  async function autoConnect() {
    var serverInput = document.getElementById('server')
    if (serverInput.getAttribute('data-default-server') !== '1') return
    if (serverInput.value.trim() === '') return
    var ok = await connect(serverInput.value.trim())
    if (!ok) return
    // 只有浏览器方式可用(纯 OIDC/OpenID 部署)时直接发起跳转,员工不必再点一次。
    var hasPassword = currentMethods.some(function (m) {
      return m.name === 'local' || m.name === 'ldap'
    })
    if (!hasPassword && currentMethods.length > 0 && browserBtn.style.display !== 'none') {
      browserBtn.click()
    } else {
      var username = document.getElementById('username')
      if (username && username.style.display !== 'none') username.focus()
    }
  }
  void autoConnect()

  function showStep2(methods) {
    currentMethods = methods.filter(function (m) { return !m.hidden })
    // 渠道区
    brandArea.innerHTML = renderChannel(currentChannel)
    // 方式选择器
    currentMethod = pickDefault(currentMethods)
    renderMethodButtons(currentMethods)
    updateFields()
    document.getElementById('step1').classList.remove('active')
    document.getElementById('step2').classList.add('active')
  }

  function renderChannel(ch) {
    if (!ch) {
      // 兜底:官方花括号 mark(与 logo.svg 一致), 而非字母/编造图形。
      // 文案取随包品牌(渠道构建下即渠道自己的名字)。
      var fallback = '<span class="fallback">' + BRACE_MARK_SVG + '</span>'
      var fbTag = BRAND.login.tagline ? '<div class="brand-tag">' + esc(BRAND.login.tagline) + '</div>' : ''
      return fallback + '<div class="brand-name">' + esc(BRAND.login.displayName) + '</div>' + fbTag
    }
    var login = ch.login || {}
    // logo_url 是相对路径(/api/client/v2/channel/logo): 在 Host 登录页需拼服务端地址。
    // 先统一去尾斜杠(trimServer),避免拼出 //api/client/v2/... 双斜杠路径。
    var server = trimServer(document.getElementById('server').value.trim())
    // logo_url 可能是三种形态：绝对 http(s)、相对路径（服务端下发，需拼服务端地址）、
    // 或**随包内联的 data: URI**（渠道构建；服务端不可达/旧版服务端时显示客户自己的
    // 标识）。只有相对路径才拼服务端地址 —— 把 data: 拼上去会变成一个取不到的地址，
    // 于是白标客户的登录页又回到厂商兜底图形（2026-09-11 实测）。
    var rawLogo = login.logo_url || ''
    var logoUrl = rawLogo === '' ? '' : (/^(https?:|data:)/.test(rawLogo) ? rawLogo : server + rawLogo)
    // logo 加载失败时保留花括号兜底(与无渠道内容时同款)。
    // 安全:logoUrl 来自网关数据(管理员可控),仍须属性转义——旧实现直接拼
    // <img src="...">,网关被劫持/注入时可在登录页(认证前)形成 XSS(2026-09-01 审计)。
    var logo = logoUrl ? '<img src="' + esc(logoUrl) + '" alt="logo" onerror="this.style.display=&quot;none&quot;;this.nextElementSibling.style.display=&quot;inline-flex&quot;"><span class="fallback" style="display:none">' + BRACE_MARK_SVG + '</span>' : '<span class="fallback">' + BRACE_MARK_SVG + '</span>'
    // 服务端没给名字时用随包品牌:同一个渠道包驱动镜像与客户端,两者同名。
    var name = login.display_name || BRAND.login.displayName
    var tagline = login.tagline || BRAND.login.tagline
    var tag = tagline ? '<div class="brand-tag">' + esc(tagline) + '</div>' : ''
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
      // 安全(2026-09-08 P1-7):m.name 来自网关 /auth/methods 响应,可被
      // 恶意/被劫持的网关控制;此前未转义直接拼进属性,可在本地登录页
      // origin 注入属性/事件处理器。label 同理(未知方式回退到 m.name)。
      var rawName = String(m.name == null ? '' : m.name)
      var label = ({ local: T.methodLocal, ldap: 'LDAP', openid: 'OpenID', oidc: 'OIDC' })[rawName] || rawName
      var name = esc(rawName)
      var configured = m.configured !== false
      return '<button type="button" data-method="' + name + '" class="method' +
        (rawName === currentMethod ? ' active' : '') +
        (configured ? '' : ' disabled') + '"' +
        (configured ? '' : ' title="' + esc(T.methodUnconfigured) + '"') + '>' + esc(label) + '</button>'
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
    if (isPassword) document.getElementById('username').placeholder = currentMethod === 'ldap' ? T.ldapUsername : T.usernamePlaceholder
    document.getElementById('btn').style.display = isPassword ? '' : 'none'
    f2.style.display = isPassword ? '' : 'none'
    browserBtn.style.display = isPassword ? 'none' : ''
    browserBtn.textContent = T.signInWith.replace('{method}',() => (methodLabel(currentMethod)))
    waiting.style.display = 'none'
  }

  function methodLabel(name) {
    return ({ local: T.methodLocal, ldap: 'LDAP', openid: 'OpenID', oidc: 'OIDC' })[name] || name
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  // 返回 Step1(内置了服务端地址的构建不渲染这个按钮,所以要判空 ——
  // 不判空会在脚本这行抛 TypeError,后面所有语句(含登录表单处理)全部不注册)
  var backBtn = document.getElementById('back-btn')
  if (backBtn) backBtn.addEventListener('click', function () {
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
    // srvcore-1 客户端一半(审计 R7 F3-N1):复位时清除宿主进程登记的"待登录
    // 服务端" —— 取消授权/轮询超时/返回上一步之后,迟到或伪造的回跳深链不再
    // 被接受。本页脚本跑在**渲染进程**(window-options.ts: contextIsolation=true、
    // nodeIntegration=false、sandbox=true),够不到宿主模块,只能走本地 HTTP 面。
    try { fetch('/api/pico/auth/browser-login', { method: 'DELETE' }).catch(function () {}) } catch (e6) {}
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    pollAttempts = 0
    browserBtn.disabled = false
    waiting.style.display = 'none'
    err2.textContent = T.browserCancelled
  }

  // ---- 浏览器方式(OpenID/OIDC): 打开授权页, 轮询等待深链回跳 ----
  async function browserLogin() {
    var server = document.getElementById('server').value.trim()
    if (!server) { err2.textContent = T.needServerFirst; return }
    err2.textContent = ''
    waiting.style.display = 'block'
    browserBtn.disabled = true
    var name = currentMethod
    var base = trimServer(server)
    // srvcore-1 客户端一半(审计 R7 F3-N1):window.open 打开的是**远端** SSO 地址,
    // 不经过本地路由;而回跳深链的守卫(deep-link.ts 的 noteBrowserLoginStarted)
    // 在宿主进程。所以必须先经本地 HTTP 面登记"本机登录页正在等待这台服务端",
    // 否则守卫永远收不到登记(判定分支不可达),伪造的 picoaide://auth?…
    // server=https://attacker.example 会把真 token 发给攻击者并采纳其会话。
    // 登记失败就不打开浏览器:否则员工在浏览器里授权成功后,回跳会因为"没有
    // 等待目标"被拒绝,表现为"授权完成却一直登不进去"。
    // 这里 await 一个同源本地请求(~毫秒级)不会让 window.open 被弹窗拦截:
    // Chromium 的 transient user activation 保留约 5 秒且 fetch 不消耗它。
    try {
      var reg = await fetch('/api/pico/auth/browser-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: server }),
      })
      if (!reg.ok) throw new Error('register failed')
    } catch (e7) {
      waiting.style.display = 'none'
      browserBtn.disabled = false
      err2.textContent = T.browserRegisterFailed
      return
    }
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
    btn.textContent = T.signingIn
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
      var msg = friendlyLoginError(raw) || T.signInFailed.replace('{status}',() => (res.status))
      // 开放问题2: auditor 拒绝时提供「打开管理后台」入口。
      if (raw.toLowerCase().indexOf('auditor_not_allowed') >= 0) {
        var server = trimServer(document.getElementById('server').value.trim())
        err2.innerHTML = T.auditorDenied + '<br><a href="' + esc(server) + '/admin/" style="color:var(--accent);font-size:13px;text-decoration:underline">' + T.adminConsole + '</a>'
      } else {
        err2.textContent = msg
      }
    } catch (e5) {
      err2.textContent = T.networkError
    } finally {
      btn.disabled = false
      btn.textContent = btnLabel
    }
  })
  var friendlyLoginError = function (raw) {
    var code = raw.toLowerCase()
    if (code.indexOf('invalid_credentials') >= 0 || code.indexOf('invalid credentials') >= 0 || code.indexOf('unauthorized') >= 0) return T.badCredentials
    if (code.indexOf('rate') >= 0 || code.indexOf('too many') >= 0) return T.tooManyAttempts
    if (code.indexOf('network') >= 0 || code.indexOf('timeout') >= 0 || code.indexOf('econnrefused') >= 0) return T.cannotConnect
    if (code.indexOf('disabled') >= 0 || code.indexOf('inactive') >= 0) return T.accountDisabled
    if (code.indexOf('auditor_not_allowed') >= 0) return T.auditorDenied
    return raw
  }
</script>
</body>
</html>`
}

export interface Config {
  defaultServer?: string
  brand?: BrandConfig
}

/**
 * 解析后的品牌文案（每个字段都非空/有确定值，页面直接渲染）。
 */
interface ResolvedBrand {
  title: string
  login: { displayName: string; shortName: string; tagline: string; welcome: string }
  client: { displayName: string; shortName: string; tagline: string }
}

/**
 * 官方渠道文案：**没有渠道包**时（本地开发、未注入）的兜底。
 *
 * 与"渠道包存在但字段为空"必须区分开：后者是注入链断了，用中性占位
 * （`channel-content.ts` 的 `NEUTRAL_CHANNEL`），绝不能拿官方文案冒充渠道 ——
 * 那正是白标要防的事故。
 */
const OFFICIAL_BRAND: ResolvedBrand = {
  // 文档/窗口标题用的是**产品名**(与 desktop-shell 的 windowTitle、内置
  // DEFAULT_CHANNEL.title 同值);登录页品牌区用的是 login.displayName
  // (官方渠道为短名 'PicoAide')。两者不可混用 —— 混了官方构建的窗口标题
  // 会从 "PicoAide Harness" 变成 "PicoAide"。
  title: 'PicoAide Harness',
  login: { displayName: 'PicoAide', shortName: 'PicoAide', tagline: 'Enterprise AI Gateway', welcome: '' },
  client: { displayName: 'PicoAide Harness', shortName: 'PicoAide', tagline: '' },
}

/** 未配置品牌时的中性名（与 desktop-channel.ts / 服务端同值）。 */
const NEUTRAL_NAME = 'Harness'

/** 非空字符串（'' 是"渠道没配这一项"，等同于缺失）。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/**
 * 把可缺字段的品牌配置解析成可直接渲染的文案。
 *
 * 兜底基座由**有没有渠道包**决定（见 `OFFICIAL_BRAND` 的注释），而不是由
 * 字段有没有值决定。
 * @param brand - 组装期注入的品牌配置（可缺）。
 * @returns 每个字段都有确定值的品牌文案。
 */
function resolveBrand(brand: BrandConfig | undefined): ResolvedBrand {
  // "没有渠道品牌"的判据是**没有任何非空名字**，而不是"对象不存在"：
  // schema 会把未注入的 brand 物化成 `{}`（见 channel-content.ts 的说明），
  // 只判 undefined 会让官方构建显示中性占位。
  if (brand === undefined
    || (nonEmpty(brand.login?.displayName) === undefined
      && nonEmpty(brand.title) === undefined
      && nonEmpty(brand.client?.displayName) === undefined)) {
    return OFFICIAL_BRAND
  }
  const login = brand.login
  const client = brand.client
  const loginName = nonEmpty(login?.displayName) ?? nonEmpty(brand.title) ?? NEUTRAL_NAME
  const clientName = nonEmpty(client?.displayName) ?? loginName
  return {
    title: nonEmpty(brand.title) ?? loginName,
    login: {
      displayName: loginName,
      shortName: nonEmpty(login?.shortName) ?? loginName,
      // 标语允许为空：渠道没配就不显示，而不是编一句。
      tagline: nonEmpty(login?.tagline) ?? '',
      welcome: nonEmpty(login?.welcome) ?? '',
    },
    client: {
      displayName: clientName,
      // 与 channel-content.ts 的 brandChannel() **同序**:client 短名缺失时回落到
      // login 短名,再回落到显示名。两份映射必须给同一个答案(侧边栏拿的是
      // channel 那份,登录页拿的是这份)。
      shortName: nonEmpty(client?.shortName) ?? nonEmpty(login?.shortName) ?? clientName,
      tagline: nonEmpty(client?.tagline) ?? '',
    },
  }
}

/**
 * 把品牌文案渲染成可安全内联进 `<script>` 的 JS 字面量。
 *
 * `JSON.stringify` 不转义 `<`，渠道名里一个 `</script>` 就能从字符串里逃逸出来
 * 改写登录页 —— 登录页是认证前唯一的 HTML 面，这里按不可信输入处理（渠道包是
 * 自家产物，但注入链路过 profile 组装，口径统一按不可信）。
 * @param brand - 已解析的品牌文案。
 * @returns 形如 `{"title":"…","login":{…}}` 的安全字面量。
 */
function brandScriptLiteral(brand: ResolvedBrand): string {
  return JSON.stringify({
    title: brand.title,
    login: brand.login,
  }).replace(/</gu, '\\u003c')
}

export const Config: z<Config> = z.object({
  defaultServer: z.string(),
  brand: z.object({
    title: z.string(),
    login: z.object({
      displayName: z.string(),
      shortName: z.string(),
      tagline: z.string(),
      welcome: z.string(),
    }),
    client: z.object({
      displayName: z.string(),
      shortName: z.string(),
      tagline: z.string(),
    }),
    // 随包 logo（data: URI）——渠道构建注入；官方构建没有这两个键。
    logoURL: z.string(),
    logoDarkURL: z.string(),
  }),
})

// 0057 强制改密页: 登录后被管理员重置密码(必须改密才能使用)时展示。
// 与 LOGIN_HTML 无关联的关系不在此处理; 页面样式与登录页保持一致(浅色卡片)。
/** 强制改密页文案（zh 是原文逐字保留, en 是镜像）。 */
interface ChangePasswordCopy {
  title: string
  hint: string
  oldPlaceholder: string
  newPlaceholder: string
  confirmPlaceholder: string
  submit: string
  tooShort: string
  mismatch: string
  sameAsOld: string
  submitting: string
  failed: string
  networkError: string
}

const CHANGE_PASSWORD_COPY: Readonly<Record<HostLocale, ChangePasswordCopy>> = {
  zh: {
    title: '修改密码',
    hint: '你的密码已被管理员重置，为保障账号安全需要先设置新密码；修改成功后请用新密码重新登录。',
    oldPlaceholder: '当前密码(管理员设置的临时密码)',
    newPlaceholder: '新密码(至少 10 位)',
    confirmPlaceholder: '确认新密码',
    submit: '确认修改',
    tooShort: '新密码至少 10 位',
    mismatch: '两次输入的新密码不一致',
    sameAsOld: '新密码不能与当前密码相同',
    submitting: '提交中…',
    failed: '修改失败',
    networkError: '网络错误，请检查服务端地址后重试',
  },
  en: {
    title: 'Change password',
    hint: 'Your password was reset by an administrator. Set a new password to secure your account, then sign in with it.',
    oldPlaceholder: 'Current password (temporary password from your administrator)',
    newPlaceholder: 'New password (at least 10 characters)',
    confirmPlaceholder: 'Confirm new password',
    submit: 'Change password',
    tooShort: 'New password needs at least 10 characters',
    mismatch: 'The two new passwords do not match',
    sameAsOld: 'New password must differ from the current one',
    submitting: 'Submitting…',
    failed: 'Change failed',
    networkError: 'Network error — check the server address and try again',
  },
}

/**
 * 强制改密页（管理员重置密码后; 完成前业务 API 均被 403）。
 *
 * 语言由调用方按请求解析后传入。
 * @param locale - 本次渲染的宿主语言。
 * @returns 独立 HTML 文档。
 */
export function renderChangePasswordPage(locale: HostLocale): string {
  const c = hostCopy(locale, CHANGE_PASSWORD_COPY.zh, CHANGE_PASSWORD_COPY.en)
  return `<!DOCTYPE html>
<html lang="${hostCopy(locale, 'zh-CN', 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c.title}</title>
<style>
  /* 与 LOGIN_HTML 同一套主题口径（独立文档 ⇒ 走 prefers-color-scheme；
     桌面壳的 nativeTheme.themeSource 会驱动它）。2026-09-16 暗色审计：
     这一页原先 11 个颜色全是字面量且无暗色分支，暗色下整屏白闪。 */
  :root {
    --accent: #4176E6;
    --accent-fg: #ffffff;
    --bg: #F9FAFB;
    --fg: #1a1d24;
    --card: #ffffff;
    --muted: #6b7280;
    --border: #d0d5dd;
    --err: #dc2626;
    --shadow: rgba(15,17,21,.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --accent-fg: #0b1220;
      --bg: #0f1115;
      --fg: #e6e6e6;
      --card: #1a1d24;
      --muted: #9aa0a6;
      --border: #333333;
      --err: #f87171;
      --shadow: rgba(0,0,0,.4);
    }
  }
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg); color-scheme: light dark; }
  .card { width: 90%; max-width: 400px; padding: 36px 28px; background: var(--card); border-radius: 14px; box-shadow: 0 8px 30px var(--shadow); }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .hint { font-size: 13px; color: var(--muted); margin: 0 0 20px; line-height: 1.6; }
  input { width: 100%; box-sizing: border-box; padding: 11px 12px; margin-bottom: 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; background: var(--card); color: var(--fg); }
  input:focus { outline: 2px solid var(--accent); border-color: transparent; }
  button { width: 100%; padding: 11px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .err { margin-top: 10px; font-size: 13px; color: var(--err); min-height: 1em; }
</style>
</head>
<body>
<div class="card">
  <h1>${c.title}</h1>
  <p class="hint">${c.hint}</p>
  <form id="cf">
    <input id="oldpw" type="password" placeholder="${c.oldPlaceholder}" autocomplete="current-password" required>
    <input id="new1" type="password" placeholder="${c.newPlaceholder}" autocomplete="new-password" required>
    <input id="new2" type="password" placeholder="${c.confirmPlaceholder}" autocomplete="new-password" required>
    <button type="submit" id="cb">${c.submit}</button>
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
    if (p1.length < 10) { cerr.textContent = ${scriptLiteral(c.tooShort)}; return }
    if (p1 !== p2) { cerr.textContent = ${scriptLiteral(c.mismatch)}; return }
    if (p1 === oldpw) { cerr.textContent = ${scriptLiteral(c.sameAsOld)}; return }
    cb.disabled = true
    cb.textContent = ${scriptLiteral(c.submitting)}
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
      cerr.textContent = String(data.error && data.error.message ? data.error.message : ${scriptLiteral(c.failed)})
    } catch (e5) {
      cerr.textContent = ${scriptLiteral(c.networkError)}
    } finally {
      cb.disabled = false
      cb.textContent = ${scriptLiteral(c.submit)}
    }
  })
<\/script>
</body>
</html>`
}

// P1-11: transient page shown while the persisted session is still being
// restored; it re-requests the index (which now resolves to the app or the
// login form) without a user-visible login-form flash.
/**
 * 会话恢复中的过渡页。
 * @param locale - 本次渲染的宿主语言（调用方按渲染解析后传入）。
 * @returns 独立 HTML 文档。
 */
export function renderRestoringPage(locale: HostLocale): string {
  return `<!DOCTYPE html>
<html lang="${hostCopy(locale, 'zh-CN', 'en')}">
<head>
<meta charset="utf-8">
<title>__BRAND_NAME__</title>
<style>
  /* 独立文档：亮色 + 暗色两套（2026-09-16 暗色审计，原先只有写死亮色）。 */
  :root { --bg: #fff; --fg: #616267; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --fg: #9aa0a6; } }
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: var(--bg); color: var(--fg); color-scheme: light dark; }
</style>
</head>
<body>
<p>${hostCopy(locale, '正在恢复登录状态…', 'Restoring your session…')}</p>
<script>
  // Once the restoration completes, the next index request serves the app
  // (or the login form). Poll briefly, then reload for good measure.
  setTimeout(function () { location.reload() }, 1200)
<\/script>
</body>
</html>`
}

export const name = 'auth-gate'
// `tools` 是 WASM 应用平台的宿主工具面（wasm_app_list / wasm_app_validate /
// wasm_app_publish）所需的服务：不声明它，apply 可能在 tools 服务就位之前跑完，
// 结果是工具静默缺席（模型只会说"没有这个工具"，日志里一条线索都没有）。
export const inject = ['webServer', 'picoSession', 'tools']

/**
 * 把渠道包预置的域名安全地放进 `value="…"` 属性。
 *
 * 只转义 HTML 元字符(属性值语义),不做 URL 编解码 —— 地址本身由
 * auth-gate 的 assertServerURLAllowed 在使用时再校验一次(https/回环)。
 * @param value - 渠道包或 profile 提供的域名。
 * @returns 可安全内联进 HTML 属性的字符串。
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/**
 * 上游 `connection` 服务(BrowserAuth 持有性检查)在本包内需要的**最小结构**。
 *
 * 刻意不 `import type {} from '@deepseek-ai/dsh-client-connection'`:那会给
 * enterprise 增加一条依赖边(要改 package.json + lockfile),而这里只需要
 * 一个方法。结构类型 + 运行时存在性判断已足够,并且能在服务缺席时明确降级。
 */
interface ConnectionTrustFence {
  /**
   * Connection 的 Host/Origin 围栏 + BrowserAuth cookie 校验。
   * @param request - 只用到 headers(Host / Cookie)。
   * @returns 401/403 表示拒绝;undefined 表示通过。
   */
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/**
 * 登录请求是否与**当前会话**冲突(审计 2026-09-12 P1-3/FIX-18)。
 *
 * 深链路径早已显式拒绝"已登录时静默换服务端"(`deep-link.ts:112-116`),
 * 而 `POST /api/pico/auth/login` 会**无条件** `setSession` —— 同一个动作在
 * 两条路径上判定相反,这就是缺陷本身。单服务端产品语义下,切换服务器必须
 * 先显式登出;同一服务端上换账号(改密/换人)仍然允许。
 * @param current - 当前会话(未登录为 null)。
 * @param requestedServer - 请求体里的 server 原文。
 * @returns true 表示必须拒绝(409)。
 */
export function loginServerSwitchConflict(current: Session | null, requestedServer: string): boolean {
  if (current === null) return false
  const target = normalizeServerURL(requestedServer)
  // 非法/空地址交给 login() 去报它自己的错,这里不抢答。
  if (target === '') return false
  return current.serverURL !== target
}

/**
 * 已装共享 Agent(preset)在磁盘上的版本号。
 *
 * 审计 2026-09-12 P1-6:能力中心的「更新到 vX」由客户端
 * `CapabilityCenterPanel.hasUpdateFor()` 决定,而它要求
 * `installedVersion !== undefined`。共享 Agent 侧的该字段此前**恒为
 * undefined**(`kind === 'skill' ? … : undefined`,注释却写着"取 '1.0.0'
 * 兜底"),于是本地已装 v1、远端已发布 v2 时也永不出现更新入口。
 *
 * 版本事实在磁盘上确实存在——`agent-preset-install.ts` 的安装器与技能走
 * 同一套落盘:`.picoaide/release.json`(provenance),旧安装回落
 * `.install-version` 标记。preset.yml 没有 version 字段,故没有第三层兜底:
 * 读不到就返回 undefined,让客户端保守判 false(宁可不提示,不可误报)。
 * @param presetDir - 一个已安装 preset 的目录。
 * @returns 版本号,或 undefined(未安装 / 无版本信息)。
 */
export async function readInstalledPresetVersion(presetDir: string): Promise<string | undefined> {
  const prov = await readProvenance(presetDir)
  if (prov !== undefined && prov.version !== '') return prov.version
  const marker = await readFile(join(presetDir, INSTALL_VERSION_FILE), 'utf8').then(s => s.trim()).catch(() => undefined)
  return marker !== undefined && marker !== '' ? marker : undefined
}

/**
 * 按 kind 选已装版本表(技能 / 共享 Agent)。
 * @param kind - 目录行的 kind('skill' | 'agent')。
 * @param name - 目录行名。
 * @param skillVersions - 技能版本表。
 * @param presetVersions - 共享 Agent 版本表。
 * @returns 已装版本,或 undefined(未知)。
 */
export function installedVersionFor(
  kind: string,
  name: string,
  skillVersions: ReadonlyMap<string, string | undefined>,
  presetVersions: ReadonlyMap<string, string | undefined>,
): string | undefined {
  return kind === 'skill' ? skillVersions.get(name) : presetVersions.get(name)
}

/**
 * 按 kind 选"本机那一份的来源"表（审计 2026-09-23 A2/A3）。
 *
 * 客户端用它决定"更新到 vX / 卸载"要不要先弹确认条：`store` = 能力中心装的，
 * 直接替换/删除；`local` = 本机自制（或缺溯源），必须先由用户确认，宿主也会
 * 在缺 `?overwrite=1` 时以 409 `LOCAL_CONTENT` 拒绝。
 * @param kind - 目录行的 kind('skill' | 'agent')。
 * @param name - 目录行名。
 * @param skillOrigins - 技能来源表。
 * @param presetOrigins - 共享 Agent 来源表。
 * @returns `'store'` / `'local'`，未知（未安装/读不到）为 undefined。
 */
export function installedOriginFor(
  kind: string,
  name: string,
  skillOrigins: ReadonlyMap<string, 'store' | 'local'>,
  presetOrigins: ReadonlyMap<string, 'store' | 'local'>,
): 'store' | 'local' | undefined {
  return kind === 'skill' ? skillOrigins.get(name) : presetOrigins.get(name)
}

/**
 * 组装期注入的品牌 → `/api/client/v2/channel` 形态的响应体。
 *
 * 字段名与服务端 `channel.Response` 对齐（客户端 `channel-sync` 直吃这份），
 * 这样"服务端可达"与"不可达"两条路径给客户端的是同一种结构，消费方不需要
 * 分支。`assets` 不在这里：随包素材由 electron-builder 打进应用资源，不走
 * 这个端点（`favicon_url`/`logo_url` 留给服务端下发）。
 * @param brand - 组装期注入的品牌配置（可缺，缺省即官方文案）。
 * @returns 与 `GET /api/client/v2/channel` 同形的对象。
 */
function builtInChannel(brand: BrandConfig | undefined): ChannelConfig {
  // 映射只有一份:channel-content.ts 的 brandChannel()（channel-sync 用的也是它）。
  // 此前这里自己又写了一遍,两份在"渠道只配了 login.short_name、没配
  // client.short_name"时给出不同的短名 —— 侧边栏于是显示成显示名并折行
  // （2026-09-11 由测试发现）。官方构建下 brandChannel() 就是 DEFAULT_CHANNEL,
  // 与原来的 OFFICIAL_BRAND 逐字段等值。
  return brandChannel(brand)
}

/**
 * Step2 顶部的"返回修改服务端地址"按钮。
 *
 * **只在没有内置服务端地址时才渲染**（`apply()` 按 `config.defaultServer` 决定）：
 * 渠道包把地址写死之后，员工不该被要求、也不该被诱导去改它 —— 客户端只跟一家
 * 服务端说话；界面上留一个"改地址"的入口，既是多余的步骤，也给"把凭据发到别的
 * 地址"留了路。地址连不上时页面**仍停在 Step1**（那里可以改地址重试），所以
 * 真出问题时不会把人困住。
 * @param locale - 渲染该页时的宿主语言。
 * @returns 按钮元素 HTML（`← 修改服务端地址` / `← Change server address`）。
 */
function backButtonHtml(locale: HostLocale): string {
  return `<button type="button" class="back" id="back-btn">${hostCopy(locale, '← 修改服务端地址', '← Change server address')}</button>`
}

/**
 * 归档超限的响应文案（技能/智能体下载与上传路径可见，回到能力中心面板）。
 *
 * 上限值来自 `MAX_ARCHIVE_BYTES`，两种语言插同一个数 —— 只翻译措辞。
 * @param locale - 本次请求的语言。
 * @returns 该语言的提示文案（zh 与历史逐字一致）。
 */
export function archiveTooLargeError(locale: HostLocale): string {
  return hostCopy(
    locale,
    `归档过大（超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB）`,
    `Archive too large (over ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB)`,
  )
}

export function apply(ctx: Context, config: Config): void {
  // srvcore-1 客户端一半(R3-F3-N1a/N1b,2026-09-13):深链守卫必须在**本进程
  // 任何深链可能到达之前**就进入严格模式,而且是**无条件**的 —— 包括没有预置
  // 服务端地址的官方构建(configuredServer === '')。
  //
  // 为什么放在 apply() 的最前面:① 「未接线/无预置地址」不再是放行条件
  // (R3-N1a:官方渠道包 brands/official/brand.json 的 server_url 是空串,旧
  // 逻辑下严格模式永不开启,伪造深链把真 token 发往攻击者域名且零告警);
  // ② configuredServer 是编译期常量(渠道包 build/channel.json 或组装配置),
  // 此刻就是权威值,等"首个登录页请求"再武装会留下启动窗口 —— 深链作为启动
  // 参数/second-instance/open-url 恰好落在这个窗口里(R3-N1b)。
  //
  // 语义:noteLoginPageWired() 打开严格模式;有预置地址时登记为"正在等待的
  // 那台",没有预置地址时 pending 保持 null ⇒ 未登录且未登记(员工没点过
  // "使用浏览器登录")的深链一律拒绝。密码登录不经深链;OIDC 部署必然先在
  // 登录页 `browserLogin()` 里登记,故不受影响(见 deep-link.ts)。
  const configuredServer = (config.defaultServer ?? '').trim()
  noteLoginPageWired()
  if (configuredServer !== '') noteBrowserLoginStarted(configuredServer)

  // F13(审计 2026-09-11):接线 TLS 校验 —— 系统 CA 信任的证书直接放行;
  // 自签名/私有 CA 只有在 PICOAI_TLS_PINS 预置或历史 pin 指纹匹配时才接受,
  // 未知/不匹配一律拒绝(此前该模块从未被调用,文档宣称的 TOFU 保护是死代码)。
  const tlsStore = defaultTlsStorePath()
  try {
    const pinned = applyPinnedFingerprintsFromEnv(tlsStore)
    if (pinned > 0) ctx.logger?.info?.(`pico: applied ${pinned} pinned TLS fingerprint(s)`)
  } catch (cause) {
    ctx.logger?.warn?.(`pico: pinned TLS fingerprints ignored: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  void installCertificateVerification(tlsStore, {
    onUnknownFingerprint: (host, fingerprint) => {
      ctx.logger?.warn?.(`pico: TLS certificate for ${JSON.stringify(host)} is not trusted and not pinned (sha256=${fingerprint}); set PICOAI_TLS_PINS to trust it`)
    },
    onMismatchFingerprint: (host, fingerprint) => {
      ctx.logger?.error?.(`pico: TLS certificate mismatch for ${JSON.stringify(host)} (sha256=${fingerprint}); connection refused`)
    },
  }).catch((cause: unknown) => {
    ctx.logger?.warn?.(`pico: TLS verification install failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  })

  // 预置域名来自渠道包(随包分发的 build/channel.json)或 profile 组装配置,
  // 会直接落进 `value="…"` 属性 —— 必须做属性转义,否则一个带引号的地址就能
  // 从属性里逃逸。渠道包是自家产物,但登录页是认证前唯一的 HTML 面,
  // 这里按不可信输入处理(与页面内 esc() 同一口径)。
  // (configuredServer 在 apply() 开头已算好并用于同步武装深链守卫。)
  const defaultServer = escapeHtmlAttribute(configuredServer)
  // 品牌名进 `<title>` 是 HTML 文本位,进页面脚本是 JS 字面量位 —— 两种上下文
  // 各用各自的转义。渠道名里一个 `</title>` / `</script>` 都能逃逸,所以
  // 不共用同一个字符串。
  const brand = resolveBrand(config.brand)
  const brandTitle = escapeHtmlAttribute(brand.title)

  /**
   * 本次请求/本次渲染的宿主语言。
   *
   * `ctx.locale` 是**客户端面**服务，宿主持不到它；权威来源是桌面壳的
   * `desktopRuntime.locale`（用户的应用内选择），其次请求的 `Accept-Language`，
   * 最后中文（见 `dsh-plugin-desktop/host-locale`）。
   *
   * **必须按请求/按渲染调用**：语言可能在两次请求之间变化（用户在设置里切
   * 语言），任何模块级或 apply 级的缓存都会把首屏永久冻结在启动时的语言。
   * `tapIndex` 拿不到请求对象（签名只有 html），所以那里只能用
   * `desktopRuntime.locale` —— 而那正是权威值。
   * @param req - 当前请求（索引渲染变换没有请求对象）。
   * @returns 该请求应使用的语言。
   */
  const hostLocale = (req?: IncomingMessage): HostLocale => {
    // 优先级：launcher 的实时值（桌面端权威）→ 客户端设置里的语言偏好 → 请求头
    // → 产品默认。加中间那一档的原因：浏览器部署（无桌面壳）里 `GET /` 的索引
    // 变换**拿不到请求对象**（上游 tapIndex 只给 html），Accept-Language 在首屏
    // 永远轮不到 ⇒ 首屏恒中文而同浏览器访问 /login 却是英文（2026-09-16 R9 审计）。
    const fromRuntime = tryNormalizeHostLocale(runtimeLocale())
    if (fromRuntime !== undefined) return fromRuntime
    const chosen = tryNormalizeHostLocale(readLocalePreference())
    if (chosen !== undefined) return chosen
    return hostLocaleFrom(undefined, req?.headers['accept-language'])
  }

  /** 结构探测 `desktopRuntime.locale`（无头组合/测试替身下缺席）。 */
  const runtimeLocale = (): unknown => {
    try {
      const runtime = typeof ctx.get === 'function'
        ? ctx.get('desktopRuntime') as { readonly locale?: unknown } | undefined
        : undefined
      return runtime?.locale
    } catch {
      return undefined
    }
  }

  /** 客户端存的语言偏好（`locale` 设置命名空间；无头组合下缺席）。 */
  const readLocalePreference = (): unknown => {
    try {
      const settings = typeof ctx.get === 'function'
        ? ctx.get('settings') as { get?: (namespace: string) => unknown } | undefined
        : undefined
      const value = settings?.get?.(LOCALE_SETTINGS_NAMESPACE) as { preference?: unknown } | undefined
      return value?.preference
    } catch {
      return undefined
    }
  }

  /** 归档超限文案（能力中心上传/安装路径可见）；语言按请求解析。 */
  const archiveTooLarge = (locale: HostLocale): string => archiveTooLargeError(locale)

  /**
   * 单遍填充模板占位符：**替换文本不再被扫描**。
   *
   * 旧的链式 `.replaceAll('__A__', …).replaceAll('__B__', …)` 有一个注入面
   * （2026-09-17 二轮对抗审计 IP-1）：值本身是渠道/运维配置（未受信），只要某个
   * 值里出现**后面才替换**的占位符字面量，它就会在**另一个上下文**里被展开 ——
   * 例如 `defaults.server_url = "https://host/__BRAND_JSON__"` 会把
   * `brandScriptLiteral()`（JSON.stringify，引号未转义）插进
   * `value="__DEFAULT_SERVER__"` 属性里，JSON 自己的 `"` 闭合属性、后续内容变成
   * 标记（已用真实 channel.json + parse5 复现：登录页出现 onfocus 处理器，
   * 聚焦即读出密码框内容）。单遍替换从结构上消灭这一类。
   *
   * 未知占位符原样保留（与旧行为一致：模板里出现的其它 `__X__` 不动）。
   * @param template - 含 `__NAME__` 占位符的模板。
   * @param values - 占位符 → 取值的函数（**不得**在取值里再调用本函数）。
   * @returns 填充后的字符串。
   */
  const fillPlaceholders = (template: string, values: Readonly<Record<string, () => string>>): string =>
    template.replace(/__[A-Z][A-Z0-9_]*__/gu, (token) => {
      const value = values[token]
      return value === undefined ? token : value()
    })

  /**
   * 组装登录页：文案与 `<html lang>` 取 `locale`，品牌名/预置地址仍在这里做
   * 上下文各自的转义替换（`__*__` 占位符单遍填充，见 fillPlaceholders）。
   * @param locale - 本次请求的语言。
   * @returns 可直接写进响应的 HTML。
   */
  const loginPage = (locale: HostLocale): string => fillPlaceholders(renderLoginPage(locale), {
    __DEFAULT_SERVER__: () => defaultServer,
    // 只有**确实配了**域名才打标记 —— 页面脚本据此决定要不要自动连接。
    __DEFAULT_SERVER_MARK__: () => (configuredServer === '' ? '' : 'data-default-server="1"'),
    // 内置了地址就不再提供"返回修改服务端地址"（见 backButtonHtml 的说明）。
    __BACK_BUTTON__: () => (configuredServer === '' ? backButtonHtml(locale) : ''),
    __BRAND_NAME__: () => brandTitle,
    __BRAND_JSON__: () => brandScriptLiteral(brand),
  })

  /**
   * 组装会话恢复过渡页（`__BRAND_NAME__` 替换同登录页，同样单遍填充）。
   * @param locale - 本次渲染的语言。
   * @returns 可直接写进响应的 HTML。
   */
  const restoringPage = (locale: HostLocale): string =>
    fillPlaceholders(renderRestoringPage(locale), { __BRAND_NAME__: () => brandTitle })

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

  // 只提醒一次(每次会话变更请求都刷日志会淹没真正的信号)。
  let warnedMissingProofFence = false

  /**
   * 持有性证明(审计 2026-09-12 P1-3/FIX-18;三轮残留②:2026-09-13 收紧 fail-open)。
   *
   * `guard()` 的注释已经自述其边界(`loopback.ts:60-64`):"a bare curl sends
   * neither header and is refused, but a curl with a forged Origin passes this
   * too"。也就是说:**本机任意进程**只要伪造 `Origin` 就能 `POST
   * /api/pico/auth/login` 把整个会话换到攻击者服务端(员工后续的对话与工具
   * 调用都会打到那台机器)。会话变更必须再要求一项只有"由本进程服务、经
   * launch token 换过票的浏览器页面"才持有的东西——即上游 `connection` 服务的
   * BrowserAuth cookie(`dsh-auth-<authority>`: HttpOnly + SameSite=Strict +
   * HMAC,由 GET /?token=… 交换而来)。
   *
   * 复用上游机制,不新造:直接调 `connection.requestRejection()` —— 它做的正是
   * "Host/Origin 围栏 + cookie 验签"两件事。
   *
   * 服务缺席时的口径(本轮修正):
   *   - `'required'`(高危:换 server / 换账号的 login、logout)——**fail-closed**。
   *     拿不到持有性证明能力 ⇒ 谁都无法证明自己是那个真页面,此时退回 `guard()`
   *     等于把"本机任意进程伪造 Origin"重新放进来(上一轮只打一条 warn,
   *     是货真价实的 fail-open)。返回 503 + 明确错误码,让人看得见地失败。
   *   - `'best-effort'`(低危:改密——必须先交出**旧密码**才能生效,本机
   *     伪造 Origin 的进程拿不出凭据)——维持既有降级:warn 一次后走 `guard()`。
   * @param req - 本地 HTTP 请求(读 headers)。
   * @param res - 拒绝时写响应体的对象。
   * @param level - 持有性证明缺失时的口径(见上)。
   * @returns true 表示可以继续处理。
   */
  const proofOfPossession = (
    req: IncomingMessage,
    res: ServerResponse,
    level: 'required' | 'best-effort',
  ): boolean => {
    const fence = (ctx as unknown as { get?: (name: string) => unknown }).get?.('connection') as ConnectionTrustFence | undefined
    if (fence === undefined || typeof fence.requestRejection !== 'function') {
      if (level === 'required') {
        ctx.logger?.warn?.('pico: connection service unavailable; refusing a high-risk session change (fail-closed)')
        json(res, 503, {
          error: 'browser session proof unavailable',
          hint: 'reopen the application window from its launch URL before changing the session',
        })
        return false
      }
      if (!warnedMissingProofFence) {
        warnedMissingProofFence = true
        ctx.logger?.warn?.('pico: connection service unavailable; session-changing routes fall back to the loopback fence')
      }
      return true
    }
    let rejection: 401 | 403 | undefined
    try {
      rejection = fence.requestRejection({ headers: req.headers })
    } catch (err) {
      // 校验器自身抛错 = 无法证明 ⇒ 按拒绝处理(不把异常泄漏成 500)。
      ctx.logger?.warn?.(`pico: browser proof check failed (${err instanceof Error ? err.message : String(err)})`)
      rejection = 403
    }
    if (rejection === undefined) return true
    ctx.logger?.warn?.(`pico: refused a session-changing request without browser proof (${String(rejection)})`)
    json(res, 403, {
      error: 'browser session proof required',
      hint: 'reopen the application window from its launch URL',
    })
    return false
  }

  /**
   * r7c-6(P2):本地**写**路由的持有性证明。
   *
   * `guard()` 只证明"回环 socket + 回环 Host + 同源标记",而它自述的边界正是
   * "伪造 Origin 的 curl 也能过"。此前技能/预设/共享技能/能力的 install、
   * upload、uninstall 只调 `guard()` —— 同一份伪造头打 login 被 403,打技能
   * 安装却穿过围栏,以用户令牌出站到网关、把技能落进本地技能根、把本地产物
   * 上传到组织共享库(本地进程与 login 围栏是同一前提:能在本机执行代码)。
   *
   * 口径与 login 一致:`required`(高危写面,fence 缺席时 fail-closed 503);
   * 读面(GET)维持 `guard()` —— 只读目录/归档不改盘、不换会话。
   * @param req - 本地 HTTP 请求(读 method/headers)。
   * @param res - 拒绝时写响应体的对象。
   * @returns true 表示可以继续处理。
   */
  const requireWriteProof = (req: IncomingMessage, res: ServerResponse): boolean =>
    req.method === 'GET' || proofOfPossession(req, res, 'required')

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

  /**
   * 登录页被下发时,用渠道预置的服务端地址**重新**武装深链守卫(srvcore-1
   * 客户端一半)。
   *
   * 真正的首次武装已在 `apply()` 同步完成(见那里的说明);这里是页面重载路径
   * 上的兜底:用户在登录页取消/超时后(`clearBrowserLoginPending()` 清空了等待
   * 目标),下一次登录页请求把预置地址放回去。
   *
   * 只用它武装、且**不覆盖**进行中的登记:用户点过浏览器登录(或填了别的地址)
   * 之后,登记以那次点击为准 —— 页面重载/被再次请求不得把等待目标改回默认值。
   *
   * 没配默认地址的构建(官方/本地)在这里**不登记任何目标**,但严格模式已经在
   * `apply()` 里打开:未登录且没点过浏览器登录的深链一律拒绝(R3-N1a),而不是
   * 回落成"没有预置地址就放行"。
   */
  const armPendingBrowserLoginFromLoginPage = (): void => {
    if (configuredServer === '' || pendingBrowserLoginServer() !== null) return
    noteBrowserLoginStarted(configuredServer)
  }

  /**
   * 「允许 AI 读取此应用的数据」的授权状态（**默认关**，2026-09-21 用户拍板）。
   *
   * 三条接线事实在这里一次说清：
   *  1. **一个实例、两个消费方** —— 本机路由（`/:app_id/ai-rows-consent`，人在面板上点）
   *     与宿主工具（`wasm_app_rows` 的闸门）共用下面这一个对象；
   *  2. **落盘位置** = `$DSH_HOME/wasm-apps-ai-rows-consent.json`（0600，原子写）——
   *     与 `server-connector/tls.ts` 的指纹库同一形态（企业插件既有的"随装小状态"落点）；
   *     不用 `ctx.settings`：那是用户可编辑的产品配置域，且 `bootstrap.ts` 在退出登录时
   *     会 `replace()` 清掉命名空间 ⇒ 授权会随重登消失；
   *  3. **数据根不可信时**（`dshHomeSafe()` 拒绝：DSH_HOME 指向系统关键目录）退化成
   *     **内存记录**（照样 fail-closed，只是重启即忘），而不是让插件 apply 失败。
   */
  const aiRowsConsentFile = ((): string | undefined => {
    try {
      return defaultAiRowsConsentPath()
    } catch (cause) {
      ctx.logger?.warn?.(`pico: resolving the data root for the AI rows consent failed (${cause instanceof Error ? cause.message : String(cause)}); the consent will not survive a restart`)
      return undefined
    }
  })()
  const aiRowsConsent = createAiRowsConsentStore({
    ...(aiRowsConsentFile === undefined ? {} : { file: aiRowsConsentFile }),
    warn: message => { ctx.logger?.warn?.(message) },
  })

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
      // 这里的语言按**每次渲染**解析：tapIndex 没有请求对象，取 desktopRuntime
      // 的当前值（用户刚在设置里切了语言时，下一次索引渲染立刻就变）。
      const locale = hostLocale()
      if (!ctx.picoSession.isRestored()) return restoringPage(locale)
      const restored = ctx.picoSession.getSession()
      // 0057: 会话带强制改密标记(管理员重置密码) → 一律回强制改密页,
      // 即使应用重启后仍在(业务 API 在改密完成前也被服务端 403)。
      if (restored !== null && restored.mustChangePassword === true) return renderChangePasswordPage(locale)
      if (!ctx.picoSession.isLoggedIn()) {
        // 未登录 ⇒ 这一页就是登录页:顺手用预置服务端武装深链守卫(见上)。
        armPendingBrowserLoginFromLoginPage()
        return loginPage(locale)
      }
      return html.replace('</head>',() => (SESSION_LOST_SCRIPT + '</head>'))
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/login',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          armPendingBrowserLoginFromLoginPage()
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(loginPage(hostLocale(req)))
        },
      }),

      // 0057 强制改密页(管理员重置密码后; 完成前业务 API 均被 403)。
      ctx.webServer.register({
        kind: 'exact', path: '/change-password',
        handler: (req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderChangePasswordPage(hostLocale(req)))
        },
      }),

      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/login',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          // FIX-18:会话变更类路由额外要求持有性证明(见 proofOfPossession)。
          // 残留②(2026-09-13):login 可换 server / 换账号 ⇒ 高危,fence 缺席时
          // fail-closed(503),不再退回只有同源标记的 guard()。
          if (!proofOfPossession(req, res, 'required')) return
          // 审计 2026-08-25 P2-2:body 上限 64KB(登录表单远小于此)。
          const raw = await collectBody(req, 64 * 1024).catch(() => null)
          if (raw === null) return json(res, 413, { error: 'body too large' })
          let body: { server?: unknown; username?: unknown; password?: unknown }
          try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
          if (typeof body.server !== 'string' || typeof body.username !== 'string' || typeof body.password !== 'string') {
            return json(res, 400, { error: 'missing fields' })
          }
          // FIX-18:已登录时**拒绝静默换服务端**——与深链路径(deep-link.ts:112-116)
          // 同一判定。此前 login 无条件 setSession,任意本机进程伪造 Origin 即可
          // 把整个会话换到攻击者服务端。切换必须先显式登出;同服务端换账号照常。
          const existing = session()
          if (loginServerSwitchConflict(existing, body.server)) {
            ctx.logger?.warn?.('pico: refused a server switch while signed in; sign out first')
            return json(res, 409, {
              error: 'already signed in to another server',
              hint: 'sign out before switching servers',
            })
          }
          try {
            const sess = await login(body.server, body.username, body.password, hostLocale(req))
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
          // FIX-18:改密同样是会话变更类操作,要求持有性证明。
          // 残留②(2026-09-13):改密必须先交出旧密码(本机伪造 Origin 的进程拿不出
          // 凭据)⇒ 低危,维持既有降级口径(best-effort,不锁死)。
          if (!proofOfPossession(req, res, 'best-effort')) return
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
          // FIX-18:登出也归"会话变更类"(防本机进程强制踢出)。产品内两个
          // 调用点(登录页、账号卡)都从本进程服务的页面发起,cookie 恒在。
          // 残留②(2026-09-13):强制登出是拒绝服务攻击面 ⇒ 高危,fence 缺席时
          // fail-closed(503),不用 guard() 放行。
          if (!proofOfPossession(req, res, 'required')) return
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

      // srvcore-1 客户端一半(审计 R7 F3-N1):登录页的浏览器 SSO 目标登记面。
      //
      // 为什么需要一条路由:登录页 HTML 由宿主进程下发,但页面脚本在**渲染进程**
      // 执行(contextIsolation/nodeIntegration 全关,见 desktop/src/window-options.ts),
      // 够不到宿主模块作用域的 `noteBrowserLoginStarted`;`window.open` 打开的又是
      // **远端** SSO 地址,不经过本地路由。没有这条面,`pendingBrowserLogin` 的
      // 判定分支永远不可达 —— 未登录时只剩 `assertServerURLAllowed`(https 域名
      // 一律放行),伪造深链就能把会话指向攻击者服务端且零告警。
      //
      // 口径与 login 相同(`required` 持有性证明):登记决定了后续深链允许采纳
      // 哪台服务端,若允许伪造 Origin 的本地进程登记,攻击者只要先登记自己的
      // 域名再触发深链,守卫反而成了帮凶。真页面(登录表单同口径)持有 dsh-auth-*
      // cookie,产品内调用方只有登录页。
      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/auth/browser-login',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST' && req.method !== 'DELETE') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          if (!proofOfPossession(req, res, 'required')) return
          if (req.method === 'DELETE') {
            clearBrowserLoginPending()
            json(res, 200, { ok: true, pending: false })
            return
          }
          const raw = await collectBody(req, 8 * 1024).catch(() => null)
          if (raw === null) return json(res, 413, { error: 'body too large' })
          let body: { server?: unknown }
          try { body = JSON.parse(raw.toString('utf8')) } catch { return json(res, 400, { error: 'bad json' }) }
          if (typeof body.server !== 'string' || body.server.trim() === '') {
            return json(res, 400, { error: 'missing server' })
          }
          const target = body.server.trim()
          // 与深链路径同一 scheme 校验:不合规的地址登记了也没用(identity=null),
          // 但在这里就拒掉能让登录页给出可读错误,而不是"授权完成却登不进去"。
          try {
            assertServerURLAllowed(target)
          } catch (error) {
            return json(res, 400, { error: error instanceof Error ? error.message : 'unsafe server' })
          }
          noteBrowserLoginStarted(target)
          json(res, 200, { ok: true, pending: true })
        },
      }),

      // v3b: 登录页渠道代理(公开, 无需 token): ?server=<url> 转发服务端
      // /api/client/v2/channel; 未传 server 且无 session 时回退**随包品牌**
      // (builtInChannel()) —— 登录页与客户端界面在服务端不可达时也得显示
      // 渠道自己的名字,而不是厂商名。
      ctx.webServer.register({
        kind: 'exact', path: '/api/pico/channel',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!guard(req, res)) return
          const s = session()
          let serverParam = ''
          try {
            serverParam = new URL(req.url ?? '/', 'http://localhost').searchParams.get('server') ?? ''
          } catch { /* ignore malformed query */ }
          const serverURL: string = serverParam || s?.serverURL || ''
          if (serverURL === '') return json(res, 200, builtInChannel(config.brand))
          try {
            assertServerURLAllowed(serverURL)
            const data = await fetchJSON(serverURL, '/api/client/v2/channel')
            // 上游必须是**像渠道内容**的载荷:否则原样透传会让客户端把垃圾当
            // 渠道内容存进 store,每个字段取不到值 → 回落内置厂商文案(白标事故,
            // 且零报错)。见 channel-content.ts 的 asChannelPayload。
            const payload = asChannelPayload(data)
            // 出口做两件事,顺序不能反:
            //  1) **绝对化**:服务端下发的 logo_url/favicon_url 是相对路径,而本端点
            //     的返回值会被客户端 store 直接存下交给 <img> 渲染 —— 相对路径在
            //     渲染层会打到本地 webServer 而 404,界面上就是裂图(2026-09-10 实测)。
            //  2) **逐字段叠加随包品牌**(mergeChannel,与 channel-sync 同一口径):
            //     服务端**不下发** `client.short_name`(侧边栏要的正是它),只透传服务端
            //     载荷会让这个字段整条丢失,侧边栏回落到显示名 "PicoAide Harness"
            //     在 184px 的行里换行成两行(2026-09-11 实测)。
            json(res, 200, payload === undefined
              ? builtInChannel(config.brand)
              : mergeChannel(builtInChannel(config.brand), absolutizeChannelAssets(payload, serverURL)))
          } catch {
            // 服务端不可达:给随包品牌而不是空载荷 —— 空载荷会让界面回落
            // 内置的厂商文案,那正是白标要防的。
            json(res, 200, builtInChannel(config.brand))
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
          // r7c-6(P2):写面(install/upload/uninstall)要求持有性证明,与 login 同口径。
          if (!requireWriteProof(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const pathname = url.pathname
          /**
           * **显式覆盖确认标记**（审计 2026-09-23 A2/A3/A15）。
           *
           * 面板在用户点过确认条之后才把 `?overwrite=1` 拼进 URL；宿主据此决定
           * 要不要拒绝"无确认的整树替换 / 删除本机内容"。契约（两端共用）：
           *  - 目标目录**不是**能力中心装的（无 provenance / 渠道非商店来源 /
           *    appId 对不上）⇒ 没有这个标记一律 409 `LOCAL_CONTENT`；
           *  - 目标目录是商店来源 ⇒ 不需要标记（正常更新/重装/卸载）。
           * ⚠️ 它与历史上的 `?force=1` **不是**一回事：那一个宿主从来没读过，
           * 是纯死面（R2-SK-5 记录在案）；这一个两端都必须读/写。
           */
          const overwrite = url.searchParams.get('overwrite') === '1'
          if (pathname === '/api/pico/skills' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/marketplace/skills', { token: s.token, locale: hostLocale(req) })
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
          // ---- 平台内置技能（随服务端镜像发布，客户端按需安装）----
          // 与市场/组织技能**共用同一条安装链路**（installSkillArchive：sha256
          // 对照 → 整树安全解包 → <dshHome>/skills），只换下载地址与来源标记。
          // 默认**不自动安装**：员工在能力中心点一次；清单里带 installed，界面
          // 据此显示「安装 / 已安装 / 更新到 vX」。
          if (pathname === '/api/pico/skills/builtin' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/skills/builtin', { token: s.token, locale: hostLocale(req) })
              const installed = await listInstalledSkills(resolveSkillsDir())
              json(res, 200, { ...data, installed })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              // 旧版服务端没有这条端点（404）：让面板把内置技能区整块隐藏，
              // 而不是显示一个空壳。原样透传状态码，不伪装成"没有内置技能"
              // （"伪装成空清单"会让运维永远查不出服务端少了这条路由）。
              if (cause instanceof ApiError && cause.status === 404) {
                return json(res, 404, { error: 'builtin skills unavailable' })
              }
              gatewayError(res, cause)
            }
            return
          }
          const builtinInstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/builtin\/([^/]+)\/install$/u.exec(pathname)
            : null
          if (builtinInstallMatch !== null) {
            const name = decodeURIComponent(builtinInstallMatch[1]!)
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              const upstream = await gatewayFetch(
                `${normalizeServerURL(s.serverURL)}/api/client/v2/skills/builtin/${encodeURIComponent(name)}/archive`,
                { headers: { Authorization: `Bearer ${s.token}` } },
              )
              if (!upstream.ok) return json(res, upstream.status, { error: 'gateway error' })
              const length = Number(upstream.headers.get('content-length') ?? '0')
              if (length > MAX_ARCHIVE_BYTES) {
                return json(res, 413, { error: 'archive too large' })
              }
              const archive = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (archive === null) return json(res, 413, { error: 'archive too large' })
              // 内置技能的这两个头不是可选项：内容是**我们自己的服务端**下发的，
              // 少了 checksum 就没有任何完整性凭据（skill-install 在没有该头时
              // 会静默跳过 sha256 对照），少了 version 就永远判不出「更新到 vX」。
              // 因此这里 fail-closed，而不是沿用市场通路那种"有就校验"的宽松口径。
              const checksum = upstream.headers.get('x-skill-checksum')
              const version = upstream.headers.get('x-skill-version')
              if (checksum === null || checksum === '' || version === null || version === '') {
                return json(res, 502, { error: 'builtin archive is missing its integrity headers; refused' })
              }
              const result = await installSkillArchive({
                name,
                archive,
                checksum,
                version,
                skillsDir: resolveSkillsDir(),
                // 溯源(D6)：标记为 builtin，与市场/组织区分开。
                channel: 'builtin',
                server: s.serverURL,
                // 覆盖本机同名自制内容必须由面板显式确认（审计 A2）。
                overwrite,
              })
              json(res, 200, { ok: true, name: result.name, version: result.version })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              // 分类 + 脱敏 + 状态码的唯一实现（审计 A12/A13）：拒绝 422、
              // 需要确认 409、系统级错误 502 且文案里没有本机路径。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
            }
            return
          }
          // POST /api/pico/skills/builtin/:name/uninstall -> local removal.
          // 审计 2026-09-23 A6：内置技能此前**只能装不能卸**（没有这条路由），
          // 装完在「我的」里变成一张本地卡、只有「上传」按钮，产品内没有任何
          // 入口能移除它。与市场卸载同口径：本地删除 + 来源校验 + 显式确认。
          const builtinUninstallMatch = req.method === 'POST'
            ? /^\/api\/pico\/skills\/builtin\/([^/]+)\/uninstall$/u.exec(pathname)
            : null
          if (builtinUninstallMatch !== null) {
            const name = decodeURIComponent(builtinUninstallMatch[1]!)
            try {
              validateSkillName(name)
            } catch (cause) {
              return json(res, 400, { error: cause instanceof Error ? cause.message : 'invalid name' })
            }
            try {
              // Purely local operation — no gateway round-trip needed.
              await uninstallSkill(resolveSkillsDir(), name, { overwrite })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
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
                // 覆盖本机同名自制内容必须由面板显式确认（审计 A2）。
                overwrite,
              })
              // 审计 2026-09-23 A11：**回传真实安装版本**。市场归档端点只按
              // "当前 approved 最高版"取（服务端不支持按版本安装），请求里带的
              // 版本号与真实落盘版本可能不同；面板据这里的 `version` 记账，而不是
              // 据"用户点的那一个版本"。
              json(res, 200, { ok: true, name: result.name, version: result.version })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              // 分类 + 脱敏 + 状态码的唯一实现（拒绝 422 / 需确认 409 / 系统级 502）。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
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
              // `overwrite` = 用户已确认删除本机自制内容（审计 A3）。
              await uninstallSkill(resolveSkillsDir(), name, { overwrite })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
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
              return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
            }
            const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
            if (content === null) {
              return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
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
          // r7c-6(P2):写面(install/upload/uninstall)要求持有性证明,与 login 同口径。
          if (!requireWriteProof(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          const presetsDir = resolvePresetsDir()
          /**
           * 覆盖/删除本机自制内容的显式确认标记（审计 2026-09-23 N2）。
           *
           * 与技能侧**同一份契约**（`/api/pico/skills*`、`/api/pico/shared-skills*`）：
           * 面板只在用户点过确认条 / 卸载第二段确认之后才把 `?overwrite=1` 拼进 URL。
           * 此前这条路由**不读任何 query**，而 `installPresetArchive` 对已存在目录
           * 一律拒收 ⇒ 面板的「更新智能体」必然失败（`preset "x" already exists locally`），
           * 同名的覆盖确认整条是死面。
           */
          const overwrite = new URL(req.url ?? '/', 'http://localhost').searchParams.get('overwrite') === '1'

          // GET /api/pico/agent-presets -> gateway catalog + installed + local.
          if (pathname === '/api/pico/agent-presets' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/agent-presets', { token: s.token, locale: hostLocale(req) })
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
                locale: hostLocale(req),
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
              // 打包/预检失败：分类 + 脱敏由 skill-install 统一给（拒绝 = 422，
              // 归档过大 = 413，系统级 = 502 且文案里不含本机路径）。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
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
                return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
              }
              const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (content === null) {
                return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
              }
              const checksum = upstream.headers.get('x-preset-checksum') ?? undefined
              const presetVersion = upstream.headers.get('x-preset-version') ?? undefined
              await installPresetArchive({
                name, archive: content, checksum, presetsDir,
                // 溯源(D6):与技能同构,记录版本/渠道/来源服务端。
                version: presetVersion, channel: 'org', server: s.serverURL,
                // 覆盖确认（审计 2026-09-23 N2）：与技能同一条 `?overwrite=1` 契约。
                overwrite,
              })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              // 分类 + 脱敏 + 状态码走**唯一实现**（审计 2026-09-23 A12：这里此前
              // 是裸分类 + 原文，系统级 errno 会把本机绝对路径透给 UI）。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
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
              // 与技能同口径（审计 A3/N2）：本机自制内容没有 `?overwrite=1` 一律拒收。
              await uninstallPreset(presetsDir, name, { overwrite })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
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
              return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
            }
            const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
            if (content === null) {
              return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
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
          // r7c-6(P2):写面(install/upload/uninstall)要求持有性证明,与 login 同口径。
          if (!requireWriteProof(req, res)) return
          const s = session()
          if (s === null) return json(res, 401, { error: 'not logged in' })
          if (req.method !== 'GET' && !writeGuard()) {
            return json(res, 403, { error: 'auditor cannot modify' })
          }
          const sharedUrl = new URL(req.url ?? '/', 'http://localhost')
          const pathname = sharedUrl.pathname
          // 显式覆盖确认标记：审计 A2/A3/A15 的两端契约，见 /api/pico/skills 分支的注释。
          const overwrite = sharedUrl.searchParams.get('overwrite') === '1'
          const skillsDir = resolveSkillsDir()

          if (pathname === '/api/pico/shared-skills' && req.method === 'GET') {
            try {
              const data = await fetchJSON(s.serverURL, '/api/client/v2/shared-skills', { token: s.token, locale: hostLocale(req) })
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
              const packed = await packSkill(skillsDir, name, version, hostLocale(req))
              const gateway = await fetchJSON(s.serverURL, '/api/client/v2/shared-skills', {
                token: s.token,
                locale: hostLocale(req),
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
              // 打包/预检失败：分类 + 脱敏由 skill-install 统一给（拒绝 = 422，
              // 归档过大 = 413，系统级 = 502 且文案里不含本机路径）。
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
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
                return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
              }
              const content = await readBodyLimited(upstream.body, MAX_ARCHIVE_BYTES).catch(() => null)
              if (content === null) {
                return json(res, 413, { error: archiveTooLarge(hostLocale(req)) })
              }
              const checksum = upstream.headers.get('x-skill-checksum') ?? undefined
              const ver = upstream.headers.get('x-skill-version') ?? version
              const result = await installSkillArchive({
                name,
                archive: content,
                checksum,
                skillsDir,
                version: ver,
                channel: 'org',
                server: s.serverURL,
                // 覆盖本机同名自制内容必须由面板显式确认（审计 A2）。
                overwrite,
              })
              // 真实落盘版本以响应为准（审计 A11：请求里的版本可能被服务端忽略）。
              json(res, 200, { ok: true, name, version: result.version ?? ver })
            } catch (cause) {
              if (cause instanceof AuthError && cause.kind === 'auth_expired') {
                ctx.picoSession.clear()
                return json(res, 401, { error: 'auth expired' })
              }
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
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
              await uninstallSkill(skillsDir, name, { overwrite })
              json(res, 200, { ok: true, name })
            } catch (cause) {
              const failure = describeArchiveFailure(cause)
              json(res, failure.status, {
                error: failure.message,
                ...failure.code === undefined ? {} : { code: failure.code },
              })
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
          // r7c-6(P2):写面(install/upload/uninstall)要求持有性证明,与 login 同口径。
          if (!requireWriteProof(req, res)) return
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
            const data = await fetchJSON(s.serverURL, `/api/client/v2/capabilities?source=${encodeURIComponent(matchSource)}`, { token: s.token, locale: hostLocale(req) })
            const items = (data as { items?: Array<Record<string, unknown>> }).items ?? []
            const installedSkills = new Set(await listInstalledSkills(skillsDir))
            const installedPresets = new Set(await listInstalledPresets(presetsDir))
            const localSkills = await listLocalSkills(skillsDir)
            const localPresets = await listLocalPresets(presetsDir)
            // installedVersion:优先读安装器写的 .install-version 标记
            // (可靠);否则退回 SKILL.md frontmatter 的 version(best-effort)。
            const localSkillVersions = new Map<string, string | undefined>()
            /** 本机那一份的来源：'store'（能力中心装的）/'local'（用户自制）——审计 A2/A3。 */
            const skillOrigins = new Map<string, 'store' | 'local'>()
            const presetOrigins = new Map<string, 'store' | 'local'>()
            // 审计 2026-09-12 P1-6:共享 Agent 的已装版本此前**恒为 undefined**
            // (`kind === 'skill' ? localSkillVersions.get(name) : undefined`),而
            // 客户端 `hasUpdateFor()` 一见 undefined 就返回 false ⇒ 能力中心
            // 对共享 Agent 永远不显示「更新到 vX」。版本事实在磁盘上是有的:
            // agent-preset-install.ts 的安装器与技能一样写了
            // `.picoaide/release.json`(provenance),这里按 kind 选 map。
            const localPresetVersions = new Map<string, string | undefined>()
            // 溯源(D6):优先读 .picoaide/release.json(应用 ID/渠道/版本 +
            // 安装时内容哈希),回退旧 .install-version 标记;并重算当前内容
            // 哈希判定「是否被本地修改过」。
            const provenance = new Map<string, { appId: string, channel: string, version: string, dirty: boolean }>()
            for (const r of localSkills) {
              const dir = join(skillsDir, r.name)
              const prov = await readProvenance(dir)
              // 来源判定（审计 A2/A3）：面板据 installedOrigin 决定"更新/卸载要不要确认"。
              // 与安装器/卸载器的判据同一份实现（isStoreProvenance）。
              skillOrigins.set(r.name, isStoreProvenance(prov, r.name) ? 'store' : 'local')
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
              const marker = join(dir, INSTALL_VERSION_FILE)
              const mv = await readFile(marker, 'utf8').then(s => s.trim()).catch(() => undefined)
              localSkillVersions.set(r.name, mv ?? r.version)
            }
            // 共享 Agent 同上:provenance(.picoaide/release.json)优先,回退
            // `.install-version`。preset.yml 没有 version 字段,所以没有
            // 「frontmatter 兜底」这一层——读不到就留 undefined,由客户端
            // hasUpdateFor 保守判 false(宁可不提示,不可误报)。
            for (const l of localPresets) {
              const dir = join(presetsDir, l.name)
              const v = await readInstalledPresetVersion(dir)
              if (v !== undefined) localPresetVersions.set(l.name, v)
              // 与技能同一份来源判据（共享 Agent 的 provenance 同格式）。
              presetOrigins.set(l.name, isStoreProvenance(await readProvenance(dir), l.name) ? 'store' : 'local')
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
                // 本机那一份的来源（审计 A2/A3）。builtin/plugin 的本地行靠它渲染「卸载」。
                installedOrigin: skillOrigins.get(l.name) ?? 'local',
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
                installedOrigin: presetOrigins.get(l.name) ?? 'local',
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
                  fetchJSON(s.serverURL, `/api/client/v2/capabilities?source=market`, { token: s.token, locale: hostLocale(req) }).catch(() => ({ items: [] })),
                  fetchJSON(s.serverURL, `/api/client/v2/capabilities?source=org`, { token: s.token, locale: hostLocale(req) }).catch(() => ({ items: [] })),
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
                    // 审计 2026-09-12 P1-6:`?source=local` 的商店行此前**不带**
                    // installedVersion ⇒ 面板 hasUpdateFor 恒 false,「更新到 vX」
                    // 对已装共享 Agent 永不出现(与 enriched 分支同源修复)。
                    installedVersion: installedVersionFor(
                      (i as { kind?: string }).kind ?? '',
                      (i as { name?: string }).name ?? '',
                      localSkillVersions,
                      localPresetVersions,
                    ),
                    // 来源（审计 A2/A3）：与 enriched 分支同源（同一个 helper）。
                    installedOrigin: installedOriginFor(
                      (i as { kind?: string }).kind ?? '',
                      (i as { name?: string }).name ?? '',
                      skillOrigins,
                      presetOrigins,
                    ),
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

            // 已装版本:best-effort。技能 = provenance/.install-version →
            // SKILL.md frontmatter;共享 Agent = provenance/.install-version
            // (preset.yml 无 version 字段,故无 frontmatter 兜底)。客户端
            // `hasUpdateFor()` 依赖这里的 installedVersion:undefined ⇒ 恒 false。
            const enriched = items.map(i => {
              const kind = i.kind as string
              const name = i.name as string
              const installed = kind === 'skill' ? installedSkills.has(name) : installedPresets.has(name)
              const installedVersion = installedVersionFor(kind, name, localSkillVersions, localPresetVersions)
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
                // 来源（审计 A2/A3）：只对"本机真的装了"的行给，未装时 undefined。
                installedOrigin: installed ? installedOriginFor(kind, name, skillOrigins, presetOrigins) : undefined,
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
      // WASM 应用平台的本地操作面（§8 第 10 项 / §4.2 的客户端上传契约）：
      // 目录 + 预检 + 发布编排（>8 MiB 分片续传、90 s 预算）+ 生命周期代理。
      // 复用同一套 guard/requireWriteProof/session/collectBody，不另立一套围栏。
      ctx.webServer.register(createWasmAppsRoute(ctx, {
        guard,
        requireWriteProof,
        // GET 也要证明显（行数据面）：同一份持有性证明原语，策略由路由决定。
        requireProof: (req, res) => proofOfPossession(req, res, 'required'),
        writeGuard,
        session,
        json,
        collectBody,
        hostLocale,
        // 「允许 AI 读取此应用的数据」的授权状态（默认关，2026-09-21 用户拍板）：
        // 面板经本机路由写它、`wasm_app_rows` 读它 —— **同一个实例**（下面那个
        // registerWasmAppTools 拿到的就是它）。
        aiRowsConsent,
      })),
      // WASM 应用平台的**宿主工具面**（§6.5b）：让 AI 能自己预检与发布，而不是
      // 只能请员工去应用中心点。工具直接调用上面那条路由背后的**同一批编排
      // 函数**（wasm-apps.ts 的 publishApp/validateApp/listCatalog/readAppRows…）——
      // 不经 HTTP，因此不需要浏览器持有性证明，也不会把员工令牌交给任何调用方。
      // 语言按**每次调用**解析（hostLocale 是 apply 作用域里的函数，不在模块级冻结）。
      registerWasmAppTools(ctx, { locale: () => hostLocale(), aiRowsConsent }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'pico auth-gate routes')
}
