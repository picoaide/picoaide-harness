import { userScopePath } from "./user-scope.js";
import { ConnectorStore } from "./store.js";
import { salesEasyDef } from "./sales-easy.js";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
//#region src/loopback.ts
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
	return isIPv4Loopback(normalized);
}
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}
/**
* Request-level trust fence: a loopback socket address AND a loopback Host
* header, plus browser same-origin markers. A bare curl from the same host
* passes the socket/Host checks; a cross-site browser request is refused.
*/
function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/**
* Browser-signal tripwire, NOT an authority check: a bare curl sends neither
* header and is refused, but a curl with a forged Origin passes this too.
* The real boundary is the loopback socket + Host + origin-equality checks
* in isLoopbackRequest; do not rely on this marker alone.
*/
function browserSameOriginMarker(req) {
	return req.headers["sec-fetch-site"] === "same-origin" || typeof req.headers.origin === "string";
}
//#endregion
//#region src/auth.ts
const deviceProbes = /* @__PURE__ */ new Map();
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_TIMEOUT_MS = 3e5;
const TOKEN_REQUEST_TIMEOUT_MS = 6e4;
async function sleep(ms, signal) {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("Aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
function throwIfAborted(signal) {
	if (signal.aborted) throw new Error("Aborted");
}
/** RFC 7636 PKCE S256. */
function pkce() {
	const verifier = randomBytes(48).toString("base64url");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url")
	};
}
/** RFC 7591 dynamic client registration; returns the issued client id. */
async function registerClient(auth, redirectUri, registrationEndpoint) {
	const response = await fetch(registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "PicoAide Harness Connector",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: auth.publicClient ? "none" : "client_secret_basic"
		})
	});
	if (!response.ok) throw new Error(`OAuth 客户端注册失败: HTTP ${response.status}`);
	const data = await response.json();
	if (!data.client_id) throw new Error("OAuth 客户端注册响应缺少 client_id");
	return data.client_id;
}
/**
* MCP OAuth discovery (spec 2025-06-18): probe the MCP endpoint; a 2xx means
* public. On 401, resolve the authorization server through RFC 9728
* protected-resource metadata (URL from the WWW-Authenticate header, fallback
* `/.well-known/oauth-protected-resource`), then RFC 8414 metadata at the
* authorization server.
*/
async function discoverMcpOAuth(mcpUrl) {
	const mcp = new URL(mcpUrl);
	const resource = mcp.origin + mcp.pathname.replace(/\/+$/, "");
	const probe = await fetch(mcpUrl, { headers: {
		Accept: "text/event-stream",
		"MCP-Protocol-Version": "2025-06-18"
	} });
	if (probe.status >= 200 && probe.status < 300) return {
		publicMcp: true,
		resource
	};
	if (probe.status !== 401 && probe.status !== 403) throw new Error(`MCP 端点响应异常: HTTP ${probe.status}`);
	const authHeader = probe.headers.get("www-authenticate") ?? "";
	const resourceMetadataCandidates = [/resource_metadata="([^"]+)"/.exec(authHeader)?.[1], `${mcp.origin}/.well-known/oauth-protected-resource`].filter((url) => Boolean(url));
	for (const metadataUrl of [...new Set(resourceMetadataCandidates)]) {
		const metadataResponse = await fetch(metadataUrl, { headers: { Accept: "application/json" } });
		if (!metadataResponse.ok) continue;
		const authorizationServer = (await metadataResponse.json()).authorization_servers?.[0];
		if (!authorizationServer) continue;
		const asUrl = new URL(authorizationServer);
		asUrl.pathname = `${asUrl.pathname.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
		const metadataResponse2 = await fetch(asUrl, { headers: { Accept: "application/json" } });
		if (!metadataResponse2.ok) continue;
		const meta = await metadataResponse2.json();
		if (!meta.authorization_endpoint || !meta.token_endpoint) continue;
		const scopes = meta.scopes_supported?.includes("offline_access") ? "offline_access" : meta.scopes_supported?.[0];
		return {
			authorizationEndpoint: meta.authorization_endpoint,
			tokenEndpoint: meta.token_endpoint,
			...meta.registration_endpoint ? { registrationEndpoint: meta.registration_endpoint } : {},
			...scopes ? { scopes } : {},
			resource
		};
	}
	throw new Error("MCP OAuth 发现失败: 服务器要求授权但未找到 OAuth 元数据");
}
/** Run an oauth2 authorization-code flow with PKCE and a loopback callback. */
async function runOAuth(def, options) {
	const auth = def.auth;
	const discovered = auth.discoveryUrl ? await discoverMcpOAuth(auth.discoveryUrl) : void 0;
	if (discovered?.publicMcp) return { updatedAt: Date.now() };
	const callbackHost = options.callbackHost ?? "127.0.0.1";
	const { verifier, challenge } = pkce();
	const state = randomBytes(24).toString("base64url");
	let resolveCode;
	let rejectCode;
	let callbackServer = null;
	const codePromise = new Promise((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	const OAuthFlowTimeoutMs = 3e5;
	const abortFlow = (reason) => {
		callbackServer?.close();
		callbackServer?.closeIdleConnections?.();
		callbackServer = null;
		rejectCode(/* @__PURE__ */ new Error(`OAuth 授权已取消: ${reason}`));
	};
	const onAbort = () => abortFlow(options.signal.reason instanceof Error ? options.signal.reason.message : String(options.signal.reason ?? "用户取消"));
	options.signal.addEventListener("abort", onAbort, { once: true });
	const flowTimer = setTimeout(() => abortFlow("等待授权超时（5 分钟）"), OAuthFlowTimeoutMs);
	const port = await new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://${callbackHost}:${port}`);
			if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
				res.writeHead(404);
				res.end("not found");
				return;
			}
			const codeParam = url.searchParams.get("code");
			const errorParam = url.searchParams.get("error");
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				Connection: "close"
			});
			res.end("<html><body><p>授权完成，可以关闭此窗口。</p></body></html>");
			server.close();
			server.closeIdleConnections();
			callbackServer = null;
			if (errorParam) {
				rejectCode(/* @__PURE__ */ new Error(`OAuth 授权失败: ${errorParam}`));
				return;
			}
			if (codeParam) resolveCode(codeParam);
			else rejectCode(/* @__PURE__ */ new Error("OAuth 回调缺少 code"));
		});
		server.listen(0, callbackHost, () => {
			resolve(server.address().port);
		});
		server.on("error", reject);
		callbackServer = server;
	});
	const redirectUri = `http://${callbackHost}:${port}/callback`;
	const registrationEndpoint = discovered?.registrationEndpoint ?? auth.registrationEndpoint;
	const clientId = registrationEndpoint ? await registerClient(auth, redirectUri, registrationEndpoint) : auth.clientId || "";
	if (!clientId) throw new Error("OAuth 服务器不支持动态客户端注册，且未配置固定 clientId");
	const codeChallengeMethod = auth.pkce ? "S256" : void 0;
	const authorizeUrl = new URL(discovered?.authorizationEndpoint ?? auth.authorizeUrl);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("client_id", clientId);
	authorizeUrl.searchParams.set("redirect_uri", redirectUri);
	authorizeUrl.searchParams.set("state", state);
	const scopes = discovered?.scopes ?? auth.scopes;
	if (scopes) authorizeUrl.searchParams.set("scope", scopes);
	if (auth.pkce) {
		authorizeUrl.searchParams.set("code_challenge", challenge);
		authorizeUrl.searchParams.set("code_challenge_method", codeChallengeMethod ?? "S256");
	}
	if (discovered?.resource) authorizeUrl.searchParams.set("resource", discovered.resource);
	options.onRequest({
		connectorId: def.id,
		authorizeUrl: authorizeUrl.toString()
	});
	const code = await codePromise;
	options.signal.removeEventListener("abort", onAbort);
	clearTimeout(flowTimer);
	callbackServer = null;
	throwIfAborted(options.signal);
	const tokenUrl = options.tokenUrlOverride ?? discovered?.tokenEndpoint ?? auth.tokenUrl;
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: clientId
	});
	if (discovered?.resource) body.set("resource", discovered.resource);
	if (auth.pkce) body.set("code_verifier", verifier);
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal: AbortSignal.any([options.signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)])
	});
	if (!response.ok) throw new Error(`OAuth token 换取失败: HTTP ${response.status}`);
	const data = await response.json();
	const accessToken = String(data.access_token ?? "");
	if (!accessToken) throw new Error("OAuth token 响应缺少 access_token");
	return {
		accessToken,
		clientId,
		...typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}
	};
}
/** Refresh an access token through the connector's token endpoint. */
async function refreshOAuthToken(def, credential, options = {}) {
	if (def.authMode !== "oauth" || !credential.refreshToken) return null;
	const auth = def.auth;
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: credential.refreshToken,
		client_id: credential.clientId ?? auth.clientId
	});
	if (auth.discoveryUrl) {
		const mcp = new URL(auth.discoveryUrl);
		body.set("resource", mcp.origin + mcp.pathname.replace(/\/+$/, ""));
	}
	let tokenUrl = options.tokenUrlOverride ?? auth.tokenUrl;
	if (!tokenUrl && auth.discoveryUrl) tokenUrl = (await discoverMcpOAuth(auth.discoveryUrl)).tokenEndpoint ?? "";
	if (!tokenUrl) return null;
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)
	});
	if (!response.ok) return null;
	const data = await response.json();
	const accessToken = String(data.access_token ?? "");
	if (!accessToken) return null;
	return {
		accessToken,
		...typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}
	};
}
/** Device-code flow: surface verification URL + user code, poll until connected. */
async function runDevice(def, options) {
	const probe = deviceProbes.get(def.id);
	if (probe) return probe(def, options);
	const auth = def.auth;
	options.onRequest({
		connectorId: def.id,
		verificationUrl: auth.verificationUrl
	});
	return pollUntilConnected(createProbe(def, options), auth.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, auth.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, options.signal);
}
function createProbe(def, options) {
	return { isConnected: async () => true };
}
async function pollUntilConnected(probe, pollIntervalMs, pollTimeoutMs, signal) {
	const deadline = Date.now() + pollTimeoutMs;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		await sleep(pollIntervalMs, signal);
		if (await probe.isConnected()) return { updatedAt: Date.now() };
	}
	throw new Error("授权轮询超时，请重试");
}
/** Token form flow: emit the field list; the UI answers with the values. */
async function runToken(def, options) {
	const fields = def.tokenFields ?? [];
	options.onRequest({
		connectorId: def.id,
		fields
	});
	return { updatedAt: Date.now() };
}
/** Server-side flow: fetch the managed token through the injected callback. */
async function runServerSide(def, options) {
	const auth = def.auth;
	options.onRequest({ connectorId: def.id });
	const accessToken = await auth.fetchToken();
	if (!accessToken) throw new Error("服务端未返回 token");
	return { accessToken };
}
/** Run the auth flow for a connector; returns the credential patch to persist. */
async function runAuth(def, options) {
	switch (def.authMode) {
		case "oauth": return runOAuth(def, options);
		case "device": return runDevice(def, options);
		case "token": return runToken(def, options);
		case "server-side": return runServerSide(def, options);
	}
}
//#endregion
//#region src/defs/index.ts
/**
* Marketplace connector definitions (决策 2026-08-25:CLI 连接器已移除——
* CLI 即 skill,由技能市场承载;连接器只保留 MCP 类)。
*/
const marketplaceDefs = [{
	"id": "moka",
	"name": "Moka HR 智能体",
	"description": "招聘和人事一体的 AI 同事，把查询与执行收进一个对话。人才推荐、招聘动态、考勤绩效、审批待办，一句话问清；智能寻聘、面试分析与面试官评估，一句话发起。",
	"authMode": "oauth",
	"auth": {
		"discoveryUrl": "https://mcp.mokahr.com/mcp",
		"clientId": "",
		"authorizeUrl": "",
		"tokenUrl": "",
		"redirectUri": "http://127.0.0.1/callback",
		"pkce": true,
		"publicClient": true,
		"scopes": "offline_access"
	},
	"mcp": [{
		"serverName": "moka",
		"transport": "streamable-http",
		"url": "https://mcp.mokahr.com/mcp"
	}]
}, {
	id: "glitchtip",
	name: "GlitchTip",
	description: "GlitchTip(Sentry 兼容错误追踪):查询 issue 与最新事件堆栈,用于错误排查与监控告警",
	authMode: "token",
	tokenFields: [
		{
			key: "GLITCHTIP_BASE_URL",
			label: "服务地址(必填,如自部署地址或 app.glitchtip.com)",
			type: "text",
			required: true
		},
		{
			key: "GLITCHTIP_TOKEN",
			label: "API Token(Auth Tokens 页创建,需 org:read / project:read / event:read)",
			type: "password",
			required: true
		},
		{
			key: "GLITCHTIP_ORGANIZATION",
			label: "组织 slug(如 picoaide)",
			type: "text",
			required: true
		}
	],
	examples: [
		"查询当前未解决的错误 issue",
		"查看最近一次异常的堆栈详情",
		"列出错误追踪中的高优先级问题"
	],
	mcp: [{
		serverName: "glitchtip",
		transport: "stdio",
		command: "npx",
		args: ["-y", "glitchtip-mcp"],
		env: {}
	}]
}];
//#endregion
//#region src/index.ts
/**
* Connector framework (mirrors WorkBuddy's connector service):
* a registry of connector definitions, per-connector auth orchestration
* (oauth redirect / device-code poll / token form / cli / server-side),
* local token persistence, and dynamic MCP registration through
* `ctx.plugin` once a connector connects.
*
* Exposes a loopback HTTP API consumed by the client settings UI:
*   GET  /api/pico/connectors                -> list with states
*   POST /api/pico/connectors/:id/connect    -> start auth flow
*   POST /api/pico/connectors/:id/auth-submit-> token form values
*   GET  /api/pico/connectors/:id/state      -> poll status + pending request
*   POST /api/pico/connectors/:id/disconnect -> stop and forget
*/
const name = "pico-connectors";
const inject = ["webServer"];
/** Cap on connector API request bodies (settings forms are small). */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
function json(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
async function readJson(req) {
	const chunks = [];
	let received = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		received += buffer.byteLength;
		if (received > MAX_REQUEST_BODY_BYTES) return null;
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}
/** Decode one path segment, rejecting malformed escapes instead of throwing. */
function decodeSegment(segment) {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}
function exact(handler) {
	return (req, res) => {
		Promise.resolve(handler(req, res)).catch((error) => {
			console.error("[dsh-connectors] handler failed", error);
			if (!res.headersSent) json(res, 500, { error: "internal error" });
		});
	};
}
function apply(ctx, options = {}) {
	const defs = dedupeById([...marketplaceDefs, ...options.connectors ?? []], [salesEasyDef]);
	const currentUser = () => {
		try {
			return ctx.get("picoSession")?.getSession?.()?.username ?? null;
		} catch {
			return null;
		}
	};
	let store = new ConnectorStore(options.storeBaseDir ? { baseDir: options.storeBaseDir } : { username: currentUser() });
	const states = /* @__PURE__ */ new Map();
	const pendingRequests = /* @__PURE__ */ new Map();
	const mcpDisposers = /* @__PURE__ */ new Map();
	/** In-flight auth flows keyed by connector id: disconnect/cancel aborts them. */
	const pendingFlows = /* @__PURE__ */ new Map();
	/** Drop all MCP registrations and reset in-memory state (user switch). */
	const teardownAll = async () => {
		for (const dispose of mcpDisposers.values()) try {
			dispose();
		} catch {}
		mcpDisposers.clear();
		for (const flow of pendingFlows.values()) flow.abort(/* @__PURE__ */ new Error("用户已切换，连接流程中止"));
		pendingFlows.clear();
		pendingRequests.clear();
		states.clear();
	};
	/** Rebuild per-user store/runtime after a login/logout/switch. */
	const reconfigureUser = () => {
		const username = currentUser();
		migrateLegacyStore(username);
		if (!options.storeBaseDir) store = new ConnectorStore({ username });
	};
	ctx.on("pico/session-changed", (next) => {
		(async () => {
			await teardownAll();
			reconfigureUser();
			if (next !== null) await restoreAll();
		})().catch((cause) => {
			ctx.logger?.error("pico-connectors: session change handling failed", cause);
		});
	});
	const setState = (id, patch) => {
		const current = states.get(id) ?? {
			status: "disconnected",
			everConnected: false
		};
		states.set(id, {
			...current,
			...patch
		});
	};
	const getDef = (id) => defs.find((def) => def.id === id);
	const emitRequest = (request) => {
		pendingRequests.set(request.connectorId, request);
	};
	/** Render request headers: static `${FIELD}` templates from credential fields, empty Authorization -> Bearer token, and the default Bearer injection for OAuth/token credentials. */
	const renderHeaders = (server, credential) => {
		const headers = {};
		for (const [name, value] of Object.entries(server.headers ?? {})) {
			if (value === "") {
				if (credential?.accessToken) headers[name] = `Bearer ${credential.accessToken}`;
				continue;
			}
			headers[name] = value.replace(/\$\{([^}]+)\}/g, (_, key) => credential?.fields?.[key] ?? "");
		}
		if (Object.keys(headers).length === 0 && credential?.accessToken) headers.Authorization = `Bearer ${credential.accessToken}`;
		return headers;
	};
	/** Merge connector definitions, keeping the hand-written ones when ids collide with generated defs. */
	function dedupeById(generated, handWritten) {
		const ids = new Set(handWritten.map((def) => def.id));
		return [...handWritten, ...generated.filter((def) => !ids.has(def.id))];
	}
	/** Register the connector's MCP servers through the mcp-client plugin. */
	const registerMcp = async (def) => {
		const credential = await store.readCredential(def.id);
		const { apply: applyMcpClient } = await import("@deepseek-ai/dsh-mcp-client");
		for (const server of def.mcp) {
			const config = server.transport === "streamable-http" ? {
				transport: "streamable-http",
				serverName: server.serverName,
				url: server.url ?? "",
				headers: renderHeaders(server, credential),
				toolCallTimeoutMs: 12e4,
				failOnStartupError: false
			} : {
				transport: "stdio",
				serverName: server.serverName,
				command: server.command ?? "",
				args: server.args ?? [],
				env: {
					...server.env ?? {},
					...process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
					...credential?.accessToken ? { PICOAIDE_CONNECTOR_ACCESS_TOKEN: credential.accessToken } : {},
					...credential?.refreshToken ? { PICOAIDE_CONNECTOR_REFRESH_TOKEN: credential.refreshToken } : {},
					...credential?.fields ?? {}
				},
				cwd: process.cwd(),
				toolCallTimeoutMs: 12e4,
				failOnStartupError: false
			};
			const fiber = await ctx.plugin({
				inject: ["tools"],
				apply: applyMcpClient,
				name: "mcp-client"
			}, config);
			mcpDisposers.set(server.serverName, () => {
				fiber?.dispose?.();
			});
		}
	};
	const unregisterMcp = async (def) => {
		for (const server of def.mcp) {
			const dispose = mcpDisposers.get(server.serverName);
			if (dispose) {
				dispose();
				mcpDisposers.delete(server.serverName);
			}
		}
	};
	/** Start the auth flow for a connector (background for poll-based modes). */
	const startConnect = async (id) => {
		const def = getDef(id);
		if (!def) throw new Error(`unknown connector: ${id}`);
		if (pendingFlows.has(id)) return;
		const existing = await store.readCredential(id);
		setState(id, {
			status: "connecting",
			everConnected: Boolean(existing) || Boolean(states.get(id)?.everConnected)
		});
		if (def.settings?.length) {
			if (def.settings.filter((field) => field.required && !existing?.fields?.[field.key]?.trim()).length > 0) {
				emitRequest({
					connectorId: id,
					fields: def.settings
				});
				return;
			}
		}
		pendingRequests.delete(id);
		const controller = new AbortController();
		pendingFlows.set(id, controller);
		try {
			const patch = await runAuth(def, {
				onRequest: emitRequest,
				signal: controller.signal,
				...existing?.fields ? { fields: existing.fields } : {}
			});
			if (def.authMode === "token") {
				setState(id, { status: "connecting" });
				return;
			}
			const current = await store.readCredential(id);
			await store.updateCredential(id, {
				...current,
				...patch
			});
			await registerMcp(def);
			setState(id, {
				status: "connected",
				everConnected: true,
				connectedAt: Date.now(),
				error: void 0
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const unauthorized = message.includes("授权") || message.includes("token") || message.includes("登录");
			if (controller.signal.aborted) setState(id, {
				status: "disconnected",
				everConnected: Boolean(states.get(id)?.everConnected),
				error: void 0
			});
			else setState(id, {
				status: unauthorized ? "unauthorized" : "error",
				error: message
			});
		} finally {
			pendingFlows.delete(id);
		}
	};
	const submitAuth = async (id, fields) => {
		const def = getDef(id);
		if (!def) throw new Error(`unknown connector: ${id}`);
		const current = await store.readCredential(id);
		await store.updateCredential(id, { fields: {
			...current?.fields ?? {},
			...fields
		} });
		if (def.authMode === "token") {
			await registerMcp(def);
			setState(id, {
				status: "connected",
				everConnected: true,
				connectedAt: Date.now(),
				error: void 0
			});
			pendingRequests.delete(id);
			return;
		}
		await startConnect(id);
	};
	const disconnect = async (id) => {
		const def = getDef(id);
		if (def) await unregisterMcp(def);
		const flow = pendingFlows.get(id);
		if (flow) flow.abort(/* @__PURE__ */ new Error("用户在连接过程中断开了连接"));
		await store.clearCredential(id);
		setState(id, {
			status: "disconnected",
			everConnected: false,
			error: void 0,
			connectedAt: void 0
		});
		pendingRequests.delete(id);
	};
	/** Restore all connector MCP registrations for the CURRENT user. */
	const restoreAll = async () => {
		for (const def of defs) try {
			const credential = await store.readCredential(def.id);
			if (!credential) continue;
			const refreshed = await refreshOAuthToken(def, credential);
			if ((refreshed ? await store.updateCredential(def.id, refreshed) : credential).accessToken) {
				await registerMcp(def);
				setState(def.id, {
					status: "connected",
					everConnected: true
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.logger.error(`pico-connectors: failed to restore ${def.id}: ${message}`);
			setState(def.id, {
				status: "error",
				error: message
			});
		}
	};
	ctx.effect(() => {
		return () => {
			for (const dispose of mcpDisposers.values()) dispose();
			for (const flow of pendingFlows.values()) flow.abort(/* @__PURE__ */ new Error("插件卸载，连接流程中止"));
			pendingFlows.clear();
		};
	}, "pico connectors: restore + cleanup");
	ctx.effect(() => {
		const list = (_req, res) => {
			json(res, 200, { connectors: defs.map((def) => {
				const state = states.get(def.id) ?? {
					status: "disconnected",
					everConnected: false
				};
				return {
					id: def.id,
					name: def.name,
					description: def.description,
					icon: def.icon ?? null,
					authMode: def.authMode,
					examples: def.examples ?? [],
					request: pendingRequests.get(def.id) ?? null,
					...state
				};
			}) });
		};
		const connect = (req, res) => {
			const rawId = decodeSegment(req.url?.split("/")[4] ?? "");
			if (rawId === null) return json(res, 400, { error: "malformed connector id" });
			const id = rawId;
			if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` });
			const stale = pendingFlows.get(id);
			if (stale) {
				stale.abort(/* @__PURE__ */ new Error("连接器重新连接，旧授权流程已取消"));
				pendingFlows.delete(id);
				pendingRequests.delete(id);
			}
			const request = { connectorId: id };
			emitRequest(request);
			startConnect(id).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				setState(id, {
					status: "error",
					error: message
				});
			});
			json(res, 200, {
				ok: true,
				request
			});
		};
		const cancel = (req, res) => {
			const rawId = decodeSegment(req.url?.split("/")[4] ?? "");
			if (rawId === null) return json(res, 400, { error: "malformed connector id" });
			const id = rawId;
			if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` });
			const flow = pendingFlows.get(id);
			if (flow) flow.abort(/* @__PURE__ */ new Error("用户取消了连接"));
			setState(id, {
				status: "disconnected",
				everConnected: Boolean(states.get(id)?.everConnected),
				error: void 0
			});
			pendingRequests.delete(id);
			json(res, 200, { ok: true });
		};
		const authSubmit = async (req, res) => {
			const rawId = decodeSegment(req.url?.split("/")[4] ?? "");
			if (rawId === null) return json(res, 400, { error: "malformed connector id" });
			const id = rawId;
			const raw = await readJson(req);
			if (!raw || typeof raw !== "object" || typeof raw.fields !== "object") return json(res, 400, { error: "missing fields" });
			const fields = raw.fields;
			for (const [key, value] of Object.entries(fields)) if (typeof value !== "string") return json(res, 400, { error: `field '${key}' must be a string` });
			try {
				submitAuth(id, fields).catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					setState(id, {
						status: "error",
						error: message
					});
				});
				json(res, 200, { ok: true });
			} catch (error) {
				json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		};
		const state = (req, res) => {
			const rawId = decodeSegment(req.url?.split("/")[4] ?? "");
			if (rawId === null) return json(res, 400, { error: "malformed connector id" });
			const id = rawId;
			if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` });
			json(res, 200, {
				...states.get(id) ?? {
					status: "disconnected",
					everConnected: false
				},
				request: pendingRequests.get(id) ?? null
			});
		};
		const disconnectHandler = async (req, res) => {
			const rawId = decodeSegment(req.url?.split("/")[4] ?? "");
			if (rawId === null) return json(res, 400, { error: "malformed connector id" });
			const id = rawId;
			if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` });
			await disconnect(id);
			json(res, 200, { ok: true });
		};
		const guard = (req, res) => {
			if (browserSameOriginMarker(req) && isLoopbackRequest(req)) return true;
			json(res, 403, { error: "forbidden" });
			return false;
		};
		const disposers = [ctx.webServer.register({
			kind: "exact",
			path: "/api/pico/connectors",
			handler: (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!guard(req, res)) return;
				list(req, res);
			}
		}), ctx.webServer.register({
			kind: "prefix",
			path: "/api/pico/connectors",
			handler: (req, res) => {
				const action = (req.url?.split("/") ?? [])[5]?.split("?")[0];
				const handlers = {
					connect: exact(connect),
					cancel: exact(cancel),
					"auth-submit": exact(authSubmit),
					state: exact(state),
					disconnect: exact(disconnectHandler)
				};
				if (!guard(req, res)) return;
				const method = req.method ?? "GET";
				const expected = action ? {
					connect: "POST",
					cancel: "POST",
					"auth-submit": "POST",
					state: "GET",
					disconnect: "POST"
				}[action] : void 0;
				if (expected !== void 0 && method !== expected) return json(res, 405, { error: "method not allowed" });
				const handler = action ? handlers[action] : void 0;
				if (handler) handler(req, res);
				else json(res, 404, { error: "not found" });
			}
		})];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "pico connectors: http routes");
	restoreAll().catch((cause) => {
		ctx.logger?.error("pico-connectors: initial restore failed", cause);
	});
}
/**
* One-time migration of the pre-2026-08 legacy store dir `~/.picoaide/connectors`
* into the per-user scope. Runs on every session change but only acts when a
* real user is logged in, the legacy dir exists, and the target dir does not.
* Best-effort: a failure leaves the legacy dir in place (the next login
* retries) and never blocks the app. Anonymous (logged-out) sessions never
* absorb the legacy data — it is claimed by the first account that logs in.
*
* TOCTOU hardening (2026-08-22): outside the `existsSync(target)` check the
* claim is serialized through an atomic marker file created with `wx`
* (O_EXCL). Whichever session/process creates the marker first wins the
* legacy data; a loser finds the marker already present and returns quietly:
* no double-rename, no lost update. The marker is removed after the rename so
* a later real user can retry if the first claim found an empty store.
*/
function migrateLegacyStore(username) {
	if (username === null || username.length === 0) return;
	try {
		const legacy = join(homedir(), ".picoaide", "connectors");
		if (!existsSync(legacy)) return;
		const target = join(userScopePath(username), "connectors");
		if (existsSync(target)) return;
		mkdirSync(join(userScopePath(username)), {
			recursive: true,
			mode: 448
		});
		const claim = join(userScopePath(username), ".legacy-claim");
		try {
			writeFileSync(claim, `${username}\n`, {
				mode: 384,
				flag: "wx"
			});
		} catch {
			return;
		}
		try {
			renameSync(legacy, target);
		} finally {
			rmSync(claim, { force: true });
		}
	} catch {}
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.js.map