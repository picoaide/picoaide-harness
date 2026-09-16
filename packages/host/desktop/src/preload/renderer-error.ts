/**
 * Sandboxed preload: forward renderer-side uncaught errors to the Host (P0-6/D8).
 *
 * 为什么用 preload 而不是注入页面脚本:窗口是 `contextIsolation: true` /
 * `nodeIntegration: false` / `sandbox: true`,页面拿不到 `ipcRenderer`。
 *
 * ★ 2026-09-16 修复轮 1(F-01,复核结论 P0):**窗口级事件不跨世界派发**。
 *   `contextIsolation: true` 时 preload 运行在**隔离世界**,而 `error` /
 *   `unhandledrejection` 是**页面主世界**的窗口级事件 —— 直接在这里
 *   `window.addEventListener(...)` 的监听器**一次都不会触发**(AB 实测:
 *   contextIsolation=true → 0 条到达;false → 2 条到达;同一探针向隔离世界
 *   手工投递事件 → 1 条到达,证明监听器/IPC/主进程都是好的)。
 *   修法 = **把监听装进主世界**,回传走两个世界共享的 DOM 事件:
 *
 *      主世界(preload 用 webFrame.executeJavaScript 注入的小片段)
 *        页面真实未捕获错误 ──▶ window.dispatchEvent(CustomEvent(BRIDGE))
 *      隔离世界(本文件)
 *        BRIDGE 监听 ──▶ 归一化(不可信方向)──▶ 风暴闸门 ──▶ ipcRenderer.send
 *      主进程
 *        installRendererErrorCapture ──▶ sink(企业 error-reporting 插件)
 *
 *   为什么用 DOM CustomEvent 而不是 `contextBridge`:D8 的红线是"不向页面暴露
 *   任何 API"。CustomEvent 不给页面任何**能力**(页面本来就能 `throw`;伪造桥
 *   事件与真的抛错等价,且主进程侧仍按不可信输入归一化 + 限流),而
 *   `exposeInMainWorld` 会往页面挂一个可调用的函数 —— 那才是需要重新拍板的
 *   口径变化。这条通路已用真机 Electron 43.4.0 实测:sandbox + contextIsolation
 *   下 `webFrame.executeJavaScript` 执行在**主世界**(用主/隔离两个世界分别读
 *   `window.__FIX1_INJECTED` 判定),页面 CSP(`script-src 'self' 'unsafe-inline'
 *   'unsafe-eval'`,与 `APP_CONTENT_SECURITY_POLICY` 一致)不影响注入,两条真实
 *   页面错误(error + unhandledrejection)经桥到达 IPC。
 *
 * 红线(与 D8 逐条对应):
 *  - 渲染进程**不持有 DSN**、**不直接发网络请求** —— 本文件只 `ipcRenderer.send`,
 *    真正的上报在主进程(企业 `error-reporting` 插件)里;
 *  - **不向页面暴露任何 API**(不用 `contextBridge`):注入片段只注册 DOM 监听并
 *    dispatch DOM 事件,不向页面挂任何可调用函数(只有一个去重标记属性);
 *  - 未登录/未启用上报时主进程侧静默丢弃,渲染进程无感;桥/注入任何一步失败都
 *    只降级,绝不影响页面。
 *
 * 该文件必须以 **CJS** 构建(`.cjs`):`sandbox: true` 下 Electron 不支持 ESM
 * preload,而本包 `"type": "module"` 会让 `.js` 被当成 ESM。
 */

import { ipcRenderer, webFrame } from 'electron'
import {
  describeThrown,
  normalizeRendererErrorReport,
  RENDERER_ERROR_CHANNEL,
  RENDERER_ERROR_MAX_TEXT,
  RENDERER_ERROR_MAX_URL,
  RendererErrorGate,
  type RendererErrorPayload,
} from '../renderer-error-contract.ts'

/** 错误风暴闸门(IPC 之前掐掉;见 contract 的说明)。 */
const gate = new RendererErrorGate()

/**
 * 主世界 → 隔离世界的桥事件名。
 *
 * 两个世界共享同一份 DOM,`window.dispatchEvent` 在两个世界都能收到 —— 这是
 * **唯一**不需要给页面任何能力的回传通路。
 */
export const RENDERER_ERROR_BRIDGE_EVENT = 'picoaide:desktop/renderer-error-bridge'

/** 主世界里标记"注入已装"的属性名(去重,避免重复注册监听器)。 */
const MAIN_WORLD_FLAG = '__picoaideRendererErrorInstalled'

function send(report: RendererErrorPayload): void {
  if (!gate.accept(report)) return
  try {
    ipcRenderer.send(RENDERER_ERROR_CHANNEL, report)
  } catch {
    // 通道不可用(窗口正在销毁)不能反过来把渲染进程搞崩。
  }
}

