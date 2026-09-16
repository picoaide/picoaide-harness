import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { subscribeSession } from './session-service.ts'
import { getBootstrap } from './server-connector/bootstrap.ts'
import { fetchJSON } from './server-connector/auth.ts'
import type { Session } from './server-connector/config.ts'
// 静态 import @sentry/node(external,运行时加载节点模块;动态 import 会被
// tsdown 拆 chunk 导致运行时解析挂起——已加日志确认 dsn 拿到后 init 卡住)。
import * as SentryNode from '@sentry/node'

/**
 * 客户端错误监控(feat/error-monitoring 2026-08):
 * 会话建立后,从服务端 bootstrap 的 `web.error_reporting_dsn` 读取 Sentry
 * 兼容 DSN(如自托管 GlitchTip),初始化 @sentry/electron 主进程采集;
 * 未捕获异常/未处理 rejection/console.error(Error 级)自动上报。
 *
 * 安全约束:DSN 一律由服务端下发(管理员在 webadmin 网关页配置),
 * 源码与本地配置不含任何上报地址。
 *
 * 2026-09-16(GlitchTip「收集不到内容」缺陷,决策 D1/D4/D7/D8):
 *  - **每一个静默分支都变成可查状态 + 会落盘的 warn**(P0-3):现场"20 天零真实
 *    错误"里,`enabled !== true`、`validateBootstrap` 回退 `EMPTY`、init 抛错
 *    三条路径此前**连日志都没有**,管理员在后台看到的是"健康"与"坏掉"一模一样;
 *  - **正向心跳**(P1-2):`web.error_reporting_heartbeat` 打开后,每次进程启动发
 *    一条带 `picoaide.heartbeat` tag 的 info 事件,**只对该 tag 绕过**等级阈值
 *    —— `error_reporting_level` 的语义**未改变**;
 *  - **状态上报服务端**(P1-3):把状态回传管理端,管理员一眼看到 N 台已启用 /
 *    M 台失败,不再靠猜;
 *  - **渲染进程采集**(P0-6/D8):经 preload → IPC 把渲染进程里用户真实遇到的
 *    未捕获错误与崩溃送进来;渲染进程**永不**持有 DSN、不直接发网络请求。
 */
export const name = 'error-reporting'

/** Services consumed: the session service providing login/logout lifecycle. */
export const inject = ['picoSession']

/** Desktop release 版本:从 dsh-plugin-desktop 包读取真实产品版本(如 2.4.0),
 * 用于 GlitchTip 按版本区分报错(release 字段)。读取失败回退 0.1.0。 */
