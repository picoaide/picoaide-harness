/** Compatibility profile composition over the official Web bundle and user plugins. */

import { findPackageJSON } from 'node:module'
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
  createRuntimeResolution,
  initProfile,
  loadOptionalPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type ProfileContext,
  type ProfileManifest,
  type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from './desktop-home.ts'
import { parseDocument } from 'yaml'
import type { DesktopShellMode } from './runtime.ts'
import { resolveBundledSpeechModel } from './speech-model-bundle.ts'
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
// 桌面自己的包同时是 profile 的**最后一个 bundle 层**（`dsh.bundle.patch` 列出
// `./cordis.patch.yml` 与九个自有包的组装补丁）。它必须排在 `@deepseek-ai/dsh-web-app`
// 之后，因为那十层是"晚于上游 bundle、早于 profile 自有层与 home 层"的层。
//
// 为什么必须是**真的 bundle 层**（2026-09-28 的 `verify:profile` P0）：
// 上游 `readProfilePatches`（= `config-editor.edit()` 每次设置写入前的复算来源、
// `plugin-manager` 读面、`ProfileContext` 自述）只读 `profile.layers` + `patchPath`
// + home 补丁 + `context.overlays`。把十层塞进 `context.overlays` 也不行：`overlays`
// 追加在**最后**，于是 `- insert:` 的行会晚于设置文档建立，`config-editor.edit()` 收尾的
// 断言 `Configuration for "<id>" is overridden by a home patch or command-line overlay`
// 会直接抛错（模型网关行 `picoaide-gateway-llm` 每次登录都要写 baseURL ⇒ 模型面全灭）。
// 放进 `profile.layers` 是唯一同时满足"复算得到"与"早于设置文档"的位置。
const REQUIRED_BUNDLES = [
  ...requiredWebBundles(),
  // 十个自有组装补丁层（本包的 `cordis.patch.yml` + 下列九个包各自的
  // `cordis.patch.yml`）以 **bundle 层**身份进入组合，顺序 = 这里列出的顺序。
  // 本包自己的那一层由 `@picoaide/dsh-enterprise` 的 `dsh.bundle.patch` 首项
  // `../../../cordis.patch.yml` 携带 —— `resolveBundleDir` 用 `resolve.paths()` 找包，
  // **不含包自身目录**，所以 `dsh-plugin-desktop` 无法把自己解析成 bundle；企业包是
  // 这十层里第一个、且它的层本来就依赖桌面层先落地（它 patch `desktop-shell` 行）。
  '@picoaide/dsh-enterprise',
  '@picoaide/dsh-account-card',
  '@picoaide/dsh-wasm-apps',
  '@picoaide/dsh-foot-menu',
  '@picoaide/dsh-wasm-apps-host',
  '@picoaide/dsh-connectors',
  '@picoaide/dsh-browser',
  'dsh-memory-evolve',
  '@picoaide/dsh-cron',
  // 语音输入（2026-09-29 产品决策：**默认开启**）。上游从 0.1.7 起把
  // `@deepseek-ai/dsh-experimental-voice-input-bundle` 作为 `@deepseek-ai/dsh`
  // 的依赖随包分发，但默认不装配；这里把它列进桌面 profile 的 bundle 层，
  // 由它插入四条行：`speech-to-text` / `speech-to-text-sensevoice` /
  // `api-speech-to-text`（宿主）与 `ui-voice-input`（浏览器：输入框麦克风按钮）。
  //
  // 桌面侧必须同时补齐三件事，否则这一行只会在启动期抛错、或者按钮点了没反应：
  //   1. `ctx.pluginNavigation` 由 `client/voice-setup.tsx` 补位 —— 语音 UI 插件
  //      `inject` 该服务，而唯一的提供者 `ui-plugin-manager` 被我们禁用
  //      （见 `cordis.patch.yml`）；缺了它整个 client fiber 永久 pending，
  //      麦克风按钮根本不出现；
  //   2. 麦克风权限（`electron-runtime.ts` 的 permission request/check 处理器：
  //      只放行**本应用主框架**的 audio 请求；macOS 还要 usage description +
  //      `com.apple.security.device.audio-input`，见 `package.json` 的 `build.mac`）；
  //   3. 模型准备面：上游的准备/进度卡片挂在 `plugins.bundle.activation|config`
  //      槽位（属 ui-plugin-manager），我们提供自己的等价面，
  //      经 `pluginNavigation.openBundle(...)` 打开。
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
]
/** 携带桌面自身组装补丁层的 bundle（见 `REQUIRED_BUNDLES` 的说明）。 */
const DESKTOP_LAYER_CARRIER_BUNDLE = '@picoaide/dsh-enterprise'
const REQUIRED_BUNDLE_SET = new Set(REQUIRED_BUNDLES)
const OBSOLETE_DESKTOP_BUNDLE_SET = new Set(['@deepseek-ai/dsh-desktop-app'])
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
// 十个自有组装补丁层（本包的 `cordis.patch.yml` + enterprise / account-card / wasm-apps /
// foot-menu / wasm-apps-host / connectors / browser / memory-evolve / cron）**不再在这里
// 逐个解析路径**：它们是 `dsh-plugin-desktop` 这个 profile bundle 层自己的
// `dsh.bundle.patch` 列表（见 `package.json` 的 `dsh.bundle`），由上游 `loadProfileDirectory`
// 逐层读进来。理由见 `REQUIRED_BUNDLES` 上方的长注释。
//
// ⚠️ **禁用危害（2026-09-21 对抗审计，仍然有效）**：`picoaide-foot-menu` 那一行是
// **五个面板入口的唯一承载行**。渠道覆盖层或 `$DSH_HOME/cordis.patch.yml` 把它
// `disabled: true` 时不会有任何报错 —— 消费者等的服务永远不出现，于是底部功能区
// **安静地**少掉定时任务 / 能力中心 / 连接器 / 浏览器 / 应用中心。因此它进了
// `REQUIRED_DESKTOP_ROWS`（boot 后断言 ACTIVE，缺席即抛错并走桌面的致命路径）。
/** 宿主行 id：scheme / 产品名注入点（见 prepareDesktopProfile 末尾）。 */
const WASM_APPS_HOST_ROW_ID = 'pico-wasm-apps-host'
/** 浏览器行 id：应用源 scheme 注入点（导航闸门按 surface 分流要用它）。 */
const BROWSER_ROW_ID = 'pico-browser'
const DIRECTORY_PICKER_ROW_ID = 'directory-picker'
const AUTO_PICKER_PACKAGE = '@deepseek-ai/dsh-host-directory-picker-auto'
const BROWSE_PICKER_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse'
const BROWSE_PICKER_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const PWSH_SANDBOX_ROW_ID = 'pwsh-sandbox'
const UPSTREAM_PWSH_SANDBOX_PACKAGE = '@deepseek-ai/dsh-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID = 'desktop-windows-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE = 'dsh-plugin-desktop/windows-pwsh-sandbox'
const AGENT_PRESET_REGISTRY_ROW_ID = 'agent-preset-registry'
const UPSTREAM_AGENT_PRESET_REGISTRY_PACKAGE = '@deepseek-ai/dsh-agent-preset-registry'
const DESKTOP_WINDOWS_AGENT_PRESET_REGISTRY_ROW_ID = 'desktop-windows-agent-preset-registry'
const DESKTOP_WINDOWS_AGENT_PRESET_REGISTRY_PACKAGE = 'dsh-plugin-desktop/windows-agent-presets'
const DEFAULT_DESKTOP_SHELL_MODE: DesktopShellMode = 'advanced'
const DEFAULT_DESKTOP_PORT = 0
/**
 * Upstream 0.1.7 replaced the file-backed settings provider
 * (`@deepseek-ai/dsh-settings-file`, whose `FileSettingsProvider`/
 * `resolveSpec`/`Config` are gone from the registry) with the profile-backed
 * [`SettingsForms`](https://github.com/deepseek-ai/deepseek-harness) service:
 * one plugin `Config` is the storage, and a **profile entry id** is the
 * settings namespace. The `settings` row therefore names this package.
 */
