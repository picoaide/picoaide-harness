/** PicoAide Harness executable: minimal Electron bootstrap around the Host Cordis root. */

import { app, crashReporter } from 'electron'
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
import { DEFAULT_DEEP_LINK_SCHEME, OFFICIAL_PRODUCT_NAME, readDesktopChannelProfile } from './desktop-channel.ts'
import { DSH_HOME_ENV, dshHomeSafe, isSystemWorkingDirectory } from './desktop-home.ts'
import { desktopUserDataDirectoryName } from './desktop-user-data.ts'
import { desktopProductVersion, ElectronDesktopRuntime } from './electron-runtime.ts'
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
import { resolveDesktopShellEnvironment } from './shell-environment.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { installAsarSpawnRewrite } from './asar-spawn.ts'
import { DesktopPluginsService } from './desktop-plugins.ts'
import {
  DESKTOP_PROFILE_NAME,
  desktopInstallAnchor,
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

/** Report optional user UI plugins skipped to keep startup recoverable. */
function notifySkippedOptionalEntries(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  entries: readonly SkippedOptionalEntry[],
): void {
  if (entries.length === 0) return
  const names = entries.map(entry => entry.name)
  const suffix = names.length > 1 ? ` and ${names.length - 1} more` : ''
  try {
    runtime.updates.notify({
      title: 'Skipped Unavailable UI Plugin',
      body: `${names[0]} is not installed in this profile${suffix}.`,
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

/** Notify once after the UI is ready; stderr carries the exact paths. */
function notifyWindowsVolumeConcerns(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  concerns: readonly WindowsVolumeConcern[],
): void {
  if (concerns.length === 0) return
  try {
    runtime.updates.notify({
      title: 'Storage May Be Unsupported',
      body: `${concerns[0]?.label ?? 'A configured path'} is on a volume that may break sandboxed commands or plugin installs.`,
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
    logSink.writeHeader(`--- ${BIN_NAME} ${PRODUCT_NAME} ${desktopProductVersion()} ${process.platform} node ${process.version} run ${Date.now()} ---`)
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
  const homeDir = dshHomeSafe({ productDir: CHANNEL_PROFILE?.homeDir })
  process.env[DSH_HOME_ENV] = homeDir
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
    const pluginManagementStatePath = join(app.getPath('userData'), 'plugin-management', 'state.json')
    const activeProfileName = DESKTOP_PROFILE_NAME
    const prepared = await prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      homeDir,
      process.platform,
      pluginManagementStatePath,
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
    await shutdown.request(1)
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
      const path = await exportDesktopDiagnostics(app.getPath('userData'), {
        appVersion: desktopProductVersion(),
        crashDumpsDir: app.getPath('crashDumps'),
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
