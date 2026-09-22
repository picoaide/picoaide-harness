/** Compatibility profile composition over the official Web bundle and user plugins. */

import { createRequire, findPackageJSON } from 'node:module'
import { existsSync, readFileSync, readdirSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  DEFAULT_APP_ORIGIN_SCHEME,
  DEFAULT_DEEP_LINK_SCHEME,
  OFFICIAL_PRODUCT_NAME,
  readDesktopChannelProfile,
  type DesktopChannelProfile,
} from './desktop-channel.ts'
import {
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type ProfileContext,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from './desktop-home.ts'
import FileSettingsProvider, {
  resolveSpec as resolveSettingsFileSpec,
  type Config as SettingsFileConfig,
} from '@deepseek-ai/dsh-settings-file'
import { parseDocument } from 'yaml'
import type { DesktopShellMode } from './runtime.ts'
import {
  activeDesktopProfileLayers,
  readDesktopDisabledBundles,
} from './desktop-plugins.ts'

/**
 * Persistent profile owned exclusively by the desktop launcher.
 *
 * Upstream 0.1.5 reserves this name: the CLI rejects both `dsh --profile
 * desktop` and `dsh plugin --profile desktop` with "profile \"desktop\" is
 * managed exclusively by the Electron application". Third-party rows reach the
 * profile through its patch layers (`cordis.patch.yml`), which is also what the
 * product's own bundle overlays use.
 */
export const DESKTOP_PROFILE_NAME = 'desktop'

/** Standalone package name inserted through the launcher-owned desktop layer. */
export const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'

/** Empty include root rewritten before every profile boot. */
export const DESKTOP_PROFILE_ROOT = 'cordis.yml'

const BIN_NAME = DESKTOP_PACKAGE_NAME
const REQUIRED_BUNDLES = requiredWebBundles()
const REQUIRED_BUNDLE_SET = new Set(REQUIRED_BUNDLES)
const OBSOLETE_DESKTOP_BUNDLE_SET = new Set(['@deepseek-ai/dsh-desktop-app'])
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
const DESKTOP_PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const ENTERPRISE_PATCH_PATH = join(dirname(createRequire(import.meta.url).resolve('@picoaide/dsh-enterprise/package.json')), 'cordis.patch.yml')
const ACCOUNT_CARD_PATCH_PATH = join(dirname(createRequire(import.meta.url).resolve('@picoaide/dsh-account-card/package.json')), 'cordis.patch.yml')
// WASM 应用中心（客户端半边）：与 account-card 同构 —— 由桌面包通过 profile 组装期
// 注入，插件自己不解析随包路径（跨包路径在 tsdown 内联后会指向不存在的目录）。
const WASM_APPS_PATCH_PATH = join(dirname(createRequire(import.meta.url).resolve('@picoaide/dsh-wasm-apps/package.json')), 'cordis.patch.yml')
// 侧边栏底部「更多」行（客户端服务 `picoFootMenu` + 向上浮层）：与 wasm-apps 同层。
// 五个面板插件把自己的底部条目登记进它提供的服务（各自在**子 fiber** 里等，见各包
// client/index.ts），所以这一行与它们之间没有装配顺序敏感度。
//
// ⚠️ **禁用危害（2026-09-21 对抗审计）**：这一行是**五个面板入口的唯一承载行**。
// 渠道覆盖层或 `$DSH_HOME/cordis.patch.yml` 把它 `disabled: true` 时不会有任何报错 ——
// 消费者等的服务永远不出现，于是底部功能区**安静地**少掉定时任务 / 能力中心 / 连接器 /
// 浏览器 / 应用中心。因此它进了 `REQUIRED_DESKTOP_ROWS`（boot 后断言 ACTIVE，缺席即
// 抛错并走桌面的致命路径），而不是"少一行也无所谓"。
const FOOT_MENU_PATCH_PATH = join(dirname(createRequire(import.meta.url).resolve('@picoaide/dsh-foot-menu/package.json')), 'cordis.patch.yml')
const CONNECTORS_PATCH_PATH = join(dirname(createRequire(import.meta.url).resolve('@picoaide/dsh-connectors/package.json')), 'cordis.patch.yml')
const BROWSER_PATCH_PATH = join(dirname(createRequire(import.meta.url).resolve('@picoaide/dsh-browser/package.json')), 'cordis.patch.yml')
// 客户端专属 WASM 应用 origin（`picoaide-app://` 协议 handler + 本机打开路由）：
// 与其余自有插件同构 —— 桌面包通过 profile 组装期注入，插件自己不解析随包路径。
const WASM_APPS_HOST_PATCH_PATH = join(dirname(createRequire(import.meta.url).resolve('@picoaide/dsh-wasm-apps-host/package.json')), 'cordis.patch.yml')
/** 宿主行 id：scheme / 产品名注入点（见 prepareDesktopProfile 末尾）。 */
const WASM_APPS_HOST_ROW_ID = 'pico-wasm-apps-host'
/** 浏览器行 id：应用源 scheme 注入点（导航闸门按 surface 分流要用它）。 */
const BROWSER_ROW_ID = 'pico-browser'
const MEMORY_PATCH_PATH = join(dirname(createRequire(import.meta.url).resolve('dsh-memory-evolve/package.json')), 'cordis.patch.yml')
const CRON_PATCH_PATH = join(dirname(createRequire(import.meta.url).resolve('@picoaide/dsh-cron/package.json')), 'cordis.patch.yml')
const DIRECTORY_PICKER_ROW_ID = 'directory-picker'
const AUTO_PICKER_PACKAGE = '@deepseek-ai/dsh-host-directory-picker-auto'
const BROWSE_PICKER_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse'
const BROWSE_PICKER_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const PWSH_SANDBOX_ROW_ID = 'pwsh-sandbox'
const UPSTREAM_PWSH_SANDBOX_PACKAGE = '@deepseek-ai/dsh-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID = 'desktop-windows-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE = 'dsh-plugin-desktop/windows-pwsh-sandbox'
const AGENT_PRESETS_ROW_ID = 'agent-presets'
const UPSTREAM_AGENT_PRESETS_PACKAGE = '@deepseek-ai/dsh-agent-presets'
const DESKTOP_WINDOWS_AGENT_PRESETS_ROW_ID = 'desktop-windows-agent-presets'
const DESKTOP_WINDOWS_AGENT_PRESETS_PACKAGE = 'dsh-plugin-desktop/windows-agent-presets'
const DEFAULT_DESKTOP_SHELL_MODE: DesktopShellMode = 'advanced'
const DEFAULT_DESKTOP_PORT = 0
const SETTINGS_FILE_PACKAGE = '@deepseek-ai/dsh-settings-file'
const DESKTOP_SETTINGS_NAMESPACE = 'dsh-desktop'
const UI_LAYOUT_PACKAGE = '@deepseek-ai/dsh-client-ui-layout'
const UI_SIDEBAR_PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar'
const UI_CONVERSATION_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
const ADVANCED_DESKTOP_SHELL_MODE: DesktopShellMode = 'advanced'

/**
 * Parse desktop presentation state and reject corrupted values.
 * @param value - untrusted settings value.
 * @returns a supported desktop shell mode.
 * @deprecated The desktop shell is fixed to advanced mode; this API is kept
 * for backward compatibility and always returns 'advanced'.
 */
/**
 * 渠道包 → 各行 patch（纯函数，无文件 I/O；`readDesktopChannelProfile` 的结果由
 * 调用方传入，于是这条注入链可以脱离真实 `build/channel.json` 单测）。
 *
 * 为什么必须是**组装期**而不是运行时下发：登录页在认证之前就渲染品牌区，那一刻
 * 服务端地址可能正是用户要输入的东西（问服务端要它自己是鸡生蛋），窗口标题与
 * 品牌名在用户敲第一个键之前就已可见。
 *
 * 官方构建（没有渠道包）返回空数组 —— 行为与渠道化改造前逐字节一致。
 * @param channelProfile - 随包分发的渠道内容（缺失=未渠道化）。
 * @param rows - 已被前面的 patch 触及的行 id 集合（只注入确实存在的行）。
 * @returns 追加到组合结果尾部的 patch 列表。
 */
export function channelProfilePatches(
  channelProfile: DesktopChannelProfile | undefined,
  rows: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): Array<Record<string, unknown>> {
  if (channelProfile === undefined) return []
  const out: Array<Record<string, unknown>> = []
  // 服务端地址与品牌文案合成**一次** patch：同一行 patch 两次时后一条会整体
  // 覆盖前一条的 config（丢域名或多丢品牌）。
  if (rows.has('picoaide-auth-gate')) {
    out.push({
      id: 'picoaide-auth-gate',
      config: {
        ...(channelProfile.defaultServerURL === undefined ? {} : { defaultServer: channelProfile.defaultServerURL }),
        brand: channelProfile.brand,
      },
    })
  }
  // 客户端界面（侧边栏/顶栏/登录后品牌）的随包兜底：服务端可达时以服务端下发的
  // 渠道内容为准，不可达/未登录时用它 —— 绝不回落厂商品牌。
  if (rows.has('picoaide-channel-sync')) {
    out.push({
      id: 'picoaide-channel-sync',
      config: { brand: channelProfile.brand },
    })
  }
  // 连接器 OAuth 的客户端名会显示在**客户自己的 IdP 授权同意页**上，
  // 渠道构建下必须是该渠道的产品名（缺省是中性名，绝不含厂商品牌）。
  if (channelProfile.productName !== undefined && rows.has('pico-connectors')) {
    out.push({
      id: 'pico-connectors',
      config: { clientName: `${channelProfile.productName} Connector` },
    })
  }
  // 深链 scheme 必须**注入**会话服务，不能让插件自己去读随包 channel.json：
  // enterprise 的 lib 是 tsdown 内联产物，`desktop-channel.ts` 里的
  // `../build/channel.json` 在那里指向不存在的路径（asar 里只有应用根的
  // `/build/`），于是浏览器 SSO 回调永远按官方 scheme 校验、渠道客户端的登录
  // 回调被当成畸形链接丢掉（2026-09-11 真机复现）。
  if (rows.has('picoaide-session')) {
    out.push({
      id: 'picoaide-session',
      config: { deepLinkScheme: channelProfile.deepLinkScheme },
    })
  }
  return out
}

export function parseDesktopShellMode(value: unknown): DesktopShellMode {
  if (value === undefined) return DEFAULT_DESKTOP_SHELL_MODE
  if (value === 'advanced' || value === 'compatibility') return 'advanced'
  throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE}.mode must be "compatibility" or "advanced"`)
}

/** Parse the requested loopback Web port and reject values Node cannot listen on. */
export function parseDesktopPort(value: unknown): number {
  if (value === undefined) return DEFAULT_DESKTOP_PORT
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_535) return value
  throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE}.port must be an integer from 0 through 65535`)
}

