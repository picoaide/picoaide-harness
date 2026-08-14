/** DSH Desktop Host plugin: owns the Electron shell as one Cordis effect. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DesktopPlatform } from './runtime.ts'
import type {} from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-shell'

/** Services required before the shell can schedule its renderer generation. */
export const inject = ['desktopRuntime', 'webServer', 'webRuntime', 'appExit', 'loader']

/** Native window configuration. */
export interface Config {
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
}

/** Validated native window configuration. */
export const Config: z<Config> = z.object({
  width: z.number().step(1).min(800).default(1280),
  height: z.number().step(1).min(600).default(840),
  minWidth: z.number().step(1).min(640).default(900),
  minHeight: z.number().step(1).min(480).default(640),
})

/**
 * Construct the same-origin renderer URL for one native platform.
 * @param port - active loopback Web server port.
 * @param platform - native Electron platform.
 * @returns the URL loaded by the BrowserWindow.
 */
export function desktopRendererUrl(port: number, platform: DesktopPlatform): string {
  const url = new URL(`http://127.0.0.1:${String(port)}/`)
  url.searchParams.set('dsh-desktop-platform', platform)
  return url.href
}

/**
 * Schedule the Electron shell after every Host plugin has settled.
 * @param ctx - Host context carrying the Electron adapter and Web carrier.
 * @param config - validated native window values.
 */
export function apply(ctx: Context, config: Config): void {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('dsh-plugin-desktop: the launcher did not provide ctx.appExit')
  }
  const iconPath = fileURLToPath(new URL('../build/icon.png', import.meta.url))
  ctx.effect(
    () => ctx.desktopRuntime.mountAfter(ctx.loader.await(), () => ({
      ...config,
      url: desktopRendererUrl(ctx.webServer.port, ctx.desktopRuntime.platform),
      productName: 'DSH Desktop',
      iconPath,
      requestQuit: appExit,
    })),
    'dsh-plugin-desktop: native shell generation',
  )
}
