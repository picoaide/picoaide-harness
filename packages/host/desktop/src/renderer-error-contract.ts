/**
 * Renderer → Host error-report contract (P0-6 / 决策 D8).
 *
 * 背景(2026-09-16,GlitchTip「收集不到内容」):错误上报此前只覆盖**主进程**
 * (`@sentry/node` 在主进程 init),渲染进程里用户真实遇到的未捕获错误
 * (React 渲染异常、IPC 失败、前端未捕获异常)与渲染进程崩溃**一条都不会进
 * GlitchTip** —— 这是"收集不到内容"最直接的功能性原因。
 *
 * 本文件是渲染进程与主进程之间的**唯一契约**:preload 侧做最小限度的
 * 归一化与限流后,经 `RENDERER_ERROR_CHANNEL` 单向上报给主进程。
 *
 * 两条硬约束(红线):
 *  1. 渲染进程**绝不**持有 DSN、**绝不**直接发起网络请求 —— DSN 与 Sentry 实例
 *     都只存在于主进程(企业插件 `error-reporting` 内)。渲染进程只把结构化
 *     载荷丢给主进程。
 *  2. IPC 是**不可信边界**:渲染进程可能被页面脚本/扩展污染,甚至恶意刷屏。
 *     所以主进程侧必须做完整校验(长度上限、类型白名单、字段截断),而不是
 *     相信 preload 传来的形状。
 */

/** 渲染进程未捕获错误/崩溃的单向 IPC 通道。 */
export const RENDERER_ERROR_CHANNEL = 'picoaide:desktop/renderer-error'

/** 单条文本字段的上限(字符)。栈可能很长,但不需要无限长。 */
export const RENDERER_ERROR_MAX_TEXT = 8 * 1024
/** 单条 URL/来源字段的上限(字符)。 */
export const RENDERER_ERROR_MAX_URL = 2 * 1024
/** 归一化后允许的类型。 */
export const RENDERER_ERROR_TYPES = ['error', 'unhandledrejection'] as const

/** 渲染进程报告的一种错误类型。 */
export type RendererErrorType = (typeof RENDERER_ERROR_TYPES)[number]

/** 渲染进程里捕获到的一条未捕获错误。 */
export interface RendererErrorPayload {
  /** 'error' = window.onerror;'unhandledrejection' = 未处理 Promise。 */
  type: RendererErrorType
  message: string
  stack?: string
  /** 出错脚本地址(window.onerror 的 source)。 */
  source?: string
  lineno?: number
  colno?: number
  /** 出错文档地址。 */
  url?: string
}

/** 主进程观察到的渲染进程崩溃(`render-process-gone`)。 */
export interface RendererGonePayload {
  type: 'render-process-gone'
  /** Electron 的崩溃原因:crashed / oom / killed / abnormal-exit / clean-exit … */
  reason: string
  exitCode: number
}

/** 主进程收到的渲染进程报告。 */
export type RendererErrorReport = RendererErrorPayload | RendererGonePayload

/** 归一化结果:不可信输入 → 有界、可安全上报的载荷。 */
export type RendererErrorNormalization =
  | { ok: true; report: RendererErrorPayload }
  | { ok: false; reason: string }

function asString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value === '') return undefined
  return value.length > max ? value.slice(0, max) : value
}

function asFiniteInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  // 行号/列号是 1-based 的小整数;越界值一律丢弃,不 clamp 成误导性数字。
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) return undefined
  return value
}

/**
 * 校验并归一化一条来自渲染进程的错误载荷(不可信边界)。
 *
 * 拒绝而不是"尽量修":形状不对的载荷说明发送方不是我们的 preload
 * (页面脚本、被注入的代码),直接丢弃比猜测更安全。
 */
export function normalizeRendererErrorReport(value: unknown): RendererErrorNormalization {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'payload is not an object' }
  }
  const record = value as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string' || !(RENDERER_ERROR_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: `unsupported type: ${String(type)}` }
  }
  const message = asString(record.message, RENDERER_ERROR_MAX_TEXT)
  if (message === undefined) {
    return { ok: false, reason: 'message must be a non-empty string' }
  }
  const report: RendererErrorPayload = { type: type as RendererErrorType, message }
  const stack = asString(record.stack, RENDERER_ERROR_MAX_TEXT)
  if (stack !== undefined) report.stack = stack
  const source = asString(record.source, RENDERER_ERROR_MAX_URL)
  if (source !== undefined) report.source = source
  const url = asString(record.url, RENDERER_ERROR_MAX_URL)
  if (url !== undefined) report.url = url
  const lineno = asFiniteInt(record.lineno)
  if (lineno !== undefined) report.lineno = lineno
  const colno = asFiniteInt(record.colno)
  if (colno !== undefined) report.colno = colno
  return { ok: true, report }
}

/**
 * 归一化未知错误/拒绝原因 → 消息与栈。
 *
 * 渲染进程里 `unhandledrejection` 的 reason 可能是任意值(字符串、Error、
 * 甚至对象);这里只做保守提取,拿不到就给出类型描述而不是丢掉事件。
 */
export function describeThrown(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      message: value.message === '' ? value.name : value.message,
      ...(typeof value.stack === 'string' && value.stack !== '' ? { stack: value.stack } : {}),
    }
  }
  if (typeof value === 'string') return { message: value === '' ? 'Unhandled rejection' : value }
  if (value === null || value === undefined) return { message: 'Unhandled rejection' }
  if (typeof value === 'object') {
    // 只取字符串形式的 message,不去 JSON.stringify(可能巨大/循环引用)。
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return { message }
    return { message: `Unhandled rejection (${Object.prototype.toString.call(value)})` }
  }
  return { message: `Unhandled rejection (${typeof value})` }
}

/**
 * 渲染进程侧的限流闸门(防错误风暴刷爆 IPC 与 GlitchTip)。
 *
 * 典型风暴:渲染循环里每帧抛错 ⇒ 每秒上千条。策略与 Sentry 自身的
 * dedupe 同取向,但**在 IPC 之前**就掐掉,避免把主进程也拖下水:
 *  - 同一 (type, message) 只放行一次;
 *  - 每个窗口期内最多 `maxPerWindow` 条。
 */
export class RendererErrorGate {
  private readonly seen = new Set<string>()
  private windowStarted = 0
  private inWindow = 0

  constructor(
    private readonly maxPerWindow = 20,
    private readonly windowMs = 10_000,
  ) {}

  /** 是否放行该载荷(并按需记账)。 */
  accept(report: RendererErrorPayload, now: number = Date.now()): boolean {
    const key = `${report.type}\u0000${report.message}`
    if (this.seen.has(key)) return false
    if (now - this.windowStarted >= this.windowMs) {
      this.windowStarted = now
      this.inWindow = 0
      this.seen.clear()
    }
    if (this.inWindow >= this.maxPerWindow) return false
    this.seen.add(key)
    this.inWindow += 1
    return true
  }
}
