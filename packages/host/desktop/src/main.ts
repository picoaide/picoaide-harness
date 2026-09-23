/** PicoAide Harness executable: minimal Electron bootstrap around the Host Cordis root. */

import { app, crashReporter, dialog, safeStorage, shell } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  type FailLoudProcess,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import {
  DEFAULT_APP_ORIGIN_SCHEME,
  DEFAULT_DEEP_LINK_SCHEME,
  OFFICIAL_PRODUCT_NAME,
  readDesktopChannelProfile,
} from './desktop-channel.ts'
// 网络出口策略（2026-09-22）：客户端**默认禁止使用任何代理**。Chromium 的开关必须在
// `app.whenReady()` 之前 append，所以在模块作用域接线（与 APP_ORIGIN_SCHEME 同理）。
import {
  applySystemProxyPolicy,
  enforceDirectNodeTransport,
  lateAllowSystemProxyWarning,
  resolveSystemProxyPolicy,
  stripProxyEnvironment,
} from './network-policy.ts'
// 客户端专属 WASM 应用 origin：协议特权注册（whenReady 之前）+ 交给插件的
// Electron 适配器。子路径 `electron-adapter` 是唯一静态 import electron 的模块，
// 插件主体（`@picoaide/dsh-wasm-apps-host`）保持纯 Node 可加载。
import { createRealElectronAdapter, createRealElectronWindowAdapter, registerAppScheme } from '@picoaide/dsh-wasm-apps-host/electron-adapter'
import {
  WASM_APPS_HOST_ADAPTER_SERVICE,
  WASM_APPS_INSTALL_KEY_SERVICE,
} from '@picoaide/dsh-wasm-apps-host'
import { createInstallKeyStore } from '@picoaide/dsh-wasm-apps-host/app-proof'
import { provideAppAiRunner } from './app-ai-runner.ts'
import { assertRequiredRowsActive } from './startup-rows.ts'
import { reportFatalBootFailure, type FatalBootChoice } from './fatal-boot.ts'
import { provideWasmAppsWindows } from './wasm-apps-windows.ts'
import { applyInstallDshHome, isSystemWorkingDirectory } from './desktop-home.ts'
import { desktopUserDataDirectoryName } from './desktop-user-data.ts'
import { desktopProductVersion, ElectronDesktopRuntime } from './electron-runtime.ts'
import { desktopStartupCopy } from './tray-locale.ts'
import { hostCopy } from './host-locale.ts'
import {
  ElectronStderrLogger,
  installDesktopChildProcessLogging,
  installDesktopUncaughtExceptionLogging,
  type DesktopLogger,
} from './desktop-logger.ts'
import {
  beginDesktopRun,
  startDesktopCrashReporting,
  type DesktopRun,
} from './crash-evidence.ts'
import { exportDesktopDiagnostics } from './diagnostic-export.ts'
import { FileExporter } from './file-exporter.ts'
import { DESKTOP_SETTINGS_NAMESPACE, type DesktopSettings } from './index.ts'
import { LogFileSink } from './log-files.ts'
import { maskSecrets } from './mask-secrets.ts'
import { reclaimOrphanedDocumentLocks, documentLockRecoveryLogLines } from './document-lock-recovery.ts'
import { resolveDesktopShellEnvironment } from './shell-environment.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { installAsarSpawnRewrite } from './asar-spawn.ts'
import { DesktopPluginsService } from './desktop-plugins.ts'
import {
  DESKTOP_PROFILE_NAME,
  desktopInstallAnchor,
  desktopProfileContext,
  prepareDesktopProfile,
  type SkippedOptionalEntry,
} from './profile.ts'
import {
  createDesktopExitCoordinator,
  createDesktopShutdown,
  installShutdownRequests,
  type DesktopShutdown,
} from './shutdown.ts'
import {
  diagnoseWindowsVolumes,
  formatWindowsVolumeConcern,
  type WindowsVolumeConcern,
} from './windows-volume-diagnostics.ts'