/** Startup settings projected into the Loader graph before the settings plugin boots. */
export interface DesktopStartupSettings {
  mode: DesktopShellMode
  port: number
}

/**
 * Read Desktop startup settings from one parsed settings document.
 * @param document - untrusted settings document root.
 * @returns validated mode and port defaults for the next generation.
 */
export function desktopStartupSettingsFromSettings(document: unknown): DesktopStartupSettings {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`${BIN_NAME}: settings document must be a map of namespace sections`)
  }
  const section = (document as Record<string, unknown>)[DESKTOP_SETTINGS_NAMESPACE]
  if (section === undefined) {
    return { mode: DEFAULT_DESKTOP_SHELL_MODE, port: DEFAULT_DESKTOP_PORT }
  }
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE} settings must be a map`)
  }
  const values = section as Record<string, unknown>
  return {
    mode: parseDesktopShellMode(values.mode),
    port: parseDesktopPort(values.port),
  }
}

/** Read only the shell mode from one parsed settings document. */
export function desktopShellModeFromSettings(document: unknown): DesktopShellMode {
  return desktopStartupSettingsFromSettings(document).mode
}

/**
 * Read startup settings from the same file resolved by the settings provider.
 * @param config - validated settings-file row config.
 * @returns the values projected into the startup Loader graph.
 */
export function readDesktopStartupSettings(config: SettingsFileConfig): DesktopStartupSettings {
  const spec = resolveSettingsFileSpec(config)
  let text: string
  try {
    text = readFileSync(spec.filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mode: DEFAULT_DESKTOP_SHELL_MODE, port: DEFAULT_DESKTOP_PORT }
    }
    throw cause
  }
  let document: unknown
  if (spec.format === 'yaml') {
    const parsed = parseDocument(text, { prettyErrors: true })
    if (parsed.errors.length > 0) {
      throw new Error(`${BIN_NAME}: invalid settings document at ${spec.filename}: ${parsed.errors.map(error => error.message).join('; ')}`)
    }
    document = parsed.toJS() ?? {}
  } else {
    document = text.trim().length === 0 ? {} : JSON.parse(text)
  }
  return desktopStartupSettingsFromSettings(document)
}

/** Read only the shell mode from the settings provider's resolved file. */
export function readDesktopShellMode(config: SettingsFileConfig): DesktopShellMode {
  return readDesktopStartupSettings(config).mode
}

/** Resolve the public Web template once and reject an incompatible DSH release. */
function requiredWebBundles(): string[] {
  const template = PROFILE_TEMPLATES.web
  if (template === undefined) {
    throw new Error(`${BIN_NAME}: installed dsh-app-boot has no web profile template`)
  }
  return [...template.bundles]
}

/** Prepared profile inputs consumed by app-boot. */
export interface PreparedDesktopProfile {
  /** Harness home shared by the launcher and generated command environment. */
  homeDir: string
  /** Resolved profile and its persistent user layer. */
  profile: Profile
  /** Absolute empty root config included by the Cordis Loader. */
  rootConfig: string
  /** Profile-owned parent URL used to resolve bare Cordis plugin packages. */
  bareModuleBaseUrl: string
  /** Complete ordered patch list for this desktop generation. */
  patches: PatchOptions[]
  /**
   * Launcher-owned patches applied **above** the profile's own layer and the home
   * patch (`$DSH_HOME/cordis.patch.yml`) — the tail of {@link patches} and the
   * desktop counterpart of the CLI's `--patch` overlays
   * (`ProfileContext.overlays`). The desktop has no command-line overlay inputs,
   * so this layer is exactly what the launcher pins itself (settings/webserver/
   * agent-presets/channel injection…); exposing the boundary keeps
   * `profileContext` describing this generation instead of re-deriving it.
   */
  overlays: PatchOptions[]
  /** Installation manifest path used as the first module-resolution anchor. */
  installAnchor: string
  /** Launch-time telemetry opt-out this generation was composed with. */
  telemetryDisabledEnv: string | undefined
  /** Optional Client UI entries skipped because this profile cannot resolve them. */
  skippedOptionalEntries: SkippedOptionalEntry[]
  /** Persisted shell mode applied after every user-owned patch. */
  mode: DesktopShellMode
  /** Persisted loopback Web port applied to every startup consumer. */
  port: number
}

/** User patch entry skipped to keep a profile bootable. */
export interface SkippedOptionalEntry {
  /** Loader row id from the skipped entry. */
  id?: string
  /** Package name from the skipped entry. */
  name: string
}

/**
 * Normalize the installation-owned prefix while preserving third-party order.
 * @param current - current persistent bundle list.
 * @returns base, Web carrier, then every third-party bundle in prior order.
 */
export function desktopBundleList(current: readonly string[]): string[] {
  const thirdParty = current.filter(name => !REQUIRED_BUNDLE_SET.has(name)
    && name !== DESKTOP_PACKAGE_NAME
    && !OBSOLETE_DESKTOP_BUNDLE_SET.has(name))
  return [...REQUIRED_BUNDLES, ...thirdParty]
}

/** Return whether two ordered string lists are identical. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Initialize or repair the persistent desktop profile.
 * @param home - Harness home containing the profiles directory.
 * @returns the absolute profile directory.
 */
export function ensureDesktopProfile(home: string = resolveDshHome()): string {
  const dir = resolveProfileDir(DESKTOP_PROFILE_NAME, home)
  if (!existsSync(join(dir, 'package.json'))) initProfile(dir, REQUIRED_BUNDLES)
  const manifest = readProfileManifest(BIN_NAME, dir)
  const rawBundles = (manifest.dsh?.profile as { bundles?: unknown } | undefined)?.bundles
  if (rawBundles !== undefined
    && (!Array.isArray(rawBundles) || rawBundles.some(value => typeof value !== 'string'))) {
    throw new Error(`${BIN_NAME}: dsh.profile.bundles must be an array of package names`)
  }
  const current = rawBundles === undefined ? [] : rawBundles as string[]
  const bundles = desktopBundleList(current)
  if (!sameList(current, bundles)) {
    writeProfileManifest(dir, {
      ...manifest,
      dsh: {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles,
        },
      },
    })
  }
  return dir
}

/**
 * Resolve the shipped agent-preset root the profile pins as a `system` root.
 *
 * The presets travel inside `@deepseek-ai/dsh-agent-presets` (`presets/`, in its
 * published `files`): this roster prepends that directory itself
 * (`includeShippedRoot`), and the CLI package ships `lib/*.js` only — it has no
 * `config/` directory, so the former `@deepseek-ai/dsh/config/agent-presets`
 * anchor resolved to a path that never existed. The lookup is anchored on the
 * preset package's manifest, resolved from the same module-graph base the rest
 * of the profile uses. It falls back to that historical anchor only when the
 * preset package or its `presets/` directory cannot be resolved at all, so
 * profile composition never throws over a redundant root: the roster's own
 * shipped root still lists the presets.
 * @param moduleUrl - module whose resolution base anchors the lookup.
 * @returns absolute path of the shipped preset root.
 */
