/**
 * 渲染进程错误采集（P0-6 / 决策 D8，2026-09-16）。
 *
 * 事故背景：GlitchTip「收集不到内容」——错误上报此前只覆盖主进程，渲染进程里
 * 用户真实遇到的未捕获错误（React 渲染异常、IPC 失败、前端未捕获异常）与渲染
 * 进程崩溃**一条都不会进 GlitchTip**。这组用例钉住五件事：
 *  1. preload 把**主世界**（注入片段）的 `window.onerror` / `unhandledrejection`
 *     经 DOM CustomEvent 桥回隔离世界，再转给主进程（F-01 修复的机制本体）；
 *  2. preload 侧有风暴闸门（渲染循环每帧抛错不能刷爆 IPC 与上报后端）；
 *  3. preload **不向页面暴露 API、不持有 DSN、不发网络请求**（静态守护）；
 *  4. 主进程把 IPC 当**不可信边界**：形状不对的载荷丢弃，超长字段截断；
 *  5. 注入不可用时降级到隔离世界监听（不比修复前更差）。
 *
 * ⚠️ 单元测试**不能**证明"主世界监听真的收到页面错误"——那是世界选择问题，
 * 只有真机 Electron 能证。行为级门禁见 `scripts/verify-renderer-error-capture.mjs`
 * 与 `e2e:client` 的「渲染进程未捕获错误真实进链路」断言（F-11）。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  describeThrown,
  normalizeRendererErrorReport,
  RENDERER_ERROR_CHANNEL,
  RENDERER_ERROR_MAX_TEXT,
  RendererErrorGate,
  type RendererErrorPayload,
} from '../src/renderer-error-contract.ts'
import {
  hasRendererErrorSink,
  installRendererErrorCapture,
  reportRendererError,
  setRendererErrorSink,
  type RendererErrorIpc,
} from '../src/renderer-error-capture.ts'
import { desktopWindowOptions } from '../src/window-options.ts'
import type { DesktopShellSpec } from '../src/runtime.ts'

import {
  buildRendererErrorBridgeSnippet,
  installRendererErrorForwarding,
  installIsolatedWorldForwarding,
  parseRendererErrorBridgeDetail,
  RENDERER_ERROR_BRIDGE_EVENT,
} from '../src/preload/renderer-error.ts'

/** ipcRenderer 替身:捕获 preload 实际发出的通道与载荷。 */
const ipcRendererMock = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: ipcRendererMock, webFrame: undefined, app: {}, BrowserWindow: class {} }))

/** 剥掉块注释与行注释(静态守护要看的是代码,不是文档)。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const PRELOAD_SOURCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/preload/renderer-error.ts',
)

/** 监听器替身:记录 add/remove,便于断言"装在哪、装了什么"。 */
function fakeWindow(href = 'http://127.0.0.1/app'): Window & {
  listeners: Map<string, (event: unknown) => void>
  dispatched: { type: string, detail: unknown }[]
} {
  const listeners = new Map<string, (event: unknown) => void>()
  const dispatched: { type: string, detail: unknown }[] = []
  return {
    listeners,
    dispatched,
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.set(type, fn) },
    removeEventListener: (type: string) => { listeners.delete(type) },
    dispatchEvent: (event: { type: string, detail?: unknown }) => {
      dispatched.push({ type: event.type, detail: event.detail })
      return true
    },
    location: { href },
  } as unknown as Window & {
    listeners: Map<string, (event: unknown) => void>
    dispatched: { type: string, detail: unknown }[]
  }
}

/** CustomEvent 替身(片段里只用到 `new CustomEvent(type, { detail })`)。 */
class FakeCustomEvent {
  readonly detail: unknown
  constructor(readonly type: string, init?: { detail?: unknown }) {
    this.detail = init?.detail
  }
}

/**
 * 在最小替身里**执行注入片段**(它本来就是一段发给主世界的源码字符串),
 * 这样被测的就是真正会跑在主世界的那段代码,而不是另写一份等价逻辑。
 */
function runBridgeSnippet(snippet: string): {
  window: ReturnType<typeof fakeWindow>
  result: unknown
} {
  const target = fakeWindow()
  const run = new Function('window', 'CustomEvent', `return ${snippet}`) as (
    window: unknown,
    CustomEvent: unknown,
  ) => unknown
  const result = run(target, FakeCustomEvent)
  return { window: target, result }
}

beforeEach(() => {
  ipcRendererMock.send.mockClear()
  // 模块级 sink 是单例:每个用例后清掉,避免相互污染。
})

