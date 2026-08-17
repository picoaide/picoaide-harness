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
/** Run an oauth2 authorization-code flow with PKCE and a loopback callback. */
async function runOAuth(def, options) {
	const auth = def.auth;
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
	const clientId = auth.registrationEndpoint ? await registerClient(auth, redirectUri, auth.registrationEndpoint) : auth.clientId;
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
	const authorizeUrl = new URL(auth.authorizeUrl);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("client_id", clientId);
	authorizeUrl.searchParams.set("redirect_uri", redirectUri);
	if (auth.scopes) authorizeUrl.searchParams.set("scope", auth.scopes);
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
	const tokenUrl = options.tokenUrlOverride ?? auth.tokenUrl;
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
	const defs = [
		salesEasyDef,
		dingTalkDef,
		...options.connectors ?? []
	];
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
	/** Register the connector's MCP servers through the mcp-client plugin. */
	const registerMcp = async (def) => {
		const credential = await store.readCredential(def.id);
		const { apply: applyMcpClient } = await import("@deepseek-ai/dsh-mcp-client");
		for (const server of def.mcp) {
			const config = server.transport === "streamable-http" ? {
				transport: "streamable-http",
				serverName: server.serverName,
				url: server.urlCommand ? await resolveUrlCommand(server.urlCommand) : server.url ?? "",
				headers: credential?.accessToken ? { Authorization: `Bearer ${credential.accessToken}` } : {},
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