const BIN_NAME = 'dsh-plugin-desktop'
/**
 * 致命启动对话框里显示的堆栈上限（字符）。
 *
 * 原生错误面的详情区不是日志文件：几百 KB 的堆栈既看不完也读不出来，
 * 完整内容始终在 `<userData>/logs`（对话框里给的就是这个目录）。
 */
const MAX_FATAL_BOOT_REASON_CHARS = 1_500
/**
 * 随包分发的渠道包（`build/channel.json`），**读一次**给下面几个常量共用。
 *
 * 官方构建（以及本地开发）没有这个文件 → undefined，所有取值回落官方默认，
 * 行为与渠道化改造前逐字节一致；渠道构建由 CI 保证它存在（`ci-channels.sh`
 * 硬性校验品牌字段，`verify-channel-package.ts` 校验它真的进了 asar）。
 */
const CHANNEL_PROFILE = readDesktopChannelProfile()

/**
 * 应用名（通知发送者、日志头）。
 *
 * 渠道构建读渠道包的 `desktop.product_name`；缺失时回落厂商名。渠道化打包时
 * electron-builder 的 `--config.productName` 也必须给同一个值（见
 * scripts/channel-build.ts），否则安装后的应用名与运行时的 `app.setName` 会打架。
 */
const PRODUCT_NAME = CHANNEL_PROFILE?.productName ?? OFFICIAL_PRODUCT_NAME

/**
 * 本安装的深链 scheme(OIDC/OpenID 浏览器回调把 token 交回客户端用的那个)。
 *
 * 由渠道包决定:浏览器在跳回客户端时会弹"打开 <scheme>?"的确认框,渠道客户
 * 不该在这里看到厂商名。官方构建未配置时回落 `picoaide` —— 行为不变。
 * **必须与 electron-builder 的 `protocols`(scripts/channel-build.ts)以及
 * 服务端 OIDC 回调拼出的 scheme 三者一致**,否则浏览器回调打不开客户端。
 */
const DEEP_LINK_SCHEME = CHANNEL_PROFILE?.deepLinkScheme ?? DEFAULT_DEEP_LINK_SCHEME

/**
 * 应用源 scheme（渠道包 `desktop.app_origin_scheme`，§10）。
 *
 * **必须在模块作用域取值**（§7.2/CLI-8 冻结）：`registerSchemesAsPrivileged` 是
 * 启动期 API，只能早于 `app.whenReady()` 调用，而插件的 Config 要到 apply 期才可见
 * —— 从 Config 取值在结构上就晚了。渠道包缺失/字段非法时 `readDesktopChannelProfile`
 * 已经 fail-loud（`AppOriginSchemeError`），这里只会拿到"官方缺省"或合法渠道值。
 */
const APP_ORIGIN_SCHEME = CHANNEL_PROFILE?.appOriginScheme ?? DEFAULT_APP_ORIGIN_SCHEME

/**
 * 出口策略（2026-09-22 定案，见 `network-policy.ts` 与
 * `docs/decisions/2026-09-22-client-system-proxy-ban.md`）：**默认禁止使用任何代理**。
 *
 * **必须在模块作用域**：`app.commandLine.appendSwitch('no-proxy-server')` 只能在
 * `app.whenReady()` 之前生效，晚一行就静默无效（Chromium 已经读过代理配置）。
 * 覆盖面是**全部** session：默认 session（gatewayFetch / net.fetch / 渲染进程）、
 * 内置浏览器分区、WASM 应用窗口 —— 逐 session `setProxy` 会漏掉后建分区（实测）。
 *
 * 取值来源：`PICOAI_ALLOW_SYSTEM_PROXY`（真实进程环境，排障）> 渠道包
 * `desktop.allow_system_proxy`（部署）> 默认禁止。
 */
const SYSTEM_PROXY_POLICY = resolveSystemProxyPolicy(process.env, CHANNEL_PROFILE)
applySystemProxyPolicy(app.commandLine, SYSTEM_PROXY_POLICY)

