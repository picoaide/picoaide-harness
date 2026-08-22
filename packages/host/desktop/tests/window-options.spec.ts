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
  productName: 'DSH Desktop',
  windowTitle: 'DeepSeek Harness Desktop',
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

  it('uses native Windows controls, Mica, shadow, and rounded corners', () => {
    const options = advancedWindowOptions(spec, {} as NativeImage, 'win32')

    expect(options).toEqual(expect.objectContaining({
      title: 'DeepSeek Harness Desktop',
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
      },
    }))
    expect(options).not.toHaveProperty('titleBarStyle')
    expect(options).not.toHaveProperty('backgroundMaterial')
  })
})
