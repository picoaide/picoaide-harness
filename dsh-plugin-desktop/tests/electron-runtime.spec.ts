import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'

const electron = vi.hoisted(() => {
  const browserWindowOptions: unknown[] = []
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

    constructor(options: unknown) {
      browserWindowOptions.push(options)
    }

    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly restore = vi.fn()
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly on = vi.fn()
    readonly off = vi.fn()
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
    vi.clearAllMocks()
  })

  it('passes only compatibility options to the real BrowserWindow call site', async () => {
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime()
    const release = runtime.mountAfter(Promise.resolve(), () => spec)

    await runtime.whenMounted()

    expect(electron.browserWindowOptions).toHaveLength(1)
    const options = electron.browserWindowOptions[0]
    expect(options).toEqual(expect.objectContaining({
      title: 'DSH Desktop',
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

    await release()
  })
})
