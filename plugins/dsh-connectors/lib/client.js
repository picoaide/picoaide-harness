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
			border: "1px solid #333",
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
			fontWeight: 600
		};
		const DESC = {
			fontSize: 13,
			margin: 0,
			color: "#c9ccd3"
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
			border: "1px solid #444",
			background: "#1a1d24",
			color: "#e6e6e6",
			fontSize: 13
		};
		const LABEL = {
			fontSize: 12,
			margin: 0,
			color: "#c9ccd3"
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
		function ConnectorsSection(_props) {
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
		/** Stable Cordis plugin name for the connectors client half. */
		const name = "pico-connectors-client";
		/** Services required: the slot registry for settings pages. */
		const inject = ["slots"];
		/**
		* Register the connectors settings section (mirrors WorkBuddy's connector
		* center): a per-connector card list with connect/disconnect and the auth
		* request surfaces (OAuth redirect, device code, token form).
		* @param ctx - browser Cordis context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.slots.register({
				name: "settings.section",
				id: "connectors",
				order: 500,
				label: "连接器"
			}, ConnectorsSection), "connectors: settings section");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map