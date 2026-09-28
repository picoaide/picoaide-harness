/**
 * 原生壳适配器（`desktopRuntime`）的测试桩 —— 挂载**完整桌面组合树**的用例共用一份。
 *
 * 为什么必须是这一份、而不是各用例自己写一个：`desktop-shell` 行 `inject` 了
 * `desktopRuntime`，桩少一个方法就会让那一行 FAILED —— 于是"组合树真的挂起来了"
 * 这件事本身就不成立，用例会以完全无关的形态红/绿。这里的方法表与
 * `scripts/verify-profile-boot.mjs` 的桩同形（那边是端到端冒烟，这里是包级用例），
 * `boot-desktop-profile.mjs` 会在 boot 之后立刻调 `mountScheduled()`，缺它直接抛
 * "desktop shell was not registered"。
 *
 * @module tests/helpers/desktop-runtime-stub
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `desktop-shell` 注册窗口规格时读到的两个字段。 */
interface ScheduledShellSpec {
  readLocalePreference: () => string | undefined
  readThemeSource: () => string
}

/** 组合树挂载期间被调用的最小原生壳面。 */
export interface DesktopRuntimeStub {
  readonly platform: NodeJS.Platform
  readonly locale: string
  readonly updates: Record<string, unknown>
  schedule(spec: unknown): Promise<() => void>
  mountScheduled(): Promise<void>
  show(): void
  registerTrayItem(): { refresh(): void, dispose(): void }
  setLocalePreference(preference?: string): void
  setThemeSource(source: string): void
  requestRestart(): Promise<void>
  prepareToQuit(): void
  setDeepLinkHandler(): void
}

/**
 * 造一个原生壳桩。
 * @returns 每一次调用都是全新实例（用例之间不共享状态）。
 */
export function desktopRuntimeStub(): DesktopRuntimeStub {
  let scheduled: ScheduledShellSpec | undefined
  const runtime: DesktopRuntimeStub = {
    platform: process.platform,
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: false,
      currentVersion: '0.0.0-test',
      statePath: join(tmpdir(), 'dsh-desktop-runtime-stub-update-state.json'),
      request: async () => { throw new Error('a headless profile boot must not perform update requests') },
      confirmDownload: async () => false,
      showManualCheckResult: () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule(spec: unknown) {
      scheduled = spec as ScheduledShellSpec
      return Promise.resolve(async () => {})
    },
    async mountScheduled() {
      if (scheduled === undefined) throw new Error('desktop shell was not registered')
    },
    show() {},
    registerTrayItem() {
      return { refresh() {}, dispose() {} }
    },
    setLocalePreference() {},
    setThemeSource() {},
    async requestRestart() {},
    prepareToQuit() {},
    setDeepLinkHandler() {},
  }
  return runtime
}
