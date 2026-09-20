/**
 * 应用窗口载体的**桌面接线判据**（§16.1 W-C「独立窗口」）。
 *
 * 为什么必须有这个文件：`windows.ts`（几何/单窗口/记忆/闸门）与
 * `electron-adapter.ts`（原生动作）都可以各自全绿，而"打开应用"在生产里**依然
 * 什么窗口都不出现** —— 2026-09-20 的实测故障正是如此：`WASM_APPS_WINDOW_ADAPTER_SERVICE`
 * 没有任何 provider、`config.userDataDir` 也没注入，于是插件走 `index.ts` 的
 * "无窗口载体"分支：广播一个零消费者的事件，回 `opened`。三个条件缺任何一个，
 * 症状完全相同，而它们**都只在 `main.ts` 的 Electron boot 回调里接线** ——
 * 单测跑不到那一段，所以判据必须打在装配点上。
 *
 * 判据分两层（照 `app-ai-runner.spec.ts` 的既定形态）：
 *  ①**行为**：真实 Cordis `provide`/`get` 往返 + 从服务取回的适配器真的让窗口管理器
 *    走完 open → focused → 关窗 → 再 open 的生命周期，并落盘状态文件；
 *  ②**链接**：`main.ts` 确实经 `provideWasmAppsWindows` 接线、传的是
 *    `createRealElectronWindowAdapter`，且把 `app.getPath('userData')` 注入了插件行
 *    （第 ② 层防的是"接线被内联回去/被删掉，而上面所有用例仍然全绿"）。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WASM_APPS_WINDOW_ADAPTER_SERVICE } from '@picoaide/dsh-wasm-apps-host'
import { APP_WINDOWS_STATE_FILE, createWasmAppsWindows, type WasmAppsWindowAdapter } from '@picoaide/dsh-wasm-apps-host/windows'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { provideWasmAppsWindows } from '../src/wasm-apps-windows.ts'

const temporaryDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-app-windows-'))
  temporaryDirs.push(dir)
  return dir
}
const live: Context[] = []
afterEach(async () => {
  for (const ctx of live.splice(0)) await ctx.fiber.dispose()
  await Promise.all(temporaryDirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }))
})

/** 记录原生调用的窗口适配器替身（真实 Electron 面由 `electron-adapter.spec.ts` 钉住）。 */
function recordingAdapter(): WasmAppsWindowAdapter & {
  created: Array<{ url: string, title: string, width: number, height: number }>
  focused: string[]
  closed: number
  guards: Array<{ appId: string }>
  guardPartitions: string[]
  live: Set<number>
  nextId: () => number
} {
  let next = 0
  const liveIds = new Set<number>()
  const adapter = {
    created: [] as Array<{ url: string, title: string, width: number, height: number }>,
    focused: [] as string[],
    closed: 0,
    guards: [] as Array<{ appId: string }>,
    guardPartitions: [] as string[],
    live: liveIds,
    nextId: (): number => next,
    createAppWindow(options: { url: string, title: string, width: number, height: number }) {
      next += 1
      liveIds.add(next)
      adapter.created.push({ url: options.url, title: options.title, width: options.width, height: options.height })
      return next
    },
    focusAppWindow(_handle: unknown, url: string) { adapter.focused.push(url) },
    closeAppWindow(handle: unknown) { adapter.closed += 1; liveIds.delete(handle as number) },
    setAspectRatio() {},
    installAppWindowGuards(_handle: unknown, appId: string) { adapter.guards.push({ appId }) },
    ensureSessionGuard(partition: string) { adapter.guardPartitions.push(partition) },
    webContentsId(handle: unknown) { return liveIds.has(handle as number) ? (handle as number) + 1000 : undefined },
    isAlive(handle: unknown) { return liveIds.has(handle as number) },
  }
  return adapter
}