const SETTINGS_PACKAGE = '@deepseek-ai/dsh-settings'
/** Profile entry id whose Config carries the desktop's own user settings. */
const DESKTOP_SHELL_ROW_ID = 'desktop-shell'
/** Legacy settings document retired by upstream 0.1.7 (imported once, then renamed). */
const LEGACY_SETTINGS_FILENAME = 'settings.yaml'
/**
 * 语音识别提供者行 id（上游 `@deepseek-ai/dsh-experimental-voice-input-bundle` 的
 * `cordis.patch.yml` 插入的四行之一）。渠道的模型部署面就注入这一行的 config。
 */
const SPEECH_SENSEVOICE_ROW_ID = 'speech-to-text-sensevoice'
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
 * @param home - 本次启动解析出的 DSH 数据根（语音识别模型的 `dataRoot` 要用它算成字面量）。
 * @returns 追加到组合结果尾部的 patch 列表。
 */
export function channelProfilePatches(
  channelProfile: DesktopChannelProfile | undefined,
  rows: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  home: string,
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
  // 语音识别模型的部署面（2026-09-29 默认开启语音之后的第一个运维缺口）：模型是
  // 运行期按需下载的 228MB 权重，走宿主 Node **直连**（客户端默认禁代理），而客户网
  // 常常"只有认证代理能出公网"——那种网络里语音永远准备不好。渠道包可以给预置目录
  // （零下载）或内网镜像（`modelOrigin`，路径仍用上游钉死的），两者都只在这行存在时注入。
  //
  // 为什么在这里重述 `dataRoot`：patch 的 `config` 是**整键替换**，而该行原本的
  // `dataRoot` 是上游 bundle 自己算的 `dshHomePath('speech-to-text','sensevoice')`
  // ——我们按同一个 home 算成字面量，漏了它这一行会因为 `dataRoot` 必填而加载失败
  // （语音整个消失）。上游给该行新增必填键时，`tests/channel-speech-patch.spec.ts`
  // 的"超集"判据会当场变红。
  const speech = channelProfile.speech
  if (rows.has(SPEECH_SENSEVOICE_ROW_ID)
    && (speech.modelDirectory !== undefined || speech.vadModelPath !== undefined || speech.modelOrigin !== undefined)) {
    out.push({
      id: SPEECH_SENSEVOICE_ROW_ID,
      config: {
        dataRoot: join(home, 'speech-to-text', 'sensevoice'),
        ...(speech.modelDirectory === undefined ? {} : { modelDirectory: speech.modelDirectory }),
        ...(speech.vadModelPath === undefined ? {} : { vadModelPath: speech.vadModelPath }),
        ...(speech.modelOrigin === undefined ? {} : { modelOrigin: speech.modelOrigin }),
      },
    })
  }
  return out
}

