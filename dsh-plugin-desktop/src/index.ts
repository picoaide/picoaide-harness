/** DSH Desktop Host plugin: owns the selected native shell generation. */

import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { DesktopShellMode } from './runtime.ts'
import type {} from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-shell'

/** Services required before the shell can register its renderer generation. */
export const inject = ['desktopRuntime', 'webServer', 'webRuntime', 'appExit', 'settings']

/** Standard settings namespace shared by tray and configuration surfaces. */
export const DESKTOP_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop')

/** Same-origin endpoint used only by the desktop settings page. */
export const DESKTOP_MODE_ENDPOINT = '/api/dsh-desktop/mode'

const MAX_MODE_REQUEST_BYTES = 128

/** Desktop settings presented by the standard settings service. */
export interface DesktopSettings {
  /** Native presentation selected for the next application generation. */
  mode: DesktopShellMode
}

/** Build the narrow loopback-only mode mutation handler. */
export function createDesktopModeHandler(options: {
  /** Exact authority of the desktop Web server. */
  authority: string
  /** Persist one schema-validated settings patch. */
  update: (patch: DesktopSettings) => Promise<void>
  /** Report rejected persistence without exposing details to the browser. */
  reportError: (error: unknown) => void
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const origin = `http://${options.authority}`
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      respond(res, 405, 'method-not-allowed')
      return
    }
    if (req.headers.host !== options.authority || req.headers.origin !== origin) {
      respond(res, 403, 'forbidden-origin')
      return
    }
    const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      respond(res, 415, 'unsupported-media-type')
      return
    }
    let source: string
    try {
      source = await readRequestBody(req)
    } catch (error) {
      respond(res, error instanceof RequestTooLargeError ? 413 : 400, 'invalid-body')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      respond(res, 400, 'invalid-json')
      return
    }
    if (!isModeBody(value)) {
      respond(res, 400, 'invalid-mode')
      return
    }
    try {
      await options.update(value)
    } catch (error) {
      options.reportError(error)
      respond(res, 400, 'mode-rejected')
      return
    }
    res.writeHead(204)
    res.end()
  }
}

class RequestTooLargeError extends Error {}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
    size += bytes.byteLength
    if (size > MAX_MODE_REQUEST_BYTES) throw new RequestTooLargeError()
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isModeBody(value: unknown): value is DesktopSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === 'mode'
    && ((value as Record<string, unknown>).mode === 'compatibility'
      || (value as Record<string, unknown>).mode === 'advanced')
}

function respond(res: ServerResponse, status: number, error: string): void {
  const body = JSON.stringify({ error })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Schema registered with the standard settings service. */
export const DesktopSettingsSchema: z<DesktopSettings> = z.object({
  mode: z.union(['compatibility', 'advanced'] as const).default('compatibility'),
})

/** Native window configuration. */
export interface Config {
  /** Native presentation mode selected before BrowserWindow construction. */
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
 * @param mode - active native presentation mode.
 * @param platform - active Electron platform.
 * @returns the URL loaded by the BrowserWindow.
 */
export function desktopRendererUrl(
  port: number,
  mode: DesktopShellMode,
  platform: Context['desktopRuntime']['platform'],
): string {
  const url = new URL(`http://127.0.0.1:${String(port)}/`)
  url.searchParams.set('dsh-desktop-mode', mode)
  url.searchParams.set('dsh-desktop-platform', platform)
  return url.href
}

/**
 * Register the Electron shell from active Web carrier values.
 * @param ctx - Host context carrying the Electron adapter and Web carrier.
 * @param config - validated native window values.
 */
export function apply(ctx: Context, config: Config): void {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('dsh-plugin-desktop: the launcher did not provide ctx.appExit')
  }
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('dsh-plugin-desktop: desktop mode endpoint requires a loopback Web server')
  }
  const iconPath = fileURLToPath(new URL('../build/app-icon.png', import.meta.url))
  const trayIcons = {
    templatePath: fileURLToPath(new URL('../build/tray-iconTemplate.png', import.meta.url)),
    bluePath: fileURLToPath(new URL('../build/tray-icon-blue.png', import.meta.url)),
  }
  const settings = ctx.settings.register(
    DESKTOP_SETTINGS_NAMESPACE,
    DesktopSettingsSchema,
    {
      applies: 'restart',
      validate: (value) => {
        if (value.mode === 'advanced' && ctx.desktopRuntime.platform === 'linux') {
          throw new Error('dsh-plugin-desktop: advanced shell mode is supported on macOS and Windows')
        }
      },
    },
  )
  const authority = `127.0.0.1:${String(ctx.webServer.port)}`
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_MODE_ENDPOINT,
      handler: createDesktopModeHandler({
        authority,
        update: patch => settings.update(patch),
        reportError: error => { ctx.logger.warn(error) },
      }),
    }),
    'dsh-plugin-desktop: mode endpoint',
  )
  ctx.effect(() => {
    let pending: ReturnType<typeof setImmediate> | undefined
    const stopWatching = settings.watch((next) => {
      if (next.mode === config.mode) {
        if (pending !== undefined) clearImmediate(pending)
        pending = undefined
        return
      }
      pending ??= setImmediate(() => {
        pending = undefined
        void ctx.desktopRuntime.requestRestart().catch((cause: unknown) => {
          ctx.logger.error('dsh-plugin-desktop: failed to restart after mode change')
          ctx.logger.error(cause)
        })
      })
    })
    return () => {
      stopWatching()
      if (pending !== undefined) clearImmediate(pending)
    }
  }, 'dsh-plugin-desktop: restart after mode change')
  ctx.effect(
    () => ctx.desktopRuntime.schedule({
      ...config,
      url: desktopRendererUrl(ctx.webServer.port, config.mode, ctx.desktopRuntime.platform),
      productName: 'DSH Desktop',
      windowTitle: 'DeepSeek Harness Desktop',
      iconPath,
      trayIcons,
      requestQuit: appExit,
      requestModeChange: async mode => settings.update({ mode }),
    }),
    'dsh-plugin-desktop: native shell generation',
  )
}
