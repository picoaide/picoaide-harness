/**
 * 窗口载体（§7.2 + §16.1 冻结契约）的纯逻辑判据。
 * 变异验证：把 `correctForRatio` 改成直接返回入参 ⇒ "恢复记忆尺寸必须按 ratio 校正"
 * 必红；把 `dropAppSchemeLedgerEntries` 的丢弃去掉 ⇒ 旧账本用例必红。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_WINDOW_MIN_HEIGHT,
  APP_WINDOW_MIN_WIDTH,
  APP_WINDOWS_STATE_FILE,
  clampAspectRatio,
  clampToWorkArea,
  classifyAppWindowNavigation,
  correctForRatio,
  createWasmAppsWindows,
  dropAppSchemeLedgerEntries,
  minimumWindowSize,
  readWindowsState,
  writeWindowsState,
  type WasmAppsWindowAdapter,
} from './windows.ts'

const temporaryDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wasm-app-windows-'))
  temporaryDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }))
})

/** 建窗替身：只记调用，不做原生动作。 */
function fakeAdapter(): WasmAppsWindowAdapter & { created: Array<Record<string, unknown>>, focused: string[], closed: unknown[], ratios: number[] } {
  const created: Array<Record<string, unknown>> = []
  const focused: string[] = []
  const closed: unknown[] = []
  const ratios: number[] = []
  let next = 0
  return {
    created,
    focused,
    closed,
    ratios,
    createAppWindow(options) {
      created.push(options as unknown as Record<string, unknown>)
      next += 1
      return { id: next }
    },
    focusAppWindow(_handle, url) { focused.push(url) },
    closeAppWindow(handle) { closed.push(handle) },
    setAspectRatio(_handle, ratio) { ratios.push(ratio) },
  }
}

describe('geometry rules (§7.2/§19 Q8)', () => {
  it('clamps the declared ratio to 0.25–4.0 and ignores non-numbers', () => {
    expect(clampAspectRatio(1.7778)).toBeCloseTo(1.7778)
    expect(clampAspectRatio(0.1)).toBe(0.25)
    expect(clampAspectRatio(9)).toBe(4)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined]) {
      expect(clampAspectRatio(bad), String(bad)).toBeUndefined()
    }
  })

  it('corrects restored sizes for the ratio (setAspectRatio 不约束程序化 resize)', () => {
    const corrected = correctForRatio(1000, 1000, 2)
    expect(corrected.width / corrected.height).toBeCloseTo(2, 1)
    // 面积量级保持（不是把窗口缩成一条线）。
    expect(corrected.width * corrected.height).toBeCloseTo(1_000_000, -3)
    expect(correctForRatio(800, 600, undefined)).toEqual({ width: 800, height: 600 })
    // 恢复记忆尺寸这条路径必须自己校正：调用者拿到的就是校正后的值。
    expect(correctForRatio(1280, 720, 1.7778)).toEqual({ width: 1280, height: 720 })
  })

  it('derives the minimum size as max(320×240, ratio-derived)', () => {
    expect(minimumWindowSize(undefined)).toEqual({ width: APP_WINDOW_MIN_WIDTH, height: APP_WINDOW_MIN_HEIGHT })
    const wide = minimumWindowSize(4)
    expect(wide.height).toBe(APP_WINDOW_MIN_HEIGHT)
    expect(wide.width / wide.height).toBeGreaterThanOrEqual(4)
  })

  it('clamps a remembered rect into the work area (显示器变化时裁剪)', () => {
    const rect = clampToWorkArea({ width: 4000, height: 3000, x: 9_000, y: -9_000 }, { x: 0, y: 0, width: 1920, height: 1080 }, undefined)
    expect(rect.width).toBeLessThanOrEqual(1920)
    expect(rect.height).toBeLessThanOrEqual(1080)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    // 没记忆位置 ⇒ 居中。
    const centered = clampToWorkArea({ width: 800, height: 600 }, { x: 0, y: 0, width: 1920, height: 1080 }, undefined)
    expect(centered.x).toBe(560)
    expect(centered.y).toBe(240)
  })
})

describe('state file (§16.1 freeze)', () => {
  it('round-trips through the frozen schema and ignores corrupted content', async () => {
    const dir = await tempDir()
    await writeWindowsState(dir, {
      version: 1,
      apps: { 'my-notes': { width: 900, height: 600, x: 10, y: 20, ratio: 1.5, lastPath: '/notes' } },
    })
    const raw = JSON.parse(await readFile(join(dir, APP_WINDOWS_STATE_FILE), 'utf8')) as Record<string, unknown>
    expect(raw.version).toBe(1)
    expect(raw.apps).toEqual({ 'my-notes': { width: 900, height: 600, x: 10, y: 20, ratio: 1.5, lastPath: '/notes' } })
    expect(await readWindowsState(dir)).toEqual({
      version: 1,
      apps: { 'my-notes': { width: 900, height: 600, x: 10, y: 20, ratio: 1.5, lastPath: '/notes' } },
    })
  })

  it('returns an empty state for a missing file, a foreign version or junk', async () => {
    const dir = await tempDir()
    expect(await readWindowsState(dir)).toEqual({ version: 1, apps: {} })
    await writeWindowsState(dir, { version: 1, apps: {} })
    expect(await readWindowsState(dir)).toEqual({ version: 1, apps: {} })
    const other = await tempDir()
    await writeFileJson(join(other, APP_WINDOWS_STATE_FILE), { version: 99, apps: { x: { width: 1, height: 1 } } })
    expect(await readWindowsState(other)).toEqual({ version: 1, apps: {} })
    const junk = await tempDir()
    await writeFileJson(join(junk, APP_WINDOWS_STATE_FILE), { version: 1, apps: { x: { width: -1, height: 0 } } })
    expect(await readWindowsState(junk)).toEqual({ version: 1, apps: {} })
  })
})

