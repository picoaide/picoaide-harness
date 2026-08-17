import { salesEasyDef } from "./sales-easy.js";
import { dingTalkDef } from "./dingtalk.js";
import { spawn } from "node:child_process";
import { promises } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
//#region src/store.ts
/**
* Token/state persistence for connectors (mirrors WorkBuddy's ConnectorOAuthStore:
* per-user files under the config dir). Tokens live in `~/.picoaide/connectors/`.
*/
const CONNECTORS_DIR = join(homedir(), ".picoaide", "connectors");
var ConnectorStore = class {
	dir;
	constructor(options = {}) {
		this.dir = options.baseDir ?? CONNECTORS_DIR;
	}
	path(id) {
		return join(this.dir, `${id}.json`);
	}
	async readCredential(id) {
		try {
			return JSON.parse(await promises.readFile(this.path(id), "utf-8"));
		} catch {
			return null;
		}
	}
	async writeCredential(id, credential) {
		await promises.mkdir(this.dir, { recursive: true });
		await promises.writeFile(this.path(id), JSON.stringify(credential, null, 2), "utf-8");
	}
	async updateCredential(id, patch) {
		const next = {
			...await this.readCredential(id) ?? { updatedAt: 0 },
			...patch,
			updatedAt: Date.now()
		};
		await this.writeCredential(id, next);
		return next;
	}
	async clearCredential(id) {
		try {
			await promises.unlink(this.path(id));
		} catch {}
	}
	async hasCredential(id) {
		return await this.readCredential(id) !== null;
	}
};
//#endregion
//#region src/auth.ts
const deviceProbes = /* @__PURE__ */ new Map();
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_TIMEOUT_MS = 3e5;
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
/** Discover the OAuth endpoints for an MCP server (RFC 8414 metadata). */
async function discoverMcpOAuth(discoveryUrl) {
	const response = await fetch(discoveryUrl, { headers: { Accept: "application/json" } });
	if (!response.ok) throw new Error(`MCP OAuth 元数据获取失败: HTTP ${response.status}`);
	const meta = await response.json();
	if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error("MCP OAuth 元数据缺少 authorization_endpoint/token_endpoint");
	const scopes = meta.scopes_supported?.includes("offline_access") ? "offline_access" : meta.scopes_supported?.[0];
	return {
		...meta,
		...scopes ? { scopes } : {}
	};
}
/** Run an oauth2 authorization-code flow with PKCE and a loopback callback. */
async function runOAuth(def, options) {
	const auth = def.auth;
	const discovered = auth.discoveryUrl ? await discoverMcpOAuth(auth.discoveryUrl) : void 0;
	const callbackHost = options.callbackHost ?? "127.0.0.1";
	const { verifier, challenge } = pkce();
	const port = await new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, callbackHost, () => {
			const address = server.address();
			server.close();
			resolve(address.port);
		});
		server.on("error", reject);
	});
	const redirectUri = `http://${callbackHost}:${port}/callback`;
	const registrationEndpoint = discovered?.registration_endpoint ?? auth.registrationEndpoint;
	const clientId = registrationEndpoint ? await registerClient(auth, redirectUri, registrationEndpoint) : auth.clientId || "";
	if (!clientId) throw new Error("OAuth 服务器不支持动态客户端注册，且未配置固定 clientId");
	const codePromise = new Promise((resolve, reject) => {
		const callbackServer = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://${callbackHost}:${port}`);
			const codeParam = url.searchParams.get("code");
			const errorParam = url.searchParams.get("error");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<html><body><p>授权完成，可以关闭此窗口。</p></body></html>");
			callbackServer.close();
			if (errorParam) {
				reject(/* @__PURE__ */ new Error(`OAuth 授权失败: ${errorParam}`));
				return;
			}
			if (codeParam) resolve(codeParam);
			else reject(/* @__PURE__ */ new Error("OAuth 回调缺少 code"));
		});
		callbackServer.listen(port, callbackHost);
		callbackServer.on("error", reject);
	});
	const codeChallengeMethod = auth.pkce ? "S256" : void 0;
	const authorizeUrl = new URL(discovered?.authorization_endpoint ?? auth.authorizeUrl);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("client_id", clientId);
	authorizeUrl.searchParams.set("redirect_uri", redirectUri);
	const scopes = discovered?.scopes ?? auth.scopes;
	if (scopes) authorizeUrl.searchParams.set("scope", scopes);
	if (auth.pkce) {
		authorizeUrl.searchParams.set("code_challenge", challenge);
		authorizeUrl.searchParams.set("code_challenge_method", codeChallengeMethod ?? "S256");
	}
	options.onRequest({
		connectorId: def.id,
		authorizeUrl: authorizeUrl.toString()
	});
	const code = await codePromise;
	throwIfAborted(options.signal);
	const tokenUrl = options.tokenUrlOverride ?? discovered?.token_endpoint ?? auth.tokenUrl;
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: clientId
	});
	if (auth.pkce) body.set("code_verifier", verifier);
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal: options.signal
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
	const response = await fetch(options.tokenUrlOverride ?? auth.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body
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
function createProbe(def, _options) {
	if (def.authMode === "cli") {
		const auth = def.auth;
		return { isConnected: () => runProbeCommand(auth.statusCommand ?? "", auth.statusArgs ?? [], auth.env) };
	}
	return { isConnected: async () => true };
}
async function runProbeCommand(command, args, env) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			env: {
				...process.env,
				...env
			},
			stdio: "ignore"
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
	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(auth.command, auth.args, {
			env: {
				...process.env,
				...auth.env
			},
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let codeReported = false;
		const extract = (text, source) => {
			if (!deviceFlow || codeReported) return;
			let uri;
			try {
				const match = text.match(new RegExp(deviceFlow.uriPattern));
				uri = (match?.[1] ?? match?.[0])?.trim();
			} catch {}
			if (!uri) return;
			let code;
			if (deviceFlow.codePattern) try {
				const match = text.match(new RegExp(deviceFlow.codePattern));
				code = (match?.[1] ?? match?.[0])?.trim();
			} catch {}
			codeReported = true;
			options.onRequest({
				connectorId: def.id,
				verificationUrl: uri,
				...code !== void 0 ? { userCode: code } : {}
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
			if (error.code === "ENOENT" && auth.installCommand) {
				reject(/* @__PURE__ */ new Error(`未找到命令 ${auth.command}，请先安装：${auth.installCommand}`));
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
//#region src/defs/index.ts
/** All marketplace-generated connector definitions. */
const marketplaceDefs = [
	{
		"id": "77ircloud",
		"name": "铱云AI供应链",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "ircloud-cli",
			"args": ["auth", "login"],
			"installCommand": "npm install -g https://oss-openclaw.77ircloud.com/cli_tools/workbuddy/npm/ircloud-cli-workbuddy-1.0.0.tgz",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "ircloud-cli",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
	},
	{
		"id": "ai-hive",
		"name": "AI-HIVE",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "npx",
			"args": [
				"-y",
				"@infimind-next/ai-hive-mcp@0.2.1",
				"auth"
			],
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "npx",
			"statusArgs": [
				"-y",
				"@infimind-next/ai-hive-mcp@0.2.1",
				"status"
			]
		},
		"mcp": []
	},
	{
		"id": "awesun",
		"name": "向日葵远程控制",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "awesun-cli",
			"args": [
				"login",
				"--qrcode",
				"--url"
			],
			"installCommand": "npm install -g @aweray/awesun-cli@latest",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "awesun-cli",
			"statusArgs": ["login", "status"]
		},
		"mcp": []
	},
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
		"id": "cloudbase",
		"name": "腾讯云 CloudBase",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "tcb",
			"args": [
				"login",
				"--flow",
				"web",
				"--yes"
			],
			"installCommand": "npm install -g @cloudbase/cli@latest",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "tcb",
			"statusArgs": ["env", "list"]
		},
		"mcp": []
	},
	{
		"id": "cnb-api",
		"name": "CNB",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "cnb",
			"args": ["login"],
			"installCommand": "npm install -g @cnbcool/cnb-cli",
			"deviceFlow": {
				"uriPattern": "(https?://[^\\s]*/oauth2/device[^\\s]*)",
				"codePattern": "user_code=([^&\\s]+)"
			},
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "cnb",
			"statusArgs": ["status"]
		},
		"mcp": []
	},
	{
		"id": "dingtalk",
		"name": "钉钉",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "dws",
			"args": [
				"auth",
				"login",
				"-y"
			],
			"installCommand": "npm install -g dingtalk-workspace-cli",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "dws",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
	},
	{
		"id": "emr-query",
		"name": "弹性MapReduce",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "tccli",
			"args": ["auth", "login"],
			"installCommand": "python -m pip install --upgrade tccli",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "tccli",
			"statusArgs": [
				"emr",
				"DescribeInstancesList",
				"--region",
				"ap-guangzhou",
				"--version",
				"2019-01-03",
				"--cli-unfold-argument",
				"--DisplayStrategy",
				"clusterList",
				"--Limit",
				"1",
				">/dev/null",
				"2>&1",
				"&&",
				"echo",
				"'Authenticated",
				"and",
				"EMR",
				"accessible'",
				"||",
				"(echo",
				"'Not",
				"authenticated",
				"or",
				"no",
				"EMR",
				"access'",
				">&2;",
				"exit",
				"1)"
			]
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
		"id": "lemonclaw",
		"name": "LemonClaw",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "lemonclaw-cli",
			"args": ["auth", "login"],
			"installCommand": "npm install -g https://download.ningmengyun.com/Skills/lemonclaw-cli-launcher-1.0.2.tgz",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "lemonclaw-cli",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
	},
	{
		"id": "lovrabet-cli",
		"name": "Lovrabet CLI",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "lovrabet",
			"args": [
				"auth",
				"device",
				"--url-only",
				"--source",
				"workbuddy"
			],
			"installCommand": "npm install -g @lovrabet/lovrabet-cli",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "lovrabet",
			"statusArgs": [
				"auth",
				"status",
				"--global",
				"--check"
			]
		},
		"mcp": []
	},
	{
		"id": "mglc",
		"name": "芒果灵创 CLI",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "mglc",
			"args": [
				"auth",
				"--source",
				"workbuddy"
			],
			"installCommand": "curl -fsSL https://aigc-assets.mgtv.com/mglc/install.sh | bash",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "mglc",
			"statusArgs": ["status", "--text-plain"]
		},
		"mcp": []
	},
	{
		"id": "miaoda",
		"name": "秒哒应用搭建",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "miaoda",
			"args": ["login"],
			"installCommand": "npm i -g miaoda-cli",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "miaoda",
			"statusArgs": ["status"]
		},
		"mcp": []
	},
	{
		"id": "seeyon-office-marketing-suite",
		"name": "致远互联协同办公服务",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "node",
			"args": ["$SEEYON_CONNECTOR_HOME/cli/seeyon-connector.js", "auth"],
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "node",
			"statusArgs": ["$SEEYON_CONNECTOR_HOME/cli/seeyon-connector.js", "status"]
		},
		"mcp": []
	},
	{
		"id": "shanlong-claw",
		"name": "shanlong-claw",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "\"$SL_CLI_HOME/bin/sl\"",
			"args": ["connector", "auth"],
			"installCommand": "bash \"$SL_CONNECTOR_HOME/install.sh\"",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "\"$SL_CLI_HOME/bin/sl\"",
			"statusArgs": ["connector", "status"]
		},
		"mcp": []
	},
	{
		"id": "tc-chengxin",
		"name": "同程程心",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "tc-chengxin",
			"args": [
				"auth",
				"login",
				"--no-wait"
			],
			"installCommand": "npm install -g \"$TC_CONNECTOR_HOME/cli/tc-chengxin-cli.tgz\"",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "tc-chengxin",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
	},
	{
		"id": "tencentads",
		"name": "腾讯营销投放",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "tencentads",
			"args": ["auth", "login"],
			"installCommand": "npm install -g tencentads-cli@latest",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "tencentads",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
	},
	{
		"id": "textin-xparse",
		"name": "TextIn xParse·智能文档解析",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "\"$HOME/.local/bin/xparse-cli\"",
			"args": [
				"--profile",
				"workbuddy",
				"auth",
				"device",
				"--open-browser=always",
				"--output=jsonl"
			],
			"installCommand": "curl -fsSL https://dllf.intsig.net/download/2026/Solution/xparse-cli/v2.2.0/install.sh | env XPARSER_VERSION=v2.2.0 sh && \"$HOME/.local/bin/xparse-cli\" --profile workbuddy config set base_url https://api.textin.com",
			"deviceFlow": {
				"uriPattern": "\"verification_uri_complete\"\\s*:\\s*\"(https?://[^\"]+)\"",
				"codePattern": "\"user_code\"\\s*:\\s*\"([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\""
			},
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "\"$HOME/.local/bin/xparse-cli\"",
			"statusArgs": [
				"--profile",
				"workbuddy",
				"auth",
				"status",
				"--output=json"
			]
		},
		"mcp": []
	},
	{
		"id": "tmeet",
		"name": "腾讯会议",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "tmeet",
			"args": [
				"auth",
				"login",
				"--no-browser"
			],
			"installCommand": "npm install -g @tencentcloud/tmeet",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "tmeet",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
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
	},
	{
		"id": "woscli",
		"name": "微盟 WOS CLI",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "$HOME/.woscli/woscli",
			"args": ["login"],
			"installCommand": "curl -fsSL https://ipaas-huawei-cloud-1252328573.cos.ap-shanghai.myqcloud.com/wai/install.sh -o /tmp/woscli-install.sh && sh /tmp/woscli-install.sh",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "$HOME/.woscli/woscli",
			"statusArgs": ["status"]
		},
		"mcp": []
	},
	{
		"id": "wps-knowledgebase",
		"name": "WPS知识库",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "kwiki-cli",
			"args": ["auth", "login"],
			"installCommand": "node \"$KWIKI_CONNECTOR_HOME/cli/install.js\"",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "kwiki-cli",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
	},
	{
		"id": "zsxq",
		"name": "知识星球",
		"description": "",
		"authMode": "cli",
		"auth": {
			"command": "zsxq-cli",
			"args": [
				"auth",
				"login",
				"--no-wait"
			],
			"installCommand": "npm install -g zsxq-cli",
			"deviceFlow": { "uriPattern": "https?://[^\\s\\n\\r\"'<>]+" },
			"authWaitForExit": true,
			"suppressBrowser": true,
			"statusCommand": "zsxq-cli",
			"statusArgs": ["auth", "status"]
		},
		"mcp": []
	},
	{
		"id": "bugly-token",
		"name": "Bugly 质量概览",
		"description": "连接您的 Bugly 账号，用于查看产品的崩溃率、ANR 率、FOOM（OOM）率与启动耗时等质量概览。Token 仅存储在本机 ~/.workbuddy 下，不会上传云端。",
		"authMode": "token",
		"tokenFields": [{
			"key": "BUGLY_ACCESS_TOKEN",
			"label": "密钥",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "bugly",
			"transport": "streamable-http",
			"url": "https://bugly.tds.qq.com/mcp",
			"headers": { "Authorization": "Bearer ${BUGLY_ACCESS_TOKEN}" }
		}]
	},
	{
		"id": "cisp-mcp",
		"name": "水滴征信",
		"description": "请从水滴征信平台获取 API Key。凭证仅存储在本机，不会上传到云端。",
		"authMode": "token",
		"tokenFields": [{
			"key": "CISP_API_KEY",
			"label": "API Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "cisp-mcp",
			"transport": "streamable-http",
			"url": "https://cisp.zenitera.com/mcp",
			"headers": { "Authorization": "Bearer ${CISP_API_KEY}" }
		}]
	},
	{
		"id": "ctrip-wendao",
		"name": "携程问道",
		"description": "输入携程问道 API Token（从携程问道开放平台申请）",
		"authMode": "token",
		"tokenFields": [{
			"key": "WENDAO_API_KEY",
			"label": "API Token",
			"type": "password",
			"required": true
		}],
		"mcp": []
	},
	{
		"id": "fazhi-law",
		"name": "同花顺法律AI助手",
		"description": "请输入从同花顺法律AI助手平台获取的 API Key。凭证仅保存在您的本机，由 WorkBuddy 在连接同花顺法律AI助手 MCP 时注入请求头；WorkBuddy 云端不存储、不接收该凭证。",
		"authMode": "token",
		"tokenFields": [{
			"key": "FAZHI_API_KEY",
			"label": "同花顺法律AI助手 API Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "fazhi-law",
			"transport": "streamable-http",
			"url": "https://bizveris.kuaicha365.com/law_agent/mcp?source=workbuddy",
			"headers": { "open-authorization": "Bearer ${FAZHI_API_KEY}" }
		}]
	},
	{
		"id": "gangtise-mcp",
		"name": "Gangtise投研",
		"description": "Gangtise MCP汇聚机构级观点，研报，日程等另类数据，提供投研AI Agent预生成数据及全球行情/财务/估值/宏观行业等结构化数据。Key 与接口地址仅存储在本机 ~/.workbuddy 下。",
		"authMode": "token",
		"tokenFields": [{
			"key": "GTS_ACCESS_KEY",
			"label": "Access Key",
			"type": "password",
			"required": true
		}, {
			"key": "GTS_SECRET_KEY",
			"label": "Secret Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "gangtise-mcp",
			"transport": "streamable-http",
			"url": "https://openapi.gangtise.com/application/open-mcp/",
			"headers": {
				"accessKey": "${GTS_ACCESS_KEY}",
				"secretKey": "${GTS_SECRET_KEY}"
			}
		}]
	},
	{
		"id": "gildata",
		"name": "恒生聚源 MCP",
		"description": "连接您的恒生聚源 MCP，用于查询金融结构化数据、研究报告、公司公告、新闻资讯、条件选股、宏观行业、工商企业数据。Token 与接口地址仅存储在本机 ~/.workbuddy 下。",
		"authMode": "token",
		"tokenFields": [{
			"key": "GILDATA_TOKEN",
			"label": "Access Token",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "gildata-finance-data",
			"transport": "streamable-http",
			"url": "https://api.gildata.com/mcp-servers/aidata-assistant-srv-tool?token=${GILDATA_TOKEN}"
		}]
	},
	{
		"id": "infimind-ecommerce-image",
		"name": "极睿电商生图",
		"description": "每位用户须登录个人账户，手动创建名为 WorkBuddy 的独立 Token，且不得在其他 MCP 客户端复用。仅专业版或企业版个人账户可调用，任务消耗该用户本人积分。凭证由 WorkBuddy 仅保存在本机。",
		"authMode": "token",
		"tokenFields": [{
			"key": "MCP_TOKEN",
			"label": "WorkBuddy Token",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "infimind-ecommerce-image",
			"transport": "stdio",
			"command": "npx",
			"args": ["-y", "@infimind/image-mcp-cli@1.0.9"],
			"env": {
				"MCP_TOKEN": "${MCP_TOKEN}",
				"API_URL": "https://aigc-next.ecpro.com"
			}
		}]
	},
	{
		"id": "infimind-video",
		"name": "极睿视频",
		"description": "请输入在极睿视频中为本次连接创建、专用于 WorkBuddy 的 MCP Token。凭证仅保存在本机 WorkBuddy 配置目录中，不会随 Connector 上架包分发；不得在其他 MCP 客户端复用。",
		"authMode": "token",
		"tokenFields": [{
			"key": "SORA_MCP_TOKEN",
			"label": "MCP Token",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "infimind-video",
			"transport": "stdio",
			"command": "npx",
			"args": ["-y", "@infimind/video-mcp-cli@1.0.11"],
			"env": {
				"SORA_MCP_TOKEN": "${SORA_MCP_TOKEN}",
				"SORA_API_URL": "https://aigc-next.iclip.cn/api"
			}
		}]
	},
	{
		"id": "kuaicha-search",
		"name": "同花顺快查企业数据",
		"description": "请输入从同花顺快查数据平台获取的 API Key。凭证仅保存在您的本机，由 WorkBuddy 在连接同花顺快查 MCP 时注入请求头；WorkBuddy 云端不存储、不接收该凭证。",
		"authMode": "token",
		"tokenFields": [{
			"key": "KUAICHA_API_KEY",
			"label": "同花顺快查 API Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "kuaicha-search",
			"transport": "streamable-http",
			"url": "https://bizveris.kuaicha365.com/mcp?source=workbuddy",
			"headers": { "open-authorization": "Bearer ${KUAICHA_API_KEY}" }
		}]
	},
	{
		"id": "lingxing-mcp",
		"name": "领星ERP",
		"description": "连接您的领星ERP账号。X-Mcp-Key 仅存储在本机，由 WorkBuddy 在连接领星 MCP 服务时通过请求头注入。请勿向他人分享该密钥。",
		"authMode": "token",
		"tokenFields": [{
			"key": "LINGXING_MCP_KEY",
			"label": "X-Mcp-Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "lingxing-mcp",
			"transport": "streamable-http",
			"url": "https://openmcp.lingxing.com/mcp-servers/lingxing-mcp",
			"headers": { "X-Mcp-Key": "${LINGXING_MCP_KEY}" }
		}]
	},
	{
		"id": "linkfox-product-selection",
		"name": "Linkfox 选品",
		"description": "输入Linkfox Agent的 API Key，用于使用Linkfox 选品的所有服务。",
		"authMode": "token",
		"tokenFields": [{
			"key": "LINKFOX_AGENT_API_KEY",
			"label": "API Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "linkfox-product-selection",
			"transport": "streamable-http",
			"url": "https://mcp-tool-gateway.linkfox.com/mcp/any-tool",
			"headers": { "Authorization": "${LINKFOX_AGENT_API_KEY}" }
		}]
	},
	{
		"id": "netease-mail",
		"name": "网易邮箱",
		"description": "输入邮箱地址和 IMAP/SMTP 授权码（非登录密码）。支持 163、126、yeah.net 等网易邮箱，以及其他支持 IMAP/SMTP 的邮箱。",
		"authMode": "token",
		"tokenFields": [{
			"key": "NETEASE_EMAIL_USER",
			"label": "邮箱地址",
			"type": "text",
			"required": true
		}, {
			"key": "NETEASE_EMAIL_PASS",
			"label": "IMAP/SMTP 授权码",
			"type": "password",
			"required": true
		}],
		"mcp": []
	},
	{
		"id": "opendata",
		"name": "及刻智能·时空数据MCP",
		"description": "请输入从及刻开放平台生成的MCP key，key仅保存在本机，key失效可通过下方链接去重新生成并更新。",
		"authMode": "token",
		"tokenFields": [{
			"key": "REGION_INSIGHT_API_KEY",
			"label": "MCP Key",
			"type": "password",
			"required": true
		}],
		"mcp": []
	},
	{
		"id": "patsnap-search",
		"name": "智慧芽专利&文献融合检索",
		"description": "API Key 仅存储在本机，由 WorkBuddy 在连接 MCP 服务时注入到连接 URL 的 apikey 参数中，不会上传到云端。",
		"authMode": "token",
		"tokenFields": [{
			"key": "PATSNAP_API_KEY",
			"label": "智慧芽 API Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "patsnap-search",
			"transport": "streamable-http",
			"url": "https://connect.zhihuiya.com/2b0355/logic-mcp?apikey=${PATSNAP_API_KEY}"
		}]
	},
	{
		"id": "picset-commerce-images",
		"name": "Picset AI 电商图片",
		"description": "请输入在 Picset AI 用户中心创建的密钥。该密钥仅由 WorkBuddy 保存在本机用户目录，并在连接 Picset AI 图片连接器时作为 Authorization 请求头发送。",
		"authMode": "token",
		"tokenFields": [{
			"key": "PICSET_AGENT_SK",
			"label": "Picset AI Secret Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "picset-commerce-images",
			"transport": "streamable-http",
			"url": "https://picsetai.cn/functions/v1/agent-mcp-v1/mcp",
			"headers": { "Authorization": "Bearer ${PICSET_AGENT_SK}" }
		}]
	},
	{
		"id": "picset-video-generation",
		"name": "Picset AI 视频生成",
		"description": "请输入在 Picset AI 用户中心创建的 Agent SK。该 SK 仅由 WorkBuddy 保存在本机用户目录，并在连接 Picset AI 视频 MCP 时作为 Authorization 请求头发送。",
		"authMode": "token",
		"tokenFields": [{
			"key": "PICSET_AGENT_SK",
			"label": "Picset AI Secret Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "picset-video-generation",
			"transport": "streamable-http",
			"url": "https://picsetai.cn/functions/v1/agent-video-mcp-v1/mcp",
			"headers": { "Authorization": "Bearer ${PICSET_AGENT_SK}" }
		}]
	},
	{
		"id": "sq-company-dynamic",
		"name": "上奇产业通-企业动态追踪",
		"description": "请在下方填入您的企业动态追踪 API Key。该凭证仅存储在您本机，用于向企业动态追踪服务发起认证请求。",
		"authMode": "token",
		"tokenFields": [{
			"key": "API_KEY",
			"label": "API Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "sq-company-dynamic",
			"transport": "streamable-http",
			"url": "https://api.chanyedata.com/mcp/c3f5924cc60dbe1729f5cc332e627304/mcp",
			"headers": { "Authorization": "${API_KEY}" }
		}]
	},
	{
		"id": "tencent-map",
		"name": "腾讯地图",
		"description": "连接你的腾讯地图开发者 Key，用于地点搜索、路线规划、地址解析等。Key 仅存储在本机 ~/.workbuddy下。",
		"authMode": "token",
		"tokenFields": [{
			"key": "TENCENT_MAP_KEY",
			"label": "Key",
			"type": "text",
			"required": true
		}],
		"mcp": []
	},
	{
		"id": "weisheng-scrm",
		"name": "微盛企微管家SCRM",
		"description": "输入微盛企微管家的 APP KEY，用于查询或管理企业微信中的客户信息、标签、客户群、营销素材、活码、群发、跟进记录、联系人、商机、汇报、抽奖、客户日程、聊天记录等业务能力。APP KEY 仅存储在本机，不会上传到云端。",
		"authMode": "token",
		"tokenFields": [{
			"key": "SCRM_APP_KEY",
			"label": "APP KEY",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "weisheng-scrm",
			"transport": "stdio",
			"command": "npx",
			"args": [
				"--registry=https://registry.npmmirror.com",
				"-y",
				"mcp-server-weisheng-scrm@latest"
			],
			"env": {
				"SCRM_APP_KEY": "",
				"SCRM_BASE_URL": "https://open.wshoto.com",
				"npm_config_registry": "https://registry.npmmirror.com"
			}
		}]
	},
	{
		"id": "wind-finance",
		"name": "Wind 金融数据",
		"description": "填写 Wind API Key 以启用万得金融数据查询，支持股票、债券、基金、指数、宏观数据的查询与分析。Key 仅保存在本机 ~/.workbuddy 下，不会上传云端。",
		"authMode": "token",
		"tokenFields": [{
			"key": "WIND_API_KEY",
			"label": "Wind API Key（个人密钥）",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "wind-finance",
			"transport": "streamable-http",
			"url": "https://mcp.wind.com.cn/vserver_workbuddy/mcp/",
			"headers": {
				"Authorization": "Bearer ${WIND_API_KEY}",
				"Accept": "application/json, text/event-stream"
			}
		}]
	},
	{
		"id": "yingmi-mcp",
		"name": "盈米MCP",
		"description": "填写盈米 MCP API Key 以启用基金与市场数据查询。Key 仅保存在本机 ~/.workbuddy 下，不会上传云端。",
		"authMode": "token",
		"tokenFields": [{
			"key": "YINGMI_API_KEY",
			"label": "API Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "yingmi-mcp",
			"transport": "streamable-http",
			"url": "https://stargate.yingmi.com/mcp/v2?apiKey=${YINGMI_API_KEY}"
		}]
	},
	{
		"id": "youshu-bd-mate",
		"name": "有数智客 · 对公(To B)营销助手",
		"description": "更全面的功能请前往有数开放平台：https://open.yscredit.com/mcp/guide，在页面中点击\"一键免费接入\"，复制生成的提示词，返回 WorkBuddy，将提示词粘贴发送给模型，即可自动完成配置。如仅需使用对公营销助手基础功能，也可前往平台点击右上角头像\"获取 MCP Key\"，将 Key 粘贴到下方输入框。Key 仅存储在本机 ~/.workbuddy 下，不会上传云端。",
		"authMode": "token",
		"tokenFields": [{
			"key": "API_KEY",
			"label": "有数 MCP Key",
			"type": "password",
			"required": true
		}],
		"mcp": [{
			"serverName": "youshu-bd-mate",
			"transport": "streamable-http",
			"url": "https://open.yscredit.com/ys-mcp/report",
			"headers": { "Authorization": "Bearer ${API_KEY}" }
		}]
	},
	{
		"id": "zfs-fssc-ai",
		"name": "中兴新云AI智报",
		"description": "连接您的财务云账号以使用 AI 智报。账号与密码仅用于向财务云登录换取会话凭证；密码不会被连接器存储，仅在服务端发起登录时使用。",
		"authMode": "token",
		"tokenFields": [{
			"key": "ZFS_LOGIN_KEY",
			"label": "财务云账号",
			"type": "text",
			"required": true
		}, {
			"key": "ZFS_PASSWORD",
			"label": "财务云密码",
			"type": "password",
			"required": true
		}],
		"mcp": []
	},
	{
		"id": "agentkey",
		"name": "AgentKey",
		"description": "AgentKey 是 AI 助手获取可信工具和实时数据的能力市场。支持网页搜索、URL抓取、新闻、社交媒体、股票市场价格、电商产品数据、企业/公司数据、天气、地图和地理位置、旅行（航班/酒店）、实时信息或任何第三方API。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://api.agentkey.app/workbuddy/v1/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "agentkey",
			"transport": "streamable-http",
			"url": "https://api.agentkey.app/workbuddy/v1/mcp"
		}]
	},
	{
		"id": "archive-hospital-mcp",
		"name": "腾讯健康全周期管理平台",
		"description": "全周期管理平台机构端 AI 智能体的 MCP 连接器。基于原有全周期管理平台，通过引入对话式 AI 智能体，实现理解管理者意图，调度平台原有能力模块完成患者数据查询管理等操作",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://bingli.tengmed.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "archive-hospital-mcp",
			"transport": "streamable-http",
			"url": "https://bingli.tengmed.com/mcp"
		}]
	},
	{
		"id": "bazhuayu",
		"name": "八爪鱼",
		"description": "用自然语言驱动八爪鱼云采集：搜索模板、启动任务、查询进度、导出结构化数据，并管理已有任务。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.bazhuayu.com?includeTools=search_templates,execute_task,get_task_status,export_data,search_tasks,start_or_stop_task/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "bazhuayu",
			"transport": "streamable-http",
			"url": "https://mcp.bazhuayu.com?includeTools=search_templates,execute_task,get_task_status,export_data,search_tasks,start_or_stop_task"
		}]
	},
	{
		"id": "canva",
		"name": "Canva可画",
		"description": "无缝调用Canva可画的设计能力。一句话生成海报、演示文稿、小红书封面等设计，通过文字描述调整尺寸、填充品牌模板及检索已有内容",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.canva.cn/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "Canva可画",
			"transport": "streamable-http",
			"url": "https://mcp.canva.cn/mcp"
		}]
	},
	{
		"id": "canva-ai",
		"name": "Canva可画",
		"description": "无缝调用Canva可画的设计能力。一句话生成海报、演示文稿、小红书封面等设计，通过文字描述调整尺寸、填充品牌模板及检索已有内容",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.canva.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "canva-mcp",
			"transport": "streamable-http",
			"url": "https://mcp.canva.com/mcp"
		}]
	},
	{
		"id": "chuhaijiang",
		"name": "出海匠",
		"description": "基于实时 TikTok Shop 数据完成选品、竞品分析、达人筛选与带货内容创作，并管理社媒账号、发布内容、运营评论和私信。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.gateway.chuhaijiang.com/mcp/oauth/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "chuhaijiang",
			"transport": "streamable-http",
			"url": "https://mcp.gateway.chuhaijiang.com/mcp/oauth"
		}]
	},
	{
		"id": "dknowc-mcp",
		"name": "深知可信工作台",
		"description": "深知可信工作台面向政策、法律、标准和公共服务场景，提供可信问答、权威检索、深度研究和材料整理能力。它可以帮助用户查询政策原文、办事条件、申报材料、补贴资质、法律法规和行业标准，梳理多地区、多时间范围的信息，并基于可追溯的权威来源形成清晰、可核验的结果。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.dknowc.cn/s6/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "dknowc-mcp",
			"transport": "streamable-http",
			"url": "https://mcp.dknowc.cn/s6/mcp"
		}]
	},
	{
		"id": "edgeone-pages",
		"name": "EdgeOne Makers",
		"description": "将项目部署到 EdgeOne Makers 并返回线上访问地址，支持全栈、云函数、AI Agent 等开发场景。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "undefined/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "edgeone-pages",
			"transport": "stdio",
			"command": "npx",
			"args": [
				"edgeone-pages-mcp-fullstack@latest",
				"--region",
				"china"
			]
		}]
	},
	{
		"id": "ezjoin-meeting",
		"name": "EzyJoin智慧会议",
		"description": "用自然语言管理 EzyJoin 智慧会议：预约会议室、创建/取消会议、查询会议日程与 AI 纪要。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://www.ezyjoin.cn/api/mcp/message/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "ezjoin-meeting",
			"transport": "streamable-http",
			"url": "https://www.ezyjoin.cn/api/mcp/message"
		}]
	},
	{
		"id": "fbs-connector",
		"name": "福帮手",
		"description": "福帮手人机协同连接器：面向 WorkBuddy 的身份识别、场景包查询、首值与继续使用记录、乐包状态确认和超级合伙人交接。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://api2.u3w.com/fbs-mcp/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "fbs-connector",
			"transport": "streamable-http",
			"url": "https://api2.u3w.com/fbs-mcp/mcp"
		}]
	},
	{
		"id": "fyopen-lawsearch",
		"name": "法研·法律法规检索",
		"description": "法研·法律法规检索，支持自然语言获取精准、现行有效的法规条文，将高质量、海量的法规知识库，无缝接入各类AI应用与工作流中。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://api.cjbdi.com:8443/354347/mcp_law_service/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "fy-law-search-service",
			"transport": "streamable-http",
			"url": "https://api.cjbdi.com:8443/354347/mcp_law_service"
		}]
	},
	{
		"id": "github-remote",
		"name": "github-remote",
		"description": "",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://api.githubcopilot.com/mcp//.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "github-remote",
			"transport": "streamable-http",
			"url": "https://api.githubcopilot.com/mcp/",
			"headers": { "Authorization": "" }
		}]
	},
	{
		"id": "gmail",
		"name": "gmail",
		"description": "",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "undefined/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "gmail",
			"transport": "stdio",
			"command": "npx",
			"args": ["-y", "mcp-email"],
			"env": {
				"EMAIL_USER": "${EMAIL_USER}",
				"EMAIL_PASSWORD": "${EMAIL_PASSWORD}",
				"EMAIL_TYPE": "gmail"
			}
		}]
	},
	{
		"id": "gongyi-open-mcp",
		"name": "腾讯公益机构服务平台",
		"description": "腾讯公益机构服务平台连接器：用自然语言查询当前登录机构的用户与机构信息、项目、进展、财务披露等机构侧业务数据。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://ssl.gongyi.qq.com/gygw-web/api/open/tob/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "gongyi-open-mcp",
			"transport": "streamable-http",
			"url": "https://ssl.gongyi.qq.com/gygw-web/api/open/tob/mcp"
		}]
	},
	{
		"id": "ima-mcp",
		"name": "ima知识库",
		"description": "引用知识库资料及文件，浏览知识库详情。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://ima.qq.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "ima-mcp",
			"transport": "streamable-http",
			"url": "https://ima.qq.com/mcp"
		}]
	},
	{
		"id": "jira",
		"name": "jira",
		"description": "",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "undefined/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "jira",
			"transport": "stdio",
			"command": "npx",
			"args": ["atlassian-jira-mcp-server"],
			"env": {
				"ATLASSIAN_SITE_NAME": "${JIRA_BASE_URL}",
				"ATLASSIAN_USER_EMAIL": "${JIRA_USERNAME}",
				"ATLASSIAN_API_TOKEN": "${JIRA_API_TOKEN}"
			}
		}]
	},
	{
		"id": "jiushuyun",
		"name": "九数云BI",
		"description": "上传 Excel 或 CSV 表格，一键生成原生的可视化数据分析报告、仪表板、图表。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://work.jiushuyun.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "jiushuyun",
			"transport": "streamable-http",
			"url": "https://work.jiushuyun.com/mcp"
		}]
	},
	{
		"id": "kling-ai",
		"name": "Kling AI",
		"description": "用可灵MCP打造独属于你的 AI 创作工作流。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://klingai.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "kling-ai",
			"transport": "streamable-http",
			"url": "https://klingai.com/mcp"
		}]
	},
	{
		"id": "lexiang",
		"name": "乐享知识库",
		"description": "搜索、创建和管理乐享知识库中的文档。支持导入 Markdown、按标签整理内容、追踪团队文档的更新动态。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.lexiang-app.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "lexiang",
			"transport": "streamable-http",
			"url": "https://mcp.lexiang-app.com/mcp"
		}]
	},
	{
		"id": "mastergo-vibe-mcp",
		"name": "MasterGo 莫高设计",
		"description": "连接 MasterGo 画布，让 AI 进行设计、修改、同步和获取 D2C 代码。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "undefined/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "mastergo",
			"transport": "stdio",
			"command": "npx",
			"args": [
				"-y",
				"@mastergo/vibe-mcp",
				"--url=http://localhost:50678"
			],
			"env": { "NO_PROXY": "localhost,127.0.0.1,::1" }
		}]
	},
	{
		"id": "moka",
		"name": "Moka HR 智能体",
		"description": "招聘和人事一体的 AI 同事，把查询与执行收进一个对话。人才推荐、招聘动态、考勤绩效、审批待办，一句话问清；智能寻聘、面试分析与面试官评估，一句话发起。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.mokahr.com/mcp/.well-known/oauth-authorization-server",
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
		"id": "morningstar",
		"name": "晨星 Morningstar",
		"description": "接入晨星全球与中国基金数据，通过自然语言实现基金查询、筛选、分析与深度研究，以及组合穿透分析",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.morningstar.cn/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "morningstar",
			"transport": "streamable-http",
			"url": "https://mcp.morningstar.cn/mcp"
		}]
	},
	{
		"id": "mx-ds-mcp",
		"name": "东方财富妙想MCP",
		"description": "通过自然语言查询的金融投研 MCP 工具套件，依托东方财富数据源，提供A股、港股、美股、基金、债券、指数板块、宏观数据查询，具备多条件资产筛选、券商研报检索、全市场公告解析、金融资讯检索能力。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mxapi.eastmoney.com/mxds/v2/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "mx-ds-mcp",
			"transport": "streamable-http",
			"url": "https://mxapi.eastmoney.com/mxds/v2/mcp"
		}]
	},
	{
		"id": "mzl-trademark",
		"name": "摩知轮商标查询",
		"description": "用自然语言检索商标：按名称、申请人、申请号、注册号、尼斯类别、法律状态、日期范围查询，覆盖中国及 110+ 海外国家/地区商标局；并支持以图搜图的图形近似检索。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://www.mozlen.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "mzl-trademark",
			"transport": "streamable-http",
			"url": "https://www.mozlen.com/mcp"
		}]
	},
	{
		"id": "neo-crm",
		"name": "销售易CRM",
		"description": "用自然语言查客户、推商机、盘线索、领公海、写跟进，一句话打通销售工作闭环。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.xiaoshouyi.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "neo-crm",
			"transport": "streamable-http",
			"url": "https://mcp.xiaoshouyi.com/mcp"
		}]
	},
	{
		"id": "notion",
		"name": "Notion",
		"description": "创建、搜索和管理 Notion 工作区。用自然语言读取页面、查询数据库、更新内容、整理知识库。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.notion.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "notion",
			"transport": "streamable-http",
			"url": "https://mcp.notion.com/mcp"
		}]
	},
	{
		"id": "pandadata",
		"name": "PandaData 金融数据",
		"description": "查询、整理和分析 A 股、期货、期权、港美股、基金、宏观经济及量化因子等金融数据，支持统计比较与趋势归纳。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://pandadatamcp.pandaaiquant.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "pandadata",
			"transport": "streamable-http",
			"url": "https://pandadatamcp.pandaaiquant.com/mcp"
		}]
	},
	{
		"id": "pkulaw",
		"name": "北大法宝·法律智能检索",
		"description": "检索 + 核验一体：语义（自然语言描述）与关键词双模式检索法规、法条与司法案例；并可把文本中的法条引用与案号回北大法宝库逐条比对、对齐标准名称，输出带 pkulaw.com 原文链接的可溯源结果，专治法律幻觉。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://apim-gateway.pkulaw.com/mcp-law-agg/1.0.0/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "pkulaw",
			"transport": "streamable-http",
			"url": "https://apim-gateway.pkulaw.com/mcp-law-agg/1.0.0/mcp"
		}]
	},
	{
		"id": "qcc-company",
		"name": "企查查",
		"description": "查询和核实企业工商登记信息。支持股东结构、实际控制人、受益所有人、高管团队、对外投资、财务数据、年报及上市信息查询，用自然语言快速完成企业身份核验与背景调查。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://agent.qcc.com/mcp/company/stream/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "qcc-company",
			"transport": "streamable-http",
			"url": "https://agent.qcc.com/mcp/company/stream"
		}]
	},
	{
		"id": "qcc-legal",
		"name": "企查查·法律数据",
		"description": "检索与核验中国法律法规和司法案例。覆盖全量现行法律、行政法规、司法解释——法规级到法条级逐字正文，标注时效性与效力级别；海量裁判文书及 2.5 万+ 权威案例（最高法/最高检指导性案例、公报案例、典型案例）；并对文本中的法条与案号引用逐条回库核验、标注时效、生成可溯源超链。用自然语言完成法条依据查找、类案检索、原文调取与法律引用核验，从源头消除法条与案号幻觉。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://agent.qcc.com/mcp/legal/stream/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "qcc-legal",
			"transport": "streamable-http",
			"url": "https://agent.qcc.com/mcp/legal/stream"
		}]
	},
	{
		"id": "qingflow",
		"name": "轻流",
		"description": "轻流无代码平台连接器。通过自然语言创建应用、管理表单数据、处理审批流程、查询和导出数据，一站式连接轻流全部能力。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.qingflow.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "qingflow",
			"transport": "streamable-http",
			"url": "https://mcp.qingflow.com/mcp"
		}]
	},
	{
		"id": "qixinhuiyan-mcp",
		"name": "启信慧眼",
		"description": "通过启信慧眼 MCP 接入企业全景数据能力，支持用户用自然语言完成企业搜索、工商画像、风险识别、经营动态、知识产权等商业情报分析。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.qixin.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "qixin",
			"transport": "streamable-http",
			"url": "https://mcp.qixin.com/mcp"
		}]
	},
	{
		"id": "qq-mail",
		"name": "QQ邮箱",
		"description": "收发、搜索和整理 QQ 邮件。用自然语言读取邮件内容、汇总邮件线程、管理文件夹。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://api.mail.qq.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "qq-mail",
			"transport": "streamable-http",
			"url": "https://api.mail.qq.com/mcp"
		}]
	},
	{
		"id": "salesnail-instructor",
		"name": "SalesNail 讲师",
		"description": "通过自然语言自助开通讲师试用、维护商业 Profile、生成客户方案，完成游戏创作、课程配置、实时带教，以及团队、学员、班级和商机的证据化分析与复盘。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://sn.long-arena.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "salesnail-instructor",
			"transport": "streamable-http",
			"url": "https://sn.long-arena.com/mcp"
		}]
	},
	{
		"id": "salestouch",
		"name": "SalesTouch 经营执行",
		"description": "通过自然语言连接 SalesTouch，完成组织资料、部门、角色权限、员工邀请、下属管理范围与销售流程配置，并处理销售执行、非销售工作、绩效、内部调研和经营汇总。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://touch.long-arena.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "salestouch",
			"transport": "streamable-http",
			"url": "https://touch.long-arena.com/mcp"
		}]
	},
	{
		"id": "shanglv-mcp-gateway",
		"name": "用友智能服务（AI BaaS）",
		"description": "通过用友银企联、税企联、商旅云等财务服务产品，为企业提供财务税务与银行资金数据服务，并提供企业商旅运营服务和行程服务。用自然语言完成企业的资金、税务、商旅的全面运营管理。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp-gateway.yql.net/mcp//.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "shanglv-mcp-gateway",
			"transport": "streamable-http",
			"url": "https://mcp-gateway.yql.net/mcp/"
		}]
	},
	{
		"id": "sharecrm",
		"name": "纷享销客CRM",
		"description": "用自然语言查询客户、推进商机、写跟进记录、处理审批、建图表等，轻松搞定销售全链路工作。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://open.fxiaoke.com/mcp/connector?id=workbuddy/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "ShareCRM",
			"transport": "streamable-http",
			"url": "https://open.fxiaoke.com/mcp/connector?id=workbuddy"
		}]
	},
	{
		"id": "supabase",
		"name": "supabase",
		"description": "",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.supabase.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "supabase",
			"transport": "streamable-http",
			"url": "https://mcp.supabase.com/mcp"
		}]
	},
	{
		"id": "tapd",
		"name": "TAPD",
		"description": "管理需求、缺陷、任务和迭代。查询项目进度、拆分需求、流转状态、填写工时，覆盖需求到发布的研发全生命周期。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://websocket.tapd.cn/mcp/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "tapd",
			"transport": "streamable-http",
			"url": "https://websocket.tapd.cn/mcp/mcp"
		}]
	},
	{
		"id": "tec-do",
		"name": "Tec-Do 2.0 广告与增长情报",
		"description": "面向出海广告投放和增长团队的 AI 能力集合。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://tec-chi-external-skill-mcp.tec-do.cn/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "tec-do",
			"transport": "streamable-http",
			"url": "https://tec-chi-external-skill-mcp.tec-do.cn/mcp"
		}]
	},
	{
		"id": "tencent-docs",
		"name": "腾讯文档",
		"description": "创建、编辑和协作腾讯文档。用自然语言管理在线表格、文档和幻灯片，轻松完成内容查询、数据整理和团队协同。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://docs.qq.com/openapi/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "tencent-docs",
			"transport": "streamable-http",
			"url": "https://docs.qq.com/openapi/mcp"
		}]
	},
	{
		"id": "tencent-health-nges",
		"name": "腾讯健康NGES",
		"description": "腾讯健康NGES MCP服务，支持智能问数和合规审核等功能",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://test.nges.qq.com/mcp/aggregate/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "nges",
			"transport": "streamable-http",
			"url": "https://test.nges.qq.com/mcp/aggregate"
		}]
	},
	{
		"id": "tencent-survey",
		"name": "腾讯问卷",
		"description": "创建、管理和分析腾讯问卷。用自然语言快速生成问卷、查看回收数据、设置题目逻辑。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://wj.qq.com/api/v2/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "tencent-survey",
			"transport": "streamable-http",
			"url": "https://wj.qq.com/api/v2/mcp"
		}]
	},
	{
		"id": "tencent-tchouse-c",
		"name": "腾讯云数据仓库 TCHouse-C",
		"description": "腾讯云数据仓库 TCHouse-C 智能运维与分析助手，用自然语言完成集群健康诊断、慢 SQL 分析、规格选型推荐、表结构设计与 NL2SQL 查询。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://tcmcpserver.cloud.tencent.com/tchousec/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "tchouse-c",
			"transport": "streamable-http",
			"url": "https://tcmcpserver.cloud.tencent.com/tchousec/mcp"
		}]
	},
	{
		"id": "tencent-weiyun",
		"name": "微云",
		"description": "查看、下载、删除微云文件，并且提供上传文件到微云、生成分享链接能力，帮你管理微云文件",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://www.weiyun.com/api/v3/mcpserver/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "weiyun",
			"transport": "streamable-http",
			"url": "https://www.weiyun.com/api/v3/mcpserver"
		}]
	},
	{
		"id": "tongzhou-fin-research",
		"name": "同舟金融研究",
		"description": "连接公开行情、研报检索、行业图谱与同舟投研材料，为股市研究提供可复核证据。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp-gateway.textmind-gz.com/mcp/tongzhou-research/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "tongzhou-fin-research",
			"transport": "streamable-http",
			"url": "https://mcp-gateway.textmind-gz.com/mcp/tongzhou-research"
		}]
	},
	{
		"id": "tyc-mcp",
		"name": "天眼查",
		"description": "通过天眼查 MCP 查询多维度企业数据。支持工商登记、股东结构、司法风险、知识产权、董监高、经营数据等 160+ 项企业数据能力，用自然语言完成企业尽调与商业情报分析。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.tianyancha.com/v1/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "tyc-mcp",
			"transport": "streamable-http",
			"url": "https://mcp.tianyancha.com/v1"
		}]
	},
	{
		"id": "westock-mcp",
		"name": "腾讯自选股",
		"description": "直连腾讯自选股，实时掌握毫秒级行情与资金动态，用自然语言分析自选数据、设置股价提醒、管理模拟交易，轻松搞定盯盘与投资决策。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://stockbuddy.qq.com/cgi/cgi-bin/openai/mcp/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "westock-mcp",
			"transport": "streamable-http",
			"url": "https://stockbuddy.qq.com/cgi/cgi-bin/openai/mcp/mcp"
		}]
	},
	{
		"id": "wk-workbuddy",
		"name": "威科先行",
		"description": "威科先行依托全面、准确、及时更新的法规、案例等法律数据研发的MCP服务，支持语义检索、关键词检索等场景。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://mcp.wkinfo.com.cn/mcp-servers/integrated//.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "wk-mcp",
			"transport": "streamable-http",
			"url": "https://mcp.wkinfo.com.cn/mcp-servers/integrated/"
		}]
	},
	{
		"id": "xiaoe-cloud-cli",
		"name": "小鹅通",
		"description": "用自然语言管理小鹅通店铺：查询课程与学员，创建和编辑课程，查看订单，并查找或上传图片、音频、电子书和文档素材。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://agent.xiaoe-tech.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "xiaoe-cloud-cli",
			"transport": "streamable-http",
			"url": "https://agent.xiaoe-tech.com/mcp"
		}]
	},
	{
		"id": "yuandian-mcp",
		"name": "华宇元典法律数据",
		"description": "华宇元典法律数据为智能体提供法律法规、案例文书、企业信息 MCP 工具能力。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://open.chineselaw.com/mcp/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "yuandian_mcp",
			"transport": "streamable-http",
			"url": "https://open.chineselaw.com/mcp"
		}]
	},
	{
		"id": "yzf-invoice-mcp-server",
		"name": "云帐房AI开票",
		"description": "通过自然语言使用云帐房 AI 开票能力，完成开票信息识别，并前往电子税局开票。",
		"authMode": "oauth",
		"auth": {
			"discoveryUrl": "https://super-ai-app.yunzhangfang.com/api/mcp/invoice/stream/.well-known/oauth-authorization-server",
			"clientId": "",
			"authorizeUrl": "",
			"tokenUrl": "",
			"redirectUri": "http://127.0.0.1/callback",
			"pkce": true,
			"publicClient": true,
			"scopes": "offline_access"
		},
		"mcp": [{
			"serverName": "yzf-invoice-mcp-server",
			"transport": "streamable-http",
			"url": "https://super-ai-app.yunzhangfang.com/api/mcp/invoice/stream"
		}]
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
function json(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
		return new Promise((resolve, reject) => {
			const child = spawn(command, rest, {
				env: { ...process.env },
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
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
				resolve(match[0]);
			});
		});
	};
	/** Render static headers: `${FIELD}` templates from credential fields, empty Authorization -> Bearer token. */
	const renderHeaders = (server, credential) => {
		const headers = {};
		for (const [name, value] of Object.entries(server.headers ?? {})) {
			if (value === "") {
				if (credential?.accessToken) headers[name] = `Bearer ${credential.accessToken}`;
				continue;
			}
			headers[name] = value.replace(/\$\{([^}]+)\}/g, (_, key) => credential?.fields?.[key] ?? "");
		}
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
			const id = decodeURIComponent(req.url?.split("/")[4] ?? "");
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
			const id = decodeURIComponent(req.url?.split("/")[4] ?? "");
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
			const id = decodeURIComponent(req.url?.split("/")[4] ?? "");
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
			const id = decodeURIComponent(req.url?.split("/")[4] ?? "");
			if (!getDef(id)) return json(res, 404, { error: `unknown connector: ${id}` });
			await disconnect(id);
			json(res, 200, { ok: true });
		};
		const disposers = [ctx.webServer.register({
			kind: "exact",
			path: "/api/pico/connectors",
			handler: list
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
export { ConnectorStore, apply, inject, name };

//# sourceMappingURL=index.js.map