const DESKTOP_PACKAGE_REQUIRE = createRequire(import.meta.url)
const DESKTOP_VERSION: string = (() => {
  try {
    return (DESKTOP_PACKAGE_REQUIRE('dsh-plugin-desktop/package.json') as { version?: string }).version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
})()

/** Active Sentry instance (only one at a time; null = not initialized). */
type SentryModule = {
  close: (timeout: number) => Promise<boolean>
  captureException?: (error: unknown, hint?: Record<string, unknown>) => string
  captureMessage?: (message: string, level?: unknown) => string
}
let sentry: SentryModule | null = null

/**
 * 客户端错误上报状态(PLAN §4.2)。每次 `sync()` 结束前更新,供上层/管理端观测。
 *
 * 为什么导出**函数**而不是导出这个绑定:tsdown/ESM 下外部 import 到的是值快照,
 * 可变绑定在打包后会失去活性(本仓 memory-evolve 的 `session.events` 踩坑同类)。
 */
export type ErrorReportingState =
  | { state: 'idle' }
  | { state: 'disabled' }
  | { state: 'ready'; dsnHost: string; level: string }
  | { state: 'failed'; reason: string; dsnHost?: string }
  | { state: 'config_unavailable'; reason: string }

let status: ErrorReportingState = { state: 'idle' }

/** 只读当前状态(纯读,便于断言与状态上报)。 */
export function getErrorReportingStatus(): ErrorReportingState {
  return status
}

/**
 * 复位状态(仅测试用)。
 *
 * 生产路径不需要它:`sync()` 在每次会话变更后都会重算并覆盖状态。
 */
export function resetErrorReportingStatusForTest(): void {
  status = { state: 'idle' }
  heartbeatSent = false
  disabledWarned = false
  reportedStatusKeys.clear()
}

/** 只取主机名,绝不记录/上报完整 DSN(public key 也没有出现在日志里的必要)。 */
export function dsnHostOf(dsn: string): string | undefined {
  try {
    const parsed = new URL(dsn.trim())
    return parsed.host === '' ? undefined : parsed.host
  } catch {
    return undefined
  }
}

/**
 * 客户端侧的 DSN 形状预检(修复轮 1,F-04/F-14)。
 *
 * 为什么服务端已经有权威校验还要在客户端再查一遍:
 *   - 库里可能存着**本轮之前**保存的坏值(现场 `http://…@localhost:8000/1` 就是
 *     被旧版 webadmin 照收的);
 *   - `@sentry/node` 对某些 DSN **不抛异常**却一条都不发:非法 DSN 会绑一个没有
 *     DSN 的 client;`:99999` 这类端口会让 node transport 退化成"不发任何事件"的
 *     空实现(只打一行 console.warn)。两条都表现为"后台显示已启用、实际零外发"。
 *
 * 这里只做**必然不可用**的判定(端口越界、缺主机/公钥、项目 ID 非正整数),
 * 不做环回/私网策略 —— 那是服务端的准入职责,客户端不该越权改语义。
 *
 * @param dsn - 已 trim 的 DSN。
 * @returns 不可用原因;`undefined` = 形状没问题。
 */
export function unsupportedDsnReason(dsn: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(dsn)
  } catch {
    // `new URL` 对 `:99999` / `:65536` / `0.0.0.0.0` 这类输入直接抛错;端口越界
    // 是最常见的一种,单独给出精确原因(否则运维只会看到"不是合法 URL")。
    const portMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*:([0-9]+)(?:[/?#]|$)/.exec(dsn)
    if (portMatch !== null) {
      const port = Number(portMatch[1])
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        return `DSN 端口 ${portMatch[1]} 不在 1-65535:客户端 SDK 不会发出任何事件`
      }
    }
    return 'DSN 不是合法的 URL:客户端 SDK 不会发出任何事件'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `DSN 协议 ${parsed.protocol.replace(/:$/, '')} 不受支持(只支持 http/https)`
  }
  if (parsed.hostname === '') return 'DSN 缺少主机名:客户端 SDK 不会发出任何事件'
  if (parsed.port !== '') {
    const port = Number(parsed.port)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      return `DSN 端口 ${parsed.port} 不在 1-65535:客户端 SDK 不会发出任何事件`
    }
  }
  if (parsed.username.trim() === '') return 'DSN 缺少公钥:客户端 SDK 不会发出任何事件'
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  const projectId = segments.length > 0 ? segments[segments.length - 1]! : ''
  if (!/^[0-9]+$/.test(projectId) || Number(projectId) <= 0) {
    return 'DSN 的项目 ID 必须是正整数:客户端 SDK 不会发出任何事件'
  }
  return undefined
}

/**
 * 询问 SDK "它到底接受了这个 DSN 没有"(修复轮 1,F-04)。
 *
 * `@sentry/node` 7.x 的 `init()` 对解析不了的 DSN **不抛异常**:`@sentry/core` 的
 * `initAndBind` 捕获后只 `logger.warn('Invalid Sentry Dsn: …')`,然后继续绑定一个
 * **没有 DSN** 的 client —— 之后 `captureEvent` 因 `!client.getDsn()` 直接丢弃。
 * 所以"没抛异常"不等于"能上报",必须回读 SDK 自己的 client。
 *
 * fail-soft 边界:探针**只在 SDK 明确给出"没有 DSN"时**才判失败;API 不存在或
 * 探针自身抛错都返回 `unknown`(宁可维持现状,也不能因为探针失效而把所有部署
 * 静默关掉 —— 那是比原缺陷更严重的回归)。
 */
export function probeSdkDsnAcceptance(): 'accepted' | 'rejected' | 'unknown' {
  try {
    const mod = SentryNode as unknown as {
      getClient?: () => unknown
      getCurrentHub?: () => { getClient?: () => unknown } | undefined
    }
    const client = typeof mod.getClient === 'function'
      ? mod.getClient()
      : mod.getCurrentHub?.()?.getClient?.()
    if (client === null || client === undefined || typeof client !== 'object') return 'unknown'
    const getDsn = (client as { getDsn?: unknown }).getDsn
    if (typeof getDsn !== 'function') return 'unknown'
    const dsn = (getDsn as () => unknown).call(client)
    return dsn === undefined || dsn === null ? 'rejected' : 'accepted'
  } catch {
    return 'unknown'
  }
}

