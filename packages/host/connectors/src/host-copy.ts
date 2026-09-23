/**
 * Connectors HOST copy: the user-visible strings this package produces in the
 * Host process (errors thrown into the connector row, the OAuth loopback
 * callback page, the refresh engine's failure messages).
 *
 * Why this module exists
 * ----------------------
 * The client half has its own dictionary (`src/client/locales.ts`) driven by
 * `ctx.locale`, but Host code cannot reach that service — `ctx.locale` lives in
 * the client face. The shared resolver is `@picoaide/dsh-host-locale`
 * (the zero-dependency leaf package; `dsh-plugin-desktop/host-locale` re-exports
 * the same module for the host surfaces that already import it):
 * probed `desktopRuntime.locale` (the user's in-app choice) → request
 * `Accept-Language` → `zh`.
 *
 * Locale discipline (2026-09-16 i18n)
 * ----------------------------------
 * Every producer resolves the locale **when it builds the message**, through
 * {@link hostLocaleOf} / {@link hostT} — never in a module-level constant. The
 * root cause this rule prevents is documented in
 * `src/client/status-label.ts`: a `const X = t(...)` evaluated at module load
 * captures the default language forever, and only a test that switches language
 * *between two real producer calls* can catch it. `tests/host-copy.spec.ts`
 * holds that test for this module.
 *
 * `zh` is the source: its values are byte-identical to the strings this package
 * shipped before translation, so Chinese output does not move.
 *
 * @module
 */
import { DEFAULT_HOST_LOCALE, hostCopy as pickHostCopy, hostLocaleFrom, type HostLocale } from '@picoaide/dsh-host-locale'

/**
 * Structural view of a context that can hand out the probed desktop runtime.
 *
 * Deliberately minimal (the same probe `desktop-loop-notify` uses): headless
 * loader smokes and plain-browser compositions have no `desktopRuntime`, and a
 * host plugin must keep working there.
 */
export interface HostCopySource {
  get(name: string): unknown
}

