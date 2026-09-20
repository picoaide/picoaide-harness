import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { URL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserGuard,
  classifyNavigation,
  ensureSessionGuard,
  isLocalHostname,
  installAppSchemeRequestGate,
  installPermissionGuard,
  MAX_DOWNLOAD_BYTES,
  navigationDenyReason,
  resolveDownloadPath,
} from '../src/guard.ts'
import type { DownloadRecorder } from '../src/guard.ts'
import type { NativeDownloadItem, NativeSession, NativeWebRequestSession } from '../src/electron-adapter.ts'

describe('navigation policy', () => {
  it('allows https and http', () => {
    expect(classifyNavigation('https://example.com/a?b=1')).toBe('allow')
    expect(classifyNavigation('http://example.com')).toBe('allow')
  })

  it('allows about:blank', () => {
    expect(classifyNavigation('about:blank')).toBe('allow')
  })

  it('denies dangerous schemes', () => {
    expect(classifyNavigation('javascript:alert(1)')).toBe('deny')
    expect(classifyNavigation('data:text/html,<script>1</script>')).toBe('deny')
    expect(classifyNavigation('file:///etc/passwd')).toBe('deny')
    expect(classifyNavigation('chrome://settings')).toBe('deny')
    expect(classifyNavigation('vbscript:x')).toBe('deny')
  })

  it('refuses the client application protocol on a browser tab (R2-P0-2 / §22.2 R4)', () => {
    // 2026-09-19 订正：内置浏览器**不得**导航到应用 scheme —— 自定义协议下
    // Origin/Sec-Fetch-* 恒为空，任意被浏览的 http(s) 页面都能发起"带身份的导航"，
    // 事后无法区分发起者。只有应用窗口可以（见下面那个 surface 用例）。
    expect(classifyNavigation('picoaide-app://demo/')).toBe('deny')
    expect(classifyNavigation('picoaide-app://demo/notes?page=2')).toBe('deny')
    // 渠道化后 scheme 是运行期值：任何非 http(s)/about 的 scheme 一律拒（不含名单）。
    expect(classifyNavigation('gentech-harness-app://demo/')).toBe('deny')
    expect(classifyNavigation('electron-app://x')).toBe('deny')
    expect(classifyNavigation('picoaide://app/demo')).toBe('deny')
  })

  it('allows the app scheme only on its own application surface (§16.1 按 surface 分流)', () => {
    const appSurface = { kind: 'app', appScheme: 'gentech-harness-app' } as const
    expect(classifyNavigation('gentech-harness-app://demo/', appSurface)).toBe('allow')
    expect(classifyNavigation('gentech-harness-app://demo/notes?page=2', appSurface)).toBe('allow')
    // 别的渠道的 scheme 与别的自定义协议在应用窗口里也拒（跨渠道隔离）。
    expect(classifyNavigation('picoaide-app://demo/', appSurface)).toBe('deny')
    expect(classifyNavigation('javascript:alert(1)', appSurface)).toBe('deny')
    // 应用窗口里的 http(s) 顶层导航也拒（外链走内置浏览器新标签，§7.2 冻结）。
    expect(classifyNavigation('https://evil.example/', appSurface)).toBe('deny')
    // 应用窗口没有 scheme 信息时不放宽任何东西（fail-closed）。
    expect(classifyNavigation('gentech-harness-app://demo/', { kind: 'app' })).toBe('deny')
  })

  it('denies empty, non-string and oversized URLs', () => {
    expect(classifyNavigation('')).toBe('deny')
    expect(classifyNavigation(42 as unknown as string)).toBe('deny')
    expect(classifyNavigation(`https://example.com/${'a'.repeat(9000)}`)).toBe('deny')
  })

  it('allows relative URLs (the page cannot escalate origin through them)', () => {
    expect(classifyNavigation('/relative/path')).toBe('allow')
  })

  it('produces a human-readable deny reason', () => {
    expect(navigationDenyReason('javascript:alert(1)')).toContain('javascript')
    expect(navigationDenyReason('')).toContain('empty or too long')
  })

  it('deny reason names the allowed schemes and the real reason for an app scheme', () => {
    const generic = navigationDenyReason('javascript:alert(1)')
    expect(generic).toContain('javascript')
    expect(generic).toContain('http')
    expect(generic).toContain('https')
    expect(navigationDenyReason('file:///etc/passwd')).toContain('"file:"')
    // 应用协议被拒的**真因**：它属于应用窗口，而不是"平台不支持这个 scheme"。
    // 说错方向会让模型绕道重试（审计里已经出现过一次这种误诊）。
    const appReason = navigationDenyReason('gentech-harness-app://demo/', { kind: 'app', appScheme: 'gentech-harness-app' })
    expect(appReason).toContain('application window')
    expect(appReason).toContain('R4')
  })
})

