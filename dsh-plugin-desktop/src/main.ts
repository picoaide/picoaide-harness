/** DSH Desktop executable: minimal Electron bootstrap around the Host Cordis root. */

import { app } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  type FailLoudProcess,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { ElectronDesktopRuntime } from './electron-runtime.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { prepareDesktopProfile } from './profile.ts'
import {
  createDesktopExitCoordinator,
  createDesktopShutdown,
  installShutdownRequests,
  type DesktopShutdown,
} from './shutdown.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const PRODUCT_NAME = 'DSH Desktop'

/** Start one Electron process and leave lifetime to the mounted desktop plugin. */
async function start(): Promise<void> {
  app.setName(PRODUCT_NAME)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let current: Context | undefined
  let shutdown: DesktopShutdown | undefined
  let removeShutdownRequests: (() => void) | undefined
  let runtime!: ElectronDesktopRuntime
  const nativeExit = createDesktopExitCoordinator(
    {
      prepareToQuit: () => { runtime.prepareToQuit() },
      relaunch: () => { app.relaunch() },
      exit: code => { app.exit(code) },
    },
    () => { removeShutdownRequests?.() },
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
  })
  const finalExit = (code: number): void => { nativeExit.finish(code) }
  shutdown = createDesktopShutdown(
    async () => { await current?.fiber.dispose() },
    finalExit,
  )
  const requestQuit = (code: number): void => { void shutdown.request(code) }
  removeShutdownRequests = installShutdownRequests(process, app, requestQuit)

  app.on('second-instance', () => { runtime.show() })
  await app.whenReady()
  if (process.platform === 'win32') app.setAppUserModelId('ai.deepseek.dsh.desktop')
  if (app.isPackaged && process.cwd() === '/') process.chdir(app.getPath('home'))

  const failLoudProcess: FailLoudProcess = {
    on: (event, handler) => process.on(event, handler),
    off: (event, handler) => process.off(event, handler),
    stderr: process.stderr,
    exit: finalExit,
  }
  installFailLoud(BIN_NAME, failLoudProcess, async () => {
    await current?.fiber.dispose()
  })

  try {
    const environment = loadLayeredEnv(BIN_NAME, process.cwd())
    const prepared = prepareDesktopProfile()
    runtime.configureTerminal({
      profileName: 'desktop',
      profileDir: prepared.profile.dir,
      homeDir: prepared.homeDir,
    })
    const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      (hostCtx) => {
        current = hostCtx
        hostCtx.effect(
          () => releasePackageResolver,
          'dsh-plugin-desktop: profile package resolution',
        )
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.provide('desktopRuntime', runtime)
        provideCmdline(hostCtx, {
          args: ['--host', '127.0.0.1', '--port', '0'],
          exit: requestQuit,
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch((cause: unknown) => {
      releasePackageResolver()
      throw cause
    })
    current = ctx
    await runtime.mountScheduled()
  } catch (cause) {
    process.stderr.write(`${BIN_NAME}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    await shutdown.request(1)
  }
}

void start()