export function shippedPresetRoot(moduleUrl: string = import.meta.url): string {
  const require = createRequire(moduleUrl)
  try {
    const shipped = join(dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json')), 'presets')
    if (existsSync(shipped)) return shipped
  } catch {
    // Swallows MODULE_NOT_FOUND and export-map rejections for the preset
    // package: both mean this install cannot offer the root, and the fallback
    // below still leaves profile composition working.
  }
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets')
}

/**
 * Remove stale module-fallback symlinks produced by an asar-packaged install.
 *
 * The 2.6.7-beta.1/2 layout pointed every shared and profile-owned fallback
 * link into `resources/app.asar`; the physical layout (`asar: false`) no
 * longer ships that archive, so those links dangle. The upstream heal
 * canonicalizes link targets with `realpathSync` before replacing them —
 * Electron's asar probe reports a plain `Invalid package ...app.asar` error
 * (not ENOENT) for a vanished archive and aborts boot before the heal can
 * rebuild. Deleting every asar-targeting symlink under `$DSH_HOME/profiles`
 * first lets the heal recreate the links against the real tree. Only
 * symlinks are touched; real directories (proxy entries, pnpm-managed
 * installs) are never removed.
 * @param home - the harness home whose profiles tree is cleaned.
 */
export function removeStaleAsarFallbackLinks(home: string = resolveDshHome()): void {
  const profilesDir = join(home, 'profiles')
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isSymbolicLink()) {
        try {
          const target = readlinkSync(path)
          const resolved = isAbsolute(target) ? target : resolve(dirname(path), target)
          if (resolved.toLowerCase().includes('app.asar')) {
            unlinkSync(path)
          }
        } catch {
          // An unreadable link is not ours to remove.
        }
      }
    }
  }
  walk(profilesDir)
}