/** 写一个 JSON 文件（测试夹具）。 */
async function writeFileJson(path: string, value: unknown): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
}

describe('window manager (single window per app)', () => {
  const urlFor = (appId: string, path: string): string => `picoaide-app://${appId}${path}`
  const workArea = (): { x: number, y: number, width: number, height: number } => ({ x: 0, y: 0, width: 1920, height: 1080 })

  it('opens one window per app and focuses (not duplicates) on reopen', async () => {
    const dir = await tempDir()
    const adapter = fakeAdapter()
    const windows = createWasmAppsWindows({ adapter, appScheme: 'picoaide-app', productName: 'Acme', userDataDir: dir, urlFor, workArea })
    const first = await windows.open('my-notes')
    expect(first.window).toBe('opened')
    expect(adapter.created).toHaveLength(1)
    expect(adapter.created[0]?.title).toBe('my-notes · Acme')
    const again = await windows.open('my-notes', '/notes')
    expect(again.window).toBe('focused')
    expect(adapter.created).toHaveLength(1)
    expect(adapter.focused[0]).toBe('picoaide-app://my-notes/notes')
    expect(windows.openApps()).toEqual(['my-notes'])
  })

  it('remembers the size and restores it corrected for the ratio', async () => {
    const dir = await tempDir()
    const first = fakeAdapter()
    const windows = createWasmAppsWindows({ adapter: first, appScheme: 'picoaide-app', productName: 'Acme', userDataDir: dir, urlFor, workArea })
    await windows.open('my-notes', '/', 2)
    const created = first.created[0] as { width: number, height: number }
    expect(created.width / created.height).toBeCloseTo(2, 1)
    expect(first.ratios).toEqual([2])
    // 第二次（新实例，同一个 userData）恢复记忆尺寸。
    const second = fakeAdapter()
    const reopened = createWasmAppsWindows({ adapter: second, appScheme: 'picoaide-app', productName: 'Acme', userDataDir: dir, urlFor, workArea })
    await reopened.open('my-notes')
    expect(second.created[0]?.width).toBe(created.width)
    expect(second.created[0]?.height).toBe(created.height)
  })

  it('closes one app and closes all on account switch (§7.2)', async () => {
    const dir = await tempDir()
    const adapter = fakeAdapter()
    const windows = createWasmAppsWindows({ adapter, appScheme: 'picoaide-app', productName: 'Acme', userDataDir: dir, urlFor, workArea })
    await windows.open('a')
    await windows.open('b')
    await windows.close('a')
    expect(windows.openApps()).toEqual(['b'])
    expect(adapter.closed).toHaveLength(1)
    await windows.closeAll()
    expect(windows.openApps()).toEqual([])
    expect(adapter.closed).toHaveLength(2)
  })
})

describe('navigation gate and legacy ledger (R2-P0-2 / R1-CLI-14)', () => {
  it('allows only the same app origin and refuses foreign apps / external URLs', () => {
    expect(classifyAppWindowNavigation('picoaide-app://my-notes/notes', 'my-notes', 'picoaide-app')).toEqual({ verdict: 'allow' })
    expect(classifyAppWindowNavigation('picoaide-app://other/', 'my-notes', 'picoaide-app')).toEqual({ verdict: 'deny', reason: 'foreign-app' })
    expect(classifyAppWindowNavigation('https://evil.example/', 'my-notes', 'picoaide-app')).toEqual({ verdict: 'deny', reason: 'external' })
    expect(classifyAppWindowNavigation('javascript:alert(1)', 'my-notes', 'picoaide-app')).toEqual({ verdict: 'deny', reason: 'external' })
    expect(classifyAppWindowNavigation('not a url', 'my-notes', 'picoaide-app')).toEqual({ verdict: 'deny', reason: 'malformed' })
    // 渠道 scheme：别的渠道的 origin 也不认。
    expect(classifyAppWindowNavigation('picoaide-app://my-notes/', 'my-notes', 'gentech-harness-app')).toEqual({ verdict: 'deny', reason: 'external' })
  })

  it('drops browser-ledger entries that point at the app scheme (and counts them)', () => {
    const entries = [
      { url: 'https://example.com/' },
      { url: 'picoaide-app://my-notes/' },
      { url: 'PICOAIde-app://my-notes/' },
      { url: undefined },
    ]
    const { kept, dropped } = dropAppSchemeLedgerEntries(entries, 'picoaide-app')
    expect(dropped).toBe(2)
    expect(kept).toHaveLength(2)
  })
})