/**
 * 旧目录式智能体预设的**本地存储格式**常量。
 *
 * 格式权威在 `@picoaide/dsh-enterprise` 的 `agent-preset-install.ts`
 * （`resolvePresetsDir()` / `PRESET_ID_PATTERN` / `COMPOSITION_FILE` /
 * `METADATA_FILE` / `MAX_PRESET_META_LEN`）。**这里只镜像字面量、不能 import 它**：
 * enterprise 已经依赖 `dsh-plugin-desktop`（`@picoaide/dsh-enterprise` 的
 * `needs: ['dsh-plugin-desktop', …]`），反向 import 会构成**构建环**，
 * `scripts/check-workspaces.mjs` 与 `temp/wasm-client-only/cycle-check.mjs`
 * 会当场判红（"实测边不在声明表里 / 实测边有环"）。
 * 两侧一致由 `tests/legacy-agent-presets.spec.ts` 的**跨包源码对拍判据**钉住：
 * 任何一侧改了 id 形状、文件名或长度上限，那条用例必红。
 */

/** 旧预设根目录名（`<home>/.agent-presets`）。 */
export const LEGACY_PRESET_DIR_NAME = '.agent-presets'

/** 让一个目录成为预设的组合文件。 */
export const LEGACY_PRESET_COMPOSITION_FILE = 'agent.cordis.yml'

/** 可选的展示元数据文件。 */
export const LEGACY_PRESET_METADATA_FILE = 'preset.yml'

/** 预设 id 形状（同上游 `PRESET_ID` 与 enterprise 的 `PRESET_ID_PATTERN`）。 */
export const LEGACY_PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/** 展示元数据长度上限（网关拒收 >500 字符，与 enterprise 同值）。 */
export const LEGACY_PRESET_META_MAX_LENGTH = 500

/** 声明行的 Loader id 前缀：上游 0.1.7 的既有形状（`preset-standard`、`preset-cordis`…）。 */
export const LEGACY_PRESET_ROW_ID_PREFIX = 'preset-'

/** 声明行的插件包名（把一条声明注册进 `ctx.agentPresets`）。 */
export const LEGACY_PRESET_DECLARATION_PACKAGE = '@deepseek-ai/dsh-agent-preset'

/** 一条旧预设目录没能变成声明行的原因（每一种都必须可见，不许静默丢弃）。 */
export type LegacyAgentPresetProblem =
  /** `.agent-presets` 根存在但读不出来（权限/不是目录…）。 */
  | 'unreadable-presets-root'
  /** 目录名不合预设 id 形状（上游 `PRESET_ID` 与 enterprise 安装器都会拒绝它）。 */
  | 'invalid-id'
  /** 目录里没有可用的 `agent.cordis.yml`（缺失/读不出/非法 YAML/不是顶层列表）。 */
  | 'unusable-composition'
  /** `preset.yml` 存在但读不出/不是映射（声明行照插，只是没有展示元数据）。 */
  | 'invalid-metadata'
  /** `preset-<id>` 已被别的层声明（随包预设或用户在设置表单里改过的那一份）。 */
  | 'shadowed-row'
  /** 本次组合里没有可用的 `agentPresets` 提供者，声明行只会永远 PENDING。 */
  | 'no-preset-registry'

/** 一条旧预设的装配期诊断（`detail` 直接进启动日志，必须点名该预设）。 */
export interface LegacyAgentPresetDiagnostic {
  /** 目录名（或 root 自身，见 `unreadable-presets-root`）。 */
  readonly preset: string
  /** 机器可读的原因。 */
  readonly problem: LegacyAgentPresetProblem
  /** 一句话，含预设名与具体原因。 */
  readonly detail: string
}

/** 一次物化的结果：可用的声明行补丁 + 必须可见的诊断。 */
export interface LegacyAgentPresetMaterialization {
  /** 每个可用预设一条 `insert` 补丁（顺序 = 目录名字典序）。 */
  readonly patches: PatchOptions[]
  /** 诊断（空数组 = 全部目录都物化成功）。 */
  readonly diagnostics: LegacyAgentPresetDiagnostic[]
}

/**
 * 一条诊断的启动日志行（唯一实现：装配期与判据共用同一份格式，所以"点名了预设"
 * 这件事本身是可判的）。
 * @param diagnostic - 物化器给出的一条诊断。
 * @returns 一行日志。
 */
export function legacyAgentPresetLogLine(diagnostic: LegacyAgentPresetDiagnostic): string {
  return `${BIN_NAME}: legacy agent preset ${JSON.stringify(diagnostic.preset)}: ${diagnostic.detail}`
}

/** 从 `preset.yml` 读出的展示元数据（都是可选字段）。 */
interface LegacyPresetMeta {
  name?: string
  description?: string
  order?: number
}

