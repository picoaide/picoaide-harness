/** Electron implementation of the launcher-provided desktop runtime capability. */

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  shell,
  Tray,
} from 'electron'
import type { DesktopPlatform, DesktopRuntime, DesktopShellSpec } from './runtime.ts'
import { compatibilityWindowOptions } from './window-options.ts'

/** Native adapter used by the DSH Desktop launcher and owned by its Cordis shell plugin. */
export class ElectronDesktopRuntime implements DesktopRuntime {
  readonly platform: DesktopPlatform

  private window: BrowserWindow | undefined
  private tray: Tray | undefined
  private scheduled: DesktopShellSpec | undefined
  private mountTask: Promise<void> | undefined
  private release: (() => Promise<void>) | undefined
  private quitting = false

  constructor() {
    if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') {
      throw new Error(`dsh-plugin-desktop: unsupported Electron platform ${process.platform}`)
    }
    this.platform = process.platform
  }

  /** @inheritdoc */
  schedule(spec: DesktopShellSpec): () => Promise<void> {
    if (this.scheduled !== undefined || this.mountTask !== undefined) {
      throw new Error('dsh-plugin-desktop: a native shell generation is already registered')
    }
    this.scheduled = spec
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      try {
        await this.mountTask
      } finally {
        await this.release?.()
        this.release = undefined
        this.mountTask = undefined
        if (this.scheduled === spec) this.scheduled = undefined
      }
    }
  }

  /** @inheritdoc */
  mountScheduled(): Promise<void> {
    const spec = this.scheduled
    if (spec === undefined) {
      return Promise.reject(new Error('dsh-plugin-desktop: the Cordis shell plugin did not register a window'))
    }
    this.mountTask ??= this.mount(spec).then((release) => { this.release = release })
    return this.mountTask
  }

  /** @inheritdoc */
  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** @inheritdoc */
  prepareToQuit(): void {
    this.quitting = true
  }

  private async mount(spec: DesktopShellSpec): Promise<() => Promise<void>> {
    const icon = nativeImage.createFromPath(spec.iconPath)
    if (icon.isEmpty()) {
      throw new Error(`dsh-plugin-desktop: failed to load application icon ${spec.iconPath}`)
    }
    const origin = new URL(spec.url).origin
    const window = new BrowserWindow(compatibilityWindowOptions(spec, icon))
    window.accessibleTitle = spec.productName
    this.window = window

    const show = (): void => { this.show() }
    const close = (event: Electron.Event): void => {
      if (this.quitting) return
      event.preventDefault()
      window.hide()
    }
    const preserveBlankTitle = (event: Electron.Event): void => { event.preventDefault() }
    const navigate = (event: Electron.Event<{ url: string }>): void => {
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(event.url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }

    app.on('activate', show)
    window.on('close', close)
    window.on('page-title-updated', preserveBlankTitle)
    window.webContents.on('will-frame-navigate', navigate)
    window.webContents.on('will-redirect', navigate)
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' || target.protocol === 'http:' || target.protocol === 'mailto:') {
          void shell.openExternal(target.href).catch((cause: unknown) => {
            process.stderr.write(`dsh-plugin-desktop: failed to open external link: ${cause instanceof Error ? cause.message : String(cause)}\n`)
          })
        }
      } catch {
        // A malformed target is rejected with the same deny result.
      }
      return { action: 'deny' }
    })

    const tray = new Tray(icon.resize({ width: 18, height: 18 }))
    this.tray = tray
    tray.setToolTip(spec.productName)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Open ${spec.productName}`, click: show },
      { type: 'separator' },
      { label: 'Quit', click: () => { spec.requestQuit(0) } },
    ]))
    tray.on('click', show)

    window.once('ready-to-show', show)
    try {
      await window.loadURL(spec.url)
    } catch (cause) {
      app.off('activate', show)
      window.off('page-title-updated', preserveBlankTitle)
      tray.destroy()
      window.destroy()
      this.tray = undefined
      this.window = undefined
      throw cause
    }

    let released = false
    return async () => {
      if (released) return
      released = true
      app.off('activate', show)
      window.off('close', close)
      window.off('page-title-updated', preserveBlankTitle)
      window.webContents.off('will-frame-navigate', navigate)
      window.webContents.off('will-redirect', navigate)
      tray.destroy()
      if (!window.isDestroyed()) window.destroy()
      if (this.tray === tray) this.tray = undefined
      if (this.window === window) this.window = undefined
    }
  }
}