function currentURL(): string | undefined {
  try {
    return typeof location === 'undefined' ? undefined : location.href
  } catch {
    return undefined
  }
}

/**
 * 主世界注入片段(字符串,在**页面主世界**执行)。
 *
 * 只做两件事:把 `error` / `unhandledrejection` 归一成 JSON,经 CustomEvent 交给
 * 隔离世界。**不联网、不读 DSN、不暴露函数**;每一步都包 try/catch —— 采集代码
 * 绝不能让页面本身出错。
 *
 * @param options.bridgeEvent - 桥事件名(默认 {@link RENDERER_ERROR_BRIDGE_EVENT})。
 * @param options.maxText - 单字段上限(与 contract 的 `RENDERER_ERROR_MAX_TEXT` 同步;
 *   在页面世界先截断,避免把巨型栈序列化两遍)。
 * @param options.maxUrl - URL 字段上限(同步 `RENDERER_ERROR_MAX_URL`)。
 * @returns 可交给 `webFrame.executeJavaScript` 的源码。
 */
export function buildRendererErrorBridgeSnippet(options: {
  bridgeEvent?: string
  maxText?: number
  maxUrl?: number
} = {}): string {
  const bridgeEvent = options.bridgeEvent ?? RENDERER_ERROR_BRIDGE_EVENT
  const maxText = options.maxText ?? RENDERER_ERROR_MAX_TEXT
  const maxUrl = options.maxUrl ?? RENDERER_ERROR_MAX_URL
  return `(function () {
  try {
    if (typeof window === 'undefined') return 'no-window';
    var flag = ${JSON.stringify(MAIN_WORLD_FLAG)};
    if (window[flag] === true) return 'already-installed';
    try {
      Object.defineProperty(window, flag, { value: true, configurable: false, enumerable: false, writable: false });
    } catch (e) {
      window[flag] = true;
    }
    var BRIDGE = ${JSON.stringify(bridgeEvent)};
    var MAX_TEXT = ${maxText};
    var MAX_URL = ${maxUrl};
    function clip(value, max) {
      if (typeof value !== 'string' || value === '') return undefined;
      return value.length > max ? value.slice(0, max) : value;
    }
    function bridge(payload) {
      try {
        window.dispatchEvent(new CustomEvent(BRIDGE, { detail: JSON.stringify(payload) }));
      } catch (e) {
        // 桥接失败(自定义事件被裁剪等)绝不能影响页面。
      }
    }
    function documentURL() {
      try { return clip(String(window.location.href), MAX_URL); } catch (e) { return undefined; }
    }
    window.addEventListener('error', function (event) {
      try {
        var message = clip(event && event.message, MAX_TEXT) || 'Uncaught error';
        var error = event && event.error;
        bridge({
          type: 'error',
          message: message,
          stack: clip(error && error.stack, MAX_TEXT),
          source: clip(event && event.filename, MAX_URL),
          lineno: typeof (event && event.lineno) === 'number' ? event.lineno : undefined,
          colno: typeof (event && event.colno) === 'number' ? event.colno : undefined,
          url: documentURL()
        });
      } catch (e) { /* 采集失败不能影响页面 */ }
    });
    window.addEventListener('unhandledrejection', function (event) {
      try {
        var reason = event && event.reason;
        var message;
        var stack;
        if (reason instanceof Error) {
          message = reason.message === '' ? reason.name : reason.message;
          stack = reason.stack;
        } else if (typeof reason === 'string') {
          message = reason === '' ? 'Unhandled rejection' : reason;
        } else if (reason === null || reason === undefined) {
          message = 'Unhandled rejection';
        } else if (typeof reason === 'object' && typeof reason.message === 'string' && reason.message !== '') {
          message = reason.message;
        } else {
          message = 'Unhandled rejection (' + Object.prototype.toString.call(reason) + ')';
        }
        bridge({
          type: 'unhandledrejection',
          message: clip(message, MAX_TEXT) || 'Unhandled rejection',
          stack: clip(stack, MAX_TEXT),
          url: documentURL()
        });
      } catch (e) { /* 采集失败不能影响页面 */ }
    });
    return 'installed';
  } catch (e) {
    return 'failed';
  }
})()`
}

/**
 * 解析桥事件 detail(主世界 → 隔离世界**同样是不可信方向**:页面脚本可以伪造
 * 桥事件,所以这里走与 IPC 相同的归一化,拒绝而不是"尽量修")。
 *
 * @param detail - CustomEvent.detail(期望是 JSON 字符串)。
 * @returns 归一化后的载荷;不合法时 `undefined`。
 */
