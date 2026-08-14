import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'

const electron = vi.hoisted(() => {
  const browserWindowOptions: unknown[] = []
  const browserWindows: BrowserWindow[] = []
  const browserWindowOn = vi.fn()
  const browserWindowOff = vi.fn()
  const icon = {
    isEmpty: vi.fn(() => false),
    resize: vi.fn(function resize() { return icon }),
  }
  const webContents = {
    on: vi.fn(),
    off: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  }

  class BrowserWindow {
    readonly webContents = webContents
    accessibleTitle = ''

    constructor(options: unknown) {
      browserWindowOptions.push(options)
      browserWindows.push(this)
    }

    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly restore = vi.fn()
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly on = browserWindowOn
    readonly off = browserWindowOff
    readonly once = vi.fn()
    readonly destroy = vi.fn()
    readonly loadURL = vi.fn(async () => {})
  }

  class Tray {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly on = vi.fn()
    readonly destroy = vi.fn()
  }

  return {
    app: { on: vi.fn(), off: vi.fn() },
    BrowserWindow,
    browserWindowOptions,
    browserWindows,
    browserWindowOff,
    browserWindowOn,
    Menu: { buildFromTemplate: vi.fn(() => ({})) },
    nativeImage: { createFromPath: vi.fn(() => icon) },
    shell: { openExternal: vi.fn(async () => {}) },
    Tray,
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  Menu: electron.Menu,
  nativeImage: electron.nativeImage,
  shell: electron.shell,
  Tray: electron.Tray,
}))

const spec: DesktopShellSpec = {
  mode: 'compatibility',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/',
  productName: 'DSH Desktop',
  iconPath: '/tmp/icon.png',
  requestQuit: () => {},
}

describe('Electron compatibility runtime', () => {
  beforeEach(() => {
    electron.browserWindowOptions.length = 0
    electron.browserWindows.length = 0
    vi.clearAllMocks()
  })

  it('passes only compatibility options to the real BrowserWindow call site', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime()
    const release = runtime.schedule(spec)

    expect(electron.browserWindowOptions).toHaveLength(0)
    await runtime.mountScheduled()

    expect(electron.browserWindowOptions).toHaveLength(1)
    const options = electron.browserWindowOptions[0]
    expect(options).toEqual(expect.objectContaining({
      title: '',
      width: 1280,
      height: 840,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    }))
    for (const option of [
      'frame',
      'titleBarStyle',
      'titleBarOverlay',
      'trafficLightPosition',
      'transparent',
      'vibrancy',
      'visualEffectState',
      'backgroundMaterial',
      'roundedCorners',
      'thickFrame',
    ]) {
      expect(options).not.toHaveProperty(option)
    }
    expect(electron.browserWindows[0]?.accessibleTitle).toBe('DSH Desktop')

    const titleListener = electron.browserWindowOn.mock.calls.find(([event]) => event === 'page-title-updated')?.[1]
    expect(titleListener).toEqual(expect.any(Function))
    const titleEvent = { preventDefault: vi.fn() }
    titleListener(titleEvent)
    expect(titleEvent.preventDefault).toHaveBeenCalledOnce()

    await release()
    expect(electron.browserWindowOff).toHaveBeenCalledWith('page-title-updated', titleListener)
  })

  it('does not mount a registration disposed before Host boot settles', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime()
    const release = runtime.schedule(spec)

    await release()

    await expect(runtime.mountScheduled()).rejects.toThrow(
      'the Cordis shell plugin did not register a window',
    )
    expect(electron.browserWindowOptions).toHaveLength(0)
  })
})
