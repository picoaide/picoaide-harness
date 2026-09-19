/** Environment variable that overrides the product home. */
export declare const DSH_HOME_ENV = "DSH_HOME";
/** Directory name of the product default Harness home under the OS home. */
export declare const PRODUCT_DSH_HOME_DIR = ".picoaide-harness";
/** Stable user-facing display form for the default product home. */
export declare const DEFAULT_DSH_HOME_DISPLAY = "~/.picoaide-harness";
/** 官方渠道 id（渠道化构建之外的默认渠道）。 */
export declare const OFFICIAL_CHANNEL_ID = "official";
/**
 * 是否是合法的渠道数据目录名（`undefined`/`''`/畸形值一律 false）。
 * @param value - 渠道包里的 `desktop.home_dir`（不可信输入）。
 */
export declare function isSafeDshHomeDirName(value: unknown): value is string;
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
export declare function channelDshHomeDir(channelId: string, options?: {
    readonly homeDir?: unknown;
    readonly slug?: unknown;
}): string;
/** Expand a leading ~ (or ~user) in a path, platform-style. */
export declare function expandHomePath(path: string, home?: string): string;
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
export declare function resolveDshHome(configured?: string, env?: Record<string, string | undefined>, home?: string, productDir?: string): string;
/**
 * Refuse a resolved home placed in a system-critical directory.
 * 审计 2026-08-25 P2-3:调用方传入的 DSH_HOME 若被同机进程注入为系统
 * 关键目录,拒绝而非静默使用(返回 false)。注意:/tmp 及其子目录**允许**
 * ——e2e/测试与沙箱隔离确实用 /tmp 下的 home(如 /tmp/home),拒绝会破坏
 * 测试与产品行为;威胁模型里 /tmp 由同用户权限隔离,风险低于 / 与系统根。
 * @param resolved - absolute normalized home path (from resolveDshHome).
 */
export declare function isSafeDshHome(resolved: string): boolean;
/** Resolve the product home and refuse an unsafe override (throws a clear error). */
export declare function dshHomeSafe(options?: {
    configured?: string;
    env?: Record<string, string | undefined>;
    /** `~` 展开用的 home 目录（测试 seam，与 `resolveDshHome` 的第三个参数同义）。 */
    home?: string | undefined;
    /** 渠道数据目录名（见 `channelDshHomeDir`）；缺省官方目录。 */
    productDir?: string | undefined;
}): string;
/**
 * 解析**本次安装**的数据根并写回 `DSH_HOME`（渠道构建 → 渠道目录）。
 *
 * 桌面启动（`main.ts` 的 `start()`）与 `--export-diagnostics` 的早退分支都必须
 * 走这里，两条路径的口径才会一致：早退分支在 `start()` **之前**运行，此前没有
 * 这一步，于是渠道包的支持包会去数**官方**数据根里的会话（desktop-3）。
 * @param options - 渠道包的 `desktop.home_dir`、环境映射与 home 测试 seam。
 * @returns 已解析的绝对数据根（同时已写入 `env[DSH_HOME]`）。
 */
export declare function applyInstallDshHome(options?: {
    readonly productDir?: string | undefined;
    readonly env?: Record<string, string | undefined>;
    readonly home?: string | undefined;
}): string;
/**
 * Join path segments onto the resolved product Harness home.
 * @param segments - path segments appended to the home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export declare function dshHomePath(...segments: string[]): string;
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
export declare function isSystemWorkingDirectory(cwd: string, env?: Record<string, string | undefined>): boolean;
/** Resolve the product home from the live environment. */
export declare function dshHome(): string;
