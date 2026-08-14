/** BrowserWindow construction for the compatibility shell. */

import type { BrowserWindowConstructorOptions, NativeImage } from 'electron'
import type { DesktopShellSpec } from './runtime.ts'

/**
 * Build a secure BrowserWindow while preserving the operating system frame.
 * @param spec - shell values resolved from the active Cordis row.
 * @param icon - validated application icon shared with the tray.
 * @returns options without custom title bars, transparency, or native materials.
 */
export function compatibilityWindowOptions(
  spec: DesktopShellSpec,
  icon: NativeImage,
): BrowserWindowConstructorOptions {
  if (spec.mode !== 'compatibility') {
    throw new Error(`dsh-plugin-desktop: unsupported compatibility window mode ${spec.mode}`)
  }
  return {
    title: spec.productName,
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
    },
  }
}
