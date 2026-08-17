window.__ModuleLoader__.load({
	id: "@picoaide/dsh-connectors",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/ConnectorsSection.tsx
		const ROW = {
			display: "flex",
			flexDirection: "column",
			gap: 12
		};
		const CARD = {
			display: "flex",
			flexDirection: "column",
			gap: 8,
			padding: "12px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8
		};
		const HEAD = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 8
		};
		const TITLE = {
			fontSize: 15,
			margin: 0,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const DESC = {
			fontSize: 13,
			margin: 0,
			color: "var(--dsw-alias-label-secondary)"
		};
		const STATUS = {
			fontSize: 12,
			margin: 0
		};
		const BUTTON = {
			padding: "6px 12px",
			borderRadius: 6,
			border: "none",
			fontSize: 13,
			cursor: "pointer",
			background: "#2563eb",
			color: "#fff"
		};
		const INPUT = {
			padding: "6px 10px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13
		};
		const LABEL = {
			fontSize: 12,
			margin: 0,
			color: "var(--dsw-alias-label-caption)"
		};
		const statusText = {
			disconnected: "未连接",
			connecting: "连接中…",
			connected: "已连接",
			unauthorized: "需要授权",
			error: "连接失败"
		};
		const statusColor = {
			disconnected: "#c9ccd3",
			connecting: "#eab308",
			connected: "#22c55e",
			unauthorized: "#f59e0b",
			error: "#f87171"
		};
		async function fetchJson(url, init) {
			const res = await fetch(url, init);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error ?? `HTTP ${String(res.status)}`);
			}
			return await res.json();
		}
		function ConnectorCard({ entry, onChanged }) {
			const [formValues, setFormValues] = (0, react.useState)({});
			const [error, setError] = (0, react.useState)(null);
			const openedUrl = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (entry.request?.authorizeUrl && openedUrl.current !== entry.request.authorizeUrl) {
					openedUrl.current = entry.request.authorizeUrl;
					window.open(entry.request.authorizeUrl, "_blank");
				}
			}, [entry.request?.authorizeUrl]);
			const connect = (0, react.useCallback)(async () => {
				setError(null);
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/connect`, { method: "POST" });
					if (entry.request?.fields && entry.request.fields.length > 0) setFormValues({});
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			}, [entry.id, onChanged]);
			const submitForm = (0, react.useCallback)(async () => {
				setError(null);
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/auth-submit`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ fields: formValues })
					});
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			}, [
				entry.id,
				formValues,
				onChanged
			]);
			const disconnect = (0, react.useCallback)(async () => {
				setError(null);
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/disconnect`, { method: "POST" });
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			}, [entry.id, onChanged]);
			const polling = entry.status === "connecting" && (entry.request?.authorizeUrl || entry.request?.verificationUrl);
			const needsForm = entry.status === "connecting" && Boolean(entry.request?.fields?.length);
			const isConnected = entry.status === "connected";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: CARD,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: HEAD,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 4,
								minWidth: 0
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: TITLE,
								children: entry.name
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: DESC,
								children: entry.description
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								...STATUS,
								color: statusColor[entry.status] ?? "#c9ccd3"
							},
							children: statusText[entry.status] ?? entry.status
						})]
					}),
					entry.request?.verificationUrl && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 4
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: LABEL,
								children: "请在浏览器中打开以下地址并登录授权："
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: entry.request.verificationUrl,
								target: "_blank",
								rel: "noreferrer",
								style: {
									fontSize: 13,
									color: "#60a5fa",
									wordBreak: "break-all"
								},
								children: entry.request.verificationUrl
							}),
							entry.request.userCode && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: LABEL,
								children: ["授权码：", entry.request.userCode]
							})
						]
					}),
					entry.request?.authorizeUrl && !entry.request.verificationUrl && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 4
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: LABEL,
							children: "授权页已在浏览器中打开；若未弹出请点击："
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							href: entry.request.authorizeUrl,
							target: "_blank",
							rel: "noreferrer",
							style: {
								fontSize: 13,
								color: "#60a5fa",
								wordBreak: "break-all"
							},
							children: entry.request.authorizeUrl
						})]
					}),
					needsForm && entry.request?.fields && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 8
						},
						children: [entry.request.fields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 4
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: LABEL,
								htmlFor: `${entry.id}-${field.key}`,
								children: [field.label, field.required ? " *" : ""]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: `${entry.id}-${field.key}`,
								style: INPUT,
								type: field.type === "password" ? "password" : "text",
								value: formValues[field.key] ?? "",
								onChange: (e) => setFormValues((v) => ({
									...v,
									[field.key]: e.target.value
								}))
							})]
						}, field.key)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: BUTTON,
							onClick: () => {
								submitForm();
							},
							children: "提交"
						})]
					}),
					polling && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: LABEL,
						children: "等待授权完成…"
					}),
					entry.error && !isConnected && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...STATUS,
							color: statusColor.error
						},
						children: entry.error
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...STATUS,
							color: statusColor.error
						},
						children: error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: isConnected ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: {
							...BUTTON,
							background: "#dc2626"
						},
						onClick: () => {
							disconnect();
						},
						children: "断开"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: BUTTON,
						disabled: entry.status === "connecting",
						onClick: () => {
							connect();
						},
						children: entry.status === "connecting" ? "连接中…" : "连接"
					}) })
				]
			});
		}
		function ConnectorsList() {
			const [connectors, setConnectors] = (0, react.useState)(null);
			const refresh = (0, react.useCallback)(() => {
				fetchJson("/api/pico/connectors").then((data) => setConnectors(data.connectors)).catch(() => setConnectors([]));
			}, []);
			(0, react.useEffect)(() => {
				refresh();
				const timer = setInterval(() => {
					refresh();
				}, 2e3);
				return () => clearInterval(timer);
			}, [refresh]);
			if (connectors === null) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: ROW,
				children: [connectors.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: DESC,
					children: "暂无连接器"
				}), connectors.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectorCard, {
					entry,
					onChanged: refresh
				}, entry.id))]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Connectors client half: exports the connector list surface for the
		* connector center (rendered by the enterprise sidebar panel), and registers
		* one slash command per CONNECTED connector (`/<connector-id>`) so the `/`
		* menu only shows connectors you can act on. Picking an example prompt sends
		* it to the session — the model then calls the connector's injected MCP tools.
		*/
		const name = "pico-connectors-client";
		const inject = ["commandUi", "sessions"];
		const POLL_INTERVAL_MS = 3e3;
		function apply(ctx) {
			const commandUi = ctx.get("commandUi");
			const sessions = ctx.get("sessions");
			const commandDisposers = /* @__PURE__ */ new Map();
			const syncCommands = (connectors) => {
				const connected = new Set(connectors.filter((c) => c.status === "connected").map((c) => c.id));
				for (const [id, dispose] of commandDisposers) if (!connected.has(id)) {
					dispose();
					commandDisposers.delete(id);
				}
				for (const connector of connectors) {
					if (connector.status !== "connected" || commandDisposers.has(connector.id)) continue;
					commandDisposers.set(connector.id, commandUi.register({
						name: connector.id,
						description: `${connector.name}（已连接）`,
						available: () => true,
						ui: {
							kind: "popupSelect",
							options: async () => {
								return [...(connector.examples ?? []).map((example, index) => ({
									id: `example-${index}`,
									label: example
								})), {
									id: "info",
									label: "查看连接器信息"
								}];
							},
							onSelect: async (option, session) => {
								const live = sessions.binding(session.sessionId)?.session;
								if (live === void 0) return;
								const text = option.id === "info" ? `${connector.name}（已连接）。模型可直接调用其注入工具（mcp__*），例如：${(connector.examples ?? []).join("、")}` : option.label;
								await live.prompt([{
									type: "text",
									text
								}], "queue");
							}
						}
					}));
				}
			};
			ctx.effect(() => {
				let cancelled = false;
				const poll = async () => {
					try {
						const res = await fetch("/api/pico/connectors");
						if (!res.ok) return;
						const data = await res.json();
						if (!cancelled) syncCommands(data.connectors ?? []);
					} catch {}
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, POLL_INTERVAL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
					for (const dispose of commandDisposers.values()) dispose();
				};
			}, "pico-connectors-client: per-connector slash commands");
		}
		//#endregion
		exports.ConnectorsList = ConnectorsList;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map