/** Read a row's object config without trusting arbitrary YAML values. */
function rowConfig(row: EntryOptions | undefined): Record<string, unknown> {
  const config = row?.config
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
}

/** Resolve a Loader row's platform gate without mutating the host process. */
function rowDisabledOnPlatform(row: EntryOptions, platform: NodeJS.Platform): boolean {
  if (!isJsExpr(row.disabled)) return row.disabled === true
  const scopedProcess = new Proxy(process, {
    get(target, property) {
      if (property === 'platform') return platform
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return Boolean(evaluate({ process: scopedProcess }, row.disabled.__jsExpr))
}

/** Reject duplicate entries before the Loader turns them into a startup crash. */
function assertUniqueEntryIds(rows: readonly EntryOptions[]): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row.id === 'string') {
      if (seen.has(row.id)) {
        throw new Error(`${BIN_NAME}: duplicate loader entry id "${row.id}" in the composed profile`)
      }
      seen.add(row.id)
    }
    if (row.group === true && Array.isArray(row.config)) {
      assertUniqueEntryIds(row.config)
    }
  }
}

/** Find one package manifest using the selected profile's dependency graph. */
function packageManifestFromProfile(name: string, profilePackageUrl: string): string | undefined {
  try {
    return findPackageJSON(name, profilePackageUrl)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return undefined
    throw cause
  }
}

