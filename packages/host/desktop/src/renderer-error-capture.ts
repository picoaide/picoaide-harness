/**
 * Host-side sink for renderer error reports (P0-6 / 决策 D8).
 *
 * 主进程侧的两件事:
 *  1. 从渲染进程经 `RENDERER_ERROR_CHANNEL` 收报告(不可信边界 ⇒ 先归一化);
 *  2. 把归一化后的报告交给**已注册的 sink** —— 具体由哪个模块上报(企业
 *     `error-reporting` 插件 → GlitchTip)不属于 desktop 包的职责,desktop 只
 *     提供通道。没有 sink(未登录/插件未加载/headless)时**静默丢弃**:
 *     错误上报坏掉绝不能影响宿主。
 *
 * 为什么 sink 是模块级而不是每次调用传:IPC 监听在启动期就装好了(早于任何
 * 插件 apply),而插件是登录后才注册 sink 的 —— 两边生命周期不同,必须解耦。
 */

import type { RendererErrorReport } from './renderer-error-contract.ts'
import { normalizeRendererErrorReport, RENDERER_ERROR_CHANNEL } from './renderer-error-contract.ts'

/** 上报落点:由拥有 Sentry 实例的一方注册。 */
export type RendererErrorSink = (report: RendererErrorReport) => void

let sink: RendererErrorSink | undefined

/**
 * 注册上报落点。
 * @param next - 接收归一化报告的落点。
 * @returns 幂等 disposer(仅当自己仍是当前 sink 时才清除)。
 */
export function setRendererErrorSink(next: RendererErrorSink): () => void {
  sink = next
  return () => {
    if (sink === next) sink = undefined
  }
}

/** 当前是否已有落点(测试与诊断用)。 */
export function hasRendererErrorSink(): boolean {
  return sink !== undefined
}

/**
 * 把一条**已在主进程内**产生的报告交给 sink(如 `render-process-gone`)。
 * 无 sink 时静默丢弃,绝不抛。
 */
export function reportRendererError(report: RendererErrorReport): boolean {
  const current = sink
  if (current === undefined) return false
  try {
    current(report)
    return true
  } catch {
    // 上报落点自身出错不得影响宿主(它在另一端已经 fail-soft,这里是双保险)。
    return false
  }
}

/** 可注入的最小 IPC 面(便于单测不依赖真实 Electron)。 */
export interface RendererErrorIpc {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): unknown
}

/**
 * 安装渲染进程错误通道的监听(启动期调用一次;幂等)。
 *
 * @param ipc - IPC 宿主(生产传 Electron `ipcMain`,测试注入假实现)。
 * @returns disposer(测试/重启用)。
 */
export function installRendererErrorCapture(ipc: RendererErrorIpc): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    const normalized = normalizeRendererErrorReport(payload)
    // 形状不对 ⇒ 不是我们的 preload 发的,丢弃比猜测安全(不可信边界)。
    if (!normalized.ok) return
    reportRendererError(normalized.report)
  }
  ipc.on(RENDERER_ERROR_CHANNEL, listener)
  return () => {
    ipc.removeListener(RENDERER_ERROR_CHANNEL, listener)
  }
}
