window.__ModuleLoader__.load({
	id: "@picoaide/dsh-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
			const [error, setError] = (0, react.useState)(null);
			const viewRef = (0, react.useRef)(null);
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
				style: {
					display: "flex",
					flexDirection: "column",
					height: "100%",
					gap: 8,
					padding: 8,
					boxSizing: "border-box"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 4,
							alignItems: "center",
							flexWrap: "wrap"
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
							children: [
								tab.title || tab.url || `Tab ${tab.id}`,
								tab.loading ? "…" : "",
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									onClick: (e) => {
										e.stopPropagation();
										post("close-tab", { tab: tab.id });
									},
									style: {
										marginLeft: 4,
										opacity: .6
									},
									children: "×"
								})
							]
						}, tab.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: toolbarButton,
							onClick: () => {
								post("open");
							},
							title: "New tab",
							children: "+"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 4,
							alignItems: "center"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: toolbarButton,
								disabled: visibleTab === void 0,
								onClick: () => {
									post("back");
								},
								title: "Back",
								children: "←"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: toolbarButton,
								disabled: visibleTab === void 0,
								onClick: () => {
									post("forward");
								},
								title: "Forward",
								children: "→"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: toolbarButton,
								disabled: visibleTab === void 0,
								onClick: () => {
									post("reload");
								},
								title: "Reload",
								children: "⟳"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle,
								value: address,
								onChange: (e) => {
									setAddress(e.target.value);
								},
								onKeyDown: (e) => {
									if (e.key === "Enter") openAddress();
								},
								placeholder: "Enter a URL and press Enter"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: toolbarButton,
								onClick: openAddress,
								children: "Go"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: {
									...toolbarButton,
									background: state.controlled ? "#e5484d" : void 0,
									color: state.controlled ? "white" : void 0
								},
								onClick: () => {
									post("takeover", { active: !state.controlled });
								},
								title: "Toggle manual control (blocks agent browser actions)",
								children: state.controlled ? "接管中·释放" : "接管"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: toolbarButton,
								onClick: () => {
									post("clear-data").then(() => {
										post("close-all");
									});
								},
								title: "Clear browsing data and close",
								children: "清除"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: toolbarButton,
								onClick: onClose,
								title: "Close panel",
								children: "✕"
							})
						]
					}),
					state.controlled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							color: "#e5484d"
						},
						children: "用户接管中：agent 的浏览器操作已暂停"
					}),
					error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							color: "#e5484d"
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
							fontFamily: "monospace"
						},
						children: ops.map((op) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { color: op.failed ? "#e5484d" : void 0 },
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
			lineHeight: 22
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
		/**
		* Sidebar foot action opening the embedded browser panel.
		* @param props - sidebar column state from the foot slot owner.
		*/
		function BrowserTrigger(props) {
			const [open, setOpen] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "pico-browser-trigger",
				style: props.wide ? TRIGGER_STYLE : TRIGGER_RAIL,
				"aria-expanded": open,
				onClick: () => {
					setOpen(true);
				},
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
					children: "浏览器"
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
		/** Services required: the slot registry for sidebar actions. */
		const inject = ["slots"];
		function apply(ctx) {
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