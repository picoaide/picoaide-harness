/** BrowserWindow construction for the platform-native advanced shell. */

import type { BrowserWindowConstructorOptions, NativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import type { DesktopPlatform, DesktopShellSpec } from './runtime.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from './window-chrome.ts'

/**
 * 沙箱 preload 的绝对路径(P0-6/D8)。
 *
 * 由本模块自身位置解析(`lib/window-options.js` → `lib/preload/renderer-error.cjs`),
 * 所以 asar 内外一致;`tsdown.config.ts` 的 `PACKAGE_NAME/preload` 配置必须与该
 * 文件名保持同步(打包断言里有对应条目)。
 */
const RENDERER_ERROR_PRELOAD = fileURLToPath(new URL('./preload/renderer-error.cjs', import.meta.url))

/**
 * Build the native material window used by the desktop-owned advanced shell.
 * @param spec - shell values resolved from the active Cordis row.
 * @param icon - validated application icon.
 * @param platform - current Electron platform.
 * @returns platform-native glass and window-control options.
 */
export function advancedWindowOptions(
  spec: DesktopShellSpec,
  icon: NativeImage,
  platform: DesktopPlatform,
): BrowserWindowConstructorOptions {
  const options: BrowserWindowConstructorOptions = {
    title: platform === 'win32' ? spec.windowTitle : '',
    width: spec.width,
    height: spec.height,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    show: false,
    icon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 沙箱 preload:只把渲染进程未捕获错误经 IPC 转给主进程(P0-6/D8)。
      // 它不向页面暴露 API,也不持有 DSN/不联网。
      preload: RENDERER_ERROR_PRELOAD,
    },
  }
  if (platform === 'darwin') {
    return {
      ...options,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    }
  }
  if (platform === 'win32') {
    return {
      ...options,
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: WINDOWS_TITLEBAR_HEIGHT,
      },
      backgroundColor: '#00000000',
      backgroundMaterial: 'mica',
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    }
  }
  if (platform === 'linux') {
    // Linux has no platform-native Mica or hidden-inset chrome; the fixed
    // shell uses an ordinary system window frame.
    return options
  }
  throw new Error('dsh-plugin-desktop: unsupported Electron platform')
}

/**
 * Select the BrowserWindow options for the active presentation mode.
 * @param spec - active shell generation.
 * @param icon - validated application icon.
 * @param platform - current Electron platform.
 * @returns mode-specific BrowserWindow options.
 */
export function desktopWindowOptions(
  spec: DesktopShellSpec,
  icon: NativeImage,
  platform: DesktopPlatform,
): BrowserWindowConstructorOptions {
  return advancedWindowOptions(spec, icon, platform)
}
