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
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path'

/** Environment variable that overrides the product home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name of the product default Harness home under the OS home. */
export const PRODUCT_DSH_HOME_DIR = '.picoaide-harness'

/** Stable user-facing display form for the default product home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${PRODUCT_DSH_HOME_DIR}`

/** 官方渠道 id（渠道化构建之外的默认渠道）。 */
export const OFFICIAL_CHANNEL_ID = 'official'

/**
 * 渠道数据目录名的合法形状：**单段**、点开头、小写 ASCII（字母/数字/连字符）。
 *
 * 限制成单段是为了它只能作为 `~` 下的一个目录名参与拼接 —— 渠道包是不可信
 * 输入，一个带 `../` 或绝对路径的值会把整个数据根挪到别处。小写是为了跨平台
 * 一致（Windows/macOS 默认大小写不敏感，Linux 敏感：同一个渠道在两个平台上
 * 会得到两个目录名）。
 */
const DSH_HOME_DIR_NAME_PATTERN = /^\.[a-z0-9][a-z0-9-]{0,62}$/u

/**
 * 是否是合法的渠道数据目录名（`undefined`/`''`/畸形值一律 false）。
 * @param value - 渠道包里的 `desktop.home_dir`（不可信输入）。
 */
export function isSafeDshHomeDirName(value: unknown): value is string {
  return typeof value === 'string' && DSH_HOME_DIR_NAME_PATTERN.test(value)
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
export function channelDshHomeDir(
  channelId: string,
  options: { readonly homeDir?: unknown; readonly slug?: unknown } = {},
): string {
  if (channelId === OFFICIAL_CHANNEL_ID) return PRODUCT_DSH_HOME_DIR
  // 显式声明的目录**一律采纳**，包括官方目录本身：beta 这类公共渠道刻意与官方
  // 共用一个数据根（2026-09-11 定案，2026-09-12 二次确认 —— 预发版是正式版的前置
  // 验证，换成独立目录会让已装预发版的用户升级后看不到既有会话）。品牌渠道写官方
  // 目录由 CI 在构建期拦（ci-channels.sh），运行期
  // 不再多一道判定：客户端要能照渠道包说的做。
  if (isSafeDshHomeDirName(options.homeDir)) return options.homeDir
  if (typeof options.slug === 'string') {
    const derived = `.${options.slug.toLowerCase()}`
    // 派生结果等于官方目录名时**不采纳**（渠道把 slug 写成官方 slug 就等于
    // 声明"我和官方是同一个应用"——那正是要防的）。
    if (isSafeDshHomeDirName(derived) && derived !== PRODUCT_DSH_HOME_DIR) return derived
  }
  return `${PRODUCT_DSH_HOME_DIR}-${channelId}`
}

/** Expand a leading ~ (or ~user) in a path, platform-style. */
export function expandHomePath(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
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
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  productDir: string = PRODUCT_DSH_HOME_DIR,
): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(home, productDir))
  return resolve(expandHomePath(selected, home))
}

/**
 * 系统关键目录的**唯一真源**（POSIX 面）。
 *
 * 数据根闸门（`isSafeDshHome`）与打包应用 cwd 闸门（`isSystemWorkingDirectory`）共用
 * 这一张表。此前是两份：cwd 那份带 Windows 根表与大小写归一，数据根那份没有，于是
 * 同族判据只在一条路径上收口（R13-B P2-3：`DSH_HOME=<链接 → /etc>`、`/ETC`、
 * `C:\Windows` 三种形态都能绕过数据根闸门）。新增/调整系统目录只改这里一处。
 *
 * `'/'` 是特例：**只匹配根本身**（否则任何绝对路径都会被它吃掉）。`/tmp` 及其子目录
 * 刻意不在表内 —— e2e/测试与沙箱隔离确实用 /tmp 下的 home（如 `/tmp/home`），拒绝会
 * 破坏测试与产品行为；威胁模型里 /tmp 由同用户权限隔离，风险低于 / 与系统根。
 *
 * `'/private/etc'`、`'/private/var'` 是 macOS 上 `/etc`、`/var` 的**真实路径**（那两个
 * 是符号链接）——别名形态必须在任何平台上都拒绝，否则"平台无关地拒绝"只在 Linux 成立。
 * `/private/tmp` 不在此表（它是 /tmp 的真实路径，必须与 /tmp 一样放行）。
 */
