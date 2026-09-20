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
  /** 视图上注册的事件监听器（本用例要直接触发 will-navigate / will-redirect）。 */
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
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
      on: (event: string, listener: (...args: unknown[]) => void) => {
        const list = this.listeners.get(event) ?? []
        list.push(listener)
        this.listeners.set(event, list)
      },
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
  readonly createdViews: MockView[] = []
  createView(): never {
    const view = new MockView()
    view.session = this.partitionSession
    this.createdViews.push(view)
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

function makeRuntime(withShellOrigin = true): { runtime: BrowserRuntime, adapter: MockAdapter } {
  const dir = join(process.cwd(), 'tests', `.shell-origin-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  const adapter = new MockAdapter()
  const runtime = new BrowserRuntime(adapter as never, {}, undefined, 'persist:test-part', {
    store: new BrowserStore({ dir }),
  })
  if (withShellOrigin) runtime.setShellOrigin(SHELL)
  return { runtime, adapter }
}

describe('内置浏览器不得导航到本机 shell origin（三轮审计 P1-①）', () => {
  it('① browser_navigate 到 shell origin 被拒（含 rows?unmask=1 的绕过尝试）', async () => {
    const { runtime } = makeRuntime()
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
    const { runtime } = makeRuntime()
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
    // ⚠️ "标签数不变"这一条**单独不足以**证明是这一行闸门起的作用（四轮审计实测：把这行
    // 换回 `guard.allowNavigation` 后本用例仍绿 —— 因为弹窗随后经 `this.open()` →
    // `navigateInternal` 的闸门被拒，标签同样不会出现）。所以再加一条**独立可观察量**：
    // op log 里必须出现"由 window.open 闸门记下的拒绝"，而不是"打开失败"。
    const denied = runtime.opLog.filter(op => /window\.open denied/u.test(op.summary))
    expect(denied.length, 'window.open 闸门必须自己记一条拒绝（否则这条判据被 navigate 闸门兜住、不独立承重）').toBeGreaterThan(0)
    expect(denied.at(-1)!.failed).toBe(true)

    capturedWindowOpen!({ url: 'https://b.example/page' })
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(runtime.listTabs().length, '正常外站的 window.open 必须仍然生效（不能一律拒）').toBe(before + 1)
    await runtime.dispose()
  })

  it('① browser_download 到 shell origin 被拒', async () => {
    const { runtime } = makeRuntime()
    await expect(runtime.downloadUrl(`${SHELL}/api/pico/apps/wasm/demo/export`)).rejects.toMatchObject({
      constructor: BrowserError,
      code: 'navigation-blocked',
    })
    await runtime.dispose()
  })

  it('① 页面自己发起的导航与**服务端重定向**落到 shell origin 也被拒（will-navigate/will-redirect）', async () => {
    // 为什么这条必须独立存在（2026-09-21）：`browser_navigate` 那条闸只罩"模型显式调用的
    // 导航"。模型可以先把标签导航到一个**它控制的**外站，再让那个站 302 到
    // `http://127.0.0.1:<port>/api/pico/...`（Electron 对重定向**不触发** `will-navigate`），
    // 或（若 eval 允许）直接 `location.href = …` —— 两者都在**持有被镜像 cookie 的标签里**
    // 发生，于是同样绕过所有依赖持有性证明的本机守卫。
    const { runtime } = makeRuntime()
    const adapter = (runtime as unknown as { adapter: MockAdapter }).adapter
    await runtime.open('https://a.example')
    const view = adapter.createdViews.at(-1)
    expect(view, '应能拿到刚创建的标签视图').toBeDefined()
    const fire = (event: string, url: string): { prevented: boolean } => {
      const state = { prevented: false }
      const handler = view!.listeners.get(event)?.[0]
      expect(handler, `标签视图必须注册 ${event} 闸门（否则这条判据是空转）`).toBeTypeOf('function')
      handler!({ preventDefault: () => { state.prevented = true } }, url)
      return state
    }
    // 两条事件都必须在 shell origin 上**取消**导航。
    expect(fire('will-redirect', `${SHELL}/api/pico/apps/wasm/demo/rows?unmask=1`).prevented).toBe(true)
    expect(fire('will-navigate', `${SHELL}/api/pico/apps/wasm/demo/rows?unmask=1`).prevented).toBe(true)
    // 反向对照：正常外站（含重定向目标）不得被取消。
    expect(fire('will-redirect', 'https://b.example/next').prevented).toBe(false)
    expect(fire('will-navigate', 'https://b.example/next').prevented).toBe(false)
    await runtime.dispose()
  })

  it('② 反向对照：**本机一律拒**、外站一律放行（不得退化成"什么都拒"）', async () => {
    // 为什么本机是"一律拒"而不是"只拒 shell origin"（2026-09-21 四轮审计 P1）：
    // 镜像的 `dsh-auth-*` 是 **host-only** cookie，而 **cookie 不看端口** ⇒ 浏览器会把它
    // 送到 `127.0.0.1` 的**任意端口**。模型在自己端口上起个静态页再导航过去，就能在
    // 自己的服务器日志里拿到这把 cookie（= 本机控制面的 bearer 凭据，可重放 login /
    // 会话切换 / 技能安装 / `rows?unmask=1`）。同 host 不同端口属 **same-site**，
    // SameSite=Strict **不拦**，所以"外部页面里 iframe 一个本机端口"同样危险。
    // 口径因此收紧为：AI 浏览器不访问本机地址（平台自己的页面由宿主 loadURL 直接加载，
    // 应用走应用窗口面，都不经这里）。
    const { runtime } = makeRuntime()
    for (const local of [
      'http://127.0.0.1:5173/',        // 曾经的"合法 dev server"——现在是凭据外带路径
      'http://127.0.0.1:1/',
      'http://localhost:3000/app',
      'http://[::1]:8080/',
      'http://0.0.0.0:9000/',
      `${SHELL}/api/pico/apps/wasm`,
    ]) {
      await expect(runtime.navigate(1, local), local).rejects.toMatchObject({ code: 'navigation-blocked' })
    }
    // 外站必须照常放行（反向对照：防"把所有导航都拒掉"的假安全）。
    expect(classifyNavigation('https://example.com/')).toBe('allow')
    expect(classifyNavigation('http://example.org/a')).toBe('allow')
    await runtime.dispose()
  })

  it('④ 子框架导航（iframe）到本机目标也被拒 —— 四轮审计 P0', async () => {
    // `will-navigate` / `will-redirect` **只报主框架**；`<iframe src="http://127.0.0.1:<端口>/…">`
    // 是子框架导航。四轮审计真机复现：模型用一个自己控制的本机页面做父页
    //（同 host ⇒ same-site ⇒ 镜像 cookie 被带上），再 `browser_eval({frame:1})` 读子框架
    // 内容，拿回 `unmask` 后的行数据。这条钉 `will-frame-navigate` 闸门存在且生效。
    const { runtime, adapter } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.createdViews.at(-1)
    const state = { prevented: false }
    const handler = view!.listeners.get('will-frame-navigate')?.[0]
    expect(handler, '标签视图必须注册 will-frame-navigate（否则这条判据是空转）').toBeTypeOf('function')
    handler!({ url: `${SHELL}/api/pico/apps/wasm/demo/rows?unmask=1`, isMainFrame: false, preventDefault: () => { state.prevented = true } })
    expect(state.prevented, '子框架导航到本机目标必须被取消').toBe(true)
    // 反向对照：子框架指向外站不得被取消（正常的第三方 iframe 仍要能显示）。
    const ok = { prevented: false }
    handler!({ url: 'https://widgets.example/embed', isMainFrame: false, preventDefault: () => { ok.prevented = true } })
    expect(ok.prevented).toBe(false)
    await runtime.dispose()
  })

  it('③ shellOrigin 未设置时，本机目标仍被拒、外站不受影响', async () => {
    // `shellOrigin` 缺席（非 Electron 宿主/测试）不能让本机判据整体失效 ——
    // 本机禁访的依据是"那里有被镜像的凭据"，不是"shellOrigin 这个字符串存不存在"。
    const { runtime } = makeRuntime(false)
    await expect(runtime.navigate(1, 'http://127.0.0.1:5173/')).rejects.toMatchObject({ code: 'navigation-blocked' })
    const outcome = await runtime.navigate(1, 'https://a.example/').then(
      () => 'resolved',
      (err: unknown) => (err instanceof BrowserError ? err.code : String(err)),
    )
    expect(outcome).not.toBe('navigation-blocked')
    await runtime.dispose()
  })
})