/** Return whether a Loader specifier names an npm package. */
function isBarePackageSpecifier(name: string): boolean {
  return !name.startsWith('.')
    && !name.startsWith('/')
    && !name.startsWith('#')
    && !URL.canParse(name)
}

/** Return whether a package is a user-facing Client UI extension, not a Host provider. */
function isOptionalClientPackage(name: string): boolean {
  return /^(@[^/]+\/)?dsh-client-ui-/u.test(name)
}

/** Drop unresolved optional Client UI rows from the machine-wide patch only. */
function omitUnresolvedOptionalEntries(
  patches: PatchOptions[],
  profilePackageUrl: string,
): { patches: PatchOptions[], skipped: SkippedOptionalEntry[] } {
  const skipped: SkippedOptionalEntry[] = []

  const filterRows = (rows: EntryOptions[]): EntryOptions[] => {
    const filtered: EntryOptions[] = []
    for (const row of rows) {
      if (typeof row.name === 'string'
        && isBarePackageSpecifier(row.name)
        && isOptionalClientPackage(row.name)
        && packageManifestFromProfile(row.name, profilePackageUrl) === undefined) {
        skipped.push({
          ...(typeof row.id === 'string' ? { id: row.id } : {}),
          name: row.name,
        })
        continue
      }
      const config = row.group === true && Array.isArray(row.config) ? filterRows(row.config) : undefined
      filtered.push(config === undefined ? row : { ...row, config })
    }
    return filtered
  }

  return {
    patches: patches.flatMap((patch) => {
      if (!Array.isArray(patch.insert)) return [patch]
      const insert = filterRows(patch.insert)
      return [{ ...patch, insert }]
    }),
    skipped,
  }
}

/**
 * Load and compose the fixed desktop profile generation.
 * @param telemetryDisabled - inherited DSH telemetry opt-out value.
 * @param home - Harness home containing profiles and the machine-wide patch.
 * @param platform - native platform selecting launcher-owned safety overlays.
 * @param pluginStatePath - optional Desktop-private disabled-bundle state.
 * @param userDataDir - optional Electron userData directory (channel-scoped) handed to
 *   the application-window host row for its geometry memory and content cache.
 * @returns root config, profile metadata, and ordered patches.
 */