describe('download bound', () => {
  it('caps downloads at 100MB', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(100 * 1024 * 1024)
  })
})

describe('no browser approval seam (product decision 2026-08-26)', () => {
  it('guard.ts has no askApproval / requireApproval', () => {
    const source = readFileSync(new URL('../src/guard.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('askApproval')
    expect(source).not.toContain('requireApproval')
    expect(source).not.toContain("ctx.get('approval')")
  })

  it('tools.ts has no requireApproval calls', () => {
    const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('requireApproval')
    expect(source).not.toContain('not approved by the user')
  })

  it('index.ts does not wire the approval service', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).not.toContain("ctx.get('approval')")
    expect(source).not.toContain('dsh-user-approval')
  })
})

describe('permission guard installs BOTH Electron handlers (2026-09-11)', () => {
  it('denies permission checks as well as permission requests', () => {
    const requestHandlers: Array<(wc: unknown, permission: string, callback: (grant: boolean) => void) => void> = []
    let check: ((wc: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) | undefined
    const session = {
      setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (grant: boolean) => void) => void) {
        requestHandlers.push(handler)
      },
      setPermissionCheckHandler(handler: (wc: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) {
        check = handler
      },
    } as unknown as NativeSession

    const dispose = installPermissionGuard(session)
    expect(requestHandlers).toHaveLength(1)
    // Electron's check handler defaults to GRANTING when unset, and Chromium
    // only reaches the request handler when the check is denied — a request
    // handler alone is dead code.
    expect(check).toBeTypeOf('function')
    expect(check?.({}, 'media', 'https://evil.example', {})).toBe(false)
    expect(check?.({}, 'geolocation', 'https://evil.example', {})).toBe(false)
    let granted: boolean | undefined
    requestHandlers[0]?.({}, 'media', (value) => { granted = value })
    expect(granted).toBe(false)
    dispose()
  })
})

