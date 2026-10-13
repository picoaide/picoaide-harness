import { loadElectronModule } from "./electron.js";
import { DEFAULT_HOST_LOCALE, hostCopy } from "@picoaide/dsh-host-locale";
//#region src/auth.ts
/**
* "这个 401 **就是**令牌无效/缺令牌"的码集合（R21-A2-01，客户端一半）。
*
* 服务端（`serverauth`）在 401 上共用三个码，语义并不相同：
*  - `AUTH_REQUIRED`（没带令牌）、`AUTH_FAILED`（令牌无效/已过期/被吊销）—— 只有这两个
*    是"重新登录能解决"；
*  - `AUDITOR_NOT_ALLOWED`（审计账号不可登录客户端）—— **账号类型被拒**，凭据本身没问题
*    （登录面由 `login()` 单独分流给"请用管理后台"的文案）。
*
* 为什么必须按码分流：`AuthError('auth_expired')` 在 auth-gate 的 13 处调用点会
* `ctx.picoSession.clearIfCurrent(该次请求用的令牌)`（R22-V1-N3：只在"当前会话仍是
* 发起这次请求时那一个"时才清），而 `clear()` 会**删掉磁盘上的 `$DSH_HOME/session.json`**
* —— 把"账号/动作被禁"或"服务端读不了认证存储（500）"误判成"令牌无效"，等于一次存储
* 抖动、或一次不该发生的 401，就把全体在线员工登出并抹掉本机令牌（LDAP/OIDC 还要重走
* IdP）。服务端那一半（存储故障回 500）见 R21-A2-01 的 FIX-2 泳道。
*/
const AUTH_EXPIRED_CODES = ["AUTH_REQUIRED", "AUTH_FAILED"];
/**
* 服务端"先改密"守卫的稳定错误码（`serverauth/handler.go` 对
* `password_must_change` 用户白名单外的一切接口回 `403 {error:{code}}`）。
*
* 它**必须**在客户端被当成契约而不是一句文案：`fetchJSON` 会把它放进
* `ApiError.code`，auth-gate 的代理层按码回 403 + 可操作路径（此前被压成
* `502 {"error":"gateway error: …"}` ⇒ 码丢了、面板只剩一句被包了一层的文本，
* 任何"把用户送回改密页"的分支都无从下手）。R15B-02，2026-09-25。
*/
const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED";
/**
* 该错误是不是"服务端要求先改密"。
*
* 判据只看码（不看 message）：服务端文案是中文散文、可随时改，而码是稳定契约
* —— 与 `AccountSection` 从"嗅探中文原文"改为"读稳定码"是同一口径。
* @param cause - 任意被捕获的值。
* @returns true 表示必须先改密再重试。
*/
function isPasswordChangeRequired(cause) {
	return cause instanceof ApiError && cause.code === "PASSWORD_CHANGE_REQUIRED";
}
/**
* 「先改密」应答里给界面的动作名（R15B-02）。
*
* 与 `code` 一样是**跨端契约**：面板/账号页据此把用户送到改密页，而不是各写各的
* 文案匹配。客户端已有的那条路径是 `/change-password`（auth-gate 的精确路由，
* 也是索引渲染在 `mustChangePassword` 时给出的页面）。
*/
const PASSWORD_CHANGE_REQUIRED_ACTION = "change-password";
/**
* User-facing message per auth failure kind (shown by the login page).
*
* 这些消息**用户可见**: 登录页把 `AuthError.message` 原样渲染出来, 所以按宿主
* 语言取文案。语言由调用方**按请求**解析后传入(见 auth-gate.ts 的 hostLocale);
* 缺省中文 = 历史行为(account-card 等不发语言的调用方行为不变)。
* @param kind - 认证失败类别。
* @param locale - 宿主语言。
* @returns 该语言的用户可见文案。
*/
function authErrorMessage(kind, locale = DEFAULT_HOST_LOCALE) {
	switch (kind) {
		case "invalid_credentials": return hostCopy(locale, "账号或密码错误", "Incorrect username or password");
		case "auth_expired": return hostCopy(locale, "登录已过期，请重新登录", "Your session has expired. Please sign in again.");
		case "network": return hostCopy(locale, "网络错误，请检查网络连接", "Network error — check your connection");
		case "server_error": return hostCopy(locale, "服务端错误，请稍后重试", "Server error — please try again later");
	}
}
var AuthError = class extends Error {
	kind;
	constructor(kind, message, locale = DEFAULT_HOST_LOCALE) {
		super(message ?? authErrorMessage(kind, locale));
		this.kind = kind;
		this.name = "AuthError";
	}
};
var ApiError = class extends Error {
	code;
	status;
	constructor(code, message, status) {
		super(message);
		this.code = code;
		this.status = status;
		this.name = "ApiError";
	}
};
/**
* Normalize a user-entered server URL: trim whitespace and strip one or more
* trailing slashes so `https://host/` and `https://host` behave identically.
* The login page brands/methods probes and every gateway request go through
* here — a trailing slash must never produce `//api/...` path segments.
*/
function normalizeServerURL(input) {
	let s = input.trim();
	while (s.length > 0 && s.endsWith("/")) s = s.slice(0, -1);
	return s;
}
async function electronSessionFetch() {
	const f = (await loadElectronModule())?.session?.defaultSession?.fetch;
	return typeof f === "function" ? f : null;
}
async function gatewayFetch(input, init) {
	const sessionFetch = await electronSessionFetch();
	const url = typeof input === "string" ? input : input.toString();
	if (sessionFetch) return sessionFetch(url, init);
	return fetch(input, init);
}
/**
* Re-check that a server URL is allowed on every use (not only at login):
* https, or http restricted to loopback hosts. Prevents a persisted session
* from steering credentials or tokens at an arbitrary http:// target later.
*/
function assertServerURLAllowed(serverURL) {
	let parsed;
	try {
		parsed = new URL(serverURL);
	} catch {
		throw new AuthError("server_error", "invalid server url");
	}
	const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new AuthError("server_error", "server must use https (http only for localhost)");
}
/**
* 登录网关。`locale` 只影响**本地生成**的用户可见文案(账号或密码错误等);
* 服务端下发的消息原样透出(服务端文案不在 i18n 范围内)。
* @param serverURL - 服务端地址(尾部斜杠会被归一)。
* @param username - 账号。
* @param password - 密码。
* @param locale - 宿主语言(调用方按请求解析)。
* @returns 已建立的会话。
*/
async function login(serverURL, username, password, locale = DEFAULT_HOST_LOCALE) {
	const server = normalizeServerURL(serverURL);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15e3);
	try {
		assertServerURLAllowed(server);
		const res = await gatewayFetch(`${server}/api/client/v2/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username,
				password
			}),
			signal: controller.signal
		});
		if (res.status === 401) {
			if ((await res.json().catch(() => null))?.error?.code === "AUDITOR_NOT_ALLOWED") throw new AuthError("server_error", hostCopy(locale, "审计账号不可登录客户端,请使用管理后台", "Audit accounts cannot sign in to the desktop client. Please use the admin console."));
			throw new AuthError("invalid_credentials", void 0, locale);
		}
		if (!res.ok) throw new AuthError("server_error", `HTTP ${res.status}`);
		const data = await res.json();
		if (!data.token) throw new AuthError("server_error", "missing token in response");
		const sess = {
			serverURL: server,
			username,
			token: data.token
		};
		if (data.user?.role) sess.role = data.user.role;
		if (data.user?.source !== void 0) sess.source = data.user.source;
		if (data.user?.password_changeable !== void 0) sess.passwordChangeable = data.user.password_changeable;
		if (data.must_change_password === true) sess.mustChangePassword = true;
		return sess;
	} catch (e) {
		if (e instanceof AuthError) throw e;
		if (controller.signal.aborted) throw new AuthError("network", "timeout");
		throw new AuthError("network", e instanceof Error ? e.message : "network error");
	} finally {
		clearTimeout(timer);
	}
}
/**
* 0057 员工自助改密(本地认证用户): 成功后服务端吊销该用户全部令牌(含当前),
* 调用方必须清除本地会话并让用户重新登录。
* 失败时抛出携带服务端中文消息的错误(原密码错误/外部用户/长度不足等)。
*/
async function changePassword(serverURL, token, oldPassword, newPassword) {
	const server = normalizeServerURL(serverURL);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15e3);
	try {
		assertServerURLAllowed(server);
		const res = await gatewayFetch(`${server}/api/client/v2/auth/password`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`
			},
			body: JSON.stringify({
				old_password: oldPassword,
				new_password: newPassword
			}),
			signal: controller.signal
		});
		if (res.ok) return;
		const message = (await res.json().catch(() => null))?.error?.message ?? `HTTP ${res.status}`;
		if (res.status === 401 || res.status === 403) throw new AuthError("invalid_credentials", message);
		throw new ApiError(`HTTP_${res.status}`, message);
	} catch (e) {
		if (e instanceof AuthError || e instanceof ApiError) throw e;
		if (controller.signal.aborted) throw new AuthError("network", "timeout");
		throw new AuthError("network", e instanceof Error ? e.message : "network error");
	} finally {
		clearTimeout(timer);
	}
}
async function fetchJSON(serverURL, path, opts = {}) {
	const server = normalizeServerURL(serverURL);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15e3);
	let res;
	try {
		assertServerURLAllowed(server);
		res = await gatewayFetch(`${server}${path}`, {
			method: opts.method ?? "GET",
			headers: {
				"Content-Type": "application/json",
				...opts.token ? { Authorization: `Bearer ${opts.token}` } : {}
			},
			...opts.body !== void 0 ? { body: JSON.stringify(opts.body) } : {},
			signal: controller.signal
		});
	} catch (e) {
		if (e instanceof AuthError) throw e;
		if (controller.signal.aborted) throw new AuthError("network", "timeout");
		throw new AuthError("network", e instanceof Error ? e.message : "network error");
	} finally {
		clearTimeout(timer);
	}
	let data = null;
	let parseFailed = false;
	try {
		data = await res.json();
	} catch {
		parseFailed = true;
	}
	if (!res.ok) {
		const env = data?.error;
		const code = env?.code ?? `HTTP_${res.status}`;
		const message = env?.message ?? `HTTP ${res.status}`;
		if (res.status === 401 && (code === "HTTP_401" || AUTH_EXPIRED_CODES.includes(code))) throw new AuthError("auth_expired", message);
		throw new ApiError(code, message, res.status);
	}
	if (parseFailed && res.status !== 204) {
		const ct = res.headers.get("content-type") ?? "";
		const locale = opts.locale ?? DEFAULT_HOST_LOCALE;
		if (ct.includes("text/html")) throw new ApiError("NOT_JSON", hostCopy(locale, "服务端返回了 HTML 页面而非 JSON,请确认地址指向 API 服务根,而非门户/SPA 页面", "The server returned an HTML page instead of JSON; make sure the address points at the API root, not a portal/SPA page"));
		throw new ApiError("UPSTREAM", hostCopy(locale, "网关响应不是合法 JSON", "The gateway response is not valid JSON"));
	}
	return data;
}
//#endregion
export { ApiError, AuthError, PASSWORD_CHANGE_REQUIRED_ACTION, PASSWORD_CHANGE_REQUIRED_CODE, assertServerURLAllowed, authErrorMessage, changePassword, fetchJSON, gatewayFetch, isPasswordChangeRequired, login, normalizeServerURL };

//# sourceMappingURL=auth.js.map