describe('provideWasmAppsWindows（桌面壳 → 插件的服务接线）', () => {
  it('provide 之后 ctx.get(WASM_APPS_WINDOW_ADAPTER_SERVICE) 必须拿得到同一个适配器', async () => {
    const ctx = new Context()
    live.push(ctx)
    // 正对照：provide 之前必须取不到（否则下面的断言可能因为别处已 provide 而恒真）。
    expect(ctx.get(WASM_APPS_WINDOW_ADAPTER_SERVICE)).toBeUndefined()

    const adapter = recordingAdapter()
    expect(provideWasmAppsWindows(ctx, adapter)).toBe(adapter)
    expect(ctx.get(WASM_APPS_WINDOW_ADAPTER_SERVICE)).toBe(adapter)
  })

  it('插件真的是从这里取适配器：取回的服务能驱动完整生命周期（opened → focused → 关窗 → 再 opened）', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    live.push(ctx)
    provideWasmAppsWindows(ctx, recordingAdapter())
    // 这一行就是 `@picoaide/dsh-wasm-apps-host/src/index.ts:403` 的做法。
    const service = ctx.get(WASM_APPS_WINDOW_ADAPTER_SERVICE) as WasmAppsWindowAdapter | undefined
    expect(service, '没有 provider ⇒ 窗口管理器根本不会构造（现象：回 opened 但没有窗口）').toBeDefined()

    const windows = createWasmAppsWindows({
      adapter: service!,
      appScheme: 'picoaide-app',
      productName: 'PicoAide Harness',
      userDataDir: dir,
      partition: () => 'persist:agent-browser-alice',
      urlFor: (appId, path) => `picoaide-app://${appId}${path}`,
      titleFor: appId => (appId === 'my-notes' ? '我的笔记' : undefined),
      workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      warn: message => { throw new Error(`unexpected warn: ${message}`) },
    })

    const adapter = service as unknown as ReturnType<typeof recordingAdapter>
    const first = await windows.open('my-notes')
    expect(first.window).toBe('opened')
    // 建窗必须落在**应用 origin** 上（http(s) 会绕过整个应用闸门）。
    expect(adapter.created).toEqual([{
      url: 'picoaide-app://my-notes/',
      title: '我的笔记 · PicoAide Harness',
      width: 1280,
      height: 720,
    }])
    // 导航闸门与 webContents 白名单都要装（缺一个 ⇒ 应用子资源请求被 session 闸门拒）。
    expect(adapter.guards).toEqual([{ appId: 'my-notes' }])
    // 权限守卫装在**插件给出的按用户分区**上（P1-2）：装默认 session 会一边保护不到
    // 应用窗口，一边用 last-wins 覆盖主窗口在同一 session 上的剪贴板白名单。
    expect(adapter.guardPartitions).toEqual(['persist:agent-browser-alice'])

    // 第二次 open = 聚焦已有窗口（不是"又开一个"，也不是"什么都不做"）。
    const again = await windows.open('my-notes', '/notes')
    expect(again.window).toBe('focused')
    expect(adapter.created).toHaveLength(1)
    expect(adapter.focused).toEqual(['picoaide-app://my-notes/notes'])

    // 状态文件落在 `<userData>/wasm-apps-windows.json`（§16.1 冻结 schema，原子写）。
    const state = JSON.parse(await readFile(join(dir, APP_WINDOWS_STATE_FILE), 'utf8')) as {
      version: number
      apps: Record<string, { width: number, height: number, lastPath?: string }>
    }
    expect(state.version).toBe(1)
    expect(state.apps['my-notes']).toMatchObject({ width: 1280, height: 720, lastPath: '/notes' })

    // 生命周期触发源（§16.1）：关闭后再次打开必须**新建**窗口。
    await windows.close('my-notes')
    expect(adapter.closed).toBe(1)
    expect(windows.has('my-notes')).toBe(false)
    const reopened = await windows.open('my-notes')
    expect(reopened.window).toBe('opened')
    expect(adapter.created).toHaveLength(2)
  })

  it('main.ts 必须经 provideWasmAppsWindows 接线，并把 userData 注入插件行', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain("import { provideWasmAppsWindows } from './wasm-apps-windows.ts'")
    expect(main).toContain('createRealElectronWindowAdapter({')
    expect(main).toContain('provideWasmAppsWindows(')
    // 反向：不得再出现"内联 hostCtx.provide(窗口服务名…)"的形态（内联 = 本条失守）。
    expect(main).not.toMatch(/hostCtx\.provide\(\s*WASM_APPS_WINDOW_ADAPTER_SERVICE/)
    // userDataDir 必须走 `prepareDesktopProfile` 的注入（缺它 ⇒ 窗口管理器整个不构造）。
    expect(main).toMatch(/prepareDesktopProfile\([\s\S]{0,400}?app\.getPath\('userData'\),\s*\)/)

    // 注入链的另一半在 `profile.ts`：把注入写成"只有传了才出现"的同时，必须真的有
    // 一处把它放进 `pico-wasm-apps-host` 行的 config（拼错键名/放错行都会静默）。
    const profile = readFileSync(new URL('../src/profile.ts', import.meta.url), 'utf8')
    expect(profile).toMatch(/userDataDir\?: string/)
    expect(profile).toMatch(/\.\.\.\(userDataDir === undefined \|\| userDataDir === '' \? \{\} : \{ userDataDir \}\)/)
  })
})

/** 防止"用替身把契约换掉"：真实适配器的构造入口必须存在（形状由另一个 spec 钉住）。 */
describe('真实适配器入口', () => {
  it('electron-adapter 子路径导出 createRealElectronWindowAdapter（main.ts 的 import 目标）', async () => {
    const module = await vi.importActual<typeof import('@picoaide/dsh-wasm-apps-host/electron-adapter')>('@picoaide/dsh-wasm-apps-host/electron-adapter')
    expect(module.createRealElectronWindowAdapter).toBeTypeOf('function')
    expect(module.createRealElectronAdapter).toBeTypeOf('function')
  })
})