/** 展示元数据的读取结果：值 + 必须上报的问题（可选文件缺失不算问题）。 */
interface LegacyPresetMetaRead {
  meta: LegacyPresetMeta
  problem?: string
}

/** 文本字段：非空字符串才取值（与 enterprise 的 `readPresetMeta` 同口径），并截到格式上限。 */
function legacyPresetText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.slice(0, LEGACY_PRESET_META_MAX_LENGTH)
}

/**
 * 读一个旧预设目录的展示元数据。
 *
 * `preset.yml` 是**可选**文件（上游迁移说明里它是 `name`/`description`/`order` 的来源，
 * 但不是"是不是预设"的判据 —— 那个判据只有 `agent.cordis.yml`）。缺失返回空元数据；
 * 存在但坏掉返回问题描述，调用方照插声明行、只把元数据丢掉。
 * @param dir - 预设目录。
 * @returns 元数据与可选的问题描述。
 */
function readLegacyPresetMeta(dir: string): LegacyPresetMetaRead {
  const filename = join(dir, LEGACY_PRESET_METADATA_FILE)
  let raw: string
  try {
    raw = readFileSync(filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { meta: {} }
    return { meta: {}, problem: `${LEGACY_PRESET_METADATA_FILE} could not be read: ${String(cause)}` }
  }
  if (raw.trim() === '') return { meta: {} }
  const document = parseDocument(raw, { prettyErrors: true })
  if (document.errors.length > 0) {
    return {
      meta: {},
      problem: `${LEGACY_PRESET_METADATA_FILE} is not valid YAML: ${document.errors.map(error => error.message).join('; ')}`,
    }
  }
  const value: unknown = document.toJS()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { meta: {}, problem: `${LEGACY_PRESET_METADATA_FILE} must be a map of display fields` }
  }
  const record = value as Record<string, unknown>
  const meta: LegacyPresetMeta = {}
  const name = legacyPresetText(record.name)
  if (name !== undefined) meta.name = name
  const description = legacyPresetText(record.description)
  if (description !== undefined) meta.description = description
  if (record.order !== undefined) {
    if (typeof record.order === 'number' && Number.isFinite(record.order)) {
      meta.order = record.order
    } else {
      // `order` 在上游 Config 里是 `z.number()`：非数字传进去会让整行**配置校验失败**
      // ⇒ 声明行永远不会注册到 roster（= 预设彻底消失），所以这里只丢字段、不丢预设。
      return { meta, problem: `${LEGACY_PRESET_METADATA_FILE} order must be a finite number` }
    }
  }
  return { meta }
}

/**
 * 把组合里的相对/绝对插件名锚定成**以该预设目录为基准**的 file URL。
 *
 * 为什么必须自己锚：`mountPreset` 挂载子树时的 `baseUrl` 是**声明方**（桌面 profile
 * 目录）的，相对名会去 profile 目录里找 —— 那不是旧目录式预设的语义（0.1.7 之前
 * 组合文件与它引用的东西同处一个目录）。上游给 patch list 的 `anchorInsertedPluginNames`
 * 只走 `insert` 列表，够不到这里的 entry list，所以这一步归物化器自己做。
 * @param entries - 待锚定的 entry list（原地改写，调用方刚 parse 出来的私有副本）。
 * @param dir - 该预设目录的绝对路径。
 */
function anchorPresetEntryNames(entries: EntryOptions[], dir: string): void {
  for (const entry of entries) {
    if (typeof entry.name === 'string' && (isAbsolute(entry.name) || entry.name.startsWith('./') || entry.name.startsWith('../'))) {
      entry.name = pathToFileURL(isAbsolute(entry.name) ? entry.name : resolve(dir, entry.name)).href
    }
    if (entry.group === true && Array.isArray(entry.config)) {
      anchorPresetEntryNames(entry.config as EntryOptions[], dir)
    }
  }
}

/**
 * 读一个旧预设目录的插件列表（`agent.cordis.yml`）。
 *
 * 走 `@deepseek-ai/dsh-app-boot` 的 `loadOptionalPatches`，**不是**自己再 parse 一遍：
 * 上游两种文件（`cordis.yml` 的 entry list 与 `cordis.patch.yml` 的 patch list）用的是
 * **同一个 YAML dialect**（`cordis-plugin-include` 的 `entryListSchema`，含 `!!js`
 * 表达式标量），只有 `loadOptionalPatches` 用的是那一份；而 `js-yaml` 并不是本包的
 * 依赖（`package.json` 只声明了 `yaml`），自己写 `!!js` 标签会与 Loader 的方言漂移。
 * 它顺带把相对/绝对插件名锚定成 file URL（**以该预设目录为基准**）——
 * `mountPreset` 的 `baseUrl` 是声明方的 profile 目录，拿不到这个基准。
 * @param dir - 预设目录。
 * @returns 插件列表，或一句点名的拒绝原因。
 */