export async function prepareDesktopProfile(
  telemetryDisabled: string | undefined = process.env.DSH_TELEMETRY_DISABLED,
  home: string = resolveDshHome(),
  platform: NodeJS.Platform = process.platform,
  pluginStatePath?: string,
  userDataDir?: string,
): Promise<PreparedDesktopProfile> {
  const profileName = DESKTOP_PROFILE_NAME
  const profileDir = ensureDesktopProfile(home)
  removeStaleAsarFallbackLinks(home)
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, home })
  const profile = loadProfile(BIN_NAME, profileName, INSTALL_ANCHOR, home)
  const disabledBundles = pluginStatePath === undefined
    ? new Set<string>()
    : readDesktopDisabledBundles(pluginStatePath, profileName)
  const rootConfig = join(profileDir, DESKTOP_PROFILE_ROOT)
  const bareModuleBaseUrl = pathToFileURL(join(profile.dir, 'package.json')).href
  writeFileSync(rootConfig, '[]\n')

  const desktopPatches = loadOverlayPatches(BIN_NAME, DESKTOP_PATCH_PATH)
  const enterprisePatches = loadOverlayPatches(BIN_NAME, ENTERPRISE_PATCH_PATH)
  const accountCardPatches = loadOverlayPatches(BIN_NAME, ACCOUNT_CARD_PATCH_PATH)
  const wasmAppsPatches = loadOverlayPatches(BIN_NAME, WASM_APPS_PATCH_PATH)
  const footMenuPatches = loadOverlayPatches(BIN_NAME, FOOT_MENU_PATCH_PATH)
  const connectorsPatches = loadOverlayPatches(BIN_NAME, CONNECTORS_PATCH_PATH)
  const browserPatches = loadOverlayPatches(BIN_NAME, BROWSER_PATCH_PATH)
  const wasmAppsHostPatches = loadOverlayPatches(BIN_NAME, WASM_APPS_HOST_PATCH_PATH)
  const memoryPatches = loadOverlayPatches(BIN_NAME, MEMORY_PATCH_PATH)
  const cronPatches = loadOverlayPatches(BIN_NAME, CRON_PATCH_PATH)
  const bundlePatches: PatchOptions[] = []
  let desktopLayerInserted = false
  for (const layer of activeDesktopProfileLayers(profile, disabledBundles)) {
    bundlePatches.push(...layer.patches)
    if (layer.packageName !== '@deepseek-ai/dsh-web-app') continue
    bundlePatches.push(...desktopPatches)
    bundlePatches.push(...enterprisePatches)
    // Account card right after the enterprise rows: it injects the
    // `picoSession` service and the enterprise shared gateway helpers.
    bundlePatches.push(...accountCardPatches)
    // WASM 应用中心（客户端半边）：与 account-card 同层，晚于 enterprise
    // （它读 enterprise 提供的本地路由与会话）。
    bundlePatches.push(...wasmAppsPatches)
    // 侧边栏底部「更多」行：五个面板插件的底部条目都登记进它提供的
    // `picoFootMenu` 服务（消费者用 `inject` 等服务到位，与它们的装配顺序无关）。
    bundlePatches.push(...footMenuPatches)
    // 客户端专属 WASM 应用 origin：与 wasm-apps（应用中心客户端半边）同层，
    // 它读 enterprise 提供的 `picoSession` 与本机 webServer。
    bundlePatches.push(...wasmAppsHostPatches)
    bundlePatches.push(...connectorsPatches)
    bundlePatches.push(...browserPatches)
    bundlePatches.push(...memoryPatches)
    // Workbench: cron (scheduled jobs, now the single workbench surface).
    // The right column is the official right Sidebar (ui-sidebar-right), which
    // the web bundle already mounts; the vendored third-party sidebar is gone.
    bundlePatches.push(...cronPatches)
    desktopLayerInserted = true
  }
  if (!desktopLayerInserted) {
    throw new Error(`${BIN_NAME}: desktop profile is missing @deepseek-ai/dsh-web-app`)
  }

  const loadedHomePatches = loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []
  const { patches: homePatches, skipped: skippedOptionalEntries } = omitUnresolvedOptionalEntries(
    loadedHomePatches,
    bareModuleBaseUrl,
  )
  const patches: PatchOptions[] = [
    ...bundlePatches,
    ...profile.patches,
    ...homePatches,
  ]
  // 分界线：这一行之后 push 的全是**启动器自己的 pin**（settings/webserver/
  // ui-layout/agent-presets/desktop-shell/渠道注入…）。它们在真实组合里就应用在
  // profile 自有层与 home 层**之上**，正是 `ProfileContext.overlays` 的语义
  // （上游 CLI 的 `--patch` 覆盖层）；`desktopProfileContext` 用它描述本次装配。
  const overlayStart = patches.length
  const composedRows = composeEntries([patches])
  assertUniqueEntryIds(composedRows)
  const rows = new Map<string, EntryOptions>()
  for (const row of composedRows) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const settings = rows.get('settings')
  if (settings?.name !== SETTINGS_FILE_PACKAGE) {
    throw new Error(`${BIN_NAME}: desktop profile must use ${SETTINGS_FILE_PACKAGE} in the settings row`)
  }
  const settingsConfig = FileSettingsProvider.Config({
    dshHome: home,
    ...rowConfig(settings),
  } as SettingsFileConfig)
  const { port } = readDesktopStartupSettings(settingsConfig)
  patches.push({
    id: 'settings',
    config: settingsConfig,
  })
  const mode: DesktopShellMode = ADVANCED_DESKTOP_SHELL_MODE
  {
    for (const [id, packageName] of [
      ['ui-layout', UI_LAYOUT_PACKAGE],
      ['ui-sidebar', UI_SIDEBAR_PACKAGE],
      ['ui-conversation', UI_CONVERSATION_PACKAGE],
    ] as const) {
      if (rows.get(id)?.name !== packageName) {
        throw new Error(`${BIN_NAME}: advanced desktop mode must use ${packageName} in the ${id} row`)
      }
    }
    patches.push(
      // Advanced desktop owns the root frame itself: ui-layout's client row
      // is disabled so its AppFrame/child-slot declarations and `layout`
      // service provider never activate (0.1.2 forbids a second declaration
      // of the sidebar/main/rightbar slots and a duplicate service).
      // The desktop shell provides the `layout` service and registers the
      // root frame with the child declarations instead (advanced-shell.ts).
      { id: 'ui-layout', disabled: true },
      { id: 'ui-sidebar', disabled: false },
      { id: 'ui-conversation', disabled: false },
    )
  }
  const presets = rows.get(AGENT_PRESETS_ROW_ID)
  if (presets !== undefined) {
    const config = {
      ...rowConfig(presets),
      roots: [{ path: shippedPresetRoot(), trust: 'system' }],
    }
    if (platform === 'win32'
      && presets.name === UPSTREAM_AGENT_PRESETS_PACKAGE
      && !rowDisabledOnPlatform(presets, platform)) {
      patches.push(
        {
          id: AGENT_PRESETS_ROW_ID,
          name: UPSTREAM_AGENT_PRESETS_PACKAGE,
          disabled: true,
        },
        {
          insert: [{
            id: DESKTOP_WINDOWS_AGENT_PRESETS_ROW_ID,
            name: DESKTOP_WINDOWS_AGENT_PRESETS_PACKAGE,
            config,
          }],
        },
      )
    } else {
      patches.push({ id: AGENT_PRESETS_ROW_ID, config })
    }
  }
  if (!rows.has('webserver')) {
    throw new Error(`${BIN_NAME}: desktop profile has no webserver row`)
  }
  if (platform === 'win32') {
    if (!rows.has(DIRECTORY_PICKER_ROW_ID)) {
      throw new Error(`${BIN_NAME}: desktop profile has no directory-picker row`)
    }
    patches.push(
      {
        id: DIRECTORY_PICKER_ROW_ID,
        name: AUTO_PICKER_PACKAGE,
        disabled: true,
      },
      {
        insert: [
          {
            id: 'desktop-directory-picker-browse-host',
            name: BROWSE_PICKER_BACKEND,
          },
          {
            id: 'desktop-directory-picker-browse-surface',
            name: BROWSE_PICKER_SURFACE,
          },
        ],
      },
    )
    const pwshSandbox = rows.get(PWSH_SANDBOX_ROW_ID)
    if (pwshSandbox?.name === UPSTREAM_PWSH_SANDBOX_PACKAGE
      && !rowDisabledOnPlatform(pwshSandbox, platform)) {
      patches.push(
        {
          id: PWSH_SANDBOX_ROW_ID,
          name: UPSTREAM_PWSH_SANDBOX_PACKAGE,
          disabled: true,
        },
        {
          insert: [
            {
              id: DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID,
              name: DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE,
              ...(pwshSandbox.disabled === undefined ? {} : { disabled: pwshSandbox.disabled }),
              config: rowConfig(pwshSandbox),
            },
          ],
        },
      )
    }
  }
  // Loopback-only binding is a launcher security invariant, not user config.
  patches.push({
    id: 'webserver',
    disabled: false,
    config: { host: '127.0.0.1', port },
  })
  if ((telemetryDisabled ?? '') !== '' && rows.has('session-telemetry-otel')) {
    patches.push({ id: 'session-telemetry-otel', disabled: true })
  }
  const desktopShell = rows.get('desktop-shell')
  if (desktopShell === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no desktop-shell row`)
  }
  // 渠道包（随包分发的 channels/<id>/channel.json）在**组装期**生效：
  // 产品名/窗口标题在登录页出现时就已经可见，服务端地址更是登录前就要用
  // （问服务端要它自己是鸡生蛋），所以两者都必须来自包内配置而非运行时下发。
  const channelProfile = readDesktopChannelProfile()
  patches.push({
    id: 'desktop-shell',
    disabled: false,
    config: {
      ...rowConfig(desktopShell),
      mode,
      port,
      ...(channelProfile?.productName === undefined ? {} : { productName: channelProfile.productName }),
      ...(channelProfile?.windowTitle === undefined ? {} : { windowTitle: channelProfile.windowTitle }),
    },
  })
  patches.push(...channelProfilePatches(channelProfile, rows))
  // 深链 scheme 必须**注入**应用协议插件行，不能让插件自己去读随包 channel.json
  // （enterprise 的 same 教训：tsdown 内联后 `../build/channel.json` 指向不存在的
  // 目录，渠道客户端的深链会被官方 scheme 的严格闸门丢掉）。官方构建没有渠道包，
  // 这里补上产品缺省 scheme —— 注入点唯一，插件侧不写死 `picoaide://`。
  if (rows.has(WASM_APPS_HOST_ROW_ID)) {
    patches.push({
      id: WASM_APPS_HOST_ROW_ID,
      // 三个值同源（§10/§16.1）：渠道包字段 → 组装期注入 → 插件 config。插件侧
      // 与渲染层都不自行读随包 `channel.json`（tsdown 内联后那个路径不成立）。
      config: {
        deepLinkScheme: channelProfile?.deepLinkScheme ?? DEFAULT_DEEP_LINK_SCHEME,
        appOriginScheme: channelProfile?.appOriginScheme ?? DEFAULT_APP_ORIGIN_SCHEME,
        productName: channelProfile?.productName ?? OFFICIAL_PRODUCT_NAME,
        // 应用窗口的几何记忆与内容缓存落点（§16.1）。**必须注入**：插件在纯 Node
        // 宿主里拿不到 Electron 的 userData，缺席时窗口管理器整个不构造 —— 现象是
        // "点打开回 opened，屏幕上什么都没有"（2026-09-20 实测故障）。
        // 取值 = Electron userData（已按渠道 `setPath`，见 desktop-user-data.ts）。
        ...(userDataDir === undefined || userDataDir === '' ? {} : { userDataDir }),
      },
    })
  }
  // 渲染层经本机只读路由 `GET /api/pico/wasm-apps/channel` 取渠道 scheme（§16.1）：
  // 浏览器面也要知道应用源 scheme 才能按 surface 分流导航闸门（应用窗口放行自己的
  // origin、浏览器标签一律拒）。同一个值、同一个注入点，两处消费。
  if (rows.has(BROWSER_ROW_ID)) {
    patches.push({
      id: BROWSER_ROW_ID,
      config: { appOriginScheme: channelProfile?.appOriginScheme ?? DEFAULT_APP_ORIGIN_SCHEME },
    })
  }
  return {
    homeDir: home,
    profile,
    rootConfig,
    bareModuleBaseUrl,
    patches: structuredClone(patches),
    overlays: structuredClone(patches.slice(overlayStart)),
    installAnchor: INSTALL_ANCHOR,
    telemetryDisabledEnv: telemetryDisabled,
    skippedOptionalEntries,
    mode,
    port,
  }
}