export function parseRendererErrorBridgeDetail(detail: unknown): RendererErrorPayload | undefined {
  if (typeof detail !== 'string' || detail === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(detail)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  // 页面世界可能送来多余字段;归一化只取白名单字段。
  const normalized = normalizeRendererErrorReport(parsed as Record<string, unknown>)
  return normalized.ok ? normalized.report : undefined
}

/**
 * 把 CustomEvent 转成结构化载荷(桥入口)。
 * @param event - BRIDGE 事件。
 */
function forwardBridgeEvent(event: Event): void {
  const detail = (event as CustomEvent).detail
  const report = parseRendererErrorBridgeDetail(detail)
  if (report === undefined) return
  send(report)
}

/**
 * **降级路径**:在隔离世界自己的 `window` 上装监听。
 *
 * 只在主世界注入不可用时使用(例如 `webFrame` 不可用、或未来的 Electron 改了
 * 注入语义)。`contextIsolation: true` 下它收不到页面主世界的窗口级事件 —— 所以
 * 它**不是**主路径,只是"注入做不到时至少不比以前更差"。
 */
export function installIsolatedWorldForwarding(target: Window): () => void {
  const onError = (event: ErrorEvent): void => {
    send({
      type: 'error',
      message: event.message === '' ? 'Uncaught error' : String(event.message),
      ...(typeof event.error?.stack === 'string' && event.error.stack !== '' ? { stack: event.error.stack } : {}),
      ...(typeof event.filename === 'string' && event.filename !== '' ? { source: event.filename } : {}),
      ...(typeof event.lineno === 'number' ? { lineno: event.lineno } : {}),
      ...(typeof event.colno === 'number' ? { colno: event.colno } : {}),
      ...(currentURL() === undefined ? {} : { url: currentURL()! }),
    })
  }

  const onRejection = (event: PromiseRejectionEvent): void => {
    const described = describeThrown(event.reason)
    send({
      type: 'unhandledrejection',
      message: described.message,
      ...(described.stack === undefined ? {} : { stack: described.stack }),
      ...(currentURL() === undefined ? {} : { url: currentURL()! }),
    })
  }

  target.addEventListener('error', onError as EventListener)
  target.addEventListener('unhandledrejection', onRejection as EventListener)
  return () => {
    target.removeEventListener('error', onError as EventListener)
    target.removeEventListener('unhandledrejection', onRejection as EventListener)
  }
}

/** `webFrame.executeJavaScript` 的最小面(便于测试注入替身)。 */
export interface RendererErrorWebFrame {
  executeJavaScript(code: string): unknown
}

/**
 * 取真实的 `webFrame`(取不到就返回 undefined)。
 *
 * 用 try/catch 而不是裸引用:在没有 Electron(单测替身/SSR 式打包检查)的环境里
 * 这个绑定可能整个不存在,裸访问会抛在**函数默认参数**上(那在 fail-soft 之外)。
 */
function defaultWebFrame(): RendererErrorWebFrame | undefined {
  try {
    return webFrame as unknown as RendererErrorWebFrame | undefined
  } catch {
    return undefined
  }
}

/**
 * 安装采集:主世界注入 + 桥监听(注入不可用时降级到隔离世界监听)。
 *
 * @param target - preload 侧的 window(CustomEvent 监听装在这里)。
 * @param frame - 注入用的 webFrame(测试注入替身;缺省用真实 webFrame)。
 * @returns disposer(测试/热重载用)。
 */
export function installRendererErrorForwarding(
  target: Window = window,
  frame?: RendererErrorWebFrame,
): () => void {
  const resolvedFrame = frame ?? defaultWebFrame()
  let disposed = false
  let disposeFallback: (() => void) | undefined

  const fallback = (): void => {
    if (disposed || disposeFallback !== undefined) return
    disposeFallback = installIsolatedWorldForwarding(target)
  }

  target.addEventListener(RENDERER_ERROR_BRIDGE_EVENT, forwardBridgeEvent as EventListener)

  let injected = false
  try {
    if (typeof resolvedFrame?.executeJavaScript === 'function') {
      const result = resolvedFrame.executeJavaScript(buildRendererErrorBridgeSnippet())
      injected = true
      // 注入是异步生效的:失败时退回隔离世界监听(降级,绝不影响页面)。
      if (typeof (result as Promise<unknown> | undefined)?.then === 'function') {
        void (result as Promise<unknown>).then(
          () => { /* 注入成功 */ },
          () => { fallback() },
        )
      }
    }
  } catch {
    injected = false
  }
  if (!injected) fallback()

  return () => {
    disposed = true
    target.removeEventListener(RENDERER_ERROR_BRIDGE_EVENT, forwardBridgeEvent as EventListener)
    disposeFallback?.()
    disposeFallback = undefined
  }
}

// 渲染进程里 import 即安装;无 window 的环境(单元测试/SSR 式打包检查)不自动装,
// 保证本模块可被安全 import(副作用只发生在真正的渲染进程里)。
if (typeof window !== 'undefined') installRendererErrorForwarding()