describe('download guard ref counting (2026-09-08 P0-5)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  function fakeSession() {
    const listeners: Array<(event: unknown, item: NativeDownloadItem) => void> = []
    return {
      listeners,
      on(_event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void {
        listeners.push(listener)
      },
      removeListener(_event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void {
        const idx = listeners.indexOf(listener)
        if (idx >= 0) listeners.splice(idx, 1)
      },
      emit(item: NativeDownloadItem): void {
        for (const listener of [...listeners]) listener({}, item)
      },
    }
  }

  function fakeItem(): NativeDownloadItem {
    return {
      getFilename: () => 'report.txt',
      getURL: () => 'https://example.com/report.txt',
      getReceivedBytes: () => 0,
      getTotalBytes: () => 10,
      setSavePath: () => {},
      cancel: () => {},
      on: () => {},
    } as unknown as NativeDownloadItem
  }

  it('keeps the shared session listener until the LAST tab releases it', () => {
    const guard = new BrowserGuard({} as never)
    const session = fakeSession()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-downloads-'))
    dirs.push(dir)
    const added: Array<{ fileName: string, actor?: string }> = []
    const recorder: DownloadRecorder = {
      add: (entry) => { added.push(entry); return added.length },
      update: () => {},
    }
    const native = session as unknown as NativeSession
    const disposeFirst = guard.installDownloadGuard(native, () => {}, recorder, '', 'user', dir)
    const disposeSecond = guard.installDownloadGuard(native, () => {}, recorder, '', 'ai', dir)
    expect(session.listeners).toHaveLength(1)
    // Closing the first tab must NOT disable interception for the rest.
    disposeFirst()
    expect(session.listeners).toHaveLength(1)
    session.emit(fakeItem())
    expect(added).toHaveLength(1)
    // The most recent registration owns the recorder context (a download has
    // no tab identity, so first-tab-forever attribution was wrong).
    expect(added[0]?.actor).toBe('ai')
    disposeSecond()
    expect(session.listeners).toHaveLength(0)
    session.emit(fakeItem())
    expect(added).toHaveLength(1)
  })

describe('下载文件名净化（2026-09-15 审计 P2-6）', () => {
  it('Windows 保留设备名 / 结尾点与空格不会静默丢失或覆盖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-dl-'))
    try {
      // Windows 会把 join(dir,'NUL') 解析成 NUL 设备：下载"成功"但盘上零字节
      expect(basename(resolveDownloadPath(dir, 'NUL'))).toBe('_NUL')
      expect(basename(resolveDownloadPath(dir, 'nul.txt'))).toBe('_nul.txt')
      expect(basename(resolveDownloadPath(dir, 'COM1.pdf'))).toBe('_COM1.pdf')
      expect(basename(resolveDownloadPath(dir, 'lpt9'))).toBe('_lpt9')
      // 结尾点/空格会被系统裁掉 ⇒ existsSync('foo.') 为假，会覆盖已存在的 foo
      expect(basename(resolveDownloadPath(dir, '报告.'))).toBe('报告')
      expect(basename(resolveDownloadPath(dir, 'name. '))).toBe('name')
      // 空名/纯符号兜底成可用名字
      expect(basename(resolveDownloadPath(dir, '..'))).toBe('download')
      expect(basename(resolveDownloadPath(dir, '  '))).toBe('download')
      // 正常名字不受影响；非法字符照旧替换
      expect(basename(resolveDownloadPath(dir, '报告.pdf'))).toBe('报告.pdf')
      expect(basename(resolveDownloadPath(dir, 'x|y?.zip'))).toBe('x_y_.zip')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
})

/**
 * 分区级权限守卫（§16.1 冻结：归属 = **分区初始化**，不是建 tab 时）。
 *
 * 缺口形态（主控 2026-09-19 只读预审计）：唯一安装点是建 tab 路径 ⇒ **一张浏览器标签都没
 * 开过就创建应用窗口**时，该分区的 check handler 缺失，而 Electron 缺 check 时**默认放行**
 * camera/mic/geolocation。
 */
describe('ensureSessionGuard：分区级幂等（CLI-2 / §16.1）', () => {
  /** 假 session：记录两个 handler 的安装次数与最后一次实现。 */
  function fakeSession() {
    const requestHandlers: Array<(wc: unknown, permission: string, callback: (grant: boolean) => void) => void> = []
    let check: ((wc: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) | undefined
    const session = {
      setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (grant: boolean) => void) => void) {
        requestHandlers.push(handler)
      },
      setPermissionCheckHandler(handler: (wc: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) {
        check = handler
      },
    } as unknown as NativeSession
    return { session, requestHandlers, check: () => check }
  }

  it('首次调用装两个 handler，重复调用是 no-op（幂等）', () => {
    const fake = fakeSession()
    expect(ensureSessionGuard(fake.session)).toBe(true)
    expect(ensureSessionGuard(fake.session)).toBe(false)
    expect(ensureSessionGuard(fake.session)).toBe(false)
    expect(fake.requestHandlers).toHaveLength(1)
    expect(fake.check()).toBeTypeOf('function')
  })

  it('未开过任何浏览器标签的 session 也会被装上守卫（应用窗口路径的形态）', () => {
    // 应用窗口宿主只做一件事：拿到分区 session 就 ensureSessionGuard —— 不需要先有标签。
    const fake = fakeSession()
    ensureSessionGuard(fake.session)
    let granted: boolean | undefined
    fake.requestHandlers[0]?.({}, 'media', (value) => { granted = value })
    expect(granted).toBe(false)
    expect(fake.check()?.({}, 'geolocation', 'https://evil.example', {})).toBe(false)
    expect(fake.check()?.({}, 'notifications', 'https://evil.example', {})).toBe(false)
  })
})

/**
 * session 级应用 scheme 请求闸门（R2S-7 / §23.2 N6）。
 *
 * 为什么必须有：`will-navigate`/`setWindowOpenHandler` 覆盖不到**子资源**请求 —— 任意
 * http(s) 页面写 `<img src="<scheme>://<app>/…">`、`sendBeacon`、`prefetch`、SW 都能抵达
 * 协议 handler，而 handler 会**带员工 bearer 转发**。判据按 R2T-7 的纪律：断言"请求**未抵达**
 * handler"（只看"响应被拦"不算）。
 */
describe('installAppSchemeRequestGate：只有应用窗口能触发应用 scheme 请求（N6）', () => {
  function fakeWebRequestSession() {
    const listeners: Array<(details: { url: string, webContentsId?: number, resourceType?: string }, callback: (response: { cancel?: boolean }) => void) => void> = []
    const filters: Array<{ urls: string[] }> = []
    const session = {
      webRequest: {
        onBeforeRequest(filter: { urls: string[] }, listener: (typeof listeners)[number]) {
          filters.push(filter)
          listeners.push(listener)
        },
      },
    } as unknown as NativeWebRequestSession
    /** 模拟一次请求：返回 Electron 会怎么处置它。 */
    const fire = (url: string, webContentsId: number): { cancel?: boolean } => {
      let outcome: { cancel?: boolean } = {}
      listeners[0]?.({ url, webContentsId, resourceType: 'image' }, (response) => { outcome = response })
      return outcome
    }
    return { session, filters, fire }
  }

  it('取消非应用窗口发起的应用 scheme 请求（img/beacon/prefetch 同一条路）', () => {
    const warn = vi.fn()
    const fake = fakeWebRequestSession()
    installAppSchemeRequestGate(fake.session, { scheme: 'harness-app', isAppSurfaceWebContents: () => false, warn })
    expect(fake.filters[0]?.urls).toEqual(['harness-app://*/*'])
    // 请求**根本不会抵达 handler**：Electron 收到的是 cancel。
    expect(fake.fire('harness-app://my-notes/api/data', 42)).toEqual({ cancel: true })
    expect(warn).toHaveBeenCalled()
  })

  it('放行应用窗口自己发出的请求（含子资源），且不碰其它协议', () => {
    const fake = fakeWebRequestSession()
    installAppSchemeRequestGate(fake.session, {
      scheme: 'harness-app',
      isAppSurfaceWebContents: id => id === 7,
    })
    expect(fake.fire('harness-app://my-notes/icon.png', 7)).toEqual({})
    // 非本 scheme 的请求直接放行（过滤器只覆盖本 scheme）。
    expect(fake.fire('https://example.com/x', 42)).toEqual({})
    // 渠道隔离：别的渠道的 scheme 不在过滤器里，也不会被这条闸门"顺手"处理。
    expect(fake.fire('other-channel-app://my-notes/', 42)).toEqual({})
  })

  it('注销后不再取消（宿主重建分区时的形态）', () => {
    const fake = fakeWebRequestSession()
    const dispose = installAppSchemeRequestGate(fake.session, { scheme: 'harness-app', isAppSurfaceWebContents: () => false })
    expect(fake.fire('harness-app://my-notes/', 1)).toEqual({ cancel: true })
    dispose()
    expect(fake.fire('harness-app://my-notes/', 1)).toEqual({})
  })
})

describe('isLocalHostname：本机目标判定（五轮审计 P2-①/P3-①）', () => {
  /**
   * 为什么这条判据必须**表驱动且双向**（2026-09-21 五轮审计）：
   *  - 漏判方向：`localhost.` / `*.localhost` / `ip6-localhost` / `[::]` /
   *    `[::ffff:127.0.0.1]` 这些写法**真的会落到本机监听**（真机实测），
   *    而"AI 浏览器不访问本机地址"这条承诺就靠这个函数兑现；
   *  - 误判方向：朴素的前缀判据会把 `127.example.com`（合法公网域名，只是以 "127." 开头）
   *    当成回环 ⇒ 把一个正常站点封掉。
   */
  const locals = [
    '127.0.0.1', '127.0.0.1:8080'.split(':')[0]!, '127.1.2.3', '127.255.255.255',
    '0.0.0.0',
    'localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'a.b.localhost',
    'ip6-localhost', 'ip6-loopback', 'localhost.localdomain',
    '[::1]', '::1', '[::]', '::',
    '[::ffff:127.0.0.1]', '::ffff:127.0.0.1', '[::ffff:7f00:1]',
  ]
  const remotes = [
    'example.com', '127.example.com', '127.0.0.1.evil.example', 'localhost.evil.example',
    'notlocalhost', 'my.localhost.example', 'example.org',
    '128.0.0.1', '126.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.1.1',
    '999.0.0.1', '127.0.0', '127.0.0.1.5',
    '[2001:db8::1]', '::2', '[::ffff:128.0.0.1]',
  ]

  it('本机写法逐个命中', () => {
    for (const host of locals) expect(isLocalHostname(host), host).toBe(true)
  })

  it('解析失败的**绝对** http(s) URL 一律拒（六轮审计 P2-①：Node 与 Chromium 的接受面不同）', () => {
    // 实测：`http://[::ffff:0177.0.0.1]:8080/` 在 Node 的 WHATWG 解析器里抛错、
    // 而 Chromium **接受并归一化成回环** `[::ffff:7f00:1]`。旧实现 catch 后返回 'allow'
    // ⇒ 闸门对该 URL 失效，而 Chromium 照常落到本机监听（真机实测模型读到了本机正文）。
    // 口径：带 scheme 的绝对 URL 解析失败 ⇒ deny；纯相对路径才放行。
    for (const raw of [
      'http://[::ffff:0177.0.0.1]:8080/',
      'http://[::ffff:127.0.0.01]/',
      'http://[::ffff:0x7f.0.0.1]:9/',
      'HTTPS://[::ffff:0177.0.0.1]/x',
      'http://[fe80::1%25eth0]:80/',
    ]) {
      expect(classifyNavigation(raw), raw).toBe('deny')
    }
    // 反向对照：相对路径仍然放行（页面无法借它越出自己的 origin）。
    expect(classifyNavigation('/local/path')).toBe('allow')
    expect(classifyNavigation('relative.html')).toBe('allow')
  })

  it('公网/其它私网写法逐个不命中（防"什么都拒"与"127. 前缀"误判）', () => {
    for (const host of remotes) expect(isLocalHostname(host), host).toBe(false)
  })
})