/**
 * Compose the launcher-owned `profileContext` for one prepared desktop generation.
 *
 * 为什么必须有它（issue #130，P0「创造模式」会话全部不可用）：上游 base bundle 的两
 * 行由 `disabled: !!js "!ctx.get('profileContext')"` 这个开关控制
 * （`deepseek-harness/packages/bundle/base/cordis.patch.yml:20-31`）——
 *   · `plugin-manager`：宿主不 provide `profileContext` 时整行被**静默** disable
 *     ⇒ `pluginManager` 服务不存在 ⇒ `cordis` preset 的行 `tool-plugin-manager`
 *     （`inject: ['tools','pluginManager','sandboxPolicy']`）永远停在 PENDING ⇒
 *     该 preset 的会话挂不起来（`preset "cordis" failed to mount: 1 row(s) did not
 *     activate: tool-plugin-manager … waiting for pluginManager`）。
 *   · `hmr`：**一旦** provide 了 `profileContext` 它就会挂载，而
 *     `@deepseek-ai/dsh-hmr` 的 `Service.init` 要求存在 `appReady`
 *     （`deepseek-harness/packages/boot/hmr/src/index.ts:200-208`），`appReady` 只有
 *     `@deepseek-ai/dsh-cmdline` 会 provide —— 桌面宿主不走 cmdline，于是整棵 profile
 *     树在 "Profile HMR requires application readiness" 处 fail-loud。两件事必须成对
 *     做：这里 provide `profileContext`，`cordis.patch.yml` 里显式关闭 `hmr` 行。
 *
 * 字段与上游 CLI 的构造同源（`deepseek-harness/apps/cli/src/profile-boot.ts:297-305`），
 * 但每个取值都来自**本次真实装配**（`prepareDesktopProfile` 的返回值），这里不另猜路径：
 *   · `name`/`dir`/`patchPath` —— 本次装配的 profile（`$DSH_HOME/profiles/desktop`）；
 *   · `installAnchor` —— 首次模块解析锚点（桌面包自己的 `package.json`，与
 *     `loadProfile`/`healProfilesModuleFallback` 用的是同一个值；`plugin-manager` 的
 *     `listBundles()` 会把它当 JSON 读，所以必须是文件而不是目录）；
 *   · `home` —— 本次装配用的 Harness home（`$DSH_HOME`，或渠道派生的数据根）；
 *   · `startedBundles` —— 本次 profile 清单解析出的 bundle 层顺序（与上游 CLI 的
 *     `composed.profile.layers.map(layer => layer.packageName)` 同源）；
 *   · `overlays` —— 启动器自己的 pin 层（应用在 profile 自有层与 home 层之上）；
 *   · `telemetryDisabledEnv` —— 本次装配实际读到的遥测开关。**不要**在这里重读
 *     `process.env`：装配的入参可能是调用方显式传进来的值（冒烟就是这么做的），重读
 *     会让"组合期用了 A、事后自述 B"分叉；
 *   · `cwd` —— 启动器的工作目录，语义与上游 CLI 相同（`process.cwd()`）。它只被用来
 *     锚定"安装 bundle"时的**相对**路径参数，绝对路径不受影响。
 *
 * `packageManager` **有意不提供**：随包不带 pnpm，也不带任何可执行包管理器入口
 * （`package.json` 的 `files`/`asarUnpack` 与 `tests/package.spec.ts` 里
 * `installDesktopPnpmRuntime` 的反向断言共同保证这一点）。编造入口只会把"这台机器没有
 * 包管理器"伪装成"命令不存在"。缺省时 `PluginManager` 用 `pnpmCommand: 'pnpm'`，即回落到
 * PATH 上的 pnpm：**插件服务本身照常可用**（`list_plugins`/`list_bundles`/启停都工作），
 * 只有 `install_bundle`/`remove_bundle` 这类包操作会因 `ENOENT` 失败——上游把 pnpm 的
 * stderr 原样回给模型（`runProfilePnpm` → `plugin_manager` 工具结果），失败是 loud 的，
 * 不是静默降级。
 * @param prepared - the prepared desktop generation this context describes.
 * @returns the launcher-owned context passed to `ctx.provide('profileContext', …)`.
 */
export function desktopProfileContext(prepared: PreparedDesktopProfile): ProfileContext {
  return {
    name: DESKTOP_PROFILE_NAME,
    dir: prepared.profile.dir,
    patchPath: prepared.profile.patchPath,
    installAnchor: prepared.installAnchor,
    startedBundles: prepared.profile.layers.map(layer => layer.packageName),
    cwd: process.cwd(),
    home: prepared.homeDir,
    overlays: prepared.overlays,
    telemetryDisabledEnv: prepared.telemetryDisabledEnv,
  }
}

/** Expose the package anchor for focused resolution tests. */
export function desktopInstallAnchor(): string {
  return INSTALL_ANCHOR
}

/** Preserve the public manifest type in the declaration graph used by plugin tooling. */
export type DesktopProfileManifest = ProfileManifest