describe('preload:主世界注入片段（F-01）', () => {
  it('片段在页面世界把 error 归一化并经 CustomEvent 桥回传', () => {
    const snippet = buildRendererErrorBridgeSnippet({ bridgeEvent: 'x-bridge' })
    const { window, result } = runBridgeSnippet(snippet)
    expect(result).toBe('installed')
    expect([...window.listeners.keys()].sort()).toEqual(['error', 'unhandledrejection'])

    const error = new Error('Uncaught TypeError: x is not a function')
    window.listeners.get('error')!({
      message: 'Uncaught TypeError: x is not a function',
      error,
      filename: 'http://127.0.0.1:34567/app.js',
      lineno: 12,
      colno: 34,
    })

    expect(window.dispatched).toHaveLength(1)
    expect(window.dispatched[0]!.type).toBe('x-bridge')
    const detail = JSON.parse(String(window.dispatched[0]!.detail)) as Record<string, unknown>
    expect(detail.type).toBe('error')
    expect(detail.message).toBe('Uncaught TypeError: x is not a function')
    expect(String(detail.stack)).toContain('Uncaught TypeError')
    expect(detail.source).toBe('http://127.0.0.1:34567/app.js')
    expect(detail.lineno).toBe(12)
    expect(detail.colno).toBe(34)
    expect(detail.url).toBe('http://127.0.0.1/app')
  })

  it('片段把 unhandledrejection 的 Error / 字符串 / 对象 / 原始值都给出可读消息', () => {
    const { window } = runBridgeSnippet(buildRendererErrorBridgeSnippet({ bridgeEvent: 'x-bridge' }))
    const reject = window.listeners.get('unhandledrejection')!
    reject({ reason: new Error('boom-error') })
    reject({ reason: 'boom-string' })
    reject({ reason: { message: 'boom-object' } })
    reject({ reason: 42 })

    const messages = window.dispatched.map((entry) => (JSON.parse(String(entry.detail)) as { message: string }).message)
    expect(messages).toEqual([
      'boom-error',
      'boom-string',
      'boom-object',
      'Unhandled rejection ([object Number])',
    ])
    const first = JSON.parse(String(window.dispatched[0]!.detail)) as Record<string, unknown>
    expect(first.type).toBe('unhandledrejection')
    // Error 原因必须带上栈（否则 GlitchTip 里无法定位）。
    expect(String(first.stack)).toContain('boom-error')
  })

  it('主世界先截断超长字段（不把巨型栈序列化两遍）', () => {
    const { window } = runBridgeSnippet(
      buildRendererErrorBridgeSnippet({ bridgeEvent: 'x-bridge', maxText: 32, maxUrl: 16 }),
    )
    window.listeners.get('error')!({
      message: 'm'.repeat(100),
      error: { stack: 's'.repeat(100) },
      filename: 'f'.repeat(100),
      lineno: 1,
    })
    const detail = JSON.parse(String(window.dispatched[0]!.detail)) as Record<string, unknown>
    expect(detail.message).toHaveLength(32)
    expect(detail.stack).toHaveLength(32)
    expect(detail.source).toHaveLength(16)
  })

  it('重复注入被去重标记挡住（不重复注册监听器）', () => {
    const snippet = buildRendererErrorBridgeSnippet({ bridgeEvent: 'x-bridge' })
    const target = fakeWindow()
    const run = new Function('window', 'CustomEvent', `return ${snippet}`) as (w: unknown, c: unknown) => unknown
    expect(run(target, FakeCustomEvent)).toBe('installed')
    expect(run(target, FakeCustomEvent)).toBe('already-installed')
    expect([...target.listeners.keys()].sort()).toEqual(['error', 'unhandledrejection'])
  })

  it('片段自身不联网、不碰 DSN、不向页面挂可调用函数', () => {
    const snippet = buildRendererErrorBridgeSnippet()
    expect(snippet).not.toMatch(/\bfetch\s*\(/)
    expect(snippet).not.toMatch(/XMLHttpRequest|WebSocket|sendBeacon/)
    expect(snippet).not.toMatch(/ipcRenderer|contextBridge|require\s*\(/)
    expect(snippet).not.toMatch(/dsn/i)
    // 只读两个事件 + dispatch 桥事件,不调用任何页面提供的函数。
    expect(snippet).toContain('addEventListener')
    expect(snippet).toContain('dispatchEvent')
  })
})

describe('preload:桥入口与安装（F-01）', () => {
  it('桥事件 detail 走与 IPC 相同的归一化（页面可以伪造 ⇒ 不可信方向）', () => {
    const good = parseRendererErrorBridgeDetail(JSON.stringify({ type: 'error', message: 'bridge-ok' }))
    expect(good).toEqual({ type: 'error', message: 'bridge-ok' })
    // 非法/伪造/超长:拒绝或截断,绝不原样透传。
    expect(parseRendererErrorBridgeDetail('not-json')).toBeUndefined()
    expect(parseRendererErrorBridgeDetail('')).toBeUndefined()
    expect(parseRendererErrorBridgeDetail(undefined)).toBeUndefined()
    expect(parseRendererErrorBridgeDetail(JSON.stringify({ type: 'evil', message: 'x' }))).toBeUndefined()
    expect(parseRendererErrorBridgeDetail(JSON.stringify({ type: 'error' }))).toBeUndefined()
    const huge = parseRendererErrorBridgeDetail(
      JSON.stringify({ type: 'error', message: 'y'.repeat(RENDERER_ERROR_MAX_TEXT + 100) }),
    )
    expect(huge?.message).toHaveLength(RENDERER_ERROR_MAX_TEXT)
  })

  it('安装时注入主世界,并把桥事件转发到 IPC', async () => {
    const executeJavaScript = vi.fn((_code: string) => Promise.resolve('installed'))
    const target = fakeWindow()
    const dispose = installRendererErrorForwarding(target, { executeJavaScript })
    expect(executeJavaScript).toHaveBeenCalledTimes(1)
    expect(String(executeJavaScript.mock.calls[0]![0])).toContain('unhandledrejection')
    // 注入可用时**不**装隔离世界监听(那是降级路径)。
    expect([...target.listeners.keys()]).toEqual([RENDERER_ERROR_BRIDGE_EVENT])

    target.listeners.get(RENDERER_ERROR_BRIDGE_EVENT)!(new FakeCustomEvent('bridge', {
      detail: JSON.stringify({ type: 'error', message: 'bridge-ipc-1', lineno: 3 }),
    }))
    expect(ipcRendererMock.send).toHaveBeenCalledTimes(1)
    const [channel, payload] = ipcRendererMock.send.mock.calls[0]! as [string, RendererErrorPayload]
    expect(channel).toBe(RENDERER_ERROR_CHANNEL)
    expect(payload).toMatchObject({ type: 'error', message: 'bridge-ipc-1', lineno: 3 })

    // 伪造/垃圾桥事件不产生 IPC。
    target.listeners.get(RENDERER_ERROR_BRIDGE_EVENT)!(new FakeCustomEvent('bridge', { detail: 'garbage' }))
    target.listeners.get(RENDERER_ERROR_BRIDGE_EVENT)!(new FakeCustomEvent('bridge', {
      detail: JSON.stringify({ type: 'evil', message: 'x' }),
    }))
    expect(ipcRendererMock.send).toHaveBeenCalledTimes(1)

    dispose()
    expect([...target.listeners.keys()]).toEqual([])
  })

  it('注入不可用或失败时降级到隔离世界监听（不比修复前更差）', async () => {
    // 1) webFrame 完全不可用(测试/SSR 式环境)。
    const targetA = fakeWindow()
    const disposeA = installRendererErrorForwarding(targetA, undefined)
    expect([...targetA.listeners.keys()].sort()).toEqual(
      ['error', 'unhandledrejection', RENDERER_ERROR_BRIDGE_EVENT].sort(),
    )
    disposeA()

    // 2) 注入同步抛错。
    const targetB = fakeWindow()
    const disposeB = installRendererErrorForwarding(targetB, {
      executeJavaScript: () => { throw new Error('injection unavailable') },
    })
    expect(targetB.listeners.has('error')).toBe(true)
    expect(targetB.listeners.has('unhandledrejection')).toBe(true)

    // 3) 注入 promise 被拒(异步失败)⇒ 稍后补上降级监听。
    const targetC = fakeWindow()
    installRendererErrorForwarding(targetC, {
      executeJavaScript: () => Promise.reject(new Error('injection rejected')),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(targetC.listeners.has('error')).toBe(true)
    disposeB()
  })

  it('降级路径的监听器能把隔离世界的错误转成 IPC（原行为保留）', () => {
    const target = fakeWindow()
    const dispose = installIsolatedWorldForwarding(target)
    expect([...target.listeners.keys()].sort()).toEqual(['error', 'unhandledrejection'])

    target.listeners.get('error')!({
      message: 'isolated-fallback-1',
      error: new Error('isolated-fallback-1'),
      filename: 'http://127.0.0.1:34567/app.js',
      lineno: 12,
      colno: 34,
    })
    const [channel, payload] = ipcRendererMock.send.mock.calls[0]! as [string, RendererErrorPayload]
    expect(channel).toBe(RENDERER_ERROR_CHANNEL)
    expect(payload).toMatchObject({ type: 'error', message: 'isolated-fallback-1', lineno: 12, colno: 34 })
    dispose()
    expect([...target.listeners.keys()]).toEqual([])
  })
})

describe('preload:静态守护（渲染进程不碰 DSN / 不发网络 / 不暴露 API）', () => {
  it('源码不含 contextBridge、网络调用或任何上报地址', () => {
    // 注释里会**说明**"不用 contextBridge / 不持有 DSN",所以先剥注释再断言实际代码,
    // 否则守护会被自己的文档绊倒(而文档正是这条红线的可读载体)。
    const code = stripComments(readFileSync(PRELOAD_SOURCE, 'utf8'))
    // 不向页面暴露 API:页面脚本无法借此伪造/读取任何东西。
    expect(code).not.toMatch(/contextBridge\s*[.(]/)
    expect(code).not.toMatch(/exposeInMainWorld\s*\(/)
    // 渲染进程绝不直接发网络请求(一切经主进程)。
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/require\(['"]node:(https?|net|tls)['"]\)/)
    expect(code).not.toMatch(/from ['"]node:(https?|net|tls)['"]/)
    // 绝不持有 DSN / Sentry(没有任何 dsn 赋值或 sentry import)。
    expect(code).not.toContain('@sentry')
    expect(code).not.toMatch(/dsn\s*[:=]/i)
    expect(code).toContain('ipcRenderer.send')
  })
})

describe('RendererErrorGate:错误风暴闸门', () => {
  const payload = (message: string, type: RendererErrorPayload['type'] = 'error'): RendererErrorPayload => ({ type, message })

  it('同一 (type,message) 只放行一次', () => {
    const gate = new RendererErrorGate(20, 10_000)
    expect(gate.accept(payload('boom'), 0)).toBe(true)
    expect(gate.accept(payload('boom'), 1)).toBe(false)
    // 不同类型算不同事件。
    expect(gate.accept(payload('boom', 'unhandledrejection'), 2)).toBe(true)
  })

  it('窗口期内封顶，窗口滚动后恢复', () => {
    const gate = new RendererErrorGate(3, 1_000)
    expect(gate.accept(payload('a'), 0)).toBe(true)
    expect(gate.accept(payload('b'), 0)).toBe(true)
    expect(gate.accept(payload('c'), 0)).toBe(true)
    // 第 4 条被窗口上限挡下（渲染循环每帧抛错也不能刷爆 IPC）。
    expect(gate.accept(payload('d'), 0)).toBe(false)
    // 滚动到下一个窗口:上限与去重都重置。
    expect(gate.accept(payload('d'), 1_000)).toBe(true)
    expect(gate.accept(payload('a'), 1_001)).toBe(true)
  })
})

describe('normalizeRendererErrorReport:IPC 是不可信边界', () => {
  it('拒绝非对象与未知类型', () => {
    expect(normalizeRendererErrorReport(null).ok).toBe(false)
    expect(normalizeRendererErrorReport('boom').ok).toBe(false)
    expect(normalizeRendererErrorReport([]).ok).toBe(false)
    expect(normalizeRendererErrorReport({ type: 'evil', message: 'x' }).ok).toBe(false)
    // 缺 message / message 非字符串都必须拒绝(不猜测、不补默认值)。
    expect(normalizeRendererErrorReport({ type: 'error' }).ok).toBe(false)
    expect(normalizeRendererErrorReport({ type: 'error', message: 42 }).ok).toBe(false)
  })

  it('截断超长字段并丢弃越界行号', () => {
    const huge = 'x'.repeat(RENDERER_ERROR_MAX_TEXT + 5000)
    const result = normalizeRendererErrorReport({
      type: 'error',
      message: huge,
      stack: huge,
      lineno: -1,
      colno: 1.5,
      source: 'y'.repeat(5000),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.message.length).toBe(RENDERER_ERROR_MAX_TEXT)
    expect(result.report.stack?.length).toBe(RENDERER_ERROR_MAX_TEXT)
    // 负数/非整数行号一律丢弃(不 clamp 成误导性数字)。
    expect(result.report.lineno).toBeUndefined()
    expect(result.report.colno).toBeUndefined()
    expect(result.report.source!.length).toBeLessThanOrEqual(2048)
  })
})

describe('describeThrown', () => {
  it('从任意 rejection 原因里保守提取消息', () => {
    expect(describeThrown(new Error('e')).message).toBe('e')
    expect(describeThrown('s').message).toBe('s')
    expect(describeThrown(null).message).toBe('Unhandled rejection')
    expect(describeThrown({ message: 'o' }).message).toBe('o')
    // 无 message 的对象:给类型描述,而不是 JSON.stringify(可能巨大/循环)。
    expect(describeThrown({ a: 1 }).message).toContain('Object')
  })
})

describe('installRendererErrorCapture:主进程侧收口', () => {
  function fakeIpc(): RendererErrorIpc & { emit: (channel: string, payload: unknown) => void, listeners: number } {
    const handlers = new Map<string, (event: unknown, payload: unknown) => void>()
    const ipc = {
      listeners: 0,
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
        handlers.set(channel, listener)
        ipc.listeners = handlers.size
      },
      removeListener: (channel: string) => {
        handlers.delete(channel)
        ipc.listeners = handlers.size
      },
      emit: (channel: string, payload: unknown) => { handlers.get(channel)?.({}, payload) },
    }
    return ipc
  }

  it('把合法载荷交给已注册的 sink', () => {
    const ipc = fakeIpc()
    const sink = vi.fn()
    const disposeSink = setRendererErrorSink(sink)
    const disposeCapture = installRendererErrorCapture(ipc)
    expect(ipc.listeners).toBe(1)
    expect(hasRendererErrorSink()).toBe(true)

    ipc.emit(RENDERER_ERROR_CHANNEL, { type: 'error', message: 'boom', lineno: 3 })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]![0]).toMatchObject({ type: 'error', message: 'boom', lineno: 3 })

    // 形状不对的载荷(页面脚本伪造 / 版本漂移)一律丢弃,不交给 sink。
    ipc.emit(RENDERER_ERROR_CHANNEL, { type: 'evil', message: 'x' })
    ipc.emit(RENDERER_ERROR_CHANNEL, 'garbage')
    expect(sink).toHaveBeenCalledTimes(1)

    disposeCapture()
    expect(ipc.listeners).toBe(0)
    disposeSink()
    expect(hasRendererErrorSink()).toBe(false)
  })

  it('没有 sink 时静默丢弃且绝不抛（未登录/未启用上报）', () => {
    const ipc = fakeIpc()
    const dispose = installRendererErrorCapture(ipc)
    expect(() => ipc.emit(RENDERER_ERROR_CHANNEL, { type: 'error', message: 'boom' })).not.toThrow()
    expect(reportRendererError({ type: 'error', message: 'x' })).toBe(false)
    expect(reportRendererError({ type: 'render-process-gone', reason: 'crashed', exitCode: 1 })).toBe(false)
    dispose()
  })

  it('sink 自身抛错也不能影响宿主', () => {
    const ipc = fakeIpc()
    const disposeSink = setRendererErrorSink(() => { throw new Error('sink exploded') })
    const disposeCapture = installRendererErrorCapture(ipc)
    expect(() => ipc.emit(RENDERER_ERROR_CHANNEL, { type: 'error', message: 'boom' })).not.toThrow()
    expect(reportRendererError({ type: 'render-process-gone', reason: 'oom', exitCode: 5 })).toBe(false)
    disposeCapture()
    disposeSink()
  })
})

describe('窗口接线:沙箱 preload', () => {
  const SPEC: DesktopShellSpec = {
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    windowTitle: 'PicoAide',
    productName: 'PicoAide',
    iconPath: '/tmp/icon.png',
    url: 'http://127.0.0.1:1/',
    readLocalePreference: () => undefined,
    readThemeSource: () => 'system',
    requestQuit: () => {},
  } as unknown as DesktopShellSpec

  it('BrowserWindow 必须挂上沙箱 preload（否则渲染采集静默失效）', () => {
    const options = desktopWindowOptions(SPEC, { isEmpty: () => false } as never, 'linux')
    expect(options.webPreferences?.preload).toBeTruthy()
    expect(String(options.webPreferences?.preload).endsWith('preload/renderer-error.cjs')).toBe(true)
    // 安全基线不能因为加 preload 而放松。
    expect(options.webPreferences?.contextIsolation).toBe(true)
    expect(options.webPreferences?.nodeIntegration).toBe(false)
    expect(options.webPreferences?.sandbox).toBe(true)
  })
})
