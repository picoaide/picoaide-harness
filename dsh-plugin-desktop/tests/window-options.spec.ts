import type { NativeImage } from 'electron'
import { describe, expect, it } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'
import { compatibilityWindowOptions } from '../src/window-options.ts'

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

describe('compatibility BrowserWindow options', () => {
  it('preserves the native frame and enables renderer isolation', () => {
    const icon = {} as NativeImage
    const options = compatibilityWindowOptions(spec, icon)

    expect(options).toEqual(expect.objectContaining({
      title: '',
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
      show: false,
      icon,
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
  })

  it('rejects an advanced spec before BrowserWindow construction', () => {
    expect(() => compatibilityWindowOptions(
      { ...spec, mode: 'advanced' },
      {} as NativeImage,
    )).toThrow('unsupported compatibility window mode advanced')
  })
})
