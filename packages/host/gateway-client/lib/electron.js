import { createRequire } from "node:module";
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region node_modules/electron/index.js
var require_electron = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { spawnSync } = __require("child_process");
	const fs = __require("fs");
	const path = __require("path");
	const pathFile = path.join(__dirname, "path.txt");
	function downloadElectron() {
		console.log("Downloading Electron binary...");
		if (spawnSync(process.execPath, [path.join(__dirname, "install.js")], { stdio: "inherit" }).status !== 0) throw new Error("Electron failed to install correctly. Please delete `node_modules/electron` and run \"npx install-electron --no\" manually.");
	}
	/**
	* Fetches the path to the Electron executable to use in development mode.
	* If the executable is missing, attempt to download it first.
	*
	* @returns the path to the Electron executable to run
	*/
	function getElectronPath() {
		let executablePath;
		if (fs.existsSync(pathFile)) executablePath = fs.readFileSync(pathFile, "utf-8");
		if (process.env.ELECTRON_OVERRIDE_DIST_PATH) return path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, executablePath || "electron");
		if (executablePath) {
			const fullPath = path.join(__dirname, "dist", executablePath);
			if (!fs.existsSync(fullPath)) downloadElectron();
			return fullPath;
		} else {
			try {
				downloadElectron();
			} catch {
				throw new Error("Electron failed to install correctly. Please delete `node_modules/electron` and run \"npx install-electron --no\" manually.");
			}
			executablePath = fs.readFileSync(pathFile, "utf-8");
			return path.join(__dirname, "dist", executablePath);
		}
	}
	module.exports = getElectronPath();
}));
//#endregion
//#region src/electron.ts
async function loadElectronModule() {
	let mod = null;
	try {
		mod = await Promise.resolve().then(() => /* @__PURE__ */ __toESM(require_electron(), 1));
	} catch {
		mod = null;
	}
	if (!mod && typeof __require === "function") try {
		mod = require_electron();
	} catch {
		mod = null;
	}
	if (!mod) return {};
	const hasApis = (m) => {
		if (!m || typeof m !== "object") return false;
		const keys = Object.keys(m);
		return [
			"safeStorage",
			"session",
			"app",
			"desktopCapturer",
			"clipboard"
		].some((k) => keys.includes(k) && Boolean(m[k]));
	};
	if (hasApis(mod)) return mod;
	try {
		const d = mod?.default;
		return d && hasApis(d) ? d : mod;
	} catch {
		return mod;
	}
}
//#endregion
export { loadElectronModule };

//# sourceMappingURL=electron.js.map