describe('权限守卫必须在建窗之前就位（CLI-2 / §16.1）', () => {
  it('从未开过浏览器标签时创建应用窗口 ⇒ 该 session 的两个 handler 都被调用（R1-L2-2）', async () => {
    const dir = await tempDir()
    // 真实守卫实现（浏览器包里的唯一一份），不是替身：断言的是"调用真的发生了"。
    const { ensureSessionGuard } = await import('@picoaide/dsh-browser/guard')
    const requestHandlers: unknown[] = []
    let checkInstalls = 0
    const sessionLike = {
      setPermissionRequestHandler(handler: unknown) { requestHandlers.push(handler) },
      setPermissionCheckHandler() { checkInstalls += 1 },
    }
    const adapter = fakeAdapter()
    const windows = createWasmAppsWindows({
      adapter: {
        ...adapter,
        ensureSessionGuard: () => { ensureSessionGuard(sessionLike as never) },
      },
      appScheme: 'picoaide-app',
      productName: 'Acme',
      userDataDir: dir,
      urlFor: (appId, path) => `picoaide-app://${appId}${path}`,
      workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    })
    // 前置：这张 session 之前没有任何浏览器标签（没有任何别的安装路径）。
    expect(requestHandlers).toHaveLength(0)
    expect(checkInstalls).toBe(0)
    await windows.open('my-notes')
    expect(requestHandlers).toHaveLength(1)
    expect(checkInstalls).toBe(1)
    // 再开一个窗口：幂等，不会重复安装（重复安装会覆盖成同一策略，但计数会露馅）。
    await windows.open('other-app')
    expect(requestHandlers).toHaveLength(1)
    expect(checkInstalls).toBe(1)
  })

  const urlFor = (appId: string, path: string): string => `picoaide-app://${appId}${path}`
  const workArea = (): { x: number, y: number, width: number, height: number } => ({ x: 0, y: 0, width: 1920, height: 1080 })

  it('创建应用窗口前调用适配器的 ensureSessionGuard（顺序也在断言里）', async () => {
    const dir = await tempDir()
    const calls: string[] = []
    const adapter = fakeAdapter()
    const windows = createWasmAppsWindows({
      adapter: {
        ...adapter,
        createAppWindow(options) {
          calls.push('create')
          return adapter.createAppWindow(options)
        },
        ensureSessionGuard() { calls.push('guard') },
      },
      appScheme: 'picoaide-app',
      productName: 'Acme',
      userDataDir: dir,
      urlFor,
      workArea,
    })
    await windows.open('my-notes')
    expect(calls).toEqual(['guard', 'create'])
  })

  it('窗口管理器把 webContents id 报给请求闸门，关闭后即移除（fail-closed 的来源）', async () => {
    const dir = await tempDir()
    const adapter = fakeAdapter()
    const windows = createWasmAppsWindows({
      adapter: { ...adapter, webContentsId: handle => (handle as { id: number }).id },
      appScheme: 'picoaide-app',
      productName: 'Acme',
      userDataDir: dir,
      urlFor,
      workArea,
    })
    expect(windows.isAppSurfaceWebContents(1)).toBe(false)
    await windows.open('my-notes')
    expect(windows.isAppSurfaceWebContents(1)).toBe(true)
    await windows.close('my-notes')
    expect(windows.isAppSurfaceWebContents(1)).toBe(false)
    await windows.open('my-notes')
    await windows.closeAll()
    expect(windows.isAppSurfaceWebContents(1)).toBe(false)
    // 没有 id 信息时一律 false（应用窗口打不开好过任意网页借用员工令牌）。
    const blind = createWasmAppsWindows({
      adapter, appScheme: 'picoaide-app', productName: 'Acme', userDataDir: dir, urlFor, workArea,
    })
    await blind.open('my-notes')
    expect(blind.isAppSurfaceWebContents(1)).toBe(false)
  })
})

describe('state write failures never block opening a window', () => {
  const workArea = (): { x: number, y: number, width: number, height: number } => ({ x: 0, y: 0, width: 1920, height: 1080 })
  it('warns instead of throwing when the state file cannot be written', async () => {
    const warn = vi.fn()
    const adapter = fakeAdapter()
    const windows = createWasmAppsWindows({
      adapter,
      appScheme: 'picoaide-app',
      productName: 'Acme',
      // 一个不存在的父路径下的文件位置：写入必然失败（目录不可创建）。
      userDataDir: '/proc/self/mem/nope',
      urlFor: (appId, path) => `picoaide-app://${appId}${path}`,
      workArea,
      warn,
    })
    const result = await windows.open('my-notes')
    expect(result.window).toBe('opened')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(warn).toHaveBeenCalled()
  })
})
