/** DSH Desktop compatibility Host plugin: owns the native shell without a client override. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DesktopShellMode } from './runtime.ts'
import type {} from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-shell'

/** Services required before the shell can register its renderer generation. */
export const inject = ['desktopRuntime', 'webServer', 'webRuntime', 'appExit']

/** Native window configuration. */
export interface Config {
  /** Native presentation mode. Advanced mode fails until its client shell ships. */
  mode: DesktopShellMode
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
  mode: z.union(['compatibility', 'advanced'] as const).default('compatibility'),
  width: z.number().step(1).min(800).default(1280),
  height: z.number().step(1).min(600).default(840),
  minWidth: z.number().step(1).min(640).default(900),
  minHeight: z.number().step(1).min(480).default(640),
})

/**
 * Construct the unmodified upstream Web root URL.
 * @param port - active loopback Web server port.
 * @returns the URL loaded by the BrowserWindow.
 */
export function desktopRendererUrl(port: number): string {
  return new URL(`http://127.0.0.1:${String(port)}/`).href
}

/**
 * Register the Electron shell from active Web carrier values.
 * @param ctx - Host context carrying the Electron adapter and Web carrier.
 * @param config - validated native window values.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode !== 'compatibility') {
    throw new Error('dsh-plugin-desktop: advanced shell mode is not implemented')
  }
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('dsh-plugin-desktop: the launcher did not provide ctx.appExit')
  }
  const iconPath = fileURLToPath(new URL('../build/icon.png', import.meta.url))
  ctx.effect(
    () => ctx.desktopRuntime.schedule({
      ...config,
      url: desktopRendererUrl(ctx.webServer.port),
      productName: 'DSH Desktop',
      iconPath,
      requestQuit: appExit,
    }),
    'dsh-plugin-desktop: native shell generation',
  )
}
