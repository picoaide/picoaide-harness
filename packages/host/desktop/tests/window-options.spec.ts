import type { NativeImage } from 'electron'
import { describe, expect, it } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'
import {
  advancedWindowOptions,
  desktopWindowOptions,
} from '../src/window-options.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from '../src/window-chrome.ts'

const spec: DesktopShellSpec = {
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/',
  productName: 'PicoAide Harness',
  windowTitle: 'PicoAide Harness',
  iconPath: '/tmp/app-icon.png',
  trayIcons: {
    templatePath: '/tmp/tray-iconTemplate.png',
    bluePath: '/tmp/tray-icon-blue.png',
  },
  readLocalePreference: () => undefined,
  readThemeSource: () => 'system',
  requestQuit: () => {},
}

describe('advanced BrowserWindow options', () => {
  it('uses hidden-inset transparent vibrancy on macOS', () => {
    const options = advancedWindowOptions(spec, {} as NativeImage, 'darwin')

    expect(options).toEqual(expect.objectContaining({
      title: '',
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // 开发态（缺省 packaged=false）：DevTools 保持可用。
        devTools: true,
        // P0-6/D8:窗口必须挂上承载渲染进程错误转发的沙箱 preload。
        preload: expect.stringContaining('preload/renderer-error.cjs'),
      },
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    }))
    expect(desktopWindowOptions(spec, {} as NativeImage, 'darwin')).toEqual(options)
  })

  it('只在打包态关闭 DevTools，开发态保持可用', () => {
    // 打包态（app.isPackaged === true）：发布产物里 DevTools 必须不可用。
    const packaged = advancedWindowOptions(spec, {} as NativeImage, 'linux', true)
    expect(packaged.webPreferences?.devTools).toBe(false)
    expect(desktopWindowOptions(spec, {} as NativeImage, 'linux', true).webPreferences?.devTools)
      .toBe(false)

    // 开发态（缺省 false）：`yarn dev` 与真机排查仍要能开 DevTools。
    const development = advancedWindowOptions(spec, {} as NativeImage, 'linux')
    expect(development.webPreferences?.devTools).toBe(true)

    // 三个平台同一条策略（不能只在 Linux 上生效）。
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(advancedWindowOptions(spec, {} as NativeImage, platform, true).webPreferences?.devTools)
        .toBe(false)
    }
  })

  it('uses native Windows controls, Mica, shadow, and rounded corners', () => {
    const options = advancedWindowOptions(spec, {} as NativeImage, 'win32')

    expect(options).toEqual(expect.objectContaining({
      title: 'PicoAide Harness',
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: WINDOWS_TITLEBAR_HEIGHT,
      },
      backgroundMaterial: 'mica',
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    }))
  })

  it('falls back to an ordinary system window frame on Linux', () => {
    const options = advancedWindowOptions(spec, {} as NativeImage, 'linux')

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
        // 开发态（缺省 packaged=false）：DevTools 保持可用。
        devTools: true,
        // P0-6/D8:窗口必须挂上承载渲染进程错误转发的沙箱 preload。
        preload: expect.stringContaining('preload/renderer-error.cjs'),
      },
    }))
    expect(options).not.toHaveProperty('titleBarStyle')
    expect(options).not.toHaveProperty('backgroundMaterial')
  })
})
