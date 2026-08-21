import { ConnectorStore } from "./store.js";
import { salesEasyDef } from "./sales-easy.js";
import { dingTalkDef } from "./dingtalk.js";
import { spawn } from "node:child_process";
import { promises } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { gunzipSync, inflateRawSync } from "node:zlib";
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
	const codePromise = new Promise((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
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
	if (def.authMode === "cli") {
		const auth = def.auth;
		return { isConnected: () => runProbeCommand(auth.statusCommand ?? "", auth.statusArgs ?? [], auth.env, options.cli) };
	}
	return { isConnected: async () => true };
}
async function runProbeCommand(command, args, env, cli) {
	const resolved = cli ? await cli.resolve(command, args) : null;
	return new Promise((resolve) => {
		const child = spawn(resolved?.command ?? command, resolved?.args ?? args, {
			env: {
				...process.env,
				...env
			},
			stdio: "ignore",
			shell: resolved?.shell
		});
		child.on("error", () => resolve(false));
		child.on("exit", (code) => resolve(code === 0));
	});
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
/**
* CLI flow (mirrors WorkBuddy's CliExecutor.runAuth): spawn the login
* command, scan stdout/stderr for the device-flow verification URL and user
* code (pushed to the UI through onRequest), then keep the process running
* until it exits naturally (exit 0 = authorized). Falls back to the login +
* status-poll sequence when no deviceFlow is configured.
*/
async function runCli(def, options) {
	const auth = def.auth;
	const signal = options.signal;
	const deviceFlow = auth.deviceFlow;
	const waitForExit = auth.authWaitForExit ?? deviceFlow !== void 0;
	const timeoutMs = auth.timeoutMs ?? (waitForExit ? 3e5 : 1e4);
	const resolved = options.cli ? await options.cli.resolve(auth.command, auth.args, (message) => {
		options.onRequest({
			connectorId: def.id,
			message
		});
	}) : null;
	const spawnCommand = resolved?.command ?? auth.command;
	const spawnArgs = resolved?.args ?? auth.args;
	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(spawnCommand, spawnArgs, {
			env: {
				...process.env,
				...auth.env
			},
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			shell: resolved?.shell
		});
		let stdout = "";
		let stderr = "";
		let reportedUri;
		let reportedCode;
		const extract = (text, _source) => {
			if (!deviceFlow) return;
			let uri;
			try {
				const match = text.match(new RegExp(deviceFlow.uriPattern));
				uri = (match?.[1] ?? match?.[0])?.trim();
			} catch {}
			let code;
			if (deviceFlow.codePattern) try {
				const match = text.match(new RegExp(deviceFlow.codePattern));
				code = (match?.[1] ?? match?.[0])?.trim();
			} catch {}
			if (!uri && !code) return;
			if (uri === reportedUri && code === reportedCode) return;
			reportedUri = uri ?? reportedUri;
			reportedCode = code ?? reportedCode;
			options.onRequest({
				connectorId: def.id,
				...reportedUri !== void 0 ? { verificationUrl: reportedUri } : {},
				...reportedCode !== void 0 ? { userCode: reportedCode } : {}
			});
		};
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			extract(stdout, "stdout");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
			extract(stderr, "stderr");
		});
		child.on("error", (error) => {
			if (error.code === "ENOENT") {
				const hint = auth.installCommand ? `，请先安装：${auth.installCommand}` : "，请确认已安装该命令行工具并加入 PATH";
				reject(/* @__PURE__ */ new Error(`未找到命令 ${auth.command}${hint}`));
				return;
			}
			reject(error);
		});
		child.on("exit", (code) => resolve(code));
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			reject(/* @__PURE__ */ new Error(`登录命令超时（${Math.round(timeoutMs / 1e3)}s）`));
		}, timeoutMs);
		child.on("exit", () => {
			clearTimeout(timer);
		});
		signal.addEventListener("abort", () => {
			try {
				child.kill();
			} catch {}
		}, { once: true });
	});
	throwIfAborted(signal);
	if (exitCode !== 0) throw new Error(`登录命令退出码 ${exitCode ?? "error"}`);
	if (waitForExit) return { updatedAt: Date.now() };
	return pollUntilConnected(createProbe(def, options), auth.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, auth.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, signal);
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
		case "cli": return runCli(def, options);
		case "server-side": return runServerSide(def, options);
	}
}
//#endregion
//#region src/cli-manifest.ts
/** Map a Node platform/arch pair to the manifest naming scheme. */
function cliPlatformKey(platform, arch) {
	switch (`${platform}-${arch}`) {
		case "darwin-x64": return "darwin-x64";
		case "darwin-arm64": return "darwin-arm64";
		case "linux-x64": return "linux-x64";
		case "linux-arm64": return "linux-arm64";
		case "win32-x64": return "win32-x64";
		case "win32-arm64": return "win32-arm64";
		default: return null;
	}
}
/** sha256 of dws platform archives, from dingtalk-workspace-cli@1.0.59 `assets/checksums.txt`. */
const DWS_CHECKSUMS = {
	"dws-linux-amd64.tar.gz": "be1eb9a1f8fc5048e578b5b0bde212fc90baca0f289236c7c333d824bd869cf3",
	"dws-linux-arm64.tar.gz": "5bfe9ac7d1798b028f0fad579bbdffec5898e2fb16ee36f5766ab58e208abd50",
	"dws-windows-amd64.zip": "5393a0d5e00c70b58833c60610ad3a772926ca5e4eb38c360928e3d2552451bc",
	"dws-windows-arm64.zip": "8c1a8eaa527a56197fd1a26d21b0f6c8b8b0e2270d1ad4c1d97519f4cab0f094",
	"dws-darwin-amd64.tar.gz": "fd14b0b1a1475891fb243bf6453857a1044ab5a40bcf7dc1c7c795f57e5b03ba",
	"dws-darwin-arm64.tar.gz": "61135a2a9286204ce060847e653c63c1e9784a0fa631bb7e0563b90628762a35"
};
const DWS_PLATFORM_ASSET = {
	"darwin-x64": "dws-darwin-amd64.tar.gz",
	"darwin-arm64": "dws-darwin-arm64.tar.gz",
	"linux-x64": "dws-linux-amd64.tar.gz",
	"linux-arm64": "dws-linux-arm64.tar.gz",
	"win32-x64": "dws-windows-amd64.zip",
	"win32-arm64": "dws-windows-arm64.zip"
};
/** sha256 of beisen platform archives, from beisen-cli@1.0.5 `checksums.txt`. */
const BEISEN_CHECKSUMS = {
	"beisen-cli-v1.0.5-linux-amd64.tar.gz": "60c14546901dac928ffb278f4ff54803634d360cd21a1814c87b213ac8918277",
	"beisen-cli-v1.0.5-linux-arm64.tar.gz": "035539a6a62a82b4ad260e4321320239562d461d77cd70cf2a20ebe223f74d66",
	"beisen-cli-v1.0.5-windows-amd64.zip": "55bb67e429fd1f22b7299846d6f9d0698dcaad4e339c892c76e09965b97fa80d",
	"beisen-cli-v1.0.5-windows-arm64.zip": "d1543df15296cab6b640d7a528c6597271e8b4be9fd309e983e91c1065ccace2",
	"beisen-cli-v1.0.5-darwin-amd64.tar.gz": "db623686476cc7273fa40126c89002a35a4b2e2d93e102195e6b65a1e851df7b",
	"beisen-cli-v1.0.5-darwin-arm64.tar.gz": "1a909801814be54f581bcc737bff62189c340f4eac97b3fb7ad52398765d7a71"
};
const BEISEN_PLATFORM_URL = {
	"darwin-x64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-darwin-amd64.tar.gz",
	"darwin-arm64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-darwin-arm64.tar.gz",
	"linux-x64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-linux-amd64.tar.gz",
	"linux-arm64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-linux-arm64.tar.gz",
	"win32-x64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-windows-amd64.zip",
	"win32-arm64": "https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-windows-arm64.zip"
};
/**
* dingtalk-workspace-cli ships every platform binary inside its npm tarball
* (`assets/dws-<platform>-<arch>.tar.gz|zip`); the `dws` launcher script and
* its skills installer are intentionally NOT used (see README of the package:
* `dws skill setup` installs agent skills on demand and is a separate,
* opt-in workflow — the connector auth/MCP path only needs the binary).
*/
const DWS_MANIFEST = {
	command: "dws",
	version: "1.0.59",
	binaryName: "dws",
	displayName: "钉钉 dws（DingTalk Workspace CLI）",
	license: "Apache-2.0",
	source: {
		kind: "npm-package",
		packageName: "dingtalk-workspace-cli",
		packageVersion: "1.0.59",
		asset: (platform) => DWS_PLATFORM_ASSET[platform] ?? null,
		innerPath: (asset) => `package/assets/${asset}`,
		checksums: DWS_CHECKSUMS,
		registries: [process.env.PICOAIDE_CONNECTORS_NPM_MIRROR?.trim() || "https://registry.npmmirror.com", "https://registry.npmjs.org"]
	}
};
/**
* beisen-cli's npm package downloads the native binary at install time from
* the vendor CDN; the connector runtime does the same fetch itself, pinned to
* the checksums published in the package's `checksums.txt`.
* NOTE: the package declares `UNLICENSED` — redistributing the fetched binary
* follows the enterprise agreement with Beisen; see THIRD_PARTY_NOTICES.md.
*/
const BEISEN_MANIFEST = {
	command: "beisen-cli",
	version: "1.0.5",
	binaryName: "beisen-cli",
	displayName: "北森 beisen-cli（北森AI · HR专家）",
	license: "UNLICENSED",
	source: {
		kind: "direct",
		url: (platform) => BEISEN_PLATFORM_URL[platform] ?? null,
		checksums: BEISEN_CHECKSUMS
	}
};
/** Built-in manifests keyed by command name. */
const CLI_MANIFESTS = /* @__PURE__ */ new Map([[DWS_MANIFEST.command, DWS_MANIFEST], [BEISEN_MANIFEST.command, BEISEN_MANIFEST]]);
//#endregion
//#region src/archive.ts
/**
* Minimal, dependency-free archive extractor for the connector CLI downloader.
*
* Supports the two archive families the pinned CLIs ship as: POSIX tar
* (optionally gzip-compressed, with GNU long-name and PAX headers) and ZIP
* (store + deflate). Only regular files and directories are materialized:
*
* - path traversal (`../`, absolute paths, backslashes, NUL) is rejected;
* - symlinks / hardlinks are never created (a crafted archive must not be
*   able to write outside the extraction root through link semantics);
* - total and per-entry byte budgets bound decompression bombs.
*
* These guarantees matter because archives arrive from the network; even
* though every archive is sha256-pinned before extraction, extraction itself
* must not be a write primitive outside the target directory.
*/
const DEFAULT_LIMITS = {
	maxTotalBytes: 80 * 1024 * 1024,
	maxEntryBytes: 64 * 1024 * 1024
};
const TAR_BLOCK = 512;
/** Reject unsafe entry names before they reach the filesystem. */
function assertSafeName(name) {
	if (name.length === 0) throw new Error("archive entry with empty name");
	if (name.includes("\0") || name.includes("\\")) throw new Error(`unsafe archive entry name: ${JSON.stringify(name)}`);
	const normalized = name.replace(/\/+/g, "/");
	if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`unsafe archive entry name: ${JSON.stringify(name)}`);
	return normalized;
}
function parseOctal(text) {
	const value = Number.parseInt(text.trim(), 8);
	return Number.isFinite(value) ? value : 0;
}
/** Octal size field, with GNU base-256 fallback (high bit set). */
function parseSize(field) {
	if (field.length === 0) return 0;
	if ((field[0] & 128) !== 0) {
		let value = field[0] & 127;
		for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i];
		return value;
	}
	return parseOctal(field.toString("latin1"));
}
/**
* Parse a (possibly gzipped) tar buffer into entries. Handles GNU long-name
* headers (`L`), PAX extended headers (`x`/`g`), and the ustar `prefix`
* field. Symlinks/hardlinks/special files are skipped (never extracted).
*/
function readTarEntries(buffer, limits = DEFAULT_LIMITS) {
	const entries = [];
	let offset = 0;
	let pendingLongName;
	let total = 0;
	const takeBlock = () => {
		if (offset + TAR_BLOCK > buffer.length) return null;
		const block = buffer.subarray(offset, offset + TAR_BLOCK);
		offset += TAR_BLOCK;
		return block;
	};
	while (offset < buffer.length) {
		const header = takeBlock();
		if (!header) break;
		if (header.every((byte) => byte === 0)) break;
		const typeflag = String.fromCharCode(header[156] ?? 0);
		const size = parseSize(header.subarray(124, 136));
		if (size < 0 || !Number.isSafeInteger(size)) throw new Error("invalid tar entry size");
		let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
		const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
		if (prefix) name = `${prefix}/${name}`;
		if (typeflag === "L") {
			pendingLongName = takeData(size).toString("utf8").replace(/\0.*$/s, "");
			continue;
		}
		if (typeflag === "x" || typeflag === "g") {
			const data = takeData(size);
			for (const line of data.toString("utf8").split("\n")) {
				const match = /^\d+ path=(.*)$/u.exec(line);
				if (match && typeflag === "x") pendingLongName = match[1];
			}
			continue;
		}
		if (pendingLongName !== void 0) {
			name = pendingLongName;
			pendingLongName = void 0;
		}
		const safe = assertSafeName(name);
		if (typeflag === "0" || typeflag === "\0" || typeflag === "7") {
			const data = takeData(size);
			total += data.length;
			if (total > limits.maxTotalBytes) throw new Error("archive exceeds total size limit");
			if (data.length > limits.maxEntryBytes) throw new Error("archive entry exceeds size limit");
			entries.push({
				name: safe,
				data
			});
		} else if (typeflag === "5") {
			entries.push({
				name: safe.replace(/\/+$/, ""),
				data: Buffer.alloc(0)
			});
			skipData(size);
		} else skipData(size);
	}
	return entries;
	function takeData(size) {
		if (offset + size > buffer.length) throw new Error("truncated tar archive");
		const data = buffer.subarray(offset, offset + size);
		offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
		return data;
	}
	function skipData(size) {
		if (offset + size > buffer.length) throw new Error("truncated tar archive");
		offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
	}
}
/** Parse a ZIP buffer into entries (store + deflate, UTF-8 names). */
function readZipEntries(buffer, limits = DEFAULT_LIMITS) {
	const EOCD = 101010256;
	let eocd = -1;
	const tail = Math.min(buffer.length, 65557);
	for (let i = buffer.length - 22; i >= buffer.length - tail; i -= 1) if (buffer.readUInt32LE(i) === EOCD) {
		eocd = i;
		break;
	}
	if (eocd < 0) throw new Error("invalid zip archive: no end-of-central-directory record");
	const totalEntries = buffer.readUInt16LE(eocd + 10);
	let cursor = buffer.readUInt32LE(eocd + 16);
	const entries = [];
	let total = 0;
	for (let i = 0; i < totalEntries; i += 1) {
		if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 33639248) throw new Error("invalid zip archive: bad central directory entry");
		const method = buffer.readUInt16LE(cursor + 10);
		const compressedSize = buffer.readUInt32LE(cursor + 20);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const externalAttrs = buffer.readUInt32LE(cursor + 38);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		cursor += 46 + nameLength + extraLength + commentLength;
		const safe = assertSafeName(name);
		const unixType = externalAttrs >>> 16 & 61440;
		if (unixType === 40960) continue;
		if (safe.endsWith("/") || unixType === 16384) {
			entries.push({
				name: safe.replace(/\/+$/, ""),
				data: Buffer.alloc(0)
			});
			continue;
		}
		if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 67324752) throw new Error("invalid zip archive: bad local file header");
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		if (dataStart + compressedSize > buffer.length) throw new Error("truncated zip archive");
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		let data;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) data = inflateRawSync(raw);
		else throw new Error(`unsupported zip compression method ${method}`);
		total += data.length;
		if (total > limits.maxTotalBytes) throw new Error("archive exceeds total size limit");
		if (data.length > limits.maxEntryBytes) throw new Error("archive entry exceeds size limit");
		entries.push({
			name: safe,
			data
		});
	}
	return entries;
}
/** Parse an archive buffer (gzip/tar/zip) into entries. */
function readArchiveEntries(buffer, limits = DEFAULT_LIMITS) {
	if (buffer.length >= 2 && buffer[0] === 31 && buffer[1] === 139) return readTarEntries(gunzipSync(buffer), limits);
	if (buffer.length >= 4 && buffer.readUInt32LE(0) === 67324752) return readZipEntries(buffer, limits);
	if (buffer.length >= 262 && buffer.toString("latin1", 257, 262) === "ustar") return readTarEntries(buffer, limits);
	throw new Error("不支持的压缩格式");
}
/** Materialize entries under `destDir`; returns the materialized relative paths. */
async function extractEntries(entries, destDir) {
	const root = resolve(destDir);
	await promises.mkdir(root, { recursive: true });
	const written = [];
	for (const entry of entries) {
		const target = resolve(root, entry.name);
		if (target !== root && !target.startsWith(root + sep)) throw new Error(`archive entry escapes extraction root: ${entry.name}`);
		if (entry.data.length === 0) {
			await promises.mkdir(target, { recursive: true });
			continue;
		}
		await promises.mkdir(dirname(target), { recursive: true });
		await promises.writeFile(target, entry.data, { mode: 493 });
		written.push(entry.name);
	}
	return written;
}
/** One-shot: parse + materialize an archive buffer. */
async function extractArchive(buffer, destDir, limits) {
	return extractEntries(readArchiveEntries(buffer, limits), destDir);
}
/** Pick one entry by exact normalized name. */
function findEntry(entries, name) {
	return entries.find((entry) => entry.name === name);
}
//#endregion
//#region src/cli-runtime.ts
/**
* Download-on-demand runtime for connector CLI tools.
*
* Resolution order for a connector CLI command (`dws`, `beisen-cli`, ...):
*   1. PATH lookup wins — a user-installed CLI is used as-is, nothing is
*      downloaded and no cache is touched.
*   2. Otherwise, if a pinned manifest exists for the command, the official
*      platform archive is downloaded, sha256-verified against the pinned
*      checksum, extracted into the user cache dir and the native binary is
*      spawned directly (never the vendor's install scripts, which have
*      invasive side effects — e.g. dws' postinstall writes skills into
*      claude/cursor agent dirs).
*   3. Otherwise `null` — the caller keeps the original command and the
*      regular ENOENT flow produces the "install the CLI manually" hint.
*
* The cache is per command+version under the connector store dir; the binary
* is only replaced when its marker (pinned archive checksum + extracted
* binary size) is missing or mismatched. Downloads are deduplicated across
* concurrent connects.
*/
/** Same per-user base as ConnectorStore (`~/.picoaide/connectors`). */
const DEFAULT_CACHE_DIR = join(homedir(), ".picoaide", "connectors", "cli");
const DIRECT_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
const NPM_TARBALL_MAX_BYTES = 120 * 1024 * 1024;
var CliRuntime = class {
	cacheDir;
	manifests;
	fetchImpl;
	downloadTimeoutMs;
	inflight = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
		this.manifests = options.manifests ?? CLI_MANIFESTS;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.downloadTimeoutMs = options.downloadTimeoutMs ?? 12e4;
	}
	/**
	* Resolve a CLI command to an executable, downloading the pinned binary
	* when the command is not installed. Returns null when the runtime does not
	* provide this command (caller falls back to the raw name).
	*/
	async resolve(command, args, onProgress) {
		const onPath = await findOnPath(command);
		if (onPath) return {
			command: onPath.path,
			args,
			shell: onPath.shell
		};
		const manifest = this.manifests.get(command);
		if (!manifest) return null;
		const binary = await this.ensureBinary(manifest, onProgress);
		if (!binary) return null;
		return {
			command: binary,
			args
		};
	}
	/**
	* Ensure the pinned native binary for `manifest` exists in the cache,
	* downloading and extracting it when needed. Returns null on platforms the
	* manifest does not cover.
	*/
	async ensureBinary(manifest, onProgress) {
		const platform = cliPlatformKey(process.platform, process.arch);
		if (!platform) return null;
		const key = `${manifest.command}@${manifest.version}`;
		const pending = this.inflight.get(key);
		if (pending) return pending;
		const run = this.installBinary(manifest, platform, onProgress);
		this.inflight.set(key, run);
		try {
			return await run;
		} finally {
			if (this.inflight.get(key) === run) this.inflight.delete(key);
		}
	}
	async installBinary(manifest, platform, onProgress) {
		const expected = this.expectedAsset(manifest, platform);
		if (!expected) return null;
		const dir = join(this.cacheDir, manifest.command, manifest.version);
		const binaryName = `${manifest.binaryName}${process.platform === "win32" ? ".exe" : ""}`;
		const binaryPath = join(dir, binaryName);
		const markerPath = join(dir, ".checksum");
		const cached = await readMarker(markerPath);
		if (cached?.archiveName === expected.archiveName && cached.checksum === expected.checksum) {
			const stat = await promises.stat(binaryPath).catch(() => null);
			if (stat?.isFile() && stat.size === cached.binarySize && (process.platform === "win32" || (stat.mode & 73) !== 0)) return binaryPath;
		}
		const fetched = await this.fetchPlatformArchive(manifest, platform, expected, onProgress);
		onProgress?.(`正在解压并安装 ${manifest.displayName}…`);
		await promises.mkdir(dir, {
			recursive: true,
			mode: 448
		});
		const tmp = join(dir, `.tmp-${process.pid}-${Date.now().toString(36)}`);
		try {
			await promises.mkdir(tmp, {
				recursive: true,
				mode: 448
			});
			const written = await extractArchive(fetched.archive, tmp);
			let extracted = join(tmp, binaryName);
			if (!written.includes(binaryName)) {
				const found = await findFileNamed(tmp, binaryName);
				if (!found) throw new Error(`压缩包内未找到 ${binaryName}`);
				extracted = found;
			}
			await promises.rename(extracted, binaryPath);
			await promises.chmod(binaryPath, 493);
			const stat = await promises.stat(binaryPath);
			await writeMarker(markerPath, `${expected.archiveName} ${expected.checksum} ${stat.size}\n`);
		} finally {
			await promises.rm(tmp, {
				recursive: true,
				force: true
			});
		}
		return binaryPath;
	}
	/** Derive the expected platform asset from the manifest (no network). */
	expectedAsset(manifest, platform) {
		const source = manifest.source;
		if (source.kind === "npm-package") {
			const asset = source.asset(platform);
			if (!asset) return null;
			const checksum = source.checksums[asset];
			if (!checksum) throw new Error(`下载清单缺少 ${asset} 的校验和，请更新插件`);
			return {
				archiveName: asset,
				checksum
			};
		}
		const url = source.url(platform);
		if (!url) return null;
		const archiveName = basename(new URL(url).pathname);
		const checksum = source.checksums[archiveName];
		if (!checksum) throw new Error(`下载清单缺少 ${archiveName} 的校验和，请更新插件`);
		return {
			archiveName,
			checksum
		};
	}
	/** Download the pinned platform archive (tarball inner asset or direct URL). */
	async fetchPlatformArchive(manifest, platform, expected, onProgress) {
		const source = manifest.source;
		if (source.kind === "npm-package") {
			let lastError;
			for (const registry of source.registries) {
				const url = `${registry.replace(/\/+$/, "")}/${source.packageName}/-/${source.packageName}-${source.packageVersion}.tgz`;
				onProgress?.(`正在从 ${new URL(url).host} 下载 ${source.packageName}（仅首次连接，约 70MB）…`);
				try {
					const inner = findEntry(readArchiveEntries(await this.download(url, NPM_TARBALL_MAX_BYTES)), source.innerPath(expected.archiveName));
					if (!inner) throw new Error(`npm 包内未找到 ${source.innerPath(expected.archiveName)}`);
					verifyChecksum(expected.archiveName, inner.data, expected.checksum);
					return {
						archiveName: expected.archiveName,
						checksum: expected.checksum,
						archive: inner.data
					};
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`下载 ${source.packageName} 失败`);
		}
		const url = source.url(platform);
		onProgress?.(`正在从 ${new URL(url).host} 下载 ${manifest.displayName}（仅首次连接）…`);
		const bytes = await this.download(url, DIRECT_DOWNLOAD_MAX_BYTES);
		verifyChecksum(expected.archiveName, bytes, expected.checksum);
		return {
			archiveName: expected.archiveName,
			checksum: expected.checksum,
			archive: bytes
		};
	}
	async download(url, maxBytes) {
		let response;
		try {
			response = await this.fetchImpl(url, {
				redirect: "follow",
				signal: AbortSignal.timeout(this.downloadTimeoutMs),
				headers: { "User-Agent": "picoaide-connectors/0.1" }
			});
		} catch (error) {
			throw new Error(`网络请求失败：${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error("文件超过大小上限，已拒绝");
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > maxBytes) throw new Error("文件超过大小上限，已拒绝");
		return bytes;
	}
};
function verifyChecksum(name, data, expected) {
	if (createHash("sha256").update(data).digest("hex") !== expected) throw new Error(`校验和验证失败（${name}），下载源可能被篡改或清单过期，已中止`);
}
async function readMarker(path) {
	try {
		const [archiveName, checksum, size] = (await promises.readFile(path, "utf8")).trim().split(/\s+/u);
		const binarySize = Number(size);
		if (!archiveName || !checksum || !Number.isSafeInteger(binarySize)) return null;
		return {
			archiveName,
			checksum,
			binarySize
		};
	} catch {
		return null;
	}
}
async function writeMarker(path, marker) {
	const tmp = `${path}.tmp`;
	await promises.writeFile(tmp, marker, { mode: 384 });
	await promises.rename(tmp, path);
}
async function findFileNamed(root, name) {
	const queue = [root];
	while (queue.length > 0) {
		const dir = queue.shift();
		let entries;
		try {
			entries = await promises.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			const stat = await promises.stat(full).catch(() => null);
			if (!stat) continue;
			if (stat.isDirectory()) queue.push(full);
			else if (entry === name) return full;
		}
	}
	return null;
}
/**
* Locate `command` on PATH (Windows: PATHEXT-aware). Returns the concrete
* file path; `.cmd`/`.bat` shims need a shell to spawn.
*/
async function findOnPath(command) {
	const isWin = process.platform === "win32";
	const pathVar = process.env.PATH ?? "";
	const extensions = isWin ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
	const separators = isWin ? /[;:]/u : /:/u;
	for (const dir of pathVar.split(separators)) {
		if (!dir) continue;
		for (const ext of extensions) {
			const candidate = join(dir, `${command}${ext}`);
			try {
				const stat = await promises.stat(candidate);
				if (!stat.isFile()) continue;
				if (!isWin && (stat.mode & 73) === 0) continue;
				return {
					path: candidate,
					shell: isWin && /\.(cmd|bat)$/iu.test(ext)
				};
			} catch {}
		}
	}
	return null;
}
//#endregion
//#region src/defs/index.ts
/** Curated marketplace connector definitions (wecom / feishu / moka / beisen-cli). */
const marketplaceDefs = [
	{
		"id": "beisen-cli",
		"name": "北森AI · HR专家",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "beisen-cli",
			"args": ["auth", "login"],
			"installCommand": "npm install -g beisen-cli",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": false,
			"statusCommand": "beisen-cli",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
	},
	{
		"id": "feishu",
		"name": "飞书",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "lark-cli",
			"args": [
				"config",
				"init",
				"--new",
				"--lang",
				"en"
			],
			"installCommand": "npm install -g @larksuite/cli",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "lark-cli",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
	},
	{
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
	},
	{
		"id": "wecom",
		"name": "企业微信",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "wecom-cli",
			"args": [
				"auth",
				"init",
				"--noninteractive",
				"--no-browser"
			],
			"installCommand": "npm install -g @wecom/cli",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "wecom-cli",
			"statusArgs": ["auth", "show"]
		},
		"mcp": []
	}
];
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
		handler(req, res);
	};
}
function apply(ctx, options = {}) {
	const defs = dedupeById([...marketplaceDefs, ...options.connectors ?? []], [salesEasyDef, dingTalkDef]);
	const store = new ConnectorStore(options.storeBaseDir ? { baseDir: options.storeBaseDir } : {});
	const cliRuntime = new CliRuntime(options.cliCacheDir ? { cacheDir: options.cliCacheDir } : void 0);
	const states = /* @__PURE__ */ new Map();
	const pendingRequests = /* @__PURE__ */ new Map();
	const mcpDisposers = /* @__PURE__ */ new Map();
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
	/** Run a command whose stdout yields the MCP endpoint URL (e.g. `dws mcp url get <id>`). */
	const resolveUrlCommand = async (args) => {
		const [command, ...rest] = args;
		if (command === void 0) throw new Error("urlCommand is empty");
		const resolved = await cliRuntime.resolve(command, rest);
		const spawnCommand = resolved?.command ?? command;
		const spawnArgs = resolved?.args ?? rest;
		return new Promise((resolve, reject) => {
			const child = spawn(spawnCommand, spawnArgs, {
				env: { ...process.env },
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				shell: resolved?.shell
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", (error) => reject(error));
			child.on("exit", (code) => {
				if (code !== 0) {
					reject(new Error(stderr.trim() || `命令退出码 ${String(code)}`));
					return;
				}
				const match = /https?:\/\/[^\s"'<>]+/u.exec(stdout);
				if (!match) {
					reject(/* @__PURE__ */ new Error(`无法从命令输出中解析 URL: ${stdout.trim().slice(0, 200)}`));
					return;
				}
				const url = match[0];
				try {
					const parsed = new URL(url);
					if (parsed.protocol !== "https:") {
						reject(/* @__PURE__ */ new Error(`MCP URL 必须是 https: ${url.slice(0, 80)}`));
						return;
					}
					const host = parsed.hostname.toLowerCase();
					if (host === "localhost" || host === "::1" || /^127\./.test(host) || /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(host)) {
						reject(/* @__PURE__ */ new Error(`MCP URL 指向本地/私网地址，已拒绝: ${url.slice(0, 80)}`));
						return;
					}
				} catch {
					reject(/* @__PURE__ */ new Error(`MCP URL 无效: ${url.slice(0, 80)}`));
					return;
				}
				resolve(url);
			});
		});
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
				url: server.urlCommand ? await resolveUrlCommand(server.urlCommand) : server.url ?? "",
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
		try {
			const controller = new AbortController();
			const patch = await runAuth(def, {
				onRequest: emitRequest,
				signal: controller.signal,
				cli: cliRuntime,
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
			setState(id, {
				status: unauthorized ? "unauthorized" : "error",
				error: message
			});
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
		await store.clearCredential(id);
		setState(id, {
			status: "disconnected",
			everConnected: false,
			error: void 0,
			connectedAt: void 0
		});
		pendingRequests.delete(id);
	};
	ctx.effect(() => {
		for (const def of defs) (async () => {
			try {
				const credential = await store.readCredential(def.id);
				if (!credential) return;
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
		})();
		return () => {
			for (const dispose of mcpDisposers.values()) dispose();
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
		const authSubmit = async (req, res) => {
			const rawId = decodeSegment(req.url?.split("/")[4] ?? "");
			if (rawId === null) return json(res, 400, { error: "malformed connector id" });
			const id = rawId;
			const raw = await readJson(req);
			if (!raw || typeof raw !== "object" || typeof raw.fields !== "object") return json(res, 400, { error: "missing fields" });
			try {
				await submitAuth(id, raw.fields);
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
					"auth-submit": exact(authSubmit),
					state: exact(state),
					disconnect: exact(disconnectHandler)
				};
				if (!guard(req, res)) return;
				const method = req.method ?? "GET";
				const expected = action ? {
					connect: "POST",
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
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.js.map