const POSIX_SYSTEM_ROOTS: readonly string[] = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/private/etc', '/private/var', '/proc', '/sbin', '/sys', '/usr', '/var']

/**
 * Windows 系统根的内置默认形态。**在任何平台上都按 win32 语义识别**：本机是 Linux 时
 * 也拒绝 `C:\Windows`（`resolve()` 会把它变成 cwd 下的相对目录名，于是"注入一个系统
 * 目录"变成"数据根随启动目录漂移"，两条都是要防的）。env 里另行声明的根在
 * `systemRoots()` 里合并进来。
 */
const WINDOWS_DEFAULT_SYSTEM_ROOTS: readonly string[] = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']

/** 声明 Windows 系统根的环境变量名（与内置默认形态同一张表，别再各写一份）。 */
const WINDOWS_ROOT_ENV_KEYS: readonly string[] = ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']

/** 盘符开头（`C:\…`、`C:/…`，也含盘符相对 `C:foo`）。 */
const WINDOWS_DRIVE = /^[A-Za-z]:/u
/** 盘符相对（`C:`、`C:foo`）：落点取决于该盘的当前目录，判不了 ⇒ 拒绝。 */
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/u
/** UNC（`\\server\share`、`//server/share`）与设备命名空间（`\\?\C:\…`、`\\.\C:`）。 */
const WINDOWS_UNC_OR_DEVICE = /^[\\/]{2}/u
/** 归一后的盘符根比较键（`c:`）。 */
const WINDOWS_DRIVE_ROOT_KEY = /^[a-z]:$/u

/** 判据接收的环境映射（`process.env` 的形状）。 */
type EnvLike = Record<string, string | undefined>

/**
 * 归一成比较键：去尾部分隔符（`/` 自身除外）、分隔符统一为 `/`、**小写**
 * （macOS/Windows 默认大小写不敏感 ⇒ `/ETC` 就是 `/etc`，判据必须平台无关地拒绝）。
 * 手写剥离而不用 `/[\\/]+$/`：同类回溯正则在本仓被 CodeQL 判过
 * js/polynomial-redos。
 */
function normalizePathForCompare(value: string): string {
  let end = value.length
  while (end > 1 && (value[end - 1] === '/' || value[end - 1] === '\\')) end--
  return value.slice(0, end).split('\\').join('/').toLowerCase()
}

/**
 * 系统根（比较键）：POSIX 表 + Windows 内置默认形态 + `SystemRoot`/`windir`/… 声明的根。
 * 一处产出，两条闸门共用。
 * @param env - 环境映射（测试 seam：显式传入，不依赖本机环境）。
 */
function systemRoots(env: EnvLike): string[] {
  const roots = [...POSIX_SYSTEM_ROOTS, ...WINDOWS_DEFAULT_SYSTEM_ROOTS].map(normalizePathForCompare)
  for (const name of WINDOWS_ROOT_ENV_KEYS) {
    const value = env[name]
    if (value === undefined || value.trim() === '') continue
    roots.push(normalizePathForCompare(value.trim()))
  }
  return roots
}

/**
 * macOS 临时目录例外（既有文档化行为）：`os.tmpdir()` 在 macOS 上是
 * `/var/folders/<随机>/T/`，与 Linux `/tmp` 等价（同用户权限隔离的临时目录），
 * e2e/profile 冒烟/沙箱用它作 DSH_HOME，拒绝会破坏这些场景。
 * 两种拼写都算（`/var/folders/...` 与它的真实路径 `/private/var/folders/...`），
 * 比较键已小写 ⇒ 大小写不敏感平台上的 `.../t/...` 同样算例外。
 */
