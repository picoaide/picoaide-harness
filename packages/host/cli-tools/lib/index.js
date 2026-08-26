import { CLI_MANIFESTS, cliPlatformKey } from "./cli-manifest.js";
import { extractArchive, findEntry, readArchiveEntries } from "./archive.js";
import { DSH_HOME_ENV, PRODUCT_DSH_HOME_DIR, dwsEnv, resolveDshHome } from "./home.js";
import { createHash } from "node:crypto";
import { promises } from "node:fs";
import { basename, join } from "node:path";
//#region src/cli-installer.ts
/**
* Auto-installer for connector CLI binaries (skill-side tooling).
*
* 决策 2026-08-25:CLI 生命周期管理从连接器框架删除——CLI 就是 skill,
* AI 按技能市场里的 SKILL.md 引导操作。本模块只保留「自动安装」一个动作:
* 技能触发(requires.bins)时调用 ensureCliInstalled(),从 npmmirror/内网
* 镜像下载 pinned 二进制、sha256 校验、解压到缓存目录并返回可执行路径。
* 无授权状态、无探测、无 PATH 解析——授权由 AI 按 skill 文档跑 CLI 命令
* (dws auth login 等)自行完成。
*
* 安全(与连接器旧实现一致):归档字节上限、解压路径穿越/符号链接拒绝、
* 校验和强制;pinned manifest 来源仅官方 npm/厂商 CDN。
*/
/**
* Default bundled-binary directory. In a packaged Electron app the
* prefetched CLI binaries ship under `<resourcesPath>/cli`; outside a
* packaged app (dev, tests) no bundled dir exists and every install
* downloads on demand.
*/
const DEFAULT_BUNDLED_DIR = (() => {
	const resourcesPath = globalThis.process?.resourcesPath;
	return typeof resourcesPath === "string" && resourcesPath.length > 0 ? join(resourcesPath, "cli") : null;
})();
const DIRECT_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
const NPM_TARBALL_MAX_BYTES = 120 * 1024 * 1024;
const DEFAULT_CACHE_DIR = join(process.env.DSH_HOME ?? join(process.env.HOME ?? "~", ".picoaide-harness"), "cli-cache");
/** Install (or reuse) the pinned binary for `command`; throws on any failure. */
async function ensureCliInstalled(command, options = {}) {
	const resolved = await new CliInstaller(options).ensure(command, void 0);
	if (resolved === null) throw new Error(`未找到 ${command} 的下载清单或当前平台不受支持`);
	return resolved;
}
var CliInstaller = class {
	cacheDir;
	bundledDir;
	manifests;
	fetchImpl;
	downloadTimeoutMs;
	inflight = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
		this.bundledDir = options.bundledDir ?? DEFAULT_BUNDLED_DIR;
		this.manifests = options.manifests ?? CLI_MANIFESTS;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.downloadTimeoutMs = options.downloadTimeoutMs ?? 12e4;
	}
	/**
	* Ensure the pinned binary for `command` exists (bundled → cache → download),
	* deduplicated across concurrent calls. Returns null when the manifest or
	* platform is unsupported.
	*/
	async ensure(command, onProgress) {
		const manifest = this.manifests.get(command);
		if (!manifest) return null;
		const bundled = await this.bundledBinary(manifest);
		if (bundled) return {
			binaryPath: bundled,
			fromCache: true
		};
		const key = `${manifest.command}@${manifest.version}`;
		const pending = this.inflight.get(key);
		if (pending) return pending;
		const run = this.installBinary(manifest, onProgress);
		this.inflight.set(key, run);
		try {
			const result = await run;
			this.inflight.delete(key);
			return result;
		} catch (error) {
			this.inflight.delete(key);
			throw error;
		}
	}
	/** Locate a prefetched binary in the bundled directory, if any. */
	async bundledBinary(manifest) {
		if (!this.bundledDir) return null;
		const binaryName = `${manifest.binaryName}${process.platform === "win32" ? ".exe" : ""}`;
		const candidate = join(this.bundledDir, manifest.command, manifest.version, binaryName);
		const stat = await promises.stat(candidate).catch(() => null);
		if (stat?.isFile() && (process.platform === "win32" || (stat.mode & 73) !== 0)) return candidate;
		return null;
	}
	/** Download + extract the pinned platform binary into the cache dir. */
	async installBinary(manifest, onProgress) {
		const platform = cliPlatformKey(process.platform, process.arch);
		if (!platform) throw new Error(`当前平台 ${process.platform}-${process.arch} 不受支持`);
		const expected = this.expectedAsset(manifest, platform);
		if (!expected) throw new Error(`下载清单缺少 ${manifest.command} 的平台资产`);
		const dir = join(this.cacheDir, manifest.command, manifest.version);
		const binaryName = `${manifest.binaryName}${process.platform === "win32" ? ".exe" : ""}`;
		const binaryPath = join(dir, binaryName);
		const markerPath = join(dir, ".checksum");
		const cached = await readMarker(markerPath);
		if (cached?.archiveName === expected.archiveName && cached.checksum === expected.checksum) {
			const stat = await promises.stat(binaryPath).catch(() => null);
			if (stat?.isFile() && stat.size === cached.binarySize && (process.platform === "win32" || (stat.mode & 73) !== 0)) return {
				binaryPath,
				fromCache: true
			};
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
		return {
			binaryPath,
			fromCache: false
		};
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
				onProgress?.(`正在从 ${new URL(url).host} 下载 ${source.packageName}（仅首次触发，约 70MB）…`);
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
		onProgress?.(`正在从 ${new URL(url).host} 下载 ${manifest.displayName}（仅首次触发）…`);
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
				headers: { "User-Agent": "picoaide-cli-tools/0.1" }
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
//#endregion
export { CLI_MANIFESTS, CliInstaller, DSH_HOME_ENV, PRODUCT_DSH_HOME_DIR, cliPlatformKey, dwsEnv, ensureCliInstalled, resolveDshHome };

//# sourceMappingURL=index.js.map