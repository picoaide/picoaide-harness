import { homedir } from "node:os";
import { join, parse, resolve, win32 } from "node:path";
//#region src/index.ts
/**
* Product home resolution for PicoAide Harness.
*
* The product owns its data directory: the default Harness home under the
* OS home is `~/.picoaide-harness` instead of the upstream `~/.dsh`.
*
* 该目录**随渠道**（2026-09-11）：官方渠道仍是 `~/.picoaide-harness`（逐字节
* 不变），渠道客户端用自己的目录（`channelDshHomeDir()` 是唯一派生点）。此前
* 所有渠道共用一个数据根，于是同一台机器上的两个渠道会共享登录 token、
* settings 与会话（跨租户），并互相顶掉单实例锁。
*
* The resolution contract mirrors the official `@deepseek-ai/dsh-home-paths`
* (packages/util/home-paths): precedence, highest first — an explicit
* configured path, `$DSH_HOME`, then the product default. An empty or
* whitespace-only `$DSH_HOME` is treated as unset. Every official package
* (settings-file, credentials-local, app-boot, …) resolves the home through
* that one shared package; this module is the product's equivalent single
* source of truth, and sibling plugins re-export it instead of copying the
* default-directory constant.
*
* The desktop launcher also writes the resolved home back into `DSH_HOME`
* at startup (main.ts), so every downstream consumer that reads the
* environment agrees on one location.
*/
/** Environment variable that overrides the product home. */
const DSH_HOME_ENV = "DSH_HOME";
/** Directory name of the product default Harness home under the OS home. */
const PRODUCT_DSH_HOME_DIR = ".picoaide-harness";
/** Stable user-facing display form for the default product home. */
const DEFAULT_DSH_HOME_DISPLAY = `~/${PRODUCT_DSH_HOME_DIR}`;
/** 官方渠道 id（渠道化构建之外的默认渠道）。 */
const OFFICIAL_CHANNEL_ID = "official";
/**
* 渠道数据目录名的合法形状：**单段**、点开头、小写 ASCII（字母/数字/连字符）。
*
* 限制成单段是为了它只能作为 `~` 下的一个目录名参与拼接 —— 渠道包是不可信
* 输入，一个带 `../` 或绝对路径的值会把整个数据根挪到别处。小写是为了跨平台
* 一致（Windows/macOS 默认大小写不敏感，Linux 敏感：同一个渠道在两个平台上
* 会得到两个目录名）。
*/
const DSH_HOME_DIR_NAME_PATTERN = /^\.[a-z0-9][a-z0-9-]{0,62}$/u;
/**
* 是否是合法的渠道数据目录名（`undefined`/`''`/畸形值一律 false）。
* @param value - 渠道包里的 `desktop.home_dir`（不可信输入）。
*/
function isSafeDshHomeDirName(value) {
	return typeof value === "string" && DSH_HOME_DIR_NAME_PATTERN.test(value);
}
/**
* 本次启动使用的数据目录名（`~` 下的那一段）。
*
* **这是"渠道数据隔离"的唯一派生点**：desktop 主进程、CI 校验与打包门禁都走它，
* 免得三处各写一套取值链（曾经就是这样把渠道包与官方包指到了同一个目录）。
*
* 取值链：
*   1. 官方渠道 → `PRODUCT_DSH_HOME_DIR`（**逐字节不变**，存量用户数据不动）；
*   2. 渠道包显式配置的 `desktop.home_dir`（含官方目录 —— beta 就是显式共用官方目录）；
*   3. 由 `desktop.slug` 小写派生（`Acme-Harness` → `.acme-harness`）；
*   4. 兜底 `<PRODUCT_DSH_HOME_DIR>-<channelId>`（如 beta：复用官方品牌、没有
*      自己的 slug）—— 兜底刻意**不回落官方目录**：白标客户端与官方客户端共用
*      一个数据根会共享登录 token/settings/会话（跨租户），也会互相顶掉单实例锁，
*      这比"目录名多一截"糟得多。
* @param channelId - 渠道 id（调用方须已按渠道 id 形状校验）。
* @param options - 渠道包里的显式目录名与 slug（可以是原始未校验值）。
* @returns `~` 下的目录名（含前导点）。
*/
function channelDshHomeDir(channelId, options = {}) {
	if (channelId === "official") return PRODUCT_DSH_HOME_DIR;
	if (isSafeDshHomeDirName(options.homeDir)) return options.homeDir;
	if (typeof options.slug === "string") {
		const derived = `.${options.slug.toLowerCase()}`;
		if (isSafeDshHomeDirName(derived) && derived !== ".picoaide-harness") return derived;
	}
	return `${PRODUCT_DSH_HOME_DIR}-${channelId}`;
}
/** Expand a leading ~ (or ~user) in a path, platform-style. */
function expandHomePath(path, home = homedir()) {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}
/**
* Resolve the single-root product Harness home.
*
* Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
* `~/.picoaide-harness`. The product keeps all user data under one root. An
* empty or whitespace-only `$DSH_HOME` is treated as unset.
*
* 审计 2026-08-25 P2-3:DSH_HOME 是完全可注入的环境变量(同机进程可设置后
* 以同一用户拉起应用)。虽保留其覆盖能力(e2e/多 profile 依赖),但拒绝把
* home 重定向到系统关键目录,避免「安全解压/凭据落盘」作用到 /tmp 等
* 攻击者控制的路径。
* @param configured - explicit harness-home override, highest precedence.
* @param env - environment mapping used to read `DSH_HOME`.
* @param home - platform home directory fallback (test seam).
* @param productDir - `~` 下的目录名（渠道构建传 `channelDshHomeDir(...)`；
*   缺省即官方目录，官方行为逐字节不变）。只在既没有配置也没有 `$DSH_HOME`
*   时参与取值 —— 显式覆盖（e2e/便携安装）永远优先。
* @returns the normalized absolute product home path.
*/
function resolveDshHome(configured, env = process.env, home = homedir(), productDir = PRODUCT_DSH_HOME_DIR) {
	const fromEnv = env[DSH_HOME_ENV];
	return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(home, productDir)), home));
}
/** 系统关键目录前缀(审计 2026-08-25 P2-3):home 不得指向这些根。
* 刻意不含 /tmp:e2e/测试/沙箱隔离确实用 /tmp 下的 home,拒绝会破坏产品。 */
const FORBIDDEN_HOME_PREFIXES = [
	"/",
	"/proc",
	"/sys",
	"/etc",
	"/usr",
	"/var",
	"/boot",
	"/dev",
	"/opt"
];
/**
* Refuse a resolved home placed in a system-critical directory.
* 审计 2026-08-25 P2-3:调用方传入的 DSH_HOME 若被同机进程注入为系统
* 关键目录,拒绝而非静默使用(返回 false)。注意:/tmp 及其子目录**允许**
* ——e2e/测试与沙箱隔离确实用 /tmp 下的 home(如 /tmp/home),拒绝会破坏
* 测试与产品行为;威胁模型里 /tmp 由同用户权限隔离,风险低于 / 与系统根。
* @param resolved - absolute normalized home path (from resolveDshHome).
*/
function isSafeDshHome(resolved) {
	const normalized = resolve(resolved);
	if (normalized === "/") return false;
	for (const prefix of FORBIDDEN_HOME_PREFIXES) if (normalized === prefix || normalized.startsWith(`${prefix}/`) || normalized.startsWith(`${prefix}\\`)) {
		if (prefix === "/var" && normalized.startsWith("/var/folders/") && normalized.includes("/T/")) continue;
		return false;
	}
	return true;
}
/** Resolve the product home and refuse an unsafe override (throws a clear error). */
function dshHomeSafe(options = {}) {
	const resolved = resolveDshHome(options.configured, options.env, options.home, options.productDir);
	if (!isSafeDshHome(resolved)) {
		const source = options.env?.["DSH_HOME"] ?? options.configured;
		throw new Error(`unsafe DSH_HOME: ${String(source ?? resolved)} resolves into a system directory`);
	}
	return resolved;
}
/**
* 解析**本次安装**的数据根并写回 `DSH_HOME`（渠道构建 → 渠道目录）。
*
* 桌面启动（`main.ts` 的 `start()`）与 `--export-diagnostics` 的早退分支都必须
* 走这里，两条路径的口径才会一致：早退分支在 `start()` **之前**运行，此前没有
* 这一步，于是渠道包的支持包会去数**官方**数据根里的会话（desktop-3）。
* @param options - 渠道包的 `desktop.home_dir`、环境映射与 home 测试 seam。
* @returns 已解析的绝对数据根（同时已写入 `env[DSH_HOME]`）。
*/
function applyInstallDshHome(options = {}) {
	const env = options.env ?? process.env;
	const resolved = dshHomeSafe({
		productDir: options.productDir,
		env,
		home: options.home
	});
	env[DSH_HOME_ENV] = resolved;
	return resolved;
}
/**
* Join path segments onto the resolved product Harness home.
* @param segments - path segments appended to the home; an empty list returns the home itself.
* @returns the normalized absolute joined path.
*/
function dshHomePath(...segments) {
	return join(resolveDshHome(), ...segments);
}
/** POSIX system directories a packaged app must never use as a cwd. */
const POSIX_SYSTEM_DIRS = [
	"/usr",
	"/etc",
	"/var",
	"/bin",
	"/sbin",
	"/boot",
	"/dev",
	"/proc",
	"/sys",
	"/lib",
	"/lib64",
	"/opt"
];
/**
* Strip trailing path separators and normalize to forward slashes without a
* backtracking regex (`/[\\/]+$/` is polynomial on uncontrolled input —
* CodeQL js/polynomial-redos).
*/
function normalizePathForCompare(value) {
	let end = value.length;
	while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) end--;
	return value.slice(0, end).split("\\").join("/").toLowerCase();
}
/**
* Is `cwd` a filesystem root or a system directory (P2-34)? A packaged app
* launched with such a working directory (desktop-entry `Path=`, a Windows
* shortcut with a wrong "start in", a service manager) would create project
* files, `.browser-store` or relative logs there, which is either impossible
* or harmful. The old check only compared against the POSIX `/`, so Windows
* `C:\`, `C:\Windows` and Program Files slipped through.
*
* Root detection covers both path flavours explicitly: `parse` uses the host
* flavour, so a Windows-style `C:\` is only recognized through `win32.parse`
* when the check runs on Linux (and vice versa for tests).
* @param cwd - candidate working directory.
* @param env - environment used to locate the Windows system roots (test seam).
*/
function isSystemWorkingDirectory(cwd, env = process.env) {
	const raw = cwd.trim();
	if (raw === "") return true;
	if (parse(raw).root === raw || win32.parse(raw).root === raw) return true;
	const target = normalizePathForCompare(resolve(raw));
	for (const base of [
		env.SystemRoot,
		env.windir,
		env.ProgramFiles,
		env["ProgramFiles(x86)"],
		env.ProgramData
	]) {
		if (base === void 0 || base.trim() === "") continue;
		const root = normalizePathForCompare(resolve(base));
		if (target === root || target.startsWith(`${root}/`)) return true;
	}
	return POSIX_SYSTEM_DIRS.some((dir) => target === dir || target.startsWith(`${dir}/`));
}
/** Resolve the product home from the live environment. */
function dshHome() {
	return resolveDshHome();
}
//#endregion
export { DEFAULT_DSH_HOME_DISPLAY, DSH_HOME_ENV, OFFICIAL_CHANNEL_ID, PRODUCT_DSH_HOME_DIR, applyInstallDshHome, channelDshHomeDir, dshHome, dshHomePath, dshHomeSafe, expandHomePath, isSafeDshHome, isSafeDshHomeDirName, isSystemWorkingDirectory, resolveDshHome };

//# sourceMappingURL=index.js.map