function isMacTempDirKey(key: string): boolean {
  const underVarFolders = key.startsWith('/var/folders/') || key.startsWith('/private/var/folders/')
  return underVarFolders && key.includes('/t/')
}

/** 比较键是否落在系统根内（`'/'` 只算根本身，不做前缀匹配）。 */
function isUnderSystemRoot(key: string, roots: readonly string[]): boolean {
  if (isMacTempDirKey(key)) return false
  for (const root of roots) {
    if (root === '/') {
      if (key === '/') return true
      continue
    }
    if (key === root || key.startsWith(`${root}/`)) return true
  }
  return false
}

/**
 * 路径的**真实落点**：取最深的已存在祖先的 `realpathSync.native`（一次解掉任意跳数的
 * 符号链接），再把余下尚不存在的段按内核顺序拼回（`..` 在 realpath 之后才生效）。
 *
 * 判据宁严不宽：realpath 失败（不存在/权限/链接环）时回落到拼写路径，绝不因此放宽 ——
 * 调用方始终**同时**检查拼写路径与真实落点，任一命中即拒。
 * @param absolute - 绝对路径（调用方保证）。
 */
function realpathNearestExisting(absolute: string): string {
  const tail: string[] = []
  let current = absolute
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length === 0 ? real : resolve(join(real, ...tail))
    } catch {
      const parent = dirname(current)
      if (parent === current || parent === '') return absolute
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Windows 形态的取值按 win32 语义判定（拼写路径 + 系统根，不做 realpath：本机 POSIX
 * 上 realpath 对盘符形态没有意义）。
 */
function isWindowsSystemPath(raw: string, roots: readonly string[]): boolean {
  // UNC/设备命名空间（`\\server\share`、`\\?\C:\…`）不是本机路径：fail-closed。
  if (WINDOWS_UNC_OR_DEVICE.test(raw)) return true
  // 盘符相对（`C:`、`C:foo`）的落点取决于该盘的当前目录，判不了 ⇒ 拒绝。
  if (WINDOWS_DRIVE_RELATIVE.test(raw)) return true
  const key = normalizePathForCompare(win32.resolve(raw))
  if (WINDOWS_DRIVE_ROOT_KEY.test(key)) return true // `C:\`、`C:/`
  return isUnderSystemRoot(key, roots)
}

/**
 * **系统路径的唯一内部谓词**：`isSafeDshHome` 与 `isSystemWorkingDirectory` 都走它
 * （R13-B P2-3：此前两份实现，符号链接 / 大小写 / Windows 形态只在其中一份上收口）。
 *
 * 判定覆盖四个面，任一命中即"系统路径"：
 *  1. 平台无关的 Windows 形态（盘符根、盘符相对、UNC/设备、Windows 系统根）；
 *  2. 大小写归一后的拼写路径（`/ETC` ⇒ `/etc`）；
 *  3. 绝对化后的拼写路径（相对路径按 cwd 解析，`..` 先按字面归一）；
 *  4. 真实落点（`realpathNearestExisting`，符号链接跳数不限）。
 *
 * 空串由调用方定语义（cwd 闸门把空串当拒绝），这里返回 false。
 * @param target - 候选路径（拼写形态即可）。
 * @param env - 环境映射（Windows 系统根 seam）。
 */
function isSystemPath(target: string, env: EnvLike): boolean {
  const raw = target.trim()
  if (raw === '') return false
  const roots = systemRoots(env)
  if (WINDOWS_DRIVE.test(raw) || WINDOWS_UNC_OR_DEVICE.test(raw)) return isWindowsSystemPath(raw, roots)
  // 拼写路径与真实落点**分别**成候选（任一命中即拒）：realpath 只是其中一面，
  // 它不可用时（不存在/权限）字面归一仍要独立成立 —— 判据宁严不宽。
  const spelled = resolve(raw)
  const real = realpathNearestExisting(isAbsolute(raw) ? raw : spelled)
  const candidates = [
    normalizePathForCompare(raw),
    normalizePathForCompare(spelled),
    normalizePathForCompare(real),
  ]
  return candidates.some(key => isUnderSystemRoot(key, roots))
}

/**
 * Refuse a resolved home placed in a system-critical directory.
 * 审计 2026-08-25 P2-3:调用方传入的 DSH_HOME 若被同机进程注入为系统
 * 关键目录,拒绝而非静默使用(返回 false)。
 *
 * R13-B P2-3 收口:判据不再只看拼写路径 —— 符号链接(跳数不限,取最近存在祖先的
 * realpath)、大小写变体与 Windows 形态都与 cwd 闸门**共用同一份实现**
 * (`isSystemPath`:一张系统根表)。注意:/tmp 及其子目录**允许**,macOS 的
 * `/var/folders/.../T/...` 同样允许(与"临时目录不是系统目录"同一条例外)。
 * @param resolved - absolute normalized home path (from resolveDshHome).
 * @param env - environment used to locate the Windows system roots (test seam).
 */
export function isSafeDshHome(resolved: string, env: EnvLike = process.env): boolean {
  return !isSystemPath(resolved, env)
}

/** Resolve the product home and refuse an unsafe override (throws a clear error). */
export function dshHomeSafe(
  options: {
    configured?: string
    env?: Record<string, string | undefined>
    /** `~` 展开用的 home 目录（测试 seam，与 `resolveDshHome` 的第三个参数同义）。 */
    home?: string | undefined
    /** 渠道数据目录名（见 `channelDshHomeDir`）；缺省官方目录。 */
    productDir?: string | undefined
  } = {},
): string {
  const resolved = resolveDshHome(options.configured, options.env, options.home, options.productDir)
  if (!isSafeDshHome(resolved, options.env ?? process.env)) {
    const source = options.env?.[DSH_HOME_ENV] ?? options.configured
    throw new Error(`unsafe DSH_HOME: ${String(source ?? resolved)} resolves into a system directory`)
  }
  return resolved
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
export function applyInstallDshHome(
  options: {
    readonly productDir?: string | undefined
    readonly env?: Record<string, string | undefined>
    readonly home?: string | undefined
  } = {},
): string {
  const env = options.env ?? process.env
  const resolved = dshHomeSafe({ productDir: options.productDir, env, home: options.home })
  env[DSH_HOME_ENV] = resolved
  return resolved
}

/**
 * Join path segments onto the resolved product Harness home.
 * @param segments - path segments appended to the home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Is `cwd` a filesystem root or a system directory (P2-34)? A packaged app
 * launched with such a working directory (desktop-entry `Path=`, a Windows
 * shortcut with a wrong "start in", a service manager) would create project
 * files, `.browser-store` or relative logs there, which is either impossible
 * or harmful. The old check only compared against the POSIX `/`, so Windows
 * `C:\`, `C:\Windows` and Program Files slipped through.
 *
 * R13-B P2-3:本闸门与数据根闸门（`isSafeDshHome`）**共用同一份实现**
 * （`isSystemPath`：一张系统根表、一套 Windows 形态判定、一次大小写归一、一次
 * realpath 归一），不再各写一份。根目录（POSIX `/`、`C:\`、UNC 根）、`/ETC` 这类
 * 大小写变体、以及指向系统目录的符号链接都因此一并覆盖。
 * @param cwd - candidate working directory.
 * @param env - environment used to locate the Windows system roots (test seam).
 */
export function isSystemWorkingDirectory(cwd: string, env: EnvLike = process.env): boolean {
  if (cwd.trim() === '') return true
  return isSystemPath(cwd, env)
}

/** Resolve the product home from the live environment. */
export function dshHome(): string {
  return resolveDshHome()
}