/** Chinese copy — the source language, byte-identical to the pre-i18n strings. */
const zh = {
  // ---- outbound URL policy (src/outbound.ts) ------------------------------
  'outbound.notUrl': '{what} 不是合法 URL: {url}',
  'outbound.notHttps': '{what} 只允许 https（或本地回环 http）: {target}',
  'outbound.credentials': '{what} 不允许在 URL 中携带用户名/密码: {target}',
  'outbound.blocked': '{what} 指向内网/链路本地/元数据地址，已拒绝: {target}',
  'outbound.notLoopback': '{what} 使用 http 但主机不是回环地址: {target}',
  'outbound.localHostname': '{what} 指向本机主机名，已拒绝: {target}',
  'outbound.blockedResolved': '{what} 的域名解析到内网/链路本地/回环地址，已拒绝: {target} -> {address}',
  'outbound.mcpFenceOrigin': 'MCP 传输缝拒绝向未登记的来源发请求: {what} {target}（本连接器允许的来源: {allowed}）',
  'outbound.mcpFenceOriginNone': '（无）',
  'outbound.badDeadline': '出站请求截止时间非法（timeoutMs={timeoutMs}），必须为正数',
  'outbound.timeout': '{what} 出站请求超时（{timeoutMs}ms 内未完成），已中止: {host}',
  'outbound.redirect': '{what} 返回重定向（{detail}），按出站策略拒绝跟随: {host}',

  // ---- flow-step labels embedded into the messages above ------------------
  'step.mcpEndpoint': 'MCP 端点',
  'step.mcpTransportRequest': 'MCP 传输请求',
  'step.registrationEndpoint': 'OAuth 客户端注册端点',
  'step.authorizationEndpoint': 'OAuth 授权端点',
  'step.tokenEndpoint': 'OAuth token 端点',
  'step.deviceVerification': '设备授权验证地址',
  'step.mcpEndpointNamed': 'MCP 端点 {serverName}',

  // ---- OAuth / device / server-side auth flows (src/auth.ts) --------------
  'auth.registrationFailed': 'OAuth 客户端注册失败: HTTP {status}',
  'auth.registrationMissingClientId': 'OAuth 客户端注册响应缺少 client_id',
  'auth.mcpProbeFailed': 'MCP 端点响应异常: HTTP {status}',
  'auth.discoveryFailed': 'MCP OAuth 发现失败: 服务器要求授权但未找到 OAuth 元数据',
  'auth.flowCancelled': 'OAuth 授权已取消: {reason}',
  'auth.userCancelled': '用户取消',
  'auth.flowTimeout': '等待授权超时（5 分钟）',
  'auth.callbackPage': '<html><body><p>授权完成，可以关闭此窗口。</p></body></html>',
  'auth.callbackFailed': 'OAuth 授权失败: {error}',
  'auth.callbackMissingCode': 'OAuth 回调缺少 code',
  'auth.noClientId': 'OAuth 服务器不支持动态客户端注册，且未配置固定 clientId',
  'auth.tokenExchangeFailed': 'OAuth token 换取失败: HTTP {status}',
  'auth.tokenMissingAccessToken': 'OAuth token 响应缺少 access_token',
  'auth.pollTimeout': '授权轮询超时，请重试',
  'auth.deviceUnverifiable': '该连接器声明为设备码授权但未定义任何凭据字段，无法验证授权是否完成；请改用具名 token 字段或 OAuth 模式',
  'auth.deviceVerificationUrlMissing': '该连接器声明为设备码授权，但没有可用的验证地址（verificationUrl 缺失或为空）——这是连接器定义的错误，请联系管理员修正后重试',
  'auth.serverMissingFetchToken': '服务端连接器定义缺少 fetchToken 回调',
  'auth.serverNoToken': '服务端未返回 token',

  // ---- connector definition problems (src/policy.ts) ----------------------
  'policy.notObject': 'mcp 项不是对象',
  'policy.serverNameInvalid': 'serverName 不合规: {serverName}',
  'policy.transportUnsupported': 'transport 不支持: {transport}',
  'policy.httpMissingUrl': 'streamable-http 缺少 url',
  'policy.urlNotAllowed': 'url 不在允许的出站范围内: {url}',
  'policy.stdioMissingCommand': 'stdio 缺少 command',
  'policy.commandNul': 'command 含 NUL',
  'policy.argsNotStringArray': 'args 必须是字符串数组',
  'policy.envNotMapping': 'env 必须是字符串映射',
  'policy.envKeyDenied': 'env 键不被允许（受保护或为空）: {key}',
  'policy.envTemplateValue': 'env.{key} 的值不是单个程序名（含空白/shell 元字符或命令解释器，会被当作命令模板执行）: {value}',
  'policy.envValueNotString': 'env.{key} 必须是字符串',
  'policy.headersNotMapping': 'headers 必须是字符串映射',
  'policy.headerValueNotString': 'headers 的值必须是字符串',
  'policy.mcpNotArray': 'mcp 必须是非空数组',
  'policy.credentialFieldKeyDenied': '{group} 的 key 不被允许: {key}',

  // ---- token refresh engine (src/mcp-oauth-provider.ts) -------------------
  'refresh.publicMcp': 'MCP 端点公开可用，无需令牌',
  'refresh.invalidTokenUrl': 'token 端点不是合法 URL',
  'refresh.noTokenEndpoint': '连接器未声明 token 端点',
  'refresh.discoveryNoTokenEndpoint': '无法从 MCP 端点发现 token 端点',
  'refresh.noCredential': '没有可用的凭据',
  'refresh.noRefreshToken': '凭据不含 refresh token，无法自动续期',
  'refresh.authorizationServerResolveFailed': '授权服务器解析失败：{message}',
  'refresh.missingMcpEndpoint': '连接器未声明 MCP 端点',
  'refresh.notCompleted': '授权服务器未完成令牌刷新，需要重新授权',
  'refresh.tokenExpired': 'refresh token 已失效，需要重新授权',
  'refresh.grantRejected': '授权服务器拒绝了刷新（{code}），需要重新授权',
  'refresh.requestRejected': '授权服务器永久拒绝了这次刷新请求（{code}），已停止自动重试；请检查该连接器的授权配置后手动重试',
  'refresh.failed': '令牌刷新失败：{message}',
  'refresh.missingAccessToken': '令牌刷新未返回 access_token',
  'refresh.notConnected': '连接器 {id} 尚未连接',
  'refresh.unsupported': '连接器 {id} 不支持令牌刷新',
  'refresh.outboundBlocked': '令牌刷新被出站策略拒绝：{message}',

  // ---- credential scope (src/store.ts + the restore pass) -----------------
  // R6-B-2：升级前保存的凭据没有服务端标记，无法判定它属于哪个租户 ⇒ 不沿用
  // （旧文件原样留在磁盘上），该连接器回到「需要授权」。凭据现在按
  // 「账号 + 服务端」隔离：换一个服务端不会读到上一个服务端的凭据。
  'store.rescopeRequired': '这条连接器升级前保存的凭据没有标记服务端，出于安全不再沿用（凭据文件仍保留在原处）——请重新授权一次',

  // ---- streamable-http redirect fence (src/mcp-transport-fence.ts) --------
  // Diagnostic seam-verification throws. They are developer diagnostics, but
  // `registerMcp` embeds them verbatim into the row's rejected[] text, so they
  // follow the locale like every other message the panel can show.
  'fence.notInstanceField': 'MCP streamable-http 传输的 {field} 不是实例自有字段（SDK 的请求字段形状已变更，实例级加固无处落笔）',
  'fence.requestInitNotFenced': 'MCP streamable-http 传输的 {field} 未被拦截（SDK 内部字段或构造方式已变更）',
  'fence.notInterceptable': 'MCP streamable-http 传输的 {field} 不可拦截',
  'fence.fetchNotFenced': 'MCP streamable-http 传输的 {field} 未被拦截（GET/SSE 通道会回落到默认 fetch 并跟随重定向）',
  'fence.noHardenedFetch': 'MCP streamable-http 传输未提供 {field} 的加固包装（默认 fetch 会跟随重定向）',
  'fence.fetchWithInitNotManual': "MCP streamable-http 传输的 {field} 未强制 redirect:'manual'",
  'fence.sendNotManual': "MCP streamable-http 传输未强制 redirect:'manual'",
  'fence.sseNotFenced': 'MCP streamable-http 传输的 GET(SSE) 流未经过可拦截的 fetch（重定向栅栏对 SSE 通道无效）',
  'fence.sseNotManual': "MCP streamable-http 传输的 GET(SSE) 流未强制 redirect:'manual'",
  'fence.resumeNotManual': "MCP streamable-http 传输的 resumeStream() 未强制 redirect:'manual'",
  'fence.targetUnresolved': '无法定位 MCP streamable-http 传输实现: {detail}',
  'fence.targetMismatch': 'MCP streamable-http 传输加固目标与 mcp-client 不一致（{detail}），拒绝注册',
  'fence.foreignImport': '已安装的 dsh-mcp-client 构建并不 import 本护栏加固的 SDK 包（{detail}），拒绝注册',
  'fence.notHardened': 'MCP streamable-http 传输不可加固: {error}',
  'fence.verificationFailed': 'MCP streamable-http 重定向栅栏校验失败: {error}',
  'fence.oursLabel': '本包',
  'fence.policyNotApplied': 'MCP streamable-http 传输未施加出站 URL 策略（SDK 给的 URL 会被真实请求，凭据头随之外送）',
  'fence.sameOriginHeadersDropped': 'MCP streamable-http 传输把连接器自带的请求头丢掉了（同源请求收不到凭据头）',
  'fence.credentialHeaderCrossOrigin': 'MCP streamable-http 传输把连接器自带凭据头发给了其它来源',

  // ---- plugin lifecycle / auth-flow outcomes (src/index.ts) ---------------
  'flow.superseded': '连接意图已被更新的请求取代',
  'flow.userSwitchedRegistration': '用户已切换，连接器注册中止',
  'flow.userSwitchedConnect': '用户已切换，连接流程中止',
  'flow.pluginUnloadRegistration': '插件卸载，连接器注册中止',
  'flow.pluginUnloadConnect': '插件卸载，连接流程中止',
  'flow.userDisconnected': '用户在连接过程中断开了连接',
  'flow.userCancelled': '用户取消了连接',
  'flow.reconnectCancelled': '连接器重新连接，旧授权流程已取消',
  'flow.approvalDenied': '用户拒绝了本地执行确认，未启动本地命令',
  'flow.approvalDeniedRow': '本地执行确认被拒绝，未启动本地命令',
  'flow.authRequired': '需要先完成授权：当前凭据被服务端拒绝（点击「连接」重新授权）',
  'flow.fenceUnavailable': '{serverName}: streamable-http 出站重定向栅栏不可用，拒绝连接（{error}）',
  'flow.refreshUnsupported': '该连接器不支持令牌刷新',
  'flow.serverNameTaken': '本地 MCP 名「{serverName}」已被连接器「{by}」接管（服务端要求 serverName 唯一），本连接器的 MCP 注册已停止',
} as const

