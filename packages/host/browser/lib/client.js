window.__ModuleLoader__.load({
	id: "@picoaide/dsh-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
		/**
		* Sidebar foot action waking the dedicated browser window. The browser lives
		* in its own OS window (created on first agent open); the sidebar button
		* shows it again after a user close. The window itself carries the tab strip
		* and control buttons; no modal panel is rendered in the main window.
		* @param props - sidebar column state from the foot slot owner.
		*/
		function BrowserTrigger(props) {
			const wake = () => {
				fetch("/api/pico/browser/show", { method: "POST" }).catch(() => {});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "pico-browser-trigger",
				style: props.wide ? TRIGGER_STYLE : TRIGGER_RAIL,
				onClick: wake,
				title: t("panel.title"),
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
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser client half: registers the sidebar foot action that wakes the
		* dedicated browser window. The window (created by the host plugin on first
		* agent open) carries its own tab strip and controls; the sidebar button
		* shows it again after a user close.
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
			}, BrowserTrigger)), "browser: sidebar browser wake action");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map