/** Report optional user UI plugins skipped to keep startup recoverable. */
function notifySkippedOptionalEntries(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  entries: readonly SkippedOptionalEntry[],
): void {
  if (entries.length === 0) return
  const names = entries.map(entry => entry.name)
  const copy = desktopStartupCopy(runtime.locale)
  const suffix = names.length > 1
    ? hostCopy(runtime.locale, ` 等 ${names.length - 1} 个`, ` and ${names.length - 1} more`)
    : ''
  try {
    runtime.updates.notify({
      title: copy.skippedPluginTitle,
      body: copy.skippedPluginBody(names[0] ?? '', suffix),
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show skipped plugin notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Surface path/volume risks that otherwise become obscure sandbox or pnpm failures later. */
function warnWindowsVolumeConcerns(logger: DesktopLogger, concerns: readonly WindowsVolumeConcern[]): void {
  for (const concern of concerns) {
    logger.error(`${BIN_NAME}: Windows volume warning: ${formatWindowsVolumeConcern(concern)}`)
  }
}

/**
 * B-02（2026-09-23 审计 P1）：致命启动失败的**用户可见出口**。
 *
 * 打包 GUI（Windows 双击 / macOS 启动台）没有 stderr 接收方，也没有任何窗口；
 * 只 `errorCause` + `exit 1` 等于"双击之后什么都没有"。这里把那次失败变成一个
 * 原生错误面（打开日志 / 重试 / 退出），文案与日志路径同源（`tray-locale.ts`
 * 的 `desktopStartupCopy` + `<userData>/logs`）。
 *
 * 详情先过 `maskSecrets`：错误串里可能出现带凭据的 URL（启动期的服务端地址、
 * 渠道配置），原生弹窗是渠道客户可见面，不能比日志更"诚实"。
 * @param cause - the failure that aborted startup.
 * @param runtime - mounted runtime (product name + active locale).
 * @param logger - stderr/file sink used when the native surface is unavailable.
 * @returns the user's exit: relaunch the process, or quit non-zero.
 */
async function reportFatalStartupFailure(
  cause: unknown,
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
): Promise<FatalBootChoice> {
  const copy = desktopStartupCopy(runtime.locale)
  const product = runtime.productName
  const logDirectory = join(app.getPath('userData'), 'logs')
  const reason = maskSecrets(
    cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
  ).slice(0, MAX_FATAL_BOOT_REASON_CHARS)
  return await reportFatalBootFailure(
    {
      showMessageBoxSync: options => dialog.showMessageBoxSync(options),
      showErrorBox: (title, content) => { dialog.showErrorBox(title, content) },
      openPath: async path => await shell.openPath(path),
    },
    {
      copy: {
        title: copy.fatalBootTitle(product),
        message: copy.fatalBootMessage(product),
        detail: copy.fatalBootDetail(reason, logDirectory),
        openLogs: copy.fatalBootOpenLogs,
        retry: copy.fatalBootRetry,
        quit: copy.fatalBootQuit,
      },
      logDirectory,
      log: message => { logger.error(message) },
    },
  )
}

/** Notify once after the UI is ready; stderr carries the exact paths. */
function notifyWindowsVolumeConcerns(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  concerns: readonly WindowsVolumeConcern[],
): void {
  if (concerns.length === 0) return
  try {
    const copy = desktopStartupCopy(runtime.locale)
    const label = concerns[0]?.label ?? hostCopy(runtime.locale, '配置的路径', 'A configured path')
    runtime.updates.notify({
      title: copy.volumeTitle,
      body: copy.volumeBody(label),
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show Windows volume warning: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Start one Electron process and leave lifetime to the mounted desktop plugin. */
async function start(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let current: Context | undefined
  let shutdown: DesktopShutdown | undefined
  let removeShutdownRequests: (() => void) | undefined
  let removeUncaughtExceptionLogging: (() => void) | undefined
  let removeChildProcessLogging: (() => void) | undefined
  let fileExporter: FileExporter | undefined
  let runtime!: ElectronDesktopRuntime
  let logSink: LogFileSink | undefined
  try {
    logSink = new LogFileSink(join(app.getPath('userData'), 'logs'), {
      maxFileBytes: 10 * 1024 * 1024,
      maxDirectoryBytes: 200 * 1024 * 1024,
    })
    logSink.enforceDirectoryCap()
    logSink.purgeOlderThan(7)
    logSink.writeHeader(`--- ${BIN_NAME} ${PRODUCT_NAME} ${desktopProductVersion()} ${process.platform} node ${process.version} proxy ${SYSTEM_PROXY_POLICY.allow ? 'system' : 'direct'}/${SYSTEM_PROXY_POLICY.source} run ${Date.now()} ---`)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    process.stderr.write(`${BIN_NAME}: file logging unavailable: ${maskSecrets(detail)}\n`)
    logSink = undefined
  }
  const electronLogger = new ElectronStderrLogger(logSink)
  try {
    startDesktopCrashReporting(crashReporter, {
      productName: PRODUCT_NAME,
      version: desktopProductVersion(),
      platform: process.platform,
      arch: process.arch,
    })
  } catch (cause) {
    electronLogger.error(`${BIN_NAME}: local crash reporting unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  let desktopRun: DesktopRun | undefined
  try {
    desktopRun = beginDesktopRun(
      join(app.getPath('userData'), 'crash-evidence', 'active-run.json'),
      {
        startedAt: new Date().toISOString(),
        pid: process.pid,
        version: desktopProductVersion(),
      },
    )
    const previousRun = desktopRun.previousRun
    if (previousRun !== undefined) {
      electronLogger.error('unreadable' in previousRun
        ? `${BIN_NAME}: previous desktop run did not shut down cleanly (active run marker unreadable)`
        : `${BIN_NAME}: previous desktop run did not shut down cleanly (startedAt: ${previousRun.startedAt}, pid: ${String(previousRun.pid)}, version: ${previousRun.version})`)
    }
  } catch (cause) {
    electronLogger.error(`${BIN_NAME}: active run tracking unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  removeChildProcessLogging = installDesktopChildProcessLogging(app, electronLogger)
  // 客户端专属 WASM 应用 origin（`picoaide-app://`）：协议特权注册是**启动期**
  // API，必须在 `app.whenReady()` 之前执行（晚于 ready 会静默无效/抛错），所以
  // 它在装配层接线，而不是由插件自己在 apply 里做。权限位与实测约束见契约
  // `docs/decisions/2026-09-19-wasm-client-internal-origin.md` §2/§3。
  registerAppScheme(APP_ORIGIN_SCHEME)
  const nativeExit = createDesktopExitCoordinator(
    {
      prepareToQuit: () => { runtime.prepareToQuit() },
      relaunch: () => { app.relaunch() },
      exit: code => { app.exit(code) },
    },
    () => {
      removeShutdownRequests?.()
      removeUncaughtExceptionLogging?.()
      removeChildProcessLogging?.()
      try {
        desktopRun?.markClean()
      } catch (cause) {
        electronLogger.error(`${BIN_NAME}: failed to clear active run marker: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    },
  )
  let restartRequested = false
  runtime = new ElectronDesktopRuntime(async () => {
    if (shutdown === undefined) {
      throw new Error('dsh-plugin-desktop: shutdown coordinator is not ready')
    }
    if (restartRequested) return
    restartRequested = true
    nativeExit.requestRelaunch()
    await shutdown.request(0)
  }, () => {}, electronLogger, DEEP_LINK_SCHEME)
  const finalExit = (code: number): void => { nativeExit.finish(code) }
  shutdown = createDesktopShutdown(
    async () => {
      await current?.fiber.dispose()
    },
    finalExit,
  )
  const requestQuit = (code: number): void => { void shutdown.request(code) }
  removeUncaughtExceptionLogging = installDesktopUncaughtExceptionLogging(
    process,
    electronLogger,
    requestQuit,
  )
  removeShutdownRequests = installShutdownRequests(process, app, requestQuit)

  app.on('second-instance', (_event, argv) => {
    runtime.show()
    // Windows/Linux: the second instance carries the deep link in argv.
    for (const arg of argv) {
      if (arg.startsWith(`${DEEP_LINK_SCHEME}://`)) runtime.receiveDeepLink(arg)
    }
  })
  // macOS: deep links are delivered through open-url (may fire before ready).
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (url.startsWith(`${DEEP_LINK_SCHEME}://`)) runtime.receiveDeepLink(url)
  })
  await app.whenReady()
  // Protocol registration: deep links open (or focus) the app.
  // Best-effort — Linux needs a packaged .desktop entry, dev builds hint only.
  try {
    if (process.platform === 'darwin') {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
    } else if (process.platform === 'win32') {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [])
    } else {
      // Linux: the packaged AppImage/deb registers via electron-builder
      // `protocols`; attempting setAsDefaultProtocolClient without a desktop
      // entry is a no-op — register only when packaged with argv hints.
      if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [])
    }
  } catch (cause) {
    electronLogger.error(`${BIN_NAME}: protocol registration failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  // Cold-start argv may already carry a deep link (launched from a browser).
  for (const arg of process.argv) {
    if (arg.startsWith(`${DEEP_LINK_SCHEME}://`)) runtime.receiveDeepLink(arg)
  }
  // Windows 的 AppUserModelId 决定通知身份(不弹/不归组多半是这里对不上快捷方式)。
  // 渠道构建必须用渠道自己的 app_id —— electron-builder 写进快捷方式的就是它,
  // 硬编码厂商值会让渠道客户端的通知在 Windows 上认不出自己。
  if (process.platform === 'win32') app.setAppUserModelId(CHANNEL_PROFILE?.appId ?? 'ai.deepseek.dsh.desktop')
  // P2-34: a packaged app must never keep a filesystem root or a system
  // directory as its working directory (desktop-entry `Path=`, a shortcut with
  // a wrong "start in", a service manager). The old `=== '/'` check only saw
  // the POSIX root, so `C:\`, `C:\Windows` and Program Files slipped through
  // and relative product files landed there.
  if (app.isPackaged && isSystemWorkingDirectory(process.cwd())) process.chdir(app.getPath('home'))
  const shellEnvironmentResolution = await resolveDesktopShellEnvironment({
    environment: process.env,
    home: app.getPath('home'),
    isPackaged: app.isPackaged,
    platform: process.platform,
  })
  for (const [name, value] of Object.entries(shellEnvironmentResolution.updates)) process.env[name] = value
  // Product-owned home — 官方 `~/.picoaide-harness`，渠道客户端用**自己的**
  // 目录（渠道包 `desktop.home_dir`，见 desktop-home.ts 的 channelDshHomeDir）；
  // 除非 DSH_HOME 被显式设置（e2e/便携安装，优先级最高）。写回环境变量让所有
  // 下游消费者（子进程、读 DSH_HOME 的兄弟插件）落在同一个位置。
  // P2-33: use the GUARDED entry point — an injected DSH_HOME pointing at a
  // system directory must abort startup (the surrounding try/catch logs it and
  // exits 1) instead of silently writing user data there. This is the same
  // `isSafeDshHome` check the enterprise installers enforce.
  const homeDir = applyInstallDshHome({ productDir: CHANNEL_PROFILE?.homeDir })
  // 孤儿写锁回收：上游的文档写锁只在 `finally` 里自删，任何一次"建锁后崩溃"都会留下
  // 永久孤儿锁，此后该文档的写入静默失败（现场事故：settings 写不进 protocol ⇒ 每个
  // 模型请求 401「缺少认证令牌」）。**必须在这里**——`prepareDesktopProfile`/`boot`
  // 之后本进程就是写入者，那时删任何锁都会撞上真实写入。
  // 注意单实例锁**不足**以保证"同一数据根只有一个实例"：渠道包可以共用数据根（beta
  // 就共用官方目录），而单实例锁在按渠道分流的 userData 里。所以每条删除判据都自带
  // 证据（本进程 PID / ESRCH / 年龄门槛），完整口径见模块头注释。
  try {
    const recovery = reclaimOrphanedDocumentLocks({ home: homeDir })
    for (const line of documentLockRecoveryLogLines(recovery)) electronLogger.error(`${BIN_NAME}: ${line}`)
  } catch (cause) {
    // 回收是启动卫生，不是启动前提：任何意外都只上报，绝不阻断启动。
    electronLogger.error(`${BIN_NAME}: document lock recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const windowsVolumeConcerns = diagnoseWindowsVolumes(process.platform, [
    { label: 'application install', path: process.execPath },
    { label: 'desktop user data', path: app.getPath('userData') },
    { label: 'DSH home', path: homeDir },
  ])
  warnWindowsVolumeConcerns(electronLogger, windowsVolumeConcerns)

  const failLoudProcess: FailLoudProcess = {
    on: (event, handler) => process.on(event, handler),
    off: (event, handler) => process.off(event, handler),
    stderr: electronLogger,
    exit: finalExit,
  }
  installFailLoud(BIN_NAME, failLoudProcess, async () => {
    await current?.fiber.dispose()
  })

  try {
    const environment = loadLayeredEnv(BIN_NAME, process.cwd())
    // 出口策略的第二刀（第一刀是模块作用域的 no-proxy-server，只管 Chromium）：
    //  · Node 栈：宿主机若显式设了 NODE_USE_ENV_PROXY，Node 在**启动时**就装好了
    //    走代理的全局 dispatcher —— 事后删环境变量无效，只能换成直连 Agent；
    //  · 子进程：agent 的 curl/git/MCP stdio 由 scrubbedParentEnv() 从 process.env
    //    派生，删掉代理名它们才真正直连。放在 loadLayeredEnv 之后，连 home `.env`
    //    注入的代理名一起清掉。
    // 判定用**删除前**的环境（NODE_USE_ENV_PROXY 本身马上就要被删掉）。
    if (!SYSTEM_PROXY_POLICY.allow) {
      const transport = await enforceDirectNodeTransport(process.env)
      if (transport === 'swapped') {
        electronLogger.error(`${BIN_NAME}: replaced the environment proxy dispatcher with a direct one (NODE_USE_ENV_PROXY was set)`)
      } else if (transport === 'unavailable') {
        electronLogger.error(`${BIN_NAME}: NODE_USE_ENV_PROXY is set but undici is unavailable; Node-side requests may still use the environment proxy`)
      }
      const late = lateAllowSystemProxyWarning(process.env, SYSTEM_PROXY_POLICY)
      if (late !== undefined) electronLogger.error(`${BIN_NAME}: ${late}`)
      const cleared = stripProxyEnvironment(process.env)
      if (cleared.length > 0) {
        electronLogger.error(`${BIN_NAME}: cleared proxy environment for this run (${cleared.join(', ')})`)
      }
    } else {
      electronLogger.error(`${BIN_NAME}: system proxy use is enabled by ${SYSTEM_PROXY_POLICY.source}; host proxy settings apply to every request`)
    }
    const pluginManagementStatePath = join(app.getPath('userData'), 'plugin-management', 'state.json')
    const activeProfileName = DESKTOP_PROFILE_NAME
    const prepared = await prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      homeDir,
      process.platform,
      pluginManagementStatePath,
      // 应用窗口的几何记忆与缓存落点（§16.1：`<userData>/wasm-apps-windows.json`）。
      // 必须显式注入：插件在纯 Node 宿主里无从得知 userData，缺席时窗口管理器
      // **整个不构造**（`index.ts` 的 `userDataDir === undefined` 分支）。
      app.getPath('userData'),
    )
    const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
    // Electron does not patch `child_process.spawn`/`spawnSync` for asar paths
    // (only `execFile`), while the harness process seam and the sandbox probe
    // spawn packaged binaries through `spawn`. Rewrite virtual `app.asar`
    // executables to their physical `app.asar.unpacked` twins before any
    // plugin module loads its `node:child_process` binding.
    const removeAsarSpawnRewrite = installAsarSpawnRewrite()
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      async (hostCtx) => {
        current = hostCtx
        hostCtx.effect(
          () => releasePackageResolver,
          'dsh-plugin-desktop: profile package resolution',
        )
        hostCtx.effect(
          () => removeAsarSpawnRewrite,
          'dsh-plugin-desktop: asar spawn path rewrite',
        )
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.provide('desktopRuntime', runtime)
        // profile 自述（issue #130，P0）：上游 base bundle 的 `plugin-manager` 行由
        // `disabled: !!js "!ctx.get('profileContext')"` 开关控制，不 provide 就会被
        // **静默** disable ⇒ `pluginManager` 服务不存在 ⇒ `cordis` preset 的行
        // `tool-plugin-manager` 永远等不到服务 ⇒ 界面上的「创造模式」全部挂不起来。
        // 构造只允许一处（`lib/profile.js` 的 desktopProfileContext，与
        // `scripts/verify-profile-boot.mjs` 共用同一个函数）—— 在本文件里内联一个字面量
        // 对象，就会让 CI 冒烟测的不是生产路径。
        //
        // ⚠️ 成对约束：provide 之后上游 `hmr` 行也会跟着激活，而它要求 `appReady`
        // （只有 cmdline 会 provide，桌面不走 cmdline）⇒ 整棵树加载失败。所以
        // `cordis.patch.yml` 里显式关闭了 `hmr` 行，两处必须一起改。
        hostCtx.provide('profileContext', desktopProfileContext(prepared))
        // 协议 handler 的实际注册面（默认 session + 每个浏览器分区）经这个适配器
        // 交给插件：`provide` 发生在 boot 的 prepare 回调里，**早于** profile 树的
        // 任何插件 apply（dsh-app-boot 的 boot(): prepare → mountRootInclude）。
        hostCtx.provide(WASM_APPS_HOST_ADAPTER_SERVICE, createRealElectronAdapter())
        // 应用窗口载体（§16.1 W-C「独立窗口」）：没有它，"打开应用"只会广播一个
        // 零消费者的事件然后回 `opened` —— 现象就是"点打开什么都没发生"。
        // scheme 与特权注册同源（`APP_ORIGIN_SCHEME`，模块作用域的渠道值）：
        // 导航闸门按它判"同 app origin"，传错即每个导航都被拒。
        provideWasmAppsWindows(
          hostCtx,
          createRealElectronWindowAdapter({
            appScheme: APP_ORIGIN_SCHEME,
            // 窗口诊断（拒绝导航/window.open、加载失败）走桌面日志：这类事件在
            // 真机上只有日志能看见（渲染进程看不到宿主侧的原生拒绝）。
            warn: message => { electronLogger.error(message) },
          }),
        )
        // 安装密钥仓库（§23.1）：私钥进 OS 钥匙串（`safeStorage`），无钥匙串时
        // 0600 明文 + 启动 warn（认账 §17）。proof 本身**不落盘**，只有这对密钥落盘。
        hostCtx.provide(
          WASM_APPS_INSTALL_KEY_SERVICE,
          createInstallKeyStore({ dir: app.getPath('userData'), safeStorage }),
        )
        // 应用 AI 的执行面（§21.2 步骤③）：在本机协议 handler 的隐藏会话
        // （`app:<app_id>`）上跑一轮 `ctx.agentLoop`。这里只 `provide` 一个**惰性**
        // 对象 —— 它内部的 `ctx.get('agents')`/`agentLoop` 在每一轮开始时才解析
        // （`provide` 发生在 profile 树挂载之前，那一刻 agent 平面还不存在）。
        //
        // 接线本身在 `./app-ai-runner.ts` 的 `provideAppAiRunner` 里（**可测**）：
        // 2026-09-20 独立复核指出"内联在这里 ⇒ 删掉 provide 全绿、生产静默 503"，
        // 抽出来后由 `tests/app-ai-runner.spec.ts` 用真实 `Context` 断言
        // `ctx.get(WASM_APPS_AI_RUNNER_SERVICE)` 确实拿得到 runner。
        provideAppAiRunner(hostCtx, {
          // 隐藏会话的 `cwd` 元数据：persona 模板的 `{{cwd}}` 需要有值（AI 没有
          // 文件面，这个路径只落在会话头上）。用 userData 而不是任何工作区 ——
          // 隐藏会话不隶属任何用户项目目录。
          cwd: app.getPath('userData'),
        })
        await hostCtx.plugin(DesktopPluginsService, {
          profileName: activeProfileName,
          homeDir,
          statePath: pluginManagementStatePath,
          installAnchor: desktopInstallAnchor(),
        })
        if (logSink !== undefined) {
          fileExporter = new FileExporter(logSink)
          hostCtx.logger.exporter(fileExporter)
        }
        provideCmdline(hostCtx, {
          args: ['--host', '127.0.0.1', '--port', String(prepared.port)],
          exit: requestQuit,
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch((cause: unknown) => {
      releasePackageResolver()
      throw cause
    })
    current = ctx
    // 上游 auditStartupEntries 只对 7 个全局 required id 抛错，我方 19 个行失败
    // 只 warn（Windows GUI 无 stderr ⇒ 彻底静默）。这里补上我方必需行的激活断言，
    // 失败走桌面自己的致命路径。见 src/startup-rows.ts 的模块注释。
    assertRequiredRowsActive(ctx)
    fileExporter?.setThreshold((ctx.settings.get(DESKTOP_SETTINGS_NAMESPACE) as DesktopSettings | undefined)?.logLevel ?? 'info')
    ctx.on('settings/updated', (namespace, next) => {
      if (namespace !== DESKTOP_SETTINGS_NAMESPACE) return
      fileExporter?.setThreshold((next as DesktopSettings).logLevel)
    })
    await runtime.mountScheduled()
    notifySkippedOptionalEntries(runtime, electronLogger, prepared.skippedOptionalEntries)
    notifyWindowsVolumeConcerns(runtime, electronLogger, windowsVolumeConcerns)
  } catch (cause) {
    electronLogger.errorCause(cause)
    // B-02（2026-09-23 审计 P1）：这里**必须**有用户可见出口。此前只有
    // `errorCause` + `shutdown.request(1)`，而 `startup-rows.ts` 的注释一直自称
    // 致命路径会走"`electronLogger.errorCause` + 恢复对话框"——注释与实现不一致，
    // 打包 GUI 上"必要行没激活 / 数据根不可写 / YAML 解析失败"全都表现为
    // 双击之后什么都没有。
    // 现在弹原生错误面，并保证退出语义只有两种：用户选「重试」→ 走既有的
    // relaunch 通道（`createDesktopExitCoordinator` 只在 code 0 时真重启）；其余
    // 一律非零码退出 —— 绝不静默退出，绝不以 0 码假装成功。
    const action = await reportFatalStartupFailure(cause, runtime, electronLogger)
    if (action === 'retry') nativeExit.requestRelaunch()
    await shutdown.request(action === 'retry' ? 0 : 1)
  }
}

async function run(): Promise<void> {
  app.setName(PRODUCT_NAME)
  // 第二份"随渠道"的数据根（第一份是 Harness home）：日志、更新状态、插件管理
  // 状态、崩溃取证与 **Electron 单实例锁** 都落在 userData 里；`setName` 只在
  // 产品名与官方不同时才天然分流（beta 复用官方品牌 → 会与 official 撞在同一
  // 个目录并互相顶掉启动），所以这里显式 setPath。必须在 app ready 之前设置
  // （后面第一次 getPath('userData') 就在 start() 里）。
  app.setPath(
    'userData',
    join(app.getPath('appData'), desktopUserDataDirectoryName(PRODUCT_NAME, CHANNEL_PROFILE?.channelId)),
  )
  if (process.argv.includes('--export-diagnostics')) {
    try {
      await app.whenReady()
      // desktop-3: 早退分支不经过 start(),数据根必须在这里按**同一口径**确定
      // (渠道包 → 渠道目录)并写回 DSH_HOME;否则支持包里的 session-inventory
      // 会走官方数据根,把另一套安装的会话 id/项目目录名带给厂商。
      const homeDir = applyInstallDshHome({ productDir: CHANNEL_PROFILE?.homeDir })
      const path = await exportDesktopDiagnostics(app.getPath('userData'), {
        appVersion: desktopProductVersion(),
        crashDumpsDir: app.getPath('crashDumps'),
        installHomeDir: homeDir,
      })
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${path}\n`, error => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      })
      app.exit(0)
    } catch (cause) {
      const message = `dsh-plugin-desktop: failed to export diagnostics: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`
      await new Promise<void>(resolve => {
        process.stderr.write(message, () => { resolve() })
      })
      app.exit(1)
    }
    return
  }
  await start()
}

void run()
