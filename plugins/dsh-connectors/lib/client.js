window.__ModuleLoader__.load({
	id: "@picoaide/dsh-connectors",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
		/**
		* Connectors client UI copy: zh is the key source, en mirrors the full key
		* set (the same pattern as dsh-cron/dsh-task locales).
		*/
		const zh = {
			"panel.title": "连接器",
			"panel.close": "关闭",
			"search.placeholder": "搜索连接器…",
			"filter.all": "全部",
			"filter.connected": "已连接",
			"filter.disconnected": "未连接",
			"filter.count": "{connected}/{total} 已连接",
			"empty.noMatch": "暂无匹配的连接器",
			"status.disconnected": "未连接",
			"status.connecting": "连接中…",
			"status.connected": "已连接",
			"status.unauthorized": "需要授权",
			"status.error": "连接失败",
			"action.connect": "连接",
			"action.disconnect": "断开",
			"action.submit": "提交",
			"action.connecting": "连接中…",
			"action.disconnecting": "断开中…",
			"auth.verificationHint": "请打开以下地址并登录授权：",
			"auth.code": "授权码：{code}",
			"auth.authorizeOpened": "授权页已在浏览器中打开；若未弹出请点击：",
			"auth.waiting": "等待授权完成…"
		};
		const en = {
			"panel.title": "Connectors",
			"panel.close": "Close",
			"search.placeholder": "Search connectors…",
			"filter.all": "All",
			"filter.connected": "Connected",
			"filter.disconnected": "Disconnected",
			"filter.count": "{connected}/{total} connected",
			"empty.noMatch": "No matching connectors",
			"status.disconnected": "Not connected",
			"status.connecting": "Connecting…",
			"status.connected": "Connected",
			"status.unauthorized": "Authorization required",
			"status.error": "Connection failed",
			"action.connect": "Connect",
			"action.disconnect": "Disconnect",
			"action.submit": "Submit",
			"action.connecting": "Connecting…",
			"action.disconnecting": "Disconnecting…",
			"auth.verificationHint": "Open the following address to authorize:",
			"auth.code": "Authorization code: {code}",
			"auth.authorizeOpened": "The authorization page was opened; if not, click here:",
			"auth.waiting": "Waiting for authorization…"
		};
		/** Translate a key (zh key source; en mirrors the full key set). */
		function t(key, params) {
			let text = zh[key];
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value);
			return text;
		}
		/** Map raw connector/CLI errors to user-facing copy (P3-6). */
		function friendlyConnectorError(raw) {
			if (raw.includes("退出码")) return "登录命令失败：请确认已安装对应命令行工具并完成登录，然后重试";
			if (raw.includes("ENOENT")) return "未找到登录命令：请先安装对应命令行工具";
			if (raw.includes("token") || raw.includes("授权") || raw.includes("登录")) return raw;
			return `连接失败：${raw}`;
		}
		//#endregion
		//#region src/client/ConnectorsSection.tsx
		const GRID = {
			display: "grid",
			gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
			gap: 12
		};
		const CARD = {
			display: "flex",
			flexDirection: "column",
			gap: 8,
			padding: "14px 16px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 12,
			minWidth: 0
		};
		const HEAD = {
			display: "flex",
			alignItems: "flex-start",
			justifyContent: "space-between",
			gap: 8
		};
		const TITLE$1 = {
			fontSize: 15,
			margin: 0,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const DESC = {
			fontSize: 13,
			margin: 0,
			color: "var(--dsw-alias-label-secondary)",
			display: "-webkit-box",
			WebkitLineClamp: 2,
			WebkitBoxOrient: "vertical",
			overflow: "hidden",
			minHeight: 36
		};
		const STATUS = {
			fontSize: 12,
			margin: 0,
			flex: "none",
			paddingTop: 2
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
		const LABEL$1 = {
			fontSize: 12,
			margin: 0,
			color: "var(--dsw-alias-label-caption)"
		};
		const TOOLBAR = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			marginBottom: 16
		};
		const FILTER_BUTTON = {
			padding: "5px 10px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			cursor: "pointer"
		};
		const FILTER_ACTIVE = {
			...FILTER_BUTTON,
			background: "var(--dsw-alias-bg-layer-3)",
			color: "var(--dsw-alias-label-primary)"
		};
		const statusText = {
			disconnected: t("status.disconnected"),
			connecting: t("status.connecting"),
			connected: t("status.connected"),
			unauthorized: t("status.unauthorized"),
			error: t("status.error")
		};
		const statusColor = {
			disconnected: "var(--dsw-alias-label-caption)",
			connecting: "var(--dsw-alias-state-warn-primary)",
			connected: "var(--dsw-alias-state-success-primary)",
			unauthorized: "var(--dsw-alias-state-warn-primary)",
			error: "var(--dsw-alias-state-error-primary)"
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
			const [busy, setBusy] = (0, react.useState)(null);
			const openedUrl = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (entry.request?.authorizeUrl && openedUrl.current !== entry.request.authorizeUrl) {
					openedUrl.current = entry.request.authorizeUrl;
					window.open(entry.request.authorizeUrl, "_blank");
				}
			}, [entry.request?.authorizeUrl]);
			const connect = (0, react.useCallback)(async () => {
				if (busy !== null) return;
				setError(null);
				setBusy("connect");
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/connect`, { method: "POST" });
					if (entry.request?.fields && entry.request.fields.length > 0) setFormValues({});
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e));
				} finally {
					setBusy(null);
				}
			}, [
				busy,
				entry.id,
				entry.request?.fields,
				onChanged
			]);
			const submitForm = (0, react.useCallback)(async () => {
				if (busy !== null) return;
				setError(null);
				setBusy("submit");
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/auth-submit`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ fields: formValues })
					});
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e));
				} finally {
					setBusy(null);
				}
			}, [
				busy,
				entry.id,
				formValues,
				onChanged
			]);
			const disconnect = (0, react.useCallback)(async () => {
				if (busy !== null) return;
				setError(null);
				setBusy("disconnect");
				try {
					await fetchJson(`/api/pico/connectors/${encodeURIComponent(entry.id)}/disconnect`, { method: "POST" });
					onChanged();
				} catch (e) {
					setError(e instanceof Error ? friendlyConnectorError(e.message) : String(e));
				} finally {
					setBusy(null);
				}
			}, [
				busy,
				entry.id,
				onChanged
			]);
			const polling = entry.status === "connecting" && (entry.request?.authorizeUrl || entry.request?.verificationUrl);
			const needsForm = entry.status === "connecting" && Boolean(entry.request?.fields?.length);
			const isConnected = entry.status === "connected";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: CARD,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: HEAD,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: TITLE$1,
							title: entry.name,
							children: entry.name
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								...STATUS,
								color: statusColor[entry.status] ?? "#c9ccd3"
							},
							children: statusText[entry.status] ?? entry.status
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: DESC,
						children: entry.description
					}),
					entry.request?.verificationUrl && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 4
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: LABEL$1,
								children: t("auth.verificationHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: entry.request.verificationUrl,
								target: "_blank",
								rel: "noreferrer",
								style: {
									fontSize: 12,
									color: "#60a5fa",
									wordBreak: "break-all"
								},
								children: entry.request.verificationUrl
							}),
							entry.request.userCode && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: LABEL$1,
								children: t("auth.code", { code: entry.request.userCode })
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
							style: LABEL$1,
							children: t("auth.authorizeOpened")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							href: entry.request.authorizeUrl,
							target: "_blank",
							rel: "noreferrer",
							style: {
								fontSize: 12,
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
								style: LABEL$1,
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
							disabled: busy === "submit",
							onClick: () => {
								submitForm();
							},
							children: busy === "submit" ? t("action.connecting") : t("action.submit")
						})]
					}),
					polling && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: LABEL$1,
						children: t("auth.waiting")
					}),
					entry.error && !isConnected && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...STATUS,
							color: statusColor.error
						},
						children: friendlyConnectorError(entry.error)
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							...STATUS,
							color: statusColor.error
						},
						children: error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							marginTop: "auto",
							paddingTop: 4
						},
						children: isConnected ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...BUTTON,
								background: "var(--dsw-alias-state-error-primary)"
							},
							disabled: busy === "disconnect",
							onClick: () => {
								disconnect();
							},
							children: busy === "disconnect" ? t("action.disconnecting") : t("action.disconnect")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: BUTTON,
							disabled: entry.status === "connecting" || busy === "connect",
							onClick: () => {
								connect();
							},
							children: entry.status === "connecting" || busy === "connect" ? t("action.connecting") : t("action.connect")
						})
					})
				]
			});
		}
		function ConnectorsList() {
			const [connectors, setConnectors] = (0, react.useState)(null);
			const [query, setQuery] = (0, react.useState)("");
			const [statusFilter, setStatusFilter] = (0, react.useState)("all");
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
			const visible = (0, react.useMemo)(() => {
				if (!connectors) return [];
				const q = query.trim().toLowerCase();
				return connectors.filter((c) => {
					if (statusFilter === "connected" && c.status !== "connected") return false;
					if (statusFilter === "disconnected" && c.status === "connected") return false;
					if (!q) return true;
					return c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
				});
			}, [
				connectors,
				query,
				statusFilter
			]);
			const connectedCount = (0, react.useMemo)(() => (connectors ?? []).filter((c) => c.status === "connected").length, [connectors]);
			if (connectors === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: DESC,
				children: t("status.connecting")
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: TOOLBAR,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...INPUT,
								flex: 1,
								minWidth: 0
							},
							placeholder: t("search.placeholder"),
							value: query,
							onChange: (e) => setQuery(e.target.value)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: statusFilter === "all" ? FILTER_ACTIVE : FILTER_BUTTON,
							onClick: () => setStatusFilter("all"),
							children: t("filter.all")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: statusFilter === "connected" ? FILTER_ACTIVE : FILTER_BUTTON,
							onClick: () => setStatusFilter("connected"),
							children: t("filter.connected")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: statusFilter === "disconnected" ? FILTER_ACTIVE : FILTER_BUTTON,
							onClick: () => setStatusFilter("disconnected"),
							children: t("filter.disconnected")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								...LABEL$1,
								flex: "none"
							},
							children: t("filter.count", {
								connected: String(connectedCount),
								total: String(connectors.length)
							})
						})
					]
				}),
				visible.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: DESC,
					children: t("empty.noMatch")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: GRID,
					children: visible.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectorCard, {
						entry,
						onChanged: refresh
					}, entry.id))
				})
			] });
		}
		//#endregion
		//#region src/client/ConnectorPanel.tsx
		const OVERLAY = {
			position: "fixed",
			inset: 0,
			zIndex: 1e3,
			display: "flex",
			alignItems: "center",
			justifyContent: "center"
		};
		const MASK = {
			position: "absolute",
			inset: 0,
			background: "var(--dsw-alias-bg-mask-1)",
			backdropFilter: "var(--dsw-mask-blur)"
		};
		const PANEL = {
			position: "relative",
			zIndex: 1,
			display: "flex",
			flexDirection: "column",
			width: 900,
			maxWidth: "calc(100vw - 48px)",
			height: "min(680px, calc(100vh - 48px))",
			borderRadius: 24,
			overflow: "hidden",
			background: "var(--dsw-alias-bg-layer-2)",
			boxShadow: "var(--dsw-shadow-lv3)"
		};
		const HEADER = {
			flex: "none",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			height: 54,
			boxSizing: "border-box",
			padding: "14px 18px"
		};
		const TITLE = {
			margin: 0,
			fontSize: 16,
			lineHeight: "24px",
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const CLOSE = {
			border: "none",
			background: "transparent",
			cursor: "pointer",
			color: "var(--dsw-alias-label-caption)",
			fontSize: 13,
			padding: "4px 8px",
			borderRadius: 6
		};
		const BODY = {
			flex: 1,
			minHeight: 0,
			overflowY: "auto",
			padding: 24
		};
		/**
		* Connector center modal: the registered connectors with their auth flows
		* (the connectors plugin's client half renders the list).
		* @param props.onClose - close the modal.
		*/
		function ConnectorPanel({ onClose }) {
			const panelRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const onKey = (e) => {
					if (e.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				panelRef.current?.focus();
				return () => {
					window.removeEventListener("keydown", onKey);
				};
			}, [onClose]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: OVERLAY,
				role: "presentation",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: MASK,
					"aria-hidden": "true",
					onClick: onClose
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: PANEL,
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("panel.title"),
					tabIndex: -1,
					ref: panelRef,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: HEADER,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							style: TITLE,
							children: t("panel.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: CLOSE,
							onClick: onClose,
							children: t("panel.close")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: BODY,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectorsList, {})
					})]
				})]
			});
		}
		//#endregion
		//#region src/client/ConnectorTrigger.tsx
		const TRIGGER_WIDE = {
			flex: "none",
			display: "flex",
			alignItems: "center",
			gap: 8,
			width: "calc(100% + 8px)",
			height: 34,
			margin: "4px -4px 4px",
			padding: "6px 2px 6px 10px",
			boxSizing: "border-box",
			border: "none",
			borderRadius: 12,
			background: "transparent",
			cursor: "pointer",
			overflow: "hidden",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "inherit",
			fontSize: 14,
			lineHeight: "22px"
		};
		const TRIGGER_RAIL = {
			...TRIGGER_WIDE,
			width: 36,
			height: 36,
			margin: "8px 0 10px",
			justifyContent: "center",
			gap: 0,
			padding: 0,
			borderRadius: "50%"
		};
		const LABEL = {
			overflow: "hidden",
			whiteSpace: "nowrap"
		};
		/**
		* Sidebar foot action opening the connector center modal, stacked above the
		* Skill center and Settings triggers (registered into `sidebar.footer.action`).
		* @param props - sidebar column state from the foot slot owner.
		*/
		/** Cross-plugin panel activation event (shared with cron/task/enterprise/browser). */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const PANEL_NAME = "connector-center";
		/**
		* Sidebar foot action opening the connector center modal, stacked above the
		* Skill center and Settings triggers (registered into `sidebar.footer.action`).
		* Opening this panel evicts sibling panels via the shared activation event;
		* a sibling activation closes this panel.
		* @param props - sidebar column state from the foot slot owner.
		*/
		function ConnectorTrigger(props) {
			const [open, setOpen] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const onOtherActivate = (event) => {
					if (event.detail !== PANEL_NAME) setOpen(false);
				};
				document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
				return () => {
					document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				};
			}, []);
			const openPanel = () => {
				if (open) return;
				setOpen(true);
				document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "pico-connector-trigger",
				style: props.wide ? TRIGGER_WIDE : TRIGGER_RAIL,
				"aria-expanded": open,
				onClick: openPanel,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width: props.wide ? 16 : 18,
					height: props.wide ? 16 : 18,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "2.5",
						y: "6.5",
						width: "8",
						height: "8",
						rx: "1.5",
						stroke: "currentColor",
						strokeWidth: "1.3"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M6 6.5V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M6 10.5h2",
						stroke: "currentColor",
						strokeWidth: "1.3",
						strokeLinecap: "round"
					})]
				}), props.wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: LABEL,
					children: "连接器"
				})]
			}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectorPanel, { onClose: () => {
				setOpen(false);
			} })] });
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Connectors client half: registers the connector center foot action in the
		* sidebar (its modal renders the connector list and drives the auth flows),
		* and registers one slash command per CONNECTED connector (`/<connector-id>`)
		* so the `/` menu only shows connectors you can act on. Picking an example
		* prompt sends it to the session — the model then calls the connector's
		* injected MCP tools.
		*/
		const name = "pico-connectors-client";
		const LOCALE_NS = "connectors";
		const inject = [
			"commandUi",
			"sessions",
			"slots",
			"locale"
		];
		const POLL_INTERVAL_MS = 3e3;
		function apply(ctx) {
			ctx.effect(() => {
				const off = ctx.locale.register(LOCALE_NS, {
					zh,
					en
				});
				return () => {
					off();
				};
			}, "connectors: client dictionaries");
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = ".pico-connector-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }";
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, "connectors: trigger hover style");
			ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "connector-center",
				order: 0
			}, ConnectorTrigger)), "connectors: connector center foot action");
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
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map