/** SDK 拒绝 DSN 时的失败原因(文案要能让管理员直接行动)。 */
export const SDK_REJECTED_DSN_REASON =
  'Sentry SDK 拒绝了该 DSN(不会发出任何事件):多为字面 IPv6 等 SDK 不接受的写法,请改用域名或 IPv4'

// 等级阈值(2026-08):数值越大越严重;level 为最低上报等级(>= 才上报)
const LEVEL_RANK: Record<string, number> = { debug: 10, info: 20, warning: 30, error: 40, fatal: 50 }

/** 心跳事件的 tag 名:只有带它的 event 才绕过等级阈值(D4 的显式例外)。 */
export const HEARTBEAT_TAG = 'picoaide.heartbeat'

// 每进程只发一次心跳(重 init/登出重登不重复);开关打开时才置位。
let heartbeatSent = false
// "未启用"只在每进程 warn 一次:登出/登录是常态,不能每次刷屏(P0-3 降噪)。
let disabledWarned = false

/**
 * 初始化(或重置)Sentry。DSN 空串 = 停止上报并关闭旧实例。
 * 用 @sentry/node(无 Electron app ready 时序限制):登录后动态拿 DSN 可
 * 随时 init/close;采集主进程未捕获异常/未处理 rejection。
 * 渲染进程采集见下方 captureRendererError(P0-6/D8)。
 *
 * @param dsn - 服务端下发的 DSN(空 = 关闭)。
 * @param release - 上报 release 标识。
 * @param level - 最低上报等级(>= 才上报);未知值回落 error。
 * @param heartbeat - true 时 init 成功后发一条带 tag 的 info 心跳(不受阈值限制)。
 * @returns 成功 `{ ok: true }`;失败 `{ ok: false, reason }`。**不抛异常**
 *          (fail-soft:上报坏掉绝不能拖垮宿主)。
 */
export async function initSentry(
  dsn: string,
  release: string,
  level = 'error',
  heartbeat = false,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (sentry !== null) {
    // 重新初始化前先关闭旧实例(登出/切换 DSN)。
    try {
      // 给缓冲区一个有限的冲刷窗口:P1-5 判定(见 IMPLEMENTATION 验证记录)确认
      // close(0) 会丢弃尚未发出的队列;1500ms 足够本机把已入队事件写出去,
      // 又不会把退出路径拖长(宿主退出协调器另有超时)。
      await sentry.close(1500)
    } catch { /* ignore */ }
    sentry = null
  }
  const normalized = dsn.trim()
  if (!normalized) {
    status = { state: 'disabled' }
    return { ok: true }
  }
  const threshold = LEVEL_RANK[level] ?? LEVEL_RANK.error!
  const dsnHost = dsnHostOf(normalized)
  // F-04/F-14(修复轮 1):**先做形状预检** —— 这些值客户端 SDK 一条都不会发
  // (非法 DSN → 绑一个没有 DSN 的 client;端口越界 → 空 transport),而 init 不抛。
  const unsupported = unsupportedDsnReason(normalized)
  if (unsupported !== undefined) {
    console.warn('error-reporting: DSN 形状不可用,拒绝启用(降级不上报):', unsupported)
    status = { state: 'failed', reason: unsupported, ...(dsnHost === undefined ? {} : { dsnHost }) }
    return { ok: false, reason: unsupported }
  }
  try {
    const mod = SentryNode as unknown as {
      init: (o: Record<string, unknown>) => void
      captureMessage: (m: string, l?: unknown) => void
      captureException?: (e: unknown, hint?: Record<string, unknown>) => string
    }
    mod.init({
      dsn: normalized,
      release,
      // 等级过滤(2026-08):低于阈值的 event 不下发(如等级=warning 只报 warning/error)。
      // 2026-09-16(D4):**只有**带 HEARTBEAT_TAG 的事件例外 —— 普通事件仍走原
      // 纯等级过滤,`error_reporting_level` 语义未被改变(回归防线见 spec 的
      // "still filters ordinary info events when heartbeat is enabled")。
      beforeSend: (event: { level?: string; tags?: Record<string, unknown> }) => {
        if (event.tags?.[HEARTBEAT_TAG] !== undefined) return event
        const lv = (event.level ?? 'error').toLowerCase()
        const rank = LEVEL_RANK[lv] ?? LEVEL_RANK.error!
        return rank >= threshold ? event : null
      },
      // defaultIntegrations 缺省为 true(7.x);显式传 true 会因版本差异
      // 触发 forEach 报错,故不传
    })
    // F-04(修复轮 1):init 不抛 ≠ SDK 接受了 DSN。回读 SDK 的 client:
    // `getDsn()` 为空说明它绑的是"没有 DSN 的 client"(事件会被静默丢弃)——
    // 这正是 F-11 现场"后台显示已启用、GlitchTip 一条不见"的第二条路径。
    if (probeSdkDsnAcceptance() === 'rejected') {
      console.warn('error-reporting: Sentry SDK 拒绝了该 DSN,本次不上报:', SDK_REJECTED_DSN_REASON, dsnHost ?? '')
      // 把 SDK 里的空 client 也关掉,避免 captureXxx 假成功(它只会静默丢弃)。
      try {
        await (SentryNode as unknown as { close?: (t: number) => Promise<unknown> }).close?.(0)
      } catch { /* ignore */ }
      status = { state: 'failed', reason: SDK_REJECTED_DSN_REASON, ...(dsnHost === undefined ? {} : { dsnHost }) }
      sentry = null
      return { ok: false, reason: SDK_REJECTED_DSN_REASON }
    }
    sentry = SentryNode as unknown as SentryModule
    status = { state: 'ready', dsnHost: dsnHost ?? '', level }
    // 链路自检(联调 2026-08-27):info 级,只有开心跳时才发 ——
    // 默认阈值 error 会把它丢掉,这正是"健康链路在后台也一片空白"的机制(F9/F11)。
    if (heartbeat && !heartbeatSent) {
      heartbeatSent = true
      try {
        mod.captureMessage(`客户端错误上报链路自检 (${release})`, {
          level: 'info',
          tags: { [HEARTBEAT_TAG]: '1' },
        } as unknown as undefined)
      } catch { /* 心跳失败不影响上报本体 */ }
    }
    return { ok: true }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    // D1:失败**不再静默** —— 状态可查 + warn 会落盘(桌面默认日志阈值 info)。
    console.warn('error-reporting: Sentry init 失败(降级不启用):', cause)
    status = { state: 'failed', reason, ...(dsnHost === undefined ? {} : { dsnHost }) }
    sentry = null
    return { ok: false, reason }
  }
}

/**
 * 采集一条渲染进程未捕获错误(P0-6/D8)。由主进程的 IPC 通道调用。
 *
 * 红线:渲染进程**不持有** DSN、**不直接**发网络请求;它只把结构化载荷交给
 * 主进程,由这里复用已 init 的 Sentry 实例上报。
 *
 * 未 init(未登录/开关关闭/init 失败)时**静默丢弃**,绝不抛异常 —— 与
 * `initSentry` 的 fail-soft 语义一致:错误上报坏掉绝不能影响界面可用性。
 *
 * @param payload - 来自渲染进程的结构化错误载荷。
 * @returns 是否真的交给了 Sentry。
 */
export function captureRendererError(payload: RendererErrorPayload): boolean {
  if (sentry === null) return false
  const mod = SentryNode as unknown as {
    captureException?: (e: unknown, hint?: Record<string, unknown>) => string
    captureMessage?: (m: string, l?: unknown) => string
  }
  try {
    const error = new Error(payload.message === '' ? 'renderer error' : payload.message)
    if (typeof payload.stack === 'string' && payload.stack !== '') error.stack = payload.stack
    const tags: Record<string, string> = { 'picoaide.process': 'renderer', 'picoaide.kind': payload.type }
    if (typeof payload.url === 'string' && payload.url !== '') tags['picoaide.url'] = payload.url
    const extra: Record<string, unknown> = {
      source: payload.source,
      lineno: payload.lineno,
      colno: payload.colno,
    }
    if (typeof mod.captureException === 'function') {
      mod.captureException(error, { tags, extra })
      return true
    }
    if (typeof mod.captureMessage === 'function') {
      mod.captureMessage(error.message, 'error' as unknown as undefined)
      return true
    }
    return false
  } catch {
    // 上报路径自身出错也不能影响宿主。
    return false
  }
}

/**
 * 采集一次渲染进程崩溃(P0-6/D8:`render-process-gone`)。
 *
 * `reason`/`exitCode` 作为 tag,便于在 GlitchTip 里按崩溃原因聚合
 * (`crashed`/`oom`/`killed`/`abnormal-exit`…)。未 init 时同样静默丢弃。
 *
 * ★ 修复轮 1(F-10,复核结论 P2):此前崩溃面走 `captureMessage(message, 'error')`
 *   —— 第二参是 **level**,不带 tags,于是崩溃事件在后台**没有任何 tag**
 *   (对照 `captureRendererError` 带 `picoaide.process=renderer`),无法用统一 tag
 *   一次筛出"渲染进程相关问题"。现在改成 `captureMessage(message, { level, tags,
 *   extra })`(CaptureContext 形式),tag 与异常分支保持一致。
 */
export function captureRendererGone(details: { reason: string; exitCode?: number }): boolean {
  if (sentry === null) return false
  const mod = SentryNode as unknown as {
    captureMessage?: (m: string, context?: unknown) => string
    captureException?: (e: unknown, hint?: Record<string, unknown>) => string
  }
  try {
    const exitCode = details.exitCode ?? 0
    const message = `渲染进程崩溃 (reason: ${details.reason}, exitCode: ${String(exitCode)})`
    const tags: Record<string, string> = {
      'picoaide.process': 'renderer',
      'picoaide.kind': 'render-process-gone',
      'picoaide.reason': details.reason,
      'picoaide.exit_code': String(exitCode),
    }
    const extra: Record<string, unknown> = { reason: details.reason, exitCode }
    if (typeof mod.captureMessage === 'function') {
      // CaptureContext 形式:`{ level, tags, extra }`(不再是 `captureMessage(msg, level)`)。
      mod.captureMessage(message, { level: 'error', tags, extra })
      return true
    }
    if (typeof mod.captureException === 'function') {
      mod.captureException(new Error(message), { tags, extra })
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 宿主(desktop)转来的渲染进程报告的结构类型。
 *
 * 刻意**不** import `dsh-plugin-desktop` 的类型:企业包与 desktop 包之间不需要
 * 新增一条依赖边(desktop 已是本包的宿主,反向 import 会造成循环)。
 * 形状真源在 `dsh-plugin-desktop/src/renderer-error-contract.ts`。
 */
export type RendererErrorReportLike =
  | RendererErrorPayload
  | { type: 'render-process-gone'; reason: string; exitCode: number }

/** 渲染进程上报的错误载荷(preload 侧构造;已做长度上限)。 */
export interface RendererErrorPayload {
  /** 'error' = window.onerror;'unhandledrejection' = 未处理 Promise。 */
  type: 'error' | 'unhandledrejection'
  message: string
  stack?: string
  source?: string
  lineno?: number
  colno?: number
  url?: string
}

/** 状态上报去重键(每进程每个 state+reason 只报一次;登出登入不重复)。 */
const reportedStatusKeys = new Set<string>()

/** 上报状态键:state + reason 前缀(reason 变化才是新信息)。 */
function statusReportKey(value: ErrorReportingState): string {
  const reason = 'reason' in value ? value.reason.slice(0, 80) : ''
  return `${value.state}#${reason}`
}

/**
 * 把当前错误上报状态回传服务端(P1-3/D7)。
 *
 * 尽力而为:失败只 `logger.debug`,**绝不重试、绝不阻塞、绝不影响宿主**
 * (与 skill-telemetry 的非致命语义一致)。上报体只含 state/reason/dsn_host/
 * level/release,**不含完整 DSN、不含 public key**。
 */
export async function reportErrorReportingStatus(
  session: Session | null,
  value: ErrorReportingState,
): Promise<boolean> {
  if (session === null) return false
  const key = statusReportKey(value)
  if (reportedStatusKeys.has(key)) return false
  reportedStatusKeys.add(key)
  const body: Record<string, string> = { state: value.state, release: `picoaide-desktop@${DESKTOP_VERSION}` }
  if ('reason' in value && value.reason !== '') body.reason = value.reason.slice(0, 200)
  if ('dsnHost' in value && value.dsnHost !== undefined && value.dsnHost !== '') body.dsn_host = value.dsnHost
  if ('level' in value && value.level !== '') body.level = value.level
  try {
    await fetchJSON(session.serverURL, '/api/client/v2/telemetry/error-reporting', {
      token: session.token,
      method: 'POST',
      body,
      timeoutMs: 5000,
    })
    return true
  } catch {
    // 状态上报失败不能产生任何用户可见影响;key 已入集,不重试风暴。
    return false
  }
}

/** Apply: watch session changes and keep Sentry in sync with the server DSN. */
export function apply(ctx: Context): void {
  // 诊断日志走 logger(2026-09-08 P2-40:三条 console.log 是发货插件里的调试
  // 残留,会污染用户控制台;降级为 debug 级)。
  ctx.logger?.debug('error-reporting: plugin applied')
  // release 用桌面客户端包版本(粗粒度够用;sourcemap 可按需细化)。
  // 编译期由 tsdown define 注入;缺省回退 "0.1.0"(与 enterprise package.json 一致)。
  const release = `picoaide-desktop@${DESKTOP_VERSION}`

  const sync = async (session: Session | null): Promise<void> => {
    ctx.logger?.debug('error-reporting: session-changed', session?.username ?? null)
    if (session === null) {
      // 登出是常态,保持 debug 不刷屏;状态回落 disabled。
      await initSentry('', release)
      return
    }
    try {
      // fellBack 此前被丢弃(PLAN §2.6 的最强静默路径):服务端 models 为空时
      // validateBootstrap 把**整份**配置换成 EMPTY(web:{}),于是 enabled 为假、
      // initSentry('') 静默返回 —— 服务端明明下发了正确 DSN,客户端一个字节都不发。
      //
      // 回修(2026-09-16,实测):`fellBack` 这个布尔把两种情况混在一起,只有
      // `empty` 才是致命回退。`default_model_substituted`(models 非空、只是
      // default_model 没配上)会**原样保留** web 段 —— 据此关掉上报就等于复现
      // 本轮要消灭的缺陷(一个字节都不发)。所以按 `fallback` 种类判定。
      const { config, fallback } = await getBootstrap(session)
      const web = config.web
      if (fallback === 'empty') {
        status = { state: 'config_unavailable', reason: 'bootstrap 回退空配置(models 为空或形状不合)' }
        ctx.logger?.warn?.('错误上报:服务端配置不可用(models 为空,已回退空配置),本次不上报')
        void reportErrorReportingStatus(session, status)
        return
      }
      if (fallback === 'default_model_substituted') {
        // 良性回退:只影响默认模型选择,上报配置仍按原样应用(仅留一条线索日志)。
        ctx.logger?.warn?.('错误上报:服务端未指定有效默认模型,已回落首个模型;错误上报配置不受影响')
      }
      // 开关(2026-08):服务端关闭则不初始化上报;等级阈值传 init 过滤。
      const enabled = web?.error_reporting_enabled === true
      const dsn = web?.error_reporting_dsn ?? ''
      ctx.logger?.debug('error-reporting: dsn from bootstrap', enabled && dsn !== '' ? 'configured' : 'disabled/empty')
      if (!enabled || dsn.trim() === '') {
        status = { state: 'disabled' }
        // 降噪:同一进程只 warn 一次(登录/登出反复触发 sync)。
        if (!disabledWarned) {
          disabledWarned = true
          ctx.logger?.warn?.('错误上报未启用(开关关闭或 DSN 为空):客户端不会上报任何错误')
        }
        void reportErrorReportingStatus(session, status)
        return
      }
      const result = await initSentry(
        dsn,
        release,
        web?.error_reporting_level ?? 'error',
        web?.error_reporting_heartbeat === true,
      )
      if (result.ok) {
        // info 会落盘(桌面默认日志阈值 info),这是"链路活着"的第一手痕迹。
        ctx.logger?.info?.(
          `error-reporting: 已启用(dsn=${status.state === 'ready' ? status.dsnHost : ''}, release=${release}, level=${web?.error_reporting_level ?? 'error'})`,
        )
      } else {
        ctx.logger?.warn?.('error-reporting: Sentry 初始化失败,本次不上报:', result.reason)
      }
      void reportErrorReportingStatus(session, status)
    } catch (cause) {
      // bootstrap 失败不阻断;但现在状态可查、日志会落盘。
      const reason = cause instanceof Error ? cause.message : String(cause)
      status = { state: 'config_unavailable', reason }
      console.warn('[error-reporting] bootstrap 失败,不上报:', cause)
      ctx.logger?.warn?.('error-reporting: bootstrap 失败,不上报:', cause)
      void reportErrorReportingStatus(session, status)
    }
  }

  const reportFailure = (cause: unknown): void => {
    try {
      ctx.logger.error(cause)
    } catch {
      // logger 不可用（极端环境/已关闭 context）时静默:错误上报失败不阻断主机。
    }
  }
  // P1-5(H5 崩溃退出竞态):宿主退出前必须给上报缓冲区一个冲刷窗口。
  //
  // 机制:宿主的未捕获异常 handler 在**启动期**注册(desktop-logger),第一个
  // uncaughtException 就 requestQuit → app.exit;而 @sentry/node 的
  // OnUncaughtException 要到登录后才注册,Node 按注册顺序先跑宿主退出逻辑 ——
  // 最有价值的崩溃事件恰好最可能丢。全仓此前**没有任何一处**在退出时 close。
  // 这里挂在插件 dispose 上(Cordis 树在退出时 dispose),超时有限不拖长退出。
  //
  // ★ 修复轮 1(F-05,复核结论 P1):**disposer 必须 `return` 那个 promise**。
  //   宿主链路是 `main.ts:217 await fiber.dispose()` → cordis `fiber._unload()`
  //   会 `await runDisposable(dispose)`(即 await disposer 的**返回值**)。此前写成
  //   `void current?.close(1500)` 把 promise 丢掉,等于"发起冲刷后立刻退出" ——
  //   复核员用独立进程收包器实测:当前实现 ARRIVED=0(3/3),显式 await close(1500)
  //   则 ARRIVED=2(3/3)。所以这里返回 promise(宿主关闭协调器另有 5s 上限,
  //   1.5s 冲刷完全在预算内)。
  //   用 `?.`:无头组合/测试替身可能没有 effect;上报的退出钩子缺失只能降级,
  //   绝不能因此让插件 apply 抛错(那会把整个宿主启动拖下水)。
  ctx.effect?.(() => () => {
    const current = sentry
    sentry = null
    if (current === null) return undefined
    try {
      // 返回 thenable(不是 void):宿主会等它,崩溃事件才有机会落地。
      return current.close(1500).catch(() => undefined)
    } catch {
      return undefined
    }
  })

  // P0-6/D8:接管宿主转来的渲染进程错误报告。
  // 只做结构判定(载荷类型见 desktop 的 renderer-error-contract;这里刻意不
  // import desktop 的模块,避免给企业包加一条运行时依赖边)。
  // 无 desktopRuntime(无头组合/CLI)时静默跳过。
  try {
    const runtime = ctx.get?.('desktopRuntime') as
      | { setRendererErrorSink?: (sink: (report: RendererErrorReportLike) => void) => () => void }
      | undefined
    if (typeof runtime?.setRendererErrorSink === 'function') {
      ctx.effect?.(() => runtime.setRendererErrorSink!((report) => {
        if (report.type === 'render-process-gone') {
          captureRendererGone({ reason: report.reason, exitCode: report.exitCode })
          return
        }
        captureRendererError(report)
      }))
    }
  } catch (cause) {
    // 接管失败绝不能影响宿主启动;上报坏掉是降级而不是故障。
    ctx.logger?.debug?.('error-reporting: 接管渲染进程错误通道失败', cause)
  }

  // subscribeSession 而不是裸 ctx.on + 轮询兜底（2026-08-27 联调时加的 1s×60
  // 轮询）：那次"登录态看不见"的根因是 `restore()` 在 SessionService 构造期就跑完，
  // 它 emit 的会话事件可能早于本插件 apply —— 裸订阅整个漏掉，只能靠轮询补。
  // 根因已在 session-service 侧修掉（subscribeSession 补发启动时那一次），轮询随之
  // 删除：它每次启动都要挂 60 秒定时器，还会与事件路径重复初始化一次 Sentry。
  subscribeSession(ctx, (session) => { void sync(session).catch(reportFailure) })
}