/** English mirror — every key of {@link zh}, same parameter names. */
const en: Record<keyof typeof zh, string> = {
  'outbound.notUrl': '{what} is not a valid URL: {url}',
  'outbound.notHttps': '{what} must use https (or http on loopback): {target}',
  'outbound.credentials': '{what} must not carry a username/password in the URL: {target}',
  'outbound.blocked': '{what} points at a private, link-local or metadata address and was refused: {target}',
  'outbound.notLoopback': '{what} uses http but the host is not a loopback address: {target}',
  'outbound.localHostname': "{what} points at this machine's own hostname and was refused: {target}",
  'outbound.blockedResolved': '{what} resolves to a private, link-local or loopback address and was refused: {target} -> {address}',
  'outbound.mcpFenceOrigin': 'The MCP transport fence refused a request to an origin this connector never registered: {what} {target} (allowed origins: {allowed})',
  'outbound.mcpFenceOriginNone': '(none)',
  'outbound.badDeadline': 'Invalid outbound request deadline (timeoutMs={timeoutMs}); it must be a positive number',
  'outbound.timeout': '{what} outbound request timed out (not finished within {timeoutMs}ms) and was aborted: {host}',
  'outbound.redirect': '{what} answered with a redirect ({detail}); the outbound policy refuses to follow it: {host}',

  'step.mcpEndpoint': 'MCP endpoint',
  'step.mcpTransportRequest': 'MCP transport request',
  'step.registrationEndpoint': 'OAuth client registration endpoint',
  'step.authorizationEndpoint': 'OAuth authorization endpoint',
  'step.tokenEndpoint': 'OAuth token endpoint',
  'step.deviceVerification': 'device authorization verification URL',
  'step.mcpEndpointNamed': 'MCP endpoint {serverName}',

  'auth.registrationFailed': 'OAuth client registration failed: HTTP {status}',
  'auth.registrationMissingClientId': 'OAuth client registration response has no client_id',
  'auth.mcpProbeFailed': 'Unexpected MCP endpoint response: HTTP {status}',
  'auth.discoveryFailed': 'MCP OAuth discovery failed: the server requires authorization but published no OAuth metadata',
  'auth.flowCancelled': 'OAuth authorization cancelled: {reason}',
  'auth.userCancelled': 'cancelled by the user',
  'auth.flowTimeout': 'timed out waiting for authorization (5 minutes)',
  'auth.callbackPage': '<html lang="en"><body><p>Authorization complete. You can close this window.</p></body></html>',
  'auth.callbackFailed': 'OAuth authorization failed: {error}',
  'auth.callbackMissingCode': 'OAuth callback is missing the code',
  'auth.noClientId': 'The OAuth server does not support dynamic client registration and no fixed clientId is configured',
  'auth.tokenExchangeFailed': 'OAuth token exchange failed: HTTP {status}',
  'auth.tokenMissingAccessToken': 'OAuth token response has no access_token',
  'auth.pollTimeout': 'Authorization polling timed out; please retry',
  'auth.deviceUnverifiable': 'This connector uses device-code authorization but declares no credential field, so completion cannot be verified; declare a token field or use the OAuth mode instead',
  'auth.deviceVerificationUrlMissing': 'This connector uses device-code authorization but has no usable verification URL (verificationUrl is missing or blank) — the connector definition is invalid; ask an administrator to fix it and retry',
  'auth.serverMissingFetchToken': 'The server-side connector definition has no fetchToken callback',
  'auth.serverNoToken': 'The server returned no token',

  'policy.notObject': 'mcp entry is not an object',
  'policy.serverNameInvalid': 'invalid serverName: {serverName}',
  'policy.transportUnsupported': 'unsupported transport: {transport}',
  'policy.httpMissingUrl': 'streamable-http is missing url',
  'policy.urlNotAllowed': 'url is outside the allowed outbound range: {url}',
  'policy.stdioMissingCommand': 'stdio is missing command',
  'policy.commandNul': 'command contains NUL',
  'policy.argsNotStringArray': 'args must be an array of strings',
  'policy.envNotMapping': 'env must be a string mapping',
  'policy.envKeyDenied': 'env key is not allowed (protected or empty): {key}',
  'policy.envTemplateValue': 'the value of env.{key} is not a single program name (it contains whitespace/shell metacharacters or a command interpreter, so it would run as a command template): {value}',
  'policy.envValueNotString': 'env.{key} must be a string',
  'policy.headersNotMapping': 'headers must be a string mapping',
  'policy.headerValueNotString': 'headers values must be strings',
  'policy.mcpNotArray': 'mcp must be a non-empty array',
  'policy.credentialFieldKeyDenied': '{group} declares a key that is not allowed: {key}',

  'refresh.publicMcp': 'The MCP endpoint is public; no token is needed',
  'refresh.invalidTokenUrl': 'the token endpoint is not a valid URL',
  'refresh.noTokenEndpoint': 'The connector declares no token endpoint',
  'refresh.discoveryNoTokenEndpoint': 'Could not discover a token endpoint from the MCP endpoint',
  'refresh.noCredential': 'No usable credential',
  'refresh.noRefreshToken': 'The credential has no refresh token, so it cannot be renewed automatically',
  'refresh.authorizationServerResolveFailed': 'Failed to resolve the authorization server: {message}',
  'refresh.missingMcpEndpoint': 'The connector declares no MCP endpoint',
  'refresh.notCompleted': 'The authorization server did not complete the token refresh; authorization is required again',
  'refresh.tokenExpired': 'The refresh token is no longer valid; authorization is required again',
  'refresh.grantRejected': 'The authorization server refused the refresh ({code}); authorization is required again',
  'refresh.requestRejected': 'The authorization server permanently refused this refresh request ({code}); automatic retries have stopped — check the connector authorization settings, then retry manually',
  'refresh.failed': 'Token refresh failed: {message}',
  'refresh.missingAccessToken': 'The token refresh returned no access_token',
  'refresh.notConnected': 'Connector {id} is not connected',
  'refresh.unsupported': 'Connector {id} does not support token refresh',
  'refresh.outboundBlocked': 'Token refresh was refused by the outbound policy: {message}',

  'store.rescopeRequired': 'This connector\'s pre-upgrade credential carries no server marker, so it is deliberately not reused (the old credential file is kept on disk) — please authorize once more. Credentials are now isolated per account AND per server, so switching servers can no longer read the previous one\'s.',

  'fence.notInstanceField': "MCP streamable-http transport: {field} is not an own field of the instance (the SDK's request-field shape changed, so there is nowhere to harden the instance)",
  'fence.requestInitNotFenced': "MCP streamable-http transport: {field} was not intercepted (the SDK's internal field or construction changed)",
  'fence.notInterceptable': 'MCP streamable-http transport: {field} cannot be intercepted',
  'fence.fetchNotFenced': 'MCP streamable-http transport: {field} was not intercepted (the GET/SSE channel would fall back to the default fetch and follow redirects)',
  'fence.noHardenedFetch': 'MCP streamable-http transport does not provide a hardened wrapper for {field} (the default fetch follows redirects)',
  'fence.fetchWithInitNotManual': "MCP streamable-http transport: {field} does not force redirect:'manual'",
  'fence.sendNotManual': "MCP streamable-http transport does not force redirect:'manual'",
  'fence.sseNotFenced': 'MCP streamable-http transport: the GET (SSE) stream does not go through an interceptable fetch (the redirect fence does not cover the SSE channel)',
  'fence.sseNotManual': "MCP streamable-http transport: the GET (SSE) stream does not force redirect:'manual'",
  'fence.resumeNotManual': "MCP streamable-http transport: resumeStream() does not force redirect:'manual'",
  'fence.targetUnresolved': 'Cannot locate the MCP streamable-http transport implementation: {detail}',
  'fence.targetMismatch': 'The MCP streamable-http transport the fence hardens is not the one mcp-client uses ({detail}); registration refused',
  'fence.foreignImport': 'The installed dsh-mcp-client build does not import the SDK package this fence hardens ({detail}); registration refused',
  'fence.notHardened': 'The MCP streamable-http transport cannot be hardened: {error}',
  'fence.verificationFailed': 'MCP streamable-http redirect fence verification failed: {error}',
  'fence.oursLabel': 'this package',
  'fence.policyNotApplied': 'The MCP streamable-http transport does not apply the outbound URL policy (a URL the resource server names would really be requested, taking the credential headers with it)',
  'fence.sameOriginHeadersDropped': 'The MCP streamable-http transport dropped the connector\'s own request headers (the same-origin request no longer carries its credential header)',
  'fence.credentialHeaderCrossOrigin': 'The MCP streamable-http transport sent the connector\'s credential headers to another origin',

  'flow.superseded': 'The connect request was superseded by a newer one',
  'flow.userSwitchedRegistration': 'The user changed; connector registration was aborted',
  'flow.userSwitchedConnect': 'The user changed; the connect flow was aborted',
  'flow.pluginUnloadRegistration': 'The plugin was unloaded; connector registration was aborted',
  'flow.pluginUnloadConnect': 'The plugin was unloaded; the connect flow was aborted',
  'flow.userDisconnected': 'The user disconnected while the connection was in progress',
  'flow.userCancelled': 'The user cancelled the connection',
  'flow.reconnectCancelled': 'The connector reconnected; the previous authorization flow was cancelled',
  'flow.approvalDenied': 'The user refused the local execution confirmation; no local command was started',
  'flow.approvalDeniedRow': 'The local execution confirmation was refused; no local command was started',
  'flow.authRequired': 'Authorization is required first: the server rejected the current credential (click "Connect" to authorize again)',
  'flow.fenceUnavailable': '{serverName}: the streamable-http outbound redirect fence is unavailable; connection refused ({error})',
  'flow.refreshUnsupported': 'This connector does not support token refresh',
  'flow.serverNameTaken': 'The local MCP name "{serverName}" was taken over by connector "{by}" (serverName must be unique); this connector\'s MCP registration has stopped',
}

