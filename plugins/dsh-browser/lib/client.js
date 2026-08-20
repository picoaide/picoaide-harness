window.__ModuleLoader__.load({
	id: "@picoaide/dsh-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
		/**
		* Browser client UI copy: zh is the key source, en mirrors the full key set.
		*/
		const zh = {
			"panel.title": "浏览器",
			"panel.close": "关闭",
			"panel.closeTab": "关闭标签页",
			"panel.tab": "标签",
			"panel.loading": "加载中",
			"panel.newTab": "新建标签页",
			"panel.back": "后退",
			"panel.forward": "前进",
			"panel.reload": "刷新",
			"panel.addressPlaceholder": "输入网址后回车",
			"panel.go": "Go",
			"panel.takeover": "接管",
			"panel.release": "接管中·释放",
			"panel.takeoverTitle": "切换手动接管（暂停 agent 浏览器操作）",
			"panel.clear": "清除",
			"panel.clearTitle": "清除浏览数据并关闭",
			"panel.controlledNotice": "用户接管中：agent 的浏览器操作已暂停"
		};
		const en = {
			"panel.title": "Browser",
			"panel.close": "Close",
			"panel.closeTab": "Close tab",
			"panel.tab": "Tab",
			"panel.loading": "loading",
			"panel.newTab": "New tab",
			"panel.back": "Back",
			"panel.forward": "Forward",
			"panel.reload": "Reload",
			"panel.addressPlaceholder": "Enter a URL and press Enter",
			"panel.go": "Go",
			"panel.takeover": "Take over",
			"panel.release": "Release",
			"panel.takeoverTitle": "Toggle manual control (blocks agent browser actions)",
			"panel.clear": "Clear",
			"panel.clearTitle": "Clear browsing data and close",
			"panel.controlledNotice": "User control: agent browser actions are paused"
		};
		/** Translate a key (zh key source; en mirrors the full key set). */
		function t(key) {
			return zh[key];
		}
		//#endregion
		//#region src/client/BrowserPanel.tsx
		const POLL_INTERVAL_MS = 2e3;
		async function fetchJson(url, init) {
			const res = await fetch(url, init);
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.error ?? `HTTP ${res.status}`);
			}
			return await res.json();
		}
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
			width: 960,
			maxWidth: "calc(100vw - 48px)",
			height: "min(720px, calc(100vh - 48px))",
			borderRadius: 24,
			overflow: "hidden",
			background: "var(--dsw-alias-bg-layer-2)",
			boxShadow: "var(--dsw-shadow-lv3)",
			padding: 12,
			boxSizing: "border-box",
			gap: 8
		};
		const HEADER = {
			flex: "none",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between"
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
		const toolbarButton = {
			padding: "4px 8px",
			fontSize: 12,
			borderRadius: 4,
			border: "1px solid #8884",
			background: "transparent",
			cursor: "pointer",
			color: "inherit"
		};
		const inputStyle = {
			flex: 1,
			minWidth: 0,
			padding: "4px 8px",
			fontSize: 12,
			borderRadius: 4,
			border: "1px solid #8884",
			background: "transparent",
			color: "inherit"
		};
		function BrowserPanel({ onClose }) {
			const [state, setState] = (0, react.useState)({
				tabs: [],
				controlled: false
			});
			const [ops, setOps] = (0, react.useState)([]);
			const [address, setAddress] = (0, react.useState)("");
			const addressDirtyRef = (0, react.useRef)(false);
			const [error, setError] = (0, react.useState)(null);
			const viewRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const el = viewRef.current;
				if (el === null) return;
				const report = () => {
					const rect = el.getBoundingClientRect();
					fetchJson("/api/pico/browser/panel", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							visible: true,
							bounds: {
								x: rect.x,
								y: rect.y,
								width: rect.width,
								height: rect.height
							}
						})
					}).catch(() => {});
				};
				report();
				const observer = new ResizeObserver(report);
				observer.observe(el);
				window.addEventListener("resize", report);
				return () => {
					observer.disconnect();
					window.removeEventListener("resize", report);
					fetchJson("/api/pico/browser/panel", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ visible: false })
					}).catch(() => {});
				};
			}, []);
			(0, react.useEffect)(() => {
				let alive = true;
				const poll = async () => {
					try {
						const next = await fetchJson("/api/pico/browser/state");
						if (!alive) return;
						setState(next);
						const visible = next.tabs.find((t) => t.visible);
						if (!addressDirtyRef.current) setAddress(visible?.url ?? "");
						const log = await fetchJson("/api/pico/browser/ops");
						if (!alive) return;
						setOps(log.ops.slice(0, 20));
						setError(null);
					} catch (cause) {
						if (alive) setError(cause instanceof Error ? cause.message : String(cause));
					}
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, POLL_INTERVAL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
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
			const post = (0, react.useCallback)(async (action, body) => {
				try {
					await fetchJson(`/api/pico/browser/${action}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body ?? {})
					});
					setError(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, []);
			const openAddress = () => {
				const url = address.trim();
				if (url === "") return;
				const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;
				if (state.tabs.length === 0) post("open", { url: withScheme });
				else post("navigate", {
					tab: state.tabs.find((t) => t.visible)?.id,
					url: withScheme
				});
				setAddress("");
			};
			const visibleTab = state.tabs.find((t) => t.visible)?.id;
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
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: HEADER,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								style: TITLE,
								children: t("panel.title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: CLOSE,
								onClick: onClose,
								"aria-label": t("panel.close"),
								children: t("panel.close")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 4,
								alignItems: "center",
								flexWrap: "wrap",
								flex: "none"
							},
							children: [state.tabs.map((tab) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								onClick: () => {
									post("switch-tab", { tab: tab.id });
								},
								style: {
									...toolbarButton,
									fontWeight: tab.visible ? 700 : 400,
									maxWidth: 160,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								},
								title: tab.url,
								"aria-label": `${t("panel.tab")} ${tab.id}${tab.loading ? ` (${t("panel.loading")})` : ""}`,
								children: [
									tab.title || tab.url || `${t("panel.tab")} ${tab.id}`,
									tab.loading ? "…" : "",
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										role: "button",
										tabIndex: 0,
										"aria-label": t("panel.closeTab"),
										onClick: (e) => {
											e.stopPropagation();
											post("close-tab", { tab: tab.id });
										},
										onKeyDown: (e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.stopPropagation();
												post("close-tab", { tab: tab.id });
											}
										},
										style: {
											marginLeft: 4,
											opacity: .6,
											cursor: "pointer"
										},
										children: "×"
									})
								]
							}, tab.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: toolbarButton,
								onClick: () => {
									post("open");
								},
								title: t("panel.newTab"),
								"aria-label": t("panel.newTab"),
								children: "+"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 4,
								alignItems: "center",
								flex: "none"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: toolbarButton,
									disabled: visibleTab === void 0,
									onClick: () => {
										post("back");
									},
									title: t("panel.back"),
									"aria-label": t("panel.back"),
									children: "←"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: toolbarButton,
									disabled: visibleTab === void 0,
									onClick: () => {
										post("forward");
									},
									title: t("panel.forward"),
									"aria-label": t("panel.forward"),
									children: "→"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: toolbarButton,
									disabled: visibleTab === void 0,
									onClick: () => {
										post("reload");
									},
									title: t("panel.reload"),
									"aria-label": t("panel.reload"),
									children: "⟳"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: inputStyle,
									value: address,
									onChange: (e) => {
										addressDirtyRef.current = true;
										setAddress(e.target.value);
									},
									onKeyDown: (e) => {
										if (e.key === "Enter") {
											addressDirtyRef.current = false;
											openAddress();
										}
									},
									placeholder: t("panel.addressPlaceholder"),
									"aria-label": t("panel.addressPlaceholder")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: toolbarButton,
									onClick: openAddress,
									"aria-label": t("panel.go"),
									children: t("panel.go")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: {
										...toolbarButton,
										background: state.controlled ? "var(--dsw-alias-state-error-primary)" : void 0,
										color: state.controlled ? "white" : void 0
									},
									onClick: () => {
										post("takeover", { active: !state.controlled });
									},
									title: t("panel.takeoverTitle"),
									"aria-label": t("panel.takeoverTitle"),
									children: state.controlled ? t("panel.release") : t("panel.takeover")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									style: toolbarButton,
									onClick: () => {
										post("clear-data").then(() => {
											post("close-all");
										});
									},
									title: t("panel.clearTitle"),
									"aria-label": t("panel.clearTitle"),
									children: t("panel.clear")
								})
							]
						}),
						state.controlled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								color: "var(--dsw-alias-state-error-primary)"
							},
							children: t("panel.controlledNotice")
						}),
						error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								color: "var(--dsw-alias-state-error-primary)"
							},
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							ref: viewRef,
							style: {
								flex: 1,
								minHeight: 0,
								position: "relative",
								overflow: "hidden"
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								opacity: .7,
								maxHeight: 90,
								overflowY: "auto",
								fontFamily: "monospace",
								flex: "none"
							},
							children: ops.map((op) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { color: op.failed ? "var(--dsw-alias-state-error-primary)" : void 0 },
								children: [
									new Date(op.time).toLocaleTimeString(),
									" [",
									op.tool,
									"] ",
									op.summary
								]
							}, op.seq))
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/BrowserTrigger.tsx
		const TRIGGER_STYLE = {
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
			...TRIGGER_STYLE,
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
		/** Cross-plugin panel activation event (shared with cron/task/enterprise/connectors). */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const PANEL_NAME = "browser-center";
		/**
		* Sidebar foot action opening the embedded browser modal. Opening this panel
		* evicts sibling panels via the shared activation event; a sibling activation
		* closes this panel.
		* @param props - sidebar column state from the foot slot owner.
		*/
		function BrowserTrigger(props) {
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
				className: "pico-browser-trigger",
				style: props.wide ? TRIGGER_STYLE : TRIGGER_RAIL,
				"aria-expanded": open,
				onClick: openPanel,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width: props.wide ? 16 : 18,
					height: props.wide ? 16 : 18,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
							cx: "8",
							cy: "8",
							r: "6.2",
							stroke: "currentColor",
							strokeWidth: "1.3"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
							cx: "8",
							cy: "8",
							r: "2.4",
							stroke: "currentColor",
							strokeWidth: "1.3"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4",
							stroke: "currentColor",
							strokeWidth: "1.3",
							strokeLinecap: "round"
						})
					]
				}), props.wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: LABEL,
					children: t("panel.title")
				})]
			}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BrowserPanel, { onClose: () => {
				setOpen(false);
			} })] });
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser client half: registers the embedded-browser panel as a sidebar foot
		* action. The panel drives the native WebContentsView through the loopback
		* browser API; the view itself is layered over the panel's placeholder by the
		* host plugin.
		*/
		const name = "pico-browser-client";
		const LOCALE_NS = "browser";
		/** Services required: the slot registry for sidebar actions. */
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => {
				const off = ctx.locale.register(LOCALE_NS, {
					zh,
					en
				});
				return () => {
					off();
				};
			}, "browser: client dictionaries");
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = ".pico-browser-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }";
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, "browser: trigger hover style");
			ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "browser-center",
				order: 1
			}, BrowserTrigger)), "browser: sidebar browser panel action");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map