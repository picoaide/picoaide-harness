import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntime } from '../src/runtime.ts'
import { BrowserError } from '../src/errors.ts'
import { BrowserStore } from '../src/store.ts'
import { classifyNavigation } from '../src/guard.ts'
import type { NativeSession } from '../src/electron-adapter.ts'

/**
 * 三轮审计 P1-①：**持有性证明挡不住"模型自己开浏览器"**。
 *
 * 三个使能条件（都实测过）：
 *  1. 宿主本机路由 `GET /api/pico/apps/wasm/:app_id/rows?unmask=1` 要求 `dsh-auth-*` cookie；
 *  2. 内置浏览器的分区**故意镜像**了那把 cookie（`index.ts` 的 `mirrorBrowserAuthCookies`，
 *     本插件自己两个 shell 页面的写操作要靠它）；
 *  3. 导航策略对浏览器标签放行一切 `http(s)`（`classifyNavigation`），**不拦 shell origin**。
 * ⇒ 模型 `browser_navigate('http://127.0.0.1:<port>/api/pico/...&unmask=1')` + `get_text`
 * 就能读未脱敏数据；而且被绕过的**不只是** `unmask` —— 任何依赖持有性证明的本机守卫都失效。
 *
 * 修法：模型可达的三条导航入口（`browser_navigate` / `window.open` / `browser_download`）
 * 一律拒**本机 shell origin**。本文件的判据：
 *  - ① 三条入口对 shell origin 全部拒绝（含同 origin 的其它路径、带端口的写法）；
 *  - ② **反向对照**：其它 `127.0.0.1:<其它端口>` 仍然放行（作者让 AI 看本地 dev server
 *    是真实用法，一并拒掉就是"为了安全毁掉功能"）；
 *  - ③ **不误伤宿主自己**：shell origin **未设置**时判据恒不生效（非 Electron 宿主/测试），
 *    且宿主 load 两个 shell 页面走的是 `webContents.loadURL`（不经本判据）。
 *
 * 变异验证：把 `navigationAllowed` 里的 `isShellOriginUrl` 分支删掉（退回直接
 * `this.guard.allowNavigation`）⇒ ①的导航用例变红（不再抛 navigation-blocked）。
 */

/** 捕获 `setWindowOpenHandler` 装上的那个回调（window.open / target=_blank 的唯一闸门）。 */
let capturedWindowOpen: ((details: { url: string }) => { action: string }) | undefined

class MockView {
  partition = ''
  session: MockSession | undefined
  attach(): void {}
  setBounds(): void {}
  setVisible(): void {}
  detach(): void {}
  moveToTop(): void {}
  destroy(): void {}
  moveAbove(): void {}
  get webContents(): never {
    return {
      cdp: { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: async () => ({}), on: () => {}, removeListener: () => {} },
      loadURL: async () => {},
      getURL: () => 'about:blank',
      getTitle: () => 'mock',
      setZoomFactor: () => {},
      getZoomFactor: () => 1,
      downloadURL: () => {},
      focus: () => {},
      insertCSS: async () => '',
      removeInsertedCSS: async () => {},
      openDevTools: () => {},
      isDevToolsOpened: () => false,
      closeDevTools: () => {},
      setWindowOpenHandler2: () => {},
      executeJavaScript: async () => undefined,
      capturePage: async () => { throw new Error('unused') },
      setAudioMuted: () => {},
      isAudioMuted: () => false,
      isLoading: () => false,
      on: () => {},
      removeListener: () => {},
      session: this.session ?? new MockSession(),
      setWindowOpenHandler: (cb: (details: { url: string }) => { action: string }) => { capturedWindowOpen = cb },
      close: () => {},
      isDestroyed: () => false,
    } as never
  }
}

class MockSession {
  clearStorageData = async (): Promise<void> => {}
  clearCache = async (): Promise<void> => {}
  setPermissionRequestHandler = (): void => {}
  setPermissionCheckHandler = (): void => {}
  on(): void {}
  removeListener(): void {}
}

class MockAdapter {
  readonly partitionSession = new MockSession()
  createView(): never {
    const view = new MockView()
    view.session = this.partitionSession
    return view as never
  }
  createMaskView(): never {
    const view = new MockView()
    view.session = this.partitionSession
    return view as never
  }
  createBrowserWindow(): never {
    return {
      loadURL: async () => {},
      show: () => {}, hide: () => {}, focus: () => {},
      isVisible: () => false, isDestroyed: () => false, close: () => {},
      setTitle: () => {},
      getContentSize: () => ({ width: 1100, height: 780 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      onResize: () => () => {}, onClosed: () => () => {}, focusPage: () => {},
    } as never
  }
  getSession(): NativeSession { return this.partitionSession }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SHELL = 'http://127.0.0.1:45678'

function makeRuntime(withShellOrigin = true): BrowserRuntime {
  const dir = join(process.cwd(), 'tests', `.shell-origin-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  const runtime = new BrowserRuntime(new MockAdapter() as never, {}, undefined, 'persist:test-part', {
    store: new BrowserStore({ dir }),
  })
  if (withShellOrigin) runtime.setShellOrigin(SHELL)
  return runtime
}

describe('内置浏览器不得导航到本机 shell origin（三轮审计 P1-①）', () => {
  it('① browser_navigate 到 shell origin 被拒（含 rows?unmask=1 的绕过尝试）', async () => {
    const runtime = makeRuntime()
    for (const url of [
      `${SHELL}/api/pico/apps/wasm/demo/rows?table=notes&unmask=1`,
      `${SHELL}/api/pico/apps/wasm`,
      `${SHELL}/browser-shell`,
      `${SHELL}/`,
    ]) {
      // 断言**错误码**（`navigation-blocked` 是 code，不是 message —— 只比 message 会漏掉
      // "拒绝理由变了但仍是同一个码"这种漂移）。
      await expect(runtime.navigate(1, url), url).rejects.toMatchObject({
        constructor: BrowserError,
        code: 'navigation-blocked',
      })
    }
    await runtime.dispose()
  })

  it('① window.open（target=_blank）落在 shell origin 时不产生新标签', async () => {
    const runtime = makeRuntime()
    capturedWindowOpen = undefined
    // 先开一个正常标签：`setWindowOpenHandler` 是在建 tab 时装的，装机后才可断言。
    await runtime.open('https://a.example')
    expect(capturedWindowOpen, '建 tab 时必须装 setWindowOpenHandler（否则本判据是空转）').toBeTypeOf('function')

    // ⚠️ 这个 handler **恒返回 `{action:'deny'}`** —— 放行不等于 `allow`，而是由宿主
    // **自己**用 `this.open(target,…)` 把弹窗变成新标签（见 runtime.ts:853-869 的注释与
    // `void this.open(...)`）。所以判据不能比返回值，只能比**真实可观察量：标签数**：
    //  - shell origin ⇒ 不该多出标签（拒绝生效）；
    //  - 正常外站 ⇒ 必须多出一个标签（反向对照：不能把 window.open 一律掐死）。
    const before = runtime.listTabs().length
    capturedWindowOpen!({ url: `${SHELL}/api/pico/apps/wasm/demo/rows?unmask=1` })
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(runtime.listTabs().length, 'window.open 到 shell origin 不得产生新标签').toBe(before)

    capturedWindowOpen!({ url: 'https://b.example/page' })
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(runtime.listTabs().length, '正常外站的 window.open 必须仍然生效（不能一律拒）').toBe(before + 1)
    await runtime.dispose()
  })

  it('① browser_download 到 shell origin 被拒', async () => {
    const runtime = makeRuntime()
    await expect(runtime.downloadUrl(`${SHELL}/api/pico/apps/wasm/demo/export`)).rejects.toMatchObject({
      constructor: BrowserError,
      code: 'navigation-blocked',
    })
    await runtime.dispose()
  })

  it('② 反向对照：同一台机器上的**其它**端口仍然放行（真实开发用法）', () => {
    // 判据落在 scheme 策略层：guard 本身不拒回环（精确打击只针对被镜像 cookie 的那个 origin）。
    expect(classifyNavigation('http://127.0.0.1:5173/')).toBe('allow')
    expect(classifyNavigation('http://localhost:3000/app')).toBe('allow')
    expect(classifyNavigation('https://example.com/')).toBe('allow')
  })

  it('③ shell origin 未设置时不得拒绝一切（守卫缺席 ≠ 全拒）', async () => {
    const runtime = makeRuntime(false)
    // 没有 shell 就没有被镜像的 cookie，判据不成立 ⇒ 正常导航不该被这条挡掉。
    // （用 promise 的形态断言"不是 navigation-blocked"：真实 loadURL 会在 mock 适配器上
    //   以别的方式失败，这里只关心**拒绝理由**不是本判据。）
    const outcome = await runtime.navigate(1, 'http://127.0.0.1:5173/').then(
      () => 'resolved',
      (err: unknown) => (err instanceof BrowserError ? err.code : String(err)),
    )
    expect(outcome).not.toBe('navigation-blocked')
    await runtime.dispose()
  })
})