/** Every host copy key of this package. */
export type HostCopyKey = keyof typeof zh

/**
 * Resolve the host locale of a Host context **at call time**.
 *
 * Deliberately a function, never a value: `desktopRuntime.locale` follows the
 * user's in-app language switch, so a cached answer is the bug this module
 * exists to avoid (see the header).
 * @param source - the plugin context (or any object with `get`).
 * @returns the locale to render host copy in.
 */
export function hostLocaleOf(source: HostCopySource | undefined): HostLocale {
  let runtime: { readonly locale?: unknown } | undefined
  try {
    runtime = source?.get('desktopRuntime') as { readonly locale?: unknown } | undefined
  } catch {
    // A context without the service (or with a throwing probe) falls through to
    // the request/default resolution inside hostLocaleFrom.
    runtime = undefined
  }
  return hostLocaleFrom(runtime)
}

/**
 * Translate one host copy key for a locale (zh is the source, en mirrors the
 * full key set). Parameters are `{name}` placeholders.
 * @param locale - the locale resolved for THIS message.
 * @param key - dictionary key.
 * @param params - placeholder values.
 * @returns the rendered string.
 */
export function hostT(locale: HostLocale, key: HostCopyKey, params?: Record<string, string>): string {
  let text: string = pickHostCopy(locale, zh[key] as string, en[key])
  if (params !== undefined) {
    // ONE pass over the template: a chained `replaceAll` per parameter re-scans
    // the values it just inserted, so a value carrying another key's `{name}`
    // token would be rewritten (2026-09-16 R9/R2 audit — `{permission}` is
    // model-supplied).
    text = text.replace(/\{(\w+)\}/gu, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match))
  }
  return text
}