function readLegacyPresetComposition(dir: string): { plugins: EntryOptions[] } | { problem: string } {
  const filename = join(dir, LEGACY_PRESET_COMPOSITION_FILE)
  let parsed: PatchOptions[] | undefined
  try {
    parsed = loadOptionalPatches(BIN_NAME, filename)
  } catch (cause) {
    return { problem: `${LEGACY_PRESET_COMPOSITION_FILE} could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
  if (parsed === undefined) return { problem: `no ${LEGACY_PRESET_COMPOSITION_FILE} in the preset directory` }
  // `PatchOptions` 与 entry list 行在运行期是同一批对象（同一个 schema、同一份 Loader
  // 条目形状）；这里的文件按契约是 entry list，所以只做一次结构性转换。
  const plugins = parsed as unknown as EntryOptions[]
  anchorPresetEntryNames(plugins, dir)
  return { plugins }
}

/**
 * 把 `$DSH_HOME/.agent-presets/<id>/` 下的旧格式预设**材料化**成 0.1.7 的声明行。
 *
 * 背景：上游 0.1.7 删掉了这条目录读取路径（`@deepseek-ai/dsh-agent-preset` 的
 * `editing-cordis-compositions` 技能逐字："Nothing reads that directory any more."），
 * 而企业「共享智能体」的安装格式**保持目录式不变**（上传/校验/落盘/归属/面板整条链路
 * 都在用它）。于是"上游会读这个目录"这层语义收回组装期：每个可用目录生成一条
 * `preset-<id>` 声明行（`id`/`name`/`description`/`order` 来自 `preset.yml`，
 * `plugins` 来自 `agent.cordis.yml` 逐字），并入交给 `boot()` 的补丁列表。
 *
 * 三条口径：
 *  1. **只解析，不执行** —— 组装期不做任何预设内容求值（`!!js` 保持为表达式节点，
 *     由 Loader 在自己的上下文中求值）；
 *  2. **不许静默丢弃** —— 每个没变成声明行的目录都带一条点名诊断（见
 *     {@link LegacyAgentPresetProblem}），`preset.yml` 坏掉不连累预设本身；
 *  3. **不制造重复行** —— `preset-<id>` 已被随包预设或用户在设置表单里的编辑声明时
 *     整条跳过（重复 Loader id 会让 `assertUniqueEntryIds` 直接抛错、整个应用起不来），
 *     而跳过是**可见的**（`shadowed-row`）且语义正确：那一层本来就该赢。
 * @param home - 本次装配的数据根（`prepareDesktopProfile` 的 `home` 入参）。
 * @param declaredRows - 已组合的行 id 集合（`prepareDesktopProfile` 的 `rows`）。
 * @returns 声明行补丁与诊断。
 */
export function materializeLegacyAgentPresets(
  home: string = resolveDshHome(),
  declaredRows: ReadonlySet<string> | ReadonlyMap<string, unknown> = new Set<string>(),
): LegacyAgentPresetMaterialization {
  const patches: PatchOptions[] = []
  const diagnostics: LegacyAgentPresetDiagnostic[] = []
  const root = join(home, LEGACY_PRESET_DIR_NAME)
  const report = (preset: string, problem: LegacyAgentPresetProblem, detail: string): void => {
    diagnostics.push({ preset, problem, detail })
  }

  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (cause) {
    // 没有这个根 = 这台机器没有装过共享智能体，是**正常**状态（不是问题）。
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { patches, diagnostics }
    report(LEGACY_PRESET_DIR_NAME, 'unreadable-presets-root', `preset root could not be listed: ${String(cause)}`)
    return { patches, diagnostics }
  }

  for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const name = entry.name
    // 点开头 = 本产品自己的东西（`installPresetArchive` 的 `.install-<id>-XXXX` staging
    // 目录、`.picoaide` 溯源标记的命名空间…）。它们不是用户预设，也不该被点名。
    if (name.startsWith('.')) continue
    // 只认目录（`statSync` 跟随符号链接：用户用软链指到别处的预设目录是合法用法，
    // 上游 `listInstalledPresets` 用 `entry.isDirectory()` 会漏掉它）。
    let isDirectory = entry.isDirectory()
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(join(root, name)).isDirectory()
      } catch (cause) {
        report(name, 'invalid-id', `preset directory could not be inspected: ${String(cause)}`)
        continue
      }
    }
    // 普通文件不是预设（既没有组合文件也不可能是目录）—— 与面板的列表面同口径。
    if (!isDirectory) continue
    if (!LEGACY_PRESET_ID_PATTERN.test(name)) {
      report(
        name,
        'invalid-id',
        `directory "${name}" is not a usable preset id (expected ${String(LEGACY_PRESET_ID_PATTERN)}); skipped`,
      )
      continue
    }
    const rowId = `${LEGACY_PRESET_ROW_ID_PREFIX}${name}`
    if (declaredRows.has(rowId)) {
      report(
        name,
        'shadowed-row',
        `loader row "${rowId}" is already declared by another layer (a shipped preset, or an edit saved from `
        + 'the settings form); that declaration stays authoritative, this directory contributes no row',
      )
      continue
    }
    const composition = readLegacyPresetComposition(join(root, name))
    if ('problem' in composition) {
      report(name, 'unusable-composition', `${composition.problem}; preset "${name}" was not declared`)
      continue
    }
    const metadata = readLegacyPresetMeta(join(root, name))
    if (metadata.problem !== undefined) {
      report(name, 'invalid-metadata', `${metadata.problem}; the preset is declared without display metadata`)
    }
    patches.push({
      insert: [{
        id: rowId,
        name: LEGACY_PRESET_DECLARATION_PACKAGE,
        config: {
          id: name,
          ...metadata.meta.order === undefined ? {} : { order: metadata.meta.order },
          ...metadata.meta.name === undefined ? {} : { name: metadata.meta.name },
          ...metadata.meta.description === undefined ? {} : { description: metadata.meta.description },
          plugins: composition.plugins,
        },
      }],
    })
  }
  return { patches, diagnostics }
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
 * Read startup settings from the composed `desktop-shell` row.
 *
 * Upstream 0.1.7 removed the file-backed settings provider: a plugin `Config`
 * inside the profile patch **is** the settings document, addressed by profile
 * entry id. The launcher must still know the port *before* boot (it binds the
 * loopback server and builds the renderer URL), so the effective value is read
 * from the already-composed profile rows — the same composition the Loader is
 * about to mount — and re-pinned onto the launcher overlay. A user edit made
 * through the settings form lands in the profile patch, is composed here on the
 * next generation, and therefore round-trips.
 *
 * A pre-0.1.7 `settings.yaml` still counts **once**, as the migration fallback:
 * upstream's `SettingsForms` imports legacy sections by entry id and retires the
 * document, and our own section id (`dsh-desktop`) is not an entry id, so its
 * values would otherwise be dropped. The profile row always wins.
 * @param row - composed `desktop-shell` row config (may be empty).
 * @param home - harness home holding a legacy `settings.yaml`, if any.
 * @returns the values projected into the startup Loader graph.
 */
export function readDesktopStartupSettings(
  row: Record<string, unknown> = {},
  home: string = resolveDshHome(),
): DesktopStartupSettings {
  if (row.port !== undefined) {
    return { mode: parseDesktopShellMode(row.mode), port: parseDesktopPort(row.port) }
  }
  return desktopStartupSettingsFromSettings(readLegacySettingsDocument(home))
}

/**
 * Parse a retired `settings.yaml` into an untrusted document, or `{}` when the
 * file is absent. Corrupt YAML stays fatal: silently defaulting a document the
 * user wrote is worse than refusing the generation.
 * @param home - harness home possibly holding the legacy document.
 * @returns the parsed document root.
 */
export function readLegacySettingsDocument(home: string = resolveDshHome()): unknown {
  const filename = join(home, LEGACY_SETTINGS_FILENAME)
  let text: string
  try {
    text = readFileSync(filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw cause
  }
  if (text.trim().length === 0) return {}
  const parsed = parseDocument(text, { prettyErrors: true })
  if (parsed.errors.length > 0) {
    throw new Error(`${BIN_NAME}: invalid settings document at ${filename}: ${parsed.errors.map(error => error.message).join('; ')}`)
  }
  return parsed.toJS() ?? {}
}

/** Read only the shell mode for one generation. */
export function readDesktopShellMode(
  row: Record<string, unknown> = {},
  home: string = resolveDshHome(),
): DesktopShellMode {
  return readDesktopStartupSettings(row, home).mode
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
  /**
   * Runtime package resolution for this generation.
   *
   * Upstream 0.1.7 removed `healProfilesModuleFallback` (the materialized
   * `profiles/node_modules` closure) in favour of an in-process interception:
   * the launcher computes this value and plugs it in **before any config-tree
   * entry mounts** (`PluginPackages`, exactly as `apps/cli/src/profile-boot.ts`
   * does). Without it the Loader cannot resolve a single bare specifier from the
   * profile directory — every plugin fails to import.
   */
  resolution: RuntimeResolution
  /** Launch-time telemetry opt-out this generation was composed with. */
  telemetryDisabledEnv: string | undefined
  /** Optional Client UI entries skipped because this profile cannot resolve them. */
  skippedOptionalEntries: SkippedOptionalEntry[]
  /**
   * 旧目录式智能体预设（`$DSH_HOME/.agent-presets/<id>/`）在本次装配里的诊断。
   *
   * 空数组 = 每个目录都物化成了声明行。非空 = 有一个目录没进 roster，`detail`
   * 点名了预设与原因（同一条也写进 stderr，见 `prepareDesktopProfile` 的说明）。
   */
  presetDiagnostics: LegacyAgentPresetDiagnostic[]
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
  // Upstream 0.1.7 folded the profile module-fallback healing into
  // `loadProfile` itself (`removeLinkProjections(dir)` + `normalizeShippedProfile`
  // run inside it); the standalone `healProfilesModuleFallback` export is gone, so
  // calling it here would only re-do — with a symbol that no longer exists — what
  // the loader already does.
  const profile = loadProfile(BIN_NAME, profileName, INSTALL_ANCHOR, home)
  const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile, home })
  const disabledBundles = pluginStatePath === undefined
    ? new Set<string>()
    : readDesktopDisabledBundles(pluginStatePath, profileName)
  const rootConfig = join(profileDir, DESKTOP_PROFILE_ROOT)
  const bareModuleBaseUrl = pathToFileURL(join(profile.dir, 'package.json')).href
  writeFileSync(rootConfig, '[]\n')

  const bundlePatches: PatchOptions[] = []
  let webAppLayerSeen = false
  let desktopLayerSeen = false
  for (const layer of activeDesktopProfileLayers(profile, disabledBundles)) {
    bundlePatches.push(...layer.patches)
    // 十层自有组装补丁来自 `dsh-plugin-desktop` 这个 **bundle 层自己的**
    // `dsh.bundle.patch` 列表（见 `package.json` 的 `dsh.bundle` 与 `REQUIRED_BUNDLES`），
    // 不再由本文件手工 push —— 手工 push 的层在 `readProfilePatches` 里复算不到，
    // 而每次设置写入都会用复算结果替换整棵树（`config-editor.edit()`）。
    if (layer.packageName === '@deepseek-ai/dsh-web-app') webAppLayerSeen = true
    if (layer.packageName === DESKTOP_LAYER_CARRIER_BUNDLE) desktopLayerSeen = true
  }
  if (!webAppLayerSeen) {
    throw new Error(`${BIN_NAME}: desktop profile is missing @deepseek-ai/dsh-web-app`)
  }
  if (!desktopLayerSeen) {
    throw new Error(
      `${BIN_NAME}: desktop profile is missing the ${DESKTOP_LAYER_CARRIER_BUNDLE} bundle layer `
      + '(its `dsh.bundle.patch` list carries the desktop launcher-owned composition layer)',
    )
  }
  // 被跳过的**必须层**是静默的（`loadProfileDirectory` 只把它们列进 `skippedBundles`）——
  // 十个自有层里任何一个解析不到/`dsh.bundle` 缺失，都会让那一层从组合里消失，而
  // `readProfilePatches` 也就复算不出来（= 设置写入把那些行从运行树上摘掉，2026-09-28 的 P0）。
  // 所以必须层一律 fail-loud。
  //
  // 范围只到**必须层**：第三方 bundle 的补丁坏掉时上游是"跳过并报告"（这是 0.1.7 的既定
  // 语义 —— 一个坏的三方 bundle 不该让整个应用起不来，见
  // `tests/desktop-plugins.spec.ts` 的坏补丁用例），那里继续由 `skippedBundles` 如实上报，
  // 不升级成致命错误。
  const skippedRequiredBundles = profile.skippedBundles
    .filter(bundle => REQUIRED_BUNDLE_SET.has(bundle.packageName))
  if (skippedRequiredBundles.length > 0) {
    throw new Error(
      `${BIN_NAME}: required profile bundles were skipped: `
      + skippedRequiredBundles.map(bundle => `${bundle.packageName} (${bundle.reason})`).join('; '),
    )
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
  if (settings?.name !== SETTINGS_PACKAGE) {
    throw new Error(`${BIN_NAME}: desktop profile must use ${SETTINGS_PACKAGE} in the settings row`)
  }
  // Upstream 0.1.7: the settings row needs no launcher config — `SettingsForms`
  // persists into the profile patch and reads the harness home from the
  // `profileContext` this launcher provides. The port still has to be known
  // before boot, so it is read from the **composed** `desktop-shell` row (the
  // profile patch the user's form edits land in) and re-pinned below.
  const desktopShellRow = rows.get(DESKTOP_SHELL_ROW_ID)
  const { port } = readDesktopStartupSettings(
    desktopShellRow === undefined ? {} : rowConfig(desktopShellRow),
    home,
  )
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
  // Agent presets (upstream 0.1.7): the declarative registry replaced the
  // directory roster. `@deepseek-ai/dsh-agent-preset-registry` provides
  // `ctx.agentPresets`, and each shipped preset is its own row
  // (`preset-<id>`, package `@deepseek-ai/dsh-agent-preset`) contributed by the
  // Web bundle's own `dsh.bundle.patch` list
  // (`@deepseek-ai/dsh-web-app` → `presets/<id>.patch.yml`). There is nothing to
  // pin here: no `roots` key exists on the new Config (an injected one would be
  // stripped), and the shipped presets no longer live on disk under the roster
  // package. Windows still swaps the registry implementation, because the
  // `minimal` preset needs a PTY the platform cannot provide.
  const presets = rows.get(AGENT_PRESET_REGISTRY_ROW_ID)
  // `agentPresets` 在本次组合里到底有没有提供者 —— 旧目录式预设的声明行只在有它时才
  // 有意义（没有它，那些行会永远停在 PENDING，而"永远 PENDING"是最难查的静默形态）。
  let presetRegistryAvailable = false
  if (presets !== undefined) {
    const config = rowConfig(presets)
    if (platform === 'win32'
      && presets.name === UPSTREAM_AGENT_PRESET_REGISTRY_PACKAGE
      && !rowDisabledOnPlatform(presets, platform)) {
      patches.push(
        {
          id: AGENT_PRESET_REGISTRY_ROW_ID,
          name: UPSTREAM_AGENT_PRESET_REGISTRY_PACKAGE,
          disabled: true,
        },
        {
          insert: [{
            id: DESKTOP_WINDOWS_AGENT_PRESET_REGISTRY_ROW_ID,
            name: DESKTOP_WINDOWS_AGENT_PRESET_REGISTRY_PACKAGE,
            config,
          }],
        },
      )
      presetRegistryAvailable = true
    } else {
      patches.push({ id: AGENT_PRESET_REGISTRY_ROW_ID, config })
      presetRegistryAvailable = presets.name === DESKTOP_WINDOWS_AGENT_PRESET_REGISTRY_PACKAGE
        || !rowDisabledOnPlatform(presets, platform)
    }
  }
  // 旧目录式智能体预设的材料化（0.1.7 收口，见 `materializeLegacyAgentPresets`）。
  // 补丁推在 `overlayStart` **之后**：它们必须落在 `overlays` 里，否则
  // `readProfilePatches`（每一次设置写入都会用它复算整棵树）看不到这些行，用户改一次
  // 设置就会把它们从运行树上摘掉（与 `REQUIRED_BUNDLES` 上方记录的那次 P0 同族）。
  const legacyPresets = materializeLegacyAgentPresets(home, rows)
  if (presetRegistryAvailable) {
    patches.push(...legacyPresets.patches)
  } else if (legacyPresets.patches.length > 0) {
    const ids = legacyPresets.patches
      .map(patch => patch.insert?.[0]?.config)
      .map(config => (typeof config === 'object' && config !== null && !Array.isArray(config)
        ? (config as { id?: unknown }).id
        : undefined))
      .filter((id): id is string => typeof id === 'string')
    legacyPresets.diagnostics.push({
      preset: LEGACY_PRESET_DIR_NAME,
      problem: 'no-preset-registry',
      detail: `this composition declares no usable ${AGENT_PRESET_REGISTRY_ROW_ID} row, so `
        + `${String(ids.length)} legacy preset director${ids.length === 1 ? 'y' : 'ies'} `
        + `[${ids.join(', ')}] contributed no declaration row`,
    })
  }
  // 诊断必须可见（不许静默丢弃）：装配期唯一的输出面就是 stderr（`main.ts` 的
  // electronLogger 在 prepare 之后才拿到 prepared）。诊断本身也随
  // `prepared.presetDiagnostics` 回给调用方，供启动日志/自检消费。
  for (const diagnostic of legacyPresets.diagnostics) {
    console.warn(legacyAgentPresetLogLine(diagnostic))
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
  const desktopShell = rows.get(DESKTOP_SHELL_ROW_ID)
  if (desktopShell === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no ${DESKTOP_SHELL_ROW_ID} row`)
  }
  // 渠道包（随包分发的 channels/<id>/channel.json）在**组装期**生效：
  // 产品名/窗口标题在登录页出现时就已经可见，服务端地址更是登录前就要用
  // （问服务端要它自己是鸡生蛋），所以两者都必须来自包内配置而非运行时下发。
  // `port` 与 `logLevel` 同为该行的 **volatile** 字段（0.1.7 起 settings 表单就是
  // profile patch 本身，条目 id = 命名空间）：先铺开已组合的用户值，再钉死本次
  // 生效的端口，其余字段（含 `logLevel`）逐字保留。
  const channelProfile = readDesktopChannelProfile()
  patches.push({
    id: DESKTOP_SHELL_ROW_ID,
    disabled: false,
    config: {
      ...rowConfig(desktopShell),
      mode,
      port,
      ...(channelProfile?.productName === undefined ? {} : { productName: channelProfile.productName }),
      ...(channelProfile?.windowTitle === undefined ? {} : { windowTitle: channelProfile.windowTitle }),
    },
  })
  patches.push(...channelProfilePatches(channelProfile, rows, home))
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
  // 随包语音模型（2026-09-29）：渠道构建可以把权重打进产物（`extraResources` →
  // `<resources>/speech-model/`），这里按**上游官方配置项**把那一行指过去
  // （`modelDirectory` + `vadModelPath`，语义就是"文件已存在 ⇒ 不下载"）。
  // 只在这两项的文件齐、大小对时注入：显式来源会**关掉**这一行的下载，指过去而文件不在
  // 就是硬故障；不注入则回落"从公网/渠道镜像下载"的既有路径（见 speech-model-bundle.ts）。
  const bundledSpeech = rows.has(SPEECH_SENSEVOICE_ROW_ID) ? resolveBundledSpeechModel() : undefined
  if (bundledSpeech !== undefined) {
    patches.push({
      id: SPEECH_SENSEVOICE_ROW_ID,
      // `config` 是整键替换：渠道那三个字段（`speech_model_dir` 等）与本项都由
      // `channelProfilePatches` 负责，两者都碰这一行时**后写者胜** —— 顺序上本项在
      // 渠道 patch 之后，所以"产物里带了载荷"优先于"渠道配了预置目录/镜像"
      // （本机装的东西比网络配置更确定；渠道要覆盖它就把 `speech_bundle_model` 关掉）。
      config: {
        dataRoot: join(home, 'speech-to-text', 'sensevoice'),
        modelDirectory: bundledSpeech.modelDirectory,
        vadModelPath: bundledSpeech.vadPath,
      },
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
    resolution,
    telemetryDisabledEnv: telemetryDisabled,
    skippedOptionalEntries,
    presetDiagnostics: legacyPresets.diagnostics,
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
 *     `loadProfile` 用的是同一个值；`plugin-manager` 的
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