/**
 * English labels for the flow-step names callers pass to the outbound policy.
 *
 * The `what` argument stays the Chinese label (that is the byte-identical
 * source string), so the mapping lives here instead of at every call site.
 * Labels that are already English (`OAuth resource metadata`, a test's
 * `probe`) pass through unchanged in both locales.
 */
const EN_STEP_LABELS: Record<string, string> = {
  [zh['step.mcpEndpoint']]: en['step.mcpEndpoint'],
  [zh['step.mcpTransportRequest']]: en['step.mcpTransportRequest'],
  [zh['step.registrationEndpoint']]: en['step.registrationEndpoint'],
  [zh['step.authorizationEndpoint']]: en['step.authorizationEndpoint'],
  [zh['step.tokenEndpoint']]: en['step.tokenEndpoint'],
  [zh['step.deviceVerification']]: en['step.deviceVerification'],
}

/**
 * Render one `what` label for a locale.
 *
 * zh returns the label verbatim (byte-identical source); en maps the known
 * labels and passes anything else — including the `MCP 端点 <serverName>` shape
 * `policy.ts` builds — through with only the known prefix translated.
 * @param locale - the locale resolved for THIS message.
 * @param what - the caller's step label.
 * @returns the label to embed in the error.
 */
export function stepLabel(locale: HostLocale, what: string): string {
  if (locale !== 'en') return what
  const exact = EN_STEP_LABELS[what]
  if (exact !== undefined) return exact
  const named = `${zh['step.mcpEndpoint']} `
  if (what.startsWith(named)) return `${en['step.mcpEndpoint']} ${what.slice(named.length)}`
  return what
}

/** Product-default host locale, re-exported for the deep modules' defaults. */
export { DEFAULT_HOST_LOCALE }
export